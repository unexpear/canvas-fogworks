/** @module GameplayFixture @description Original minimal player, interaction target and template for gameplay/save regression tests. */
import { createEmptyDocument } from "../../document/Document";
import type { Node } from "../../document/Node";
export function gameplayFixture() {
    const doc = createEmptyDocument();
    const node = (id: string, x: number): Node => ({ id,type:"core.rectangle",parent:null,children:[],geometry:{x:0,y:0,width:10,height:10},style:{fill:"#fff",opacity:1},layout:{},
        spatial3d:{transform:{position:{x,y:0,z:0},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}}} });
    const player = node("player",0); player.entity={player:true,body:"dynamic"}; player.spatial3d!.collider={kind:"box",halfExtents:{x:.5,y:.5,z:.5}};
    const camera=node("camera",0); camera.spatial3d!.camera={kind:"perspective",near:.1,far:100,verticalFovDegrees:60}; camera.spatial3d!.transform.position.z=5;
    const lever=node("lever",1); lever.entity={rules:[{event:"interact",other:"player",target:"self",action:{kind:"spawn",templateId:"template"}},
        {event:"interact",other:"player",target:"self",action:{kind:"score",key:"uses"}}, {event:"interact",other:"player",target:"self",action:{kind:"checkpoint"}}]};
    const template=node("template",100); template.hidden=true; template.entity={body:"dynamic"};
    for(const item of [player,camera,lever,template])doc.nodes.set(item.id,item);
    doc.rootNodeUuids=[...doc.nodes.keys()];return doc;
}
