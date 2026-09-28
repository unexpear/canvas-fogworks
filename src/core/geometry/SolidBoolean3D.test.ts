/** @module SolidBoolean3D.test @description Boolean volume identities, cutout collision, convex closure, face provenance and bounded immutable failure. */
import {generateBlockout,Point3D} from "./Blockout3D";
import {SolidCell3D,solidCells3D,solidBoolean3D} from "./SolidBoolean3D";
import {transformedHull3D} from "../runtime/ConvexContact3D";
import {contact3D} from "../runtime/Collision3D";
import {IDENTITY_TRANSFORM_3D} from "../document/Spatial3D";
const cross=(a:Point3D,b:Point3D):Point3D=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:Point3D,b:Point3D)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const sub=(a:Point3D,b:Point3D):Point3D=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const box=(id:string,w=2,h=2,d=2,x=0,y=0,z=0)=>solidCells3D(generateBlockout({kind:"box",width:w,height:h,depth:d}).parts,id)
    .map(p=>({...p,vertices:p.vertices.map(v=>[v[0]+x,v[1]+y,v[2]+z] as Point3D)}));
function volume(cells:readonly SolidCell3D[]){
    let sum=0;for(const cell of cells)for(const face of cell.faces)for(let i=1;i<face.length-1;i++)sum+=dot(cell.vertices[face[0]],cross(cell.vertices[face[i]],cell.vertices[face[i+1]]))/6;
    return sum;
}
function closed(cells:readonly SolidCell3D[]){
    for(const cell of cells){
        const edges=new Map<string,number>();
        for(const face of cell.faces){
            const a=cell.vertices[face[0]],b=cell.vertices[face[1]],c=cell.vertices[face[2]],n=cross(sub(b,a),sub(c,a));
            expect(Math.hypot(...n)).toBeGreaterThan(0);
            for(const p of cell.vertices)expect(dot(n,sub(p,a))).toBeLessThanOrEqual(1e-7);
            for(let i=0;i<face.length;i++){const key=`${face[i]}/${face[(i+1)%face.length]}`;edges.set(key,(edges.get(key)??0)+1);}
        }
        for(const [key,count] of edges){expect(count).toBe(1);expect(edges.get(key.split("/").reverse().join("/"))).toBe(1);}
        expect(volume([cell])).toBeGreaterThan(0);expect(cell.surfaceIds).toHaveLength(cell.faces.length);
    }
}
test("overlapping cubes obey union/intersection/difference volumes and remain closed convex cells",()=>{
    const a=box("left"),b=box("right",2,2,2,1);
    for(const [op,expected] of [["add",12],["intersect",4],["subtract",4]] as const){
        const result=solidBoolean3D(op,a,b);expect(volume(result)).toBeCloseTo(expected);closed(result);
    }
});
test("disjoint, touching, identical, contained and empty operands have regularized semantics",()=>{
    const a=box("a"),inside=box("inside",1,1,1,0,.5);
    expect(volume(solidBoolean3D("subtract",a,inside))).toBeCloseTo(7);
    expect(volume(solidBoolean3D("add",a,inside))).toBeCloseTo(8);
    expect(solidBoolean3D("subtract",a,a)).toEqual([]);
    expect(volume(solidBoolean3D("add",a,a))).toBeCloseTo(8);
    for(const x of [2,3]){
        const b=box("b",2,2,2,x);
        expect(solidBoolean3D("intersect",a,b)).toEqual([]);
        expect(volume(solidBoolean3D("subtract",a,b))).toBeCloseTo(8);
        expect(volume(solidBoolean3D("add",a,b))).toBeCloseTo(16);
    }
    expect(solidBoolean3D("intersect",a,[])).toEqual([]);
    expect(volume(solidBoolean3D("subtract",a,[]))).toBeCloseTo(8);
    expect(volume(solidBoolean3D("add",[],a))).toBeCloseTo(8);
});
test("a subtracted doorway has no collision inside its opening while jambs and header remain solid",()=>{
    const wall=box("wall",4,3,.4),door=box("door",1,2,1),result=solidBoolean3D("subtract",wall,door);
    expect(volume(result)).toBeCloseTo(4);closed(result);
    const shape={transform:IDENTITY_TRANSFORM_3D,collider:null,convexParts:result.map(p=>transformedHull3D(p,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]))};
    const hit=(x:number,y:number,z:number)=>contact3D({transform:{...IDENTITY_TRANSFORM_3D,position:{x,y,z}},collider:{kind:"sphere",radius:.1}},shape);
    for(const z of [-.5,-.2,0,.2,.5])expect(hit(0,1,z)).toBeNull();
    expect(hit(.55,1,0)).not.toBeNull();expect(hit(0,2.05,0)).not.toBeNull();
    expect(result.flatMap(c=>c.surfaceIds).some(id=>id.startsWith("door/"))).toBe(true);
    expect(result.flatMap(c=>c.surfaceIds).some(id=>id.startsWith("wall/"))).toBe(true);
});
test("rotated cuts satisfy independent point membership and volume conservation",()=>{
    const a=box("base",4,3,4),angle=.37,c=Math.cos(angle),s=Math.sin(angle);
    const b=box("cut",1.5,4,6,0,-.5).map(p=>({...p,vertices:p.vertices.map(v=>[c*v[0]+s*v[2],v[1],-s*v[0]+c*v[2]] as Point3D)}));
    const difference=solidBoolean3D("subtract",a,b),intersection=solidBoolean3D("intersect",a,b);
    expect(volume(difference)+volume(intersection)).toBeCloseTo(48);closed(difference);closed(intersection);
    const contains=(cells:SolidCell3D[],p:Point3D)=>cells.some(cell=>cell.faces.every(f=>{
        const [a,b,c]=f.slice(0,3).map(i=>cell.vertices[i]);return dot(cross(sub(b,a),sub(c,a)),sub(p,a))<=1e-8;
    }));
    for(let i=0;i<100;i++){
        const p:Point3D=[Math.sin(i*2.31)*1.99,.1+(i%11)*.25,Math.cos(i*1.73)*1.99];
        const cutX=c*p[0]-s*p[2],cutZ=s*p[0]+c*p[2],inCut=Math.abs(cutX)<.75&&Math.abs(cutZ)<3;
        expect(contains(difference,p)).toBe(!inCut);expect(contains(intersection,p)).toBe(inCut);
    }
});
test("overlapping input cells are normalized, outputs deterministic and source data isolated",()=>{
    const a=[...box("a"),...box("b",2,2,2,1)],b=box("c",1,1,4,0,.5),before=JSON.stringify([a,b]);
    const first=solidBoolean3D("subtract",a,b),second=solidBoolean3D("subtract",a,b);
    expect(first).toEqual(second);expect(volume(solidBoolean3D("add",a,[]))).toBeCloseTo(12);
    first[0].vertices[0]=[99,99,99];first[0].faces[0].reverse();expect(JSON.stringify([a,b])).toBe(before);
});
test("malformed, open, concave and excessive operands fail without modifying input",()=>{
    const a=box("a"),before=JSON.stringify(a),open=box("open");open[0].faces.pop();open[0].surfaceIds.pop();
    expect(()=>solidBoolean3D("add",open,a)).toThrow("closed");
    const invalid=box("invalid");invalid[0].vertices[0]=[NaN,0,0];expect(()=>solidBoolean3D("add",invalid,a)).toThrow("finite");
    const bent=box("bent");bent[0].vertices[0]=[0,1,0];expect(()=>solidBoolean3D("subtract",a,bent)).toThrow();
    expect(()=>solidBoolean3D("add",Array(257).fill(a[0]),[])).toThrow("256");
    expect(JSON.stringify(a)).toBe(before);
});
test("a window retains all four surrounding wall surfaces and closed cut caps",()=>{
    const wall=box("wall",4,3,.4),window=box("window",1,1,1,0,1);
    const result=solidBoolean3D("subtract",wall,window);closed(result);expect(volume(result)).toBeCloseTo(4.4);
    const surfaces=new Set(result.flatMap(cell=>cell.surfaceIds));
    expect([...surfaces].filter(id=>id.startsWith("window/"))).toHaveLength(4);
});
test("fragmenting cuts stop at a bounded evaluation failure without adopting partial output",()=>{
    const a=box("base",20,20,20),cutters:SolidCell3D[]=[];
    for(let i=0;i<8;i++){
        const position=-8+i*2;
        cutters.push(...box(`x${i}`,.2,22,22,position,-1),...box(`y${i}`,22,.2,22,0,position+10),...box(`z${i}`,22,22,.2,0,-1,position));
    }
    const before=JSON.stringify([a,cutters]);
    expect(()=>solidBoolean3D("subtract",a,cutters)).toThrow(/work budget|256 convex cells/);
    expect(JSON.stringify([a,cutters])).toBe(before);
});
