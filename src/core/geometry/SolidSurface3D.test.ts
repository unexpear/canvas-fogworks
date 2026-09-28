/** @module SolidSurface3D.test @description Exterior area, cutout visibility, internal-face removal, provenance and GPU precision safety. */
import {generateBlockout,Point3D} from "./Blockout3D";
import {solidCells3D,solidBoolean3D} from "./SolidBoolean3D";
import {solidSurfaceMesh3D,SolidSurfaceMesh3D} from "./SolidSurface3D";
const box=(id:string,w=2,h=2,d=2,x=0,y=0,z=0)=>solidCells3D(generateBlockout({kind:"box",width:w,height:h,depth:d}).parts,id)
    .map(cell=>({...cell,vertices:cell.vertices.map(p=>[p[0]+x,p[1]+y,p[2]+z] as Point3D)}));
function area(result:SolidSurfaceMesh3D){
    const {positions:p,indices:ix}=result.mesh;let sum=0;
    for(let i=0;i<ix.length;i+=3){const a=ix[i]*3,b=ix[i+1]*3,c=ix[i+2]*3;
        const u=[0,1,2].map(j=>p[b+j]-p[a+j]),v=[0,1,2].map(j=>p[c+j]-p[a+j]);
        sum+=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;
    }return sum;
}
function zRayHit(result:SolidSurfaceMesh3D,x:number,y:number):boolean{
    const {positions:p,indices:ix}=result.mesh;
    for(let i=0;i<ix.length;i+=3){
        const [a,b,c]=[0,1,2].map(j=>{const at=ix[i+j]*3;return [p[at],p[at+1]];});
        const det=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);if(Math.abs(det)<1e-10)continue;
        const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/det;
        const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/det;
        if(u>=0&&v>=0&&u+v<=1)return true;
    }return false;
}
test("touching and overlapping cubes expose only the combined exterior area",()=>{
    expect(area(solidSurfaceMesh3D(box("a")))).toBeCloseTo(24);
    expect(area(solidSurfaceMesh3D([...box("a"),...box("b",2,2,2,2)]))).toBeCloseTo(40);
    expect(area(solidSurfaceMesh3D([...box("a"),...box("b",2,2,2,1)]))).toBeCloseTo(32);
    expect(area(solidSurfaceMesh3D([...box("a"),...box("duplicate")]))).toBeCloseTo(24);
});
test("partially covered coplanar faces remove only the shared patch",()=>{
    // Main box area 24 plus small box area 6, minus twice the 1x1 shared patch.
    const result=solidSurfaceMesh3D([...box("base"),...box("small",1,1,1,1.5,.5)]);
    expect(area(result)).toBeCloseTo(28);
    const remaining=result.surfaces.filter(s=>Math.abs(s.normal[0]-1)<1e-8&&s.points.every(p=>Math.abs(p[0]-1)<1e-8));
    expect(remaining.length).toBeGreaterThan(0);
});
test("door and window meshes have analytically correct exposed area and visible openings",()=>{
    const wall=box("wall",4,3,.4);
    const door=solidSurfaceMesh3D(solidBoolean3D("subtract",wall,box("door",1,2,1)));
    const window=solidSurfaceMesh3D(solidBoolean3D("subtract",wall,box("window",1,1,1,0,1)));
    expect(area(door)).toBeCloseTo(27.2,5);expect(area(window)).toBeCloseTo(29.2,5);
    for(const result of [door,window]){
        expect(zRayHit(result,.123,1.23)).toBe(false);
        expect(zRayHit(result,1.123,1.23)).toBe(true);
        expect(zRayHit(result,.123,2.23)).toBe(true);
        expect(result.triangleSurfaceIds).toHaveLength(result.mesh.indices.length/3);
        expect(result.mesh.normals).toHaveLength(result.mesh.positions.length);
        expect(result.mesh.uvs).toHaveLength(result.mesh.positions.length/3*2);
    }
    expect(zRayHit(window,.123,.23)).toBe(true);
    expect(window.triangleSurfaceIds.some(id=>id.startsWith("window/"))).toBe(true);
});
test("rotated cell boundaries preserve exterior area and immutable deterministic output",()=>{
    const cells=solidBoolean3D("subtract",box("wall",4,3,.4),box("door",1,2,1)),angle=.43,c=Math.cos(angle),s=Math.sin(angle);
    const rotated=cells.map(cell=>({...cell,vertices:cell.vertices.map(p=>[c*p[0]+s*p[2],p[1],-s*p[0]+c*p[2]] as Point3D)}));
    const before=JSON.stringify(rotated),result=solidSurfaceMesh3D(rotated);
    expect(area(result)).toBeCloseTo(27.2,5);expect(result).toEqual(solidSurfaceMesh3D(rotated));
    result.surfaces[0].points[0]=[99,99,99];result.mesh.positions.fill(99);expect(JSON.stringify(rotated)).toBe(before);
});
test("empty solids render no triangles and GPU-collapsed geometry is refused",()=>{
    expect(solidSurfaceMesh3D([]).mesh.indices).toHaveLength(0);
    const tinyFarAway=box("tiny",.001,.001,.001,999999,0,0);
    expect(()=>solidSurfaceMesh3D(tinyFarAway)).toThrow("precision");
    expect(()=>solidSurfaceMesh3D(Array(257).fill(box("a")[0]))).toThrow("256");
});
