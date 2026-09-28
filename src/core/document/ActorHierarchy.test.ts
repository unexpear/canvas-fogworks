/** @module ActorHierarchy.test @description Actor-owned traversal, isolated hierarchy copies and explicit reference-namespace remapping. */
import {actorHierarchyIds,copyActorHierarchy,remapActorAction,ACTOR_NODE_LIMIT} from "./ActorHierarchy";
import {gameReference} from "../examples/ReferenceProjects";
import {Node} from "./Node";
function fixture(){
    const doc=gameReference(),node=doc.nodes.get("goal")!;
    doc.nodes.set("actor",{...node,id:"actor",parent:null,children:["child"],entity:{respawnAt:"child",warpsTo:"child",transitionTo:"child",rules:[{event:"start",other:"any",target:"self",action:{kind:"spawn",templateId:"child"}}],behavior:{version:1,enabled:true,nodes:[
        {id:"child",kind:"event",event:"start",other:"any",next:"spawn"},
        {id:"spawn",kind:"action",target:"self",action:{kind:"spawn",templateId:"child"},next:null}]}},
        animation:{initial:"idle",driver:"child",states:[{name:"idle",clip:"child"}],transitions:[]},
        interactions:[{trigger:"click",target:"child",state:null}],
        userData:{"vde.warpsTo":{type:"string",value:"child"},"description":{type:"string",value:"child"}},
        overrides:{"child":{style:{opacity:.5}},"child::outside":{style:{opacity:.7}}}});
    doc.nodes.set("child",{...node,id:"child",parent:"actor",children:[],componentId:"actor",entity:{behaviorAssetId:"child"},style:{...node.style,shadow:{dx:1,dy:2,blur:3,color:"#000"}}});
    doc.rootNodeUuids.push("actor");return doc;
}
test("copies owned children and remaps known references, not IDs from unrelated namespaces",()=>{
    const doc=fixture(),before=JSON.stringify([...doc.nodes]),ids=new Map([["actor","copy"],["child","copyChild"]]);
    expect(actorHierarchyIds(doc,"actor")).toEqual(["actor","child"]);
    const [root,child]=copyActorHierarchy(doc,"actor",ids);
    expect(root.id).toBe("copy");expect(root.parent).toBeNull();expect(root.children).toEqual(["copyChild"]);expect(child.parent).toBe("copy");
    expect(root.entity).toMatchObject({respawnAt:"copyChild",warpsTo:"copyChild",transitionTo:"child"});
    expect(root.entity!.rules![0].action).toEqual({kind:"spawn",templateId:"copyChild"});
    expect(root.entity!.behavior!.nodes[0].id).toBe("child");expect(root.entity!.behavior!.nodes[1]).toMatchObject({action:{templateId:"copyChild"}});
    expect(root.animation).toMatchObject({driver:"copyChild",states:[{clip:"child"}]});expect(root.interactions![0].target).toBe("copyChild");
    expect(child.componentId).toBe("copy");expect(child.entity!.behaviorAssetId).toBe("child");
    expect(Object.keys(root.overrides!)).toEqual(["copyChild","copyChild::outside"]);
    expect(root.userData!["vde.warpsTo"].value).toBe("copyChild");expect(root.userData!.description.value).toBe("child");
    root.entity!.behavior!.nodes=[];child.style.shadow!.blur=90;root.overrides!.copyChild.style!.opacity=.1;
    expect(JSON.stringify([...doc.nodes])).toBe(before);
});
test("external project references and placement coordinates remain deliberate",()=>{
    const doc=fixture(),root=doc.nodes.get("actor")!;doc.nodes.set("actor",{...root,componentId:"outside",animation:{...root.animation!,driver:"outside"},entity:{respawnAt:"outside"}});
    const [copy]=copyActorHierarchy(doc,"actor",new Map([["actor","copy"],["child","copyChild"]]),"player");
    expect(copy.parent).toBe("player");expect(copy.componentId).toBe("outside");expect(copy.animation!.driver).toBe("outside");expect(copy.entity!.respawnAt).toBe("outside");expect(copy.geometry).toEqual(root.geometry);
    expect(remapActorAction({kind:"score",key:"child"},new Map([["child","copyChild"]]))).toEqual({kind:"score",key:"child"});
});
test("missing children, duplicate ownership, malformed parent links and mapping collisions are refused",()=>{
    for(const mutate of [
        (doc:ReturnType<typeof fixture>)=>doc.nodes.delete("child"),
        (doc:ReturnType<typeof fixture>)=>{doc.nodes.get("actor")!.children=["child","child"];},
        (doc:ReturnType<typeof fixture>)=>{doc.nodes.get("child")!.children=["actor"];},
        (doc:ReturnType<typeof fixture>)=>{doc.nodes.get("child")!.parent="outside";}
    ]){const doc=fixture();mutate(doc);expect(()=>actorHierarchyIds(doc,"actor")).toThrow();}
    for(const ids of [new Map([["actor","copy"]]),new Map([["actor","copy"],["child","copy"]]),new Map([["actor","player"],["child","copyChild"]]),new Map([["actor","copy"],["child","bad::id"]])])expect(()=>copyActorHierarchy(fixture(),"actor",ids)).toThrow();
    const doc=fixture();doc.nodes.get("actor")!.overrides!.copyChild={style:{opacity:.2}};
    expect(()=>copyActorHierarchy(doc,"actor",new Map([["actor","copy"],["child","copyChild"]]))).toThrow("collide");
});
test("the actor node budget bounds deep hierarchies without recursive host calls",()=>{
    const doc=gameReference(),source=doc.nodes.get("goal")!,nodes=new Map<string,Node>();
    for(let i=0;i<ACTOR_NODE_LIMIT;i++)nodes.set("n"+i,{...source,id:"n"+i,parent:i?"n"+(i-1):null,children:i<ACTOR_NODE_LIMIT-1?["n"+(i+1)]:[]});
    expect(actorHierarchyIds({nodes},"n0")).toHaveLength(ACTOR_NODE_LIMIT);
    nodes.get("n"+(ACTOR_NODE_LIMIT-1))!.children=["overflow"];nodes.set("overflow",{...source,id:"overflow",parent:"n"+(ACTOR_NODE_LIMIT-1),children:[]});
    expect(()=>actorHierarchyIds({nodes},"n0")).toThrow("256");
});
