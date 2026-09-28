/** @module GameplayFoundations.test @description Named input edges, shared interactions, 3D template lifetime and checkpoint invariants. */
import { InputActions, PLAYER_ACTIONS } from "./InputActions";
import { createEmptyDocument, SCHEMA_VERSION } from "../document/Document";
import type { Node } from "../document/Node";
import { serializeDocument, deserializeDocument } from "../document/Serializer";
import { gameplayRulesError } from "../document/Gameplay";
import { world3DFrom, stepWorld3D, applyWorld3D, respawnRun3D } from "./World3D";
import { checkpoint3D, interact3D, applyRules3D } from "./Gameplay3D";
import { worldFrom } from "./World";
import { interactGameplay2D } from "./GameplaySession";
import { gameReference } from "../examples/ReferenceProjects";
import { interactionTarget } from "./Interaction";

import { gameplayFixture } from "../tests/fixtures/GameplayFixture";
test("interaction ignores hidden ancestors and breaks equal-distance ties by node ID", () => {
    const doc = gameplayFixture(), lever = doc.nodes.get("lever")!;
    doc.nodes.set("a-lever", { ...lever, id: "a-lever" }); doc.rootNodeUuids.push("a-lever");
    const position = (id: string) => doc.nodes.get(id)?.spatial3d?.transform.position;
    expect(interactionTarget(doc,"player",position,2)).toBe("a-lever");
    doc.nodes.set("hidden-group", { ...lever, id: "hidden-group", hidden: true, children: ["a-lever","lever"], entity: undefined });
    doc.nodes.set("a-lever", { ...doc.nodes.get("a-lever")!, parent: "hidden-group" });
    doc.nodes.set("lever", { ...lever, parent: "hidden-group" });
    expect(interactionTarget(doc,"player",position,2)).toBeNull();
});
test("input aliases and OS repeats produce one press; release waits for every alias", () => {
    const input = new InputActions(PLAYER_ACTIONS);
    input.setKey("KeyA",true); expect(input.pressed("left")).toBe(true);
    input.setKey("KeyA",true); input.setKey("ArrowLeft",true); expect(input.pressed("left")).toBe(false);
    input.setKey("KeyA",false); expect(input.held("left")).toBe(true); expect(input.released("left")).toBe(false);
    input.setKey("ArrowLeft",false); expect(input.released("left")).toBe(true); expect(input.released("left")).toBe(false);
});
test("rebind copies configuration, clears held edges and preserves valid bindings on failure", () => {
    const bindings={use:["KeyF"]},input=new InputActions(bindings); bindings.use[0]="KeyG";
    input.setKey("KeyF",true); expect(input.held("use")).toBe(true); input.clear();expect(input.pressed("use")).toBe(false);
    expect(()=>input.rebind({"bad name":["KeyG"]})).toThrow();expect(input.setKey("KeyF",true)).toBe(true);
    input.rebind({use:["KeyG"]});expect(input.held("use")).toBe(false);expect(input.setKey("KeyF",true)).toBe(false);
});
test("schema 78 migrates without injecting gameplay; new rules round-trip at the current version", () => {
    const doc=gameplayFixture(), raw=JSON.parse(serializeDocument(doc));raw.version="78";
    const loaded=deserializeDocument(JSON.stringify(raw));expect(loaded.version).toBe(SCHEMA_VERSION);expect(loaded.nodes.get("lever")!.entity).toEqual(doc.nodes.get("lever")!.entity);
    expect(gameplayRulesError([{event:"interact",other:"player",target:"self",range:0,action:{kind:"spawn",templateId:"x"}}])).toContain("range");
    expect(gameplayRulesError([{event:"interact",other:"any",target:"self",action:{kind:"spawn",templateId:""}}])).toContain("template");
});
test("3D interaction spawns a visible transient template, tallies and checkpoints without editing authoring", () => {
    const doc=gameplayFixture(),before=serializeDocument(doc), fresh=world3DFrom(doc), world=interact3D(doc,fresh,"player");
    expect(world.spawns).toHaveLength(1);expect(world.bodies.get("runtime-spawn-0")?.dynamic).toBe(true);
    expect(applyWorld3D(doc,world).nodes.get("runtime-spawn-0")?.hidden).toBe(false);
    expect(world.tallies?.get("uses")).toBe(1);expect(world.checkpoint?.playerId).toBe("player");
    expect(fresh.spawns).toBeUndefined();expect(serializeDocument(doc)).toBe(before);
});
test("interaction honors each rule range, nearest stable target, hidden and absent actors", () => {
    const doc=gameplayFixture(), lever=doc.nodes.get("lever")!;
    doc.nodes.set("lever",{...lever,entity:{rules:[{event:"interact",range:.1,other:"player",target:"self",action:{kind:"score",key:"too-far"}}]}});
    expect(interact3D(doc,world3DFrom(doc),"player").tallies).toBeUndefined();
    doc.nodes.set("lever",{...lever,hidden:true});expect(interact3D(doc,world3DFrom(doc),"player").spawns).toBeUndefined();
});
test("despawn removes runtime physics and presentation; checkpoint respawn revives the player", () => {
    const doc=gameplayFixture(),player=doc.nodes.get("player")!;
    doc.nodes.set("player",{...player,entity:{...player.entity,rules:[{event:"interact",other:"any",target:"self",action:{kind:"despawn"}}]}});
    let world=checkpoint3D(world3DFrom(doc),"player");world=applyRules3D(doc,world,[{self:"player",other:"lever",event:"interact"}]);
    expect(world.bodies.has("player")).toBe(false);expect(applyWorld3D(doc,world).nodes.get("player")?.hidden).toBe(true);
    const revived=respawnRun3D(doc,world,"player");expect(revived.bodies.has("player")).toBe(true);expect(revived.despawned?.has("player")).toBe(false);
});
test("start rules execute once and commands cannot despawn the active camera", () => {
    const doc=gameplayFixture(),camera=doc.nodes.get("camera")!;
    doc.nodes.set("camera",{...camera,entity:{rules:[{event:"start",other:"any",target:"self",action:{kind:"score",key:"starts"}},
        {event:"start",other:"any",target:"self",action:{kind:"despawn"}}]}});
    let world=stepWorld3D(doc,world3DFrom(doc));world=stepWorld3D(doc,world);
    expect(world.tallies?.get("starts")).toBe(1);expect(world.bodies.has("camera")).toBe(true);
});
test("spawn caps and authored ID conflicts refuse additional instances", () => {
    const doc=gameplayFixture();let world=world3DFrom(doc);
    for(let i=0;i<260;i++)world=interact3D(doc,world,"player");expect(world.spawns).toHaveLength(256);
    expect(world.diagnostics?.some(message=>message.includes("spawn limit"))).toBe(true);
    doc.nodes.set("runtime-spawn-0",{...doc.nodes.get("template")!,id:"runtime-spawn-0"});
    expect(interact3D(doc,world3DFrom(doc),"player").spawns).toBeUndefined();
});
test("2D uses the same interaction rules to spawn and set checkpoints", () => {
    const doc=gameReference(), player=doc.nodes.get("player")!;
    const lever:Node={...player,id:"lever",entity:{rules:[{event:"interact",range:1000,other:"player",target:"self",action:{kind:"spawn",templateId:"template"}},
        {event:"interact",range:1000,other:"player",target:"self",action:{kind:"checkpoint"}}]},geometry:{...player.geometry,x:player.geometry.x+30}};
    doc.nodes.set("lever",lever);doc.nodes.set("template",{...player,id:"template",hidden:true,entity:{body:"dynamic"}});doc.rootNodeUuids.push("lever","template");
    const world=interactGameplay2D(doc,worldFrom(doc),"player").world;
    expect(world.spawns).toHaveLength(1);expect(world.checkpoint?.playerId).toBe("player");
});
