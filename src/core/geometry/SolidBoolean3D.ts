/** @module SolidBoolean3D @description Bounded convex-cell set operations for generated blockout solids; immutable inputs and retained face provenance. */
import {BlockoutPart,Point3D} from "./Blockout3D";
export interface SolidCell3D extends BlockoutPart {surfaceIds:string[]}
export type SolidOperation3D="add"|"subtract"|"intersect";
/** Operations are in one local authoring coordinate space. Features below this tolerance are
 * not supported; touching-only intersections are empty (regularized solid semantics). */
export const SOLID_EPSILON_3D=1e-8;
export const SOLID_CELL_LIMIT_3D=256;
const EPS=SOLID_EPSILON_3D;
type Plane={normal:Point3D;origin:Point3D;surface:string};
const sub=(a:Point3D,b:Point3D):Point3D=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a:Point3D,b:Point3D)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:Point3D,b:Point3D):Point3D=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const near=(a:Point3D,b:Point3D)=>Math.hypot(...sub(a,b))<=EPS;
const distance=(p:Point3D,plane:Plane)=>dot(sub(p,plane.origin),plane.normal);
class Budget {
    private work=0;
    spend(count:number){if((this.work+=count)>1_000_000)throw Error("Solid evaluation exceeds its work budget.");}
    cells(cells:readonly SolidCell3D[]){if(cells.length>SOLID_CELL_LIMIT_3D)throw Error("Solid evaluation exceeds 256 convex cells.");}
}
function normal(points:readonly Point3D[]):Point3D{
    let best:Point3D=[0,0,0],size=0;
    for(let i=1;i<points.length-1;i++){
        const n=cross(sub(points[i],points[0]),sub(points[i+1],points[0])),length=Math.hypot(...n);
        if(length>size){size=length;best=n;}
    }
    if(!size)throw Error("Degenerate solid face.");return best.map(v=>v/size) as unknown as Point3D;
}
function planes(cell:SolidCell3D):Plane[]{
    return cell.faces.map((face,i)=>{const points=face.map(index=>cell.vertices[index]);return {normal:normal(points),origin:points[0],surface:cell.surfaceIds[i]};});
}
/** Face labels belong to authored operands, not transient fragment numbers. */
export function solidCells3D(parts:readonly BlockoutPart[],operand:string):SolidCell3D[]{
    return parts.map(part=>({...part,vertices:part.vertices.map(p=>[...p] as Point3D),faces:part.faces.map(f=>[...f]),
        surfaceIds:part.faces.map((_,i)=>`${operand}/${part.id}/${i}`)}));
}
function validate(cell:SolidCell3D,budget:Budget){
    if(!cell||!Array.isArray(cell.vertices)||cell.vertices.length<4||cell.vertices.length>512||
        !Array.isArray(cell.faces)||cell.faces.length<4||cell.faces.length>512||!Array.isArray(cell.surfaceIds)||cell.surfaceIds.length!==cell.faces.length)throw Error("Invalid or oversized convex solid cell.");
    if(cell.vertices.some(p=>!Array.isArray(p)||p.length!==3||p.some(v=>!Number.isFinite(v)||Math.abs(v)>1e6)))throw Error("Solid coordinates must be finite and within local authoring bounds.");
    const edges=new Map<string,number>();
    for(const face of cell.faces){
        if(!Array.isArray(face)||face.length<3||face.length>512||new Set(face).size!==face.length||face.some(i=>!Number.isInteger(i)||i<0||i>=cell.vertices.length))throw Error("Invalid solid face indices.");
        for(let i=0;i<face.length;i++){const a=face[i],b=face[(i+1)%face.length];edges.set(`${a}/${b}`,(edges.get(`${a}/${b}`)??0)+1);}
    }
    for(const [edge,count] of edges){const [a,b]=edge.split("/");if(count!==1||edges.get(`${b}/${a}`)!==1)throw Error("Solid cell must be closed and consistently wound.");}
    const ps=planes(cell);
    ps.forEach((plane,i)=>{
        budget.spend(cell.vertices.length+cell.faces[i].length);
        if(cell.faces[i].some(index=>Math.abs(distance(cell.vertices[index],plane))>EPS)||cell.vertices.some(p=>distance(p,plane)>EPS))throw Error("Solid cell must have planar outward faces and be convex.");
        if(!cell.vertices.some(p=>distance(p,plane)<-EPS))throw Error("Solid cell is below supported thickness.");
        if(typeof plane.surface!=="string"||!plane.surface||plane.surface.length>4096)throw Error("Invalid solid surface identity.");
    });
}
function copy(cell:SolidCell3D):SolidCell3D{return {...cell,vertices:cell.vertices.map(p=>[...p] as Point3D),faces:cell.faces.map(f=>[...f]),surfaceIds:[...cell.surfaceIds]};}
function clean(points:Point3D[]):Point3D[]{
    let result=points.filter((p,i)=>!near(p,points[(i+points.length-1)%points.length]));
    let changed=true;
    while(changed&&result.length>=3){changed=false;for(let i=0;i<result.length;i++){
        const a=result[(i+result.length-1)%result.length],b=result[i],c=result[(i+1)%result.length];
        const ac=sub(c,a),ab=sub(b,a);
        if(Math.hypot(...cross(ac,ab))<=EPS*Math.hypot(...ac)&&dot(ab,sub(b,c))<=0){result.splice(i,1);changed=true;break;}
    }}return result;
}
/** Keep the closed negative halfspace; a cap restores the cut boundary. */
function clip(cell:SolidCell3D,plane:Plane,budget:Budget):SolidCell3D|null{
    budget.spend(cell.vertices.length);
    const ds=cell.vertices.map(p=>distance(p,plane));
    if(!ds.some(d=>d<-EPS))return null;
    if(!ds.some(d=>d>EPS))return cell;
    const polygons:Point3D[][]=[],surfaces:string[]=[],rim:Point3D[]=[];
    for(let f=0;f<cell.faces.length;f++){
        const face=cell.faces[f],polygon:Point3D[]=[];budget.spend(face.length);
        for(let j=0;j<face.length;j++){
            const ia=face[j],ib=face[(j+1)%face.length],a=cell.vertices[ia],b=cell.vertices[ib];
            const da=Math.abs(ds[ia])<=EPS?0:ds[ia],db=Math.abs(ds[ib])<=EPS?0:ds[ib];
            if(da<=0)polygon.push(a);
            if((da<0&&db>0)||(da>0&&db<0)){
                const t=da/(da-db);polygon.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]);
            }
        }
        const cleaned=clean(polygon);if(cleaned.length<3)continue;
        polygons.push(cleaned);surfaces.push(cell.surfaceIds[f]);
        for(const p of cleaned)if(Math.abs(distance(p,plane))<=EPS&&!rim.some(q=>near(p,q)))rim.push(p);
    }
    if(rim.length<3)throw Error("Solid cut could not form a closed cap.");
    const center=([0,1,2].map(axis=>rim.reduce((sum,p)=>sum+p[axis],0)/rim.length)) as unknown as Point3D;
    const basis=sub(rim[0],center),size=Math.hypot(...basis),u=basis.map(v=>v/size) as unknown as Point3D,v=cross(plane.normal,u);
    rim.sort((a,b)=>Math.atan2(dot(sub(a,center),v),dot(sub(a,center),u))-Math.atan2(dot(sub(b,center),v),dot(sub(b,center),u)));
    polygons.push(clean(rim));surfaces.push(plane.surface);
    const vertices:Point3D[]=[],faces=polygons.map(polygon=>polygon.map(p=>{
        let index=vertices.findIndex(q=>near(p,q));if(index<0){index=vertices.length;vertices.push([...p] as Point3D);}return index;
    }));
    const result={id:cell.id,vertices,faces,surfaceIds:surfaces};validate(result,budget);return result;
}
function difference(a:SolidCell3D,b:SolidCell3D,budget:Budget):SolidCell3D[]{
    let inside:SolidCell3D|null=a;const outside:SolidCell3D[]=[];
    for(const plane of planes(b)){
        if(!inside)break;
        const piece=clip(inside,{...plane,normal:plane.normal.map(n=>-n) as unknown as Point3D},budget);
        if(piece)outside.push(piece);
        inside=clip(inside,plane,budget);budget.cells(outside);
    }
    return outside;
}
function subtract(cells:SolidCell3D[],cutters:readonly SolidCell3D[],budget:Budget):SolidCell3D[]{
    for(const cutter of cutters){const next:SolidCell3D[]=[];for(const cell of cells){next.push(...difference(cell,cutter,budget));budget.cells(next);}cells=next;}
    return cells;
}
function union(cells:readonly SolidCell3D[],budget:Budget):SolidCell3D[]{
    const result:SolidCell3D[]=[];
    for(const cell of cells){result.push(...subtract([cell],result,budget));budget.cells(result);}return result;
}
/** Returns non-overlapping convex volumes. Shared internal faces are retained in this collision
 * representation; exterior-surface extraction is a separate rendering step, not a manifold claim.
 * Refuses excessive work/fragmentation without mutating or partially adopting either operand. */
export function solidBoolean3D(operation:SolidOperation3D,left:readonly SolidCell3D[],right:readonly SolidCell3D[]):SolidCell3D[]{
    if(!["add","subtract","intersect"].includes(operation))throw Error("Unknown solid operation.");
    const budget=new Budget();budget.cells(left);budget.cells(right);
    for(const cell of [...left,...right])validate(cell,budget);
    const a=union(left,budget),b=union(right,budget);let result:SolidCell3D[];
    if(operation==="add")result=union([...a,...b],budget);
    else if(operation==="subtract")result=subtract(a,b,budget);
    else {
        result=[];for(const cell of a)for(const cutter of b){
            let inside:SolidCell3D|null=cell;
            for(const plane of planes(cutter)){if(!inside)break;inside=clip(inside,plane,budget);}
            if(inside)result.push(inside);budget.cells(result);
        }
    }
    return result.map((cell,i)=>({...copy(cell),id:`cell-${i}`}));
}
