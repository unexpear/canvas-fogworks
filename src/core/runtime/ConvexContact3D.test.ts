/** @module ConvexContact3D.test @description Convex contact containment, ramps, hollow rooms, sphere features and transformed OBB agreement. */
import {generateBlockout} from "../geometry/Blockout3D";
import {nodeMatrix} from "../import/Gltf";
import {convexContact3D,sphereConvexContact3D,transformedHull3D} from "./ConvexContact3D";
import {contact3D,CollisionShape3D} from "./Collision3D";
const identity=nodeMatrix({}),box=generateBlockout({kind:"box",width:2,height:2,depth:2}).parts[0];
const hull=(matrix=identity)=>transformedHull3D(box,matrix);
test("separation, touching and full containment use the true exit distance",()=>{
    const outer=hull(),inner=hull(nodeMatrix({translation:[0,.8,0],scale:[.2,.2,.2]}));
    expect(convexContact3D(inner,outer)?.depth).toBeCloseTo(1.2);
    expect(convexContact3D(hull(nodeMatrix({translation:[2,0,0]})),outer)).toBeNull();
    expect(convexContact3D(hull(nodeMatrix({translation:[3,0,0]})),outer)).toBeNull();
    const contact=convexContact3D(hull(nodeMatrix({translation:[1.5,0,0]})),outer)!;
    expect(contact.depth).toBeCloseTo(.5);contact.normal.forEach((n,i)=>expect(n).toBeCloseTo(i===0?1:0));
});
test("affine shear and tiny valid scale produce usable hulls; collapsed or projective transforms are refused",()=>{
    const shear=[...identity];shear[4]=.7;
    const shape=hull(shear);
    expect(sphereConvexContact3D({center:[.7,1,0],radius:.2},shape)).not.toBeNull();
    expect(sphereConvexContact3D({center:[-1,1.9,0],radius:.1},shape)).toBeNull();
    expect(()=>hull(nodeMatrix({scale:[1e-8,1e-8,1e-8]}))).not.toThrow();
    expect(()=>hull(nodeMatrix({scale:[0,1,1]}))).toThrow("Collapsed");
    expect(()=>hull([1,0,1,0,0,1,1,0,1,1,2,0,0,0,0,1])).toThrow("Collapsed");
    expect(()=>hull(nodeMatrix({scale:[1,Number.MAX_VALUE,1]}))).toThrow("overflow");
    const projective=[...identity];projective[3]=.2;expect(()=>hull(projective)).toThrow("affine");
});
test("sphere contacts agree with the established box solver around rotated faces, edges and corners",()=>{
    const centered={...box,vertices:box.vertices.map(v=>[v[0],v[1]-1,v[2]] as const)};
    const q={x:Math.sin(.2),y:0,z:0,w:Math.cos(.2)};
    const b:CollisionShape3D={transform:{position:{x:0,y:0,z:0},rotation:q,scale:{x:1.4,y:.8,z:1.1}},collider:{kind:"box",halfExtents:{x:1,y:1,z:1}}};
    const shape=transformedHull3D(centered,nodeMatrix({rotation:[q.x,q.y,q.z,q.w],scale:[1.4,.8,1.1]}));
    for(let i=0;i<150;i++){
        const center:[number,number,number]=[Math.sin(i*.73)*2,Math.cos(i*.21)*1.6,Math.sin(i*.31)*1.7];
        const a:CollisionShape3D={transform:{position:{x:center[0],y:center[1],z:center[2]},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}},collider:{kind:"sphere",radius:.35}};
        const expected=contact3D(a,b),actual=sphereConvexContact3D({center,radius:.35},shape);
        expect(!!actual).toBe(!!expected);if(actual&&expected)expect(actual.depth).toBeCloseTo(expected.depth,8);
    }
});
test("a ramp has a sloped contact and no phantom solid volume above the slope",()=>{
    const ramp=transformedHull3D(generateBlockout({kind:"ramp",width:4,height:2,depth:4}).parts[0],identity);
    expect(sphereConvexContact3D({center:[0,1.8,0],radius:.2},ramp)).toBeNull();
    const contact=sphereConvexContact3D({center:[0,1.1,0],radius:.2},ramp)!;
    expect(contact.normal[1]).toBeCloseTo(2/Math.sqrt(5));expect(contact.normal[2]).toBeCloseTo(-1/Math.sqrt(5));
    const center:[number,number,number]=[0,1.1,0];for(let i=0;i<3;i++)center[i]+=contact.normal[i]*(contact.depth+1e-7);
    expect(sphereConvexContact3D({center,radius:.2},ramp)).toBeNull();
});
test("room interiors remain empty while floors, walls and ceilings collide independently",()=>{
    const room=generateBlockout({kind:"room",width:4,height:3,depth:6,thickness:.2,ceiling:true});
    const hits=(center:[number,number,number])=>room.parts.filter(part=>sphereConvexContact3D({center,radius:.2},transformedHull3D(part,identity))).map(part=>part.id);
    expect(hits([0,1,0])).toEqual([]);expect(hits([0,.1,0])).toEqual(["floor"]);
    expect(hits([1.9,1,0])).toEqual(["right"]);expect(hits([0,2.9,0])).toEqual(["ceiling"]);
});
test("sphere edge/corner features reject face-plane false positives and containment exits correctly",()=>{
    const shape=hull();expect(sphereConvexContact3D({center:[1.4,1,1.4],radius:.5},shape)).toBeNull();
    const hit=sphereConvexContact3D({center:[1.3,1,1.3],radius:.5},shape)!;
    expect(hit.depth).toBeCloseTo(.5-Math.hypot(.3,.3));expect(hit.normal[0]).toBeCloseTo(Math.SQRT1_2);
    expect(sphereConvexContact3D({center:[0,1,0],radius:.2},shape)!.depth).toBeCloseTo(1.2);
});
test("rotated nonuniform reflected boxes agree with the established OBB solver",()=>{
    for(let i=0;i<32;i++){
        const angle=i*.137;
        const a:CollisionShape3D={transform:{position:{x:Math.sin(i)*2.2,y:Math.cos(i)*1.3,z:.7},rotation:{x:0,y:Math.sin(angle/2),z:0,w:Math.cos(angle/2)},scale:{x:-1.3,y:.6,z:1.1}},collider:{kind:"box",halfExtents:{x:1,y:1,z:1}}};
        const b:CollisionShape3D={transform:{position:{x:0,y:0,z:0},rotation:{x:Math.sin(.3),y:0,z:0,w:Math.cos(.3)},scale:{x:1,y:1,z:1}},collider:{kind:"box",halfExtents:{x:1,y:1,z:1}}};
        const convert=(body:CollisionShape3D)=>{const {position:p,rotation:q,scale:s}=body.transform;
            // Generator box sits on y=0; center it before applying the body's TRS.
            const centered={...box,vertices:box.vertices.map(v=>[v[0],v[1]-1,v[2]] as const)};
            return transformedHull3D(centered,nodeMatrix({translation:[p.x,p.y,p.z],rotation:[q.x,q.y,q.z,q.w],scale:[s.x,s.y,s.z]}));};
        const expected=contact3D(a,b),actual=convexContact3D(convert(a),convert(b));
        expect(!!actual).toBe(!!expected);if(actual&&expected)expect(actual.depth).toBeCloseTo(expected.depth,8);
    }
});
