import { createEmptyDocument, SCHEMA_VERSION } from "../document/Document";
import { Node } from "../document/Node";
import { AnimationController, animationControllerError } from "../document/AnimationController";
import { deserializeDocument, serializeDocument } from "../document/Serializer";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { SetAnimationControllerAction } from "../actions/SetAnimationControllerAction";
import { applyAnimations, sampleClip, stepAnimations } from "./AnimationPlayback";
import { animateWorld2D } from "./AnimationWorld";
import { applyCommands, stepWorld, worldFrom } from "./World";
import { restartRun, respawnRun } from "./RunFlow";
import { advanceWorld3D, restartRun3D, respawnRun3D } from "./World3D";
import { applyFrame } from "../document/Timeline";
import { buildFrame3D } from "../../renderer/Scene3D";

const controller = (): AnimationController => ({ initial: "idle", states: [{ name: "idle", clip: "idle" }, { name: "walk", clip: "walk" }],
    transitions: [{ from: "idle", to: "walk", when: "moving" }, { from: "walk", to: "idle", when: "idle" }] });
function fixture() {
    const doc = createEmptyDocument(); doc.timeline = { fps: 12, frames: 24 };
    doc.clips = [{ name: "idle", from: 0, to: 11 }, { name: "walk", from: 12, to: 23 }];
    const node: Node = { id: "hero", type: "core.rectangle", parent: null, children: [],
        geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#ff0000", opacity: 1 }, layout: {},
        entity: { body: "dynamic", player: true }, animation: controller(),
        track: [{ frame: 0, hold: true, values: { style: { fill: "#ff0000" } } },
            { frame: 12, hold: true, values: { style: { fill: "#00ff00" } } }] };
    doc.nodes.set(node.id, node); doc.rootNodeUuids = [node.id]; return { doc, node };
}

describe("named clip clocks and state transitions", () => {
    test("inclusive ranges wrap, one-shots retain every frame, and invalid clocks start safely", () => {
        const clip = { name: "shot", from: 10, to: 12, loop: false };
        expect(sampleClip(clip, 2 / 12, 12)).toEqual({ frame: 12, finished: false });
        expect(sampleClip(clip, 3 / 12, 12)).toEqual({ frame: 12, finished: true });
        expect(sampleClip({ ...clip, loop: true }, 3 / 12, 12)).toEqual({ frame: 10, finished: false });
        expect(sampleClip(clip, NaN, 12).frame).toBe(10);
        expect(sampleClip(clip, -1, 12).frame).toBe(10);
        expect(sampleClip({ ...clip, to: 10 }, 1 / 12, 12).finished).toBe(true);
    });
    test("each entity starts its clip on entry, independent of the document clock", () => {
        const { doc, node } = fixture(); doc.nodes.set("other", { ...node, id: "other", animation: controller() });
        let players = stepAnimations(doc, undefined, 50);
        players = stepAnimations(doc, players, 51, id => new Set(id === "hero" ? ["moving"] : []));
        expect(players?.get("hero")?.frame).toBe(12);
        expect(players?.get("hero")?.enteredAt).toBe(51);
        players = stepAnimations(doc, players, 51.25, () => new Set(["moving"]));
        expect(players?.get("hero")?.frame).toBe(15);
        expect(players?.get("other")?.frame).toBe(12);
        expect(node.frame).toBeUndefined();
    });
    test("first matching transition wins and self-transitions restart only once per step", () => {
        const { doc, node } = fixture();
        node.animation!.transitions.unshift({ from: "idle", to: "idle", when: "moving" });
        const start = stepAnimations(doc, undefined, 0);
        const next = stepAnimations(doc, start, 0.5, () => new Set(["moving"]));
        expect(next?.get("hero")).toMatchObject({ state: "idle", enteredAt: 0.5, frame: 0 });
    });
    test("finished transitions wait for the complete one-shot duration and honor speed", () => {
        const { doc, node } = fixture(); doc.clips![0].loop = false;
        node.animation!.states[0].speed = 2;
        node.animation!.transitions = [{ from: "idle", to: "walk", when: "finished" }];
        let players = stepAnimations(doc, undefined, 0);
        players = stepAnimations(doc, players, 11 / 24);
        expect(players?.get("hero")?.state).toBe("idle");
        players = stepAnimations(doc, players, 0.5);
        expect(players?.get("hero")).toMatchObject({ state: "walk", frame: 12, enteredAt: 0.5 });
    });
    test("missing clips are inert, and a controller edit resets its clock", () => {
        const { doc, node } = fixture(); let players = stepAnimations(doc, undefined, 0);
        node.animation!.states[0].speed = 2;
        players = stepAnimations(doc, players, 0.5);
        expect(players?.get("hero")?.frame).toBe(0);
        doc.clips = []; expect(stepAnimations(doc, players, 1)).toBeUndefined();
        delete doc.timeline; expect(stepAnimations(doc, players, 2)).toBeUndefined();
    });
    test("parent playback reaches children while a child controller owns its scope", () => {
        const { doc, node } = fixture(); node.children = ["child", "owned"];
        doc.nodes.set("child", { ...node, id: "child", parent: node.id, children: [], animation: undefined });
        doc.nodes.set("owned", { ...node, id: "owned", parent: node.id, children: [], animation: controller() });
        let players = stepAnimations(doc, undefined, 0);
        players = stepAnimations(doc, players, 0.1, id => new Set(id === "hero" ? ["moving"] : []));
        const projected = applyAnimations(doc, players);
        expect(projected.nodes.get("child")?.frame).toBe(12);
        expect(projected.nodes.get("owned")?.frame).toBe(1);
        expect(applyFrame(projected, 0).nodes.get("child")?.style.fill).toBe("#00ff00");
        expect(doc.nodes.get("child")?.frame).toBeUndefined();
        expect(applyAnimations(doc, undefined)).toBe(doc);
    });
});

describe("animation authoring and persistence", () => {
    test.each([null, {}, { ...controller(), initial: "missing" }, { ...controller(), states: [] },
        { ...controller(), states: [{ name: "idle", clip: "idle", speed: NaN }] },
        { ...controller(), states: [{ name: "idle", clip: "idle", speed: 0 }] },
        { ...controller(), transitions: [{ from: "idle", to: "missing", when: "moving" }] },
        { ...controller(), transitions: [{ from: "idle", to: "walk", when: "unknown" }] },
        { ...controller(), states: [{ name: "idle", clip: "idle" }, { name: "idle", clip: "walk" }] }
    ])("refuses malformed controllers %j", value => expect(animationControllerError(value)).not.toBeNull());
    test("load and action share validation; undo/redo/clear round-trip without live aliasing", () => {
        const { doc, node } = fixture(); delete node.animation;
        const dispatcher = new ActionDispatcher(doc), value = controller();
        expect(dispatcher.dispatchAction(new SetAnimationControllerAction(dispatcher.getDocument(), node.id, value)).success).toBe(true);
        value.states[0].clip = "changed outside history";
        expect(dispatcher.getDocument().nodes.get(node.id)?.animation?.states[0].clip).toBe("idle");
        expect(dispatcher.undo()?.nodes.get(node.id)?.animation).toBeUndefined();
        expect(dispatcher.redo()?.nodes.get(node.id)?.animation?.initial).toBe("idle");
        const round = deserializeDocument(serializeDocument(dispatcher.getDocument()));
        expect(round.nodes.get(node.id)?.animation).toEqual(controller());
        const raw = JSON.parse(serializeDocument(round)); raw.document.nodes.hero.animation.initial = "invalid";
        expect(() => deserializeDocument(JSON.stringify(raw))).toThrow(/animation.initial/);
        expect(dispatcher.dispatchAction(new SetAnimationControllerAction(dispatcher.getDocument(), node.id, undefined)).success).toBe(true);
        expect(dispatcher.getDocument().nodes.get(node.id)?.animation).toBeUndefined();
        expect(dispatcher.dispatchAction(new SetAnimationControllerAction(dispatcher.getDocument(), "absent", controller())).success).toBe(false);
    });
    test("schema 76 migrates without inventing controllers", () => {
        const { doc, node } = fixture(); delete node.animation;
        const raw = JSON.parse(serializeDocument(doc)); raw.version = "76";
        const loaded = deserializeDocument(JSON.stringify(raw));
        expect(loaded.version).toBe(SCHEMA_VERSION);
        expect(loaded.nodes.get(node.id)?.animation).toBeUndefined();
    });
});

describe("runtime adapters and 3D composition", () => {
    test("2D samples settled velocity, driver events, and final gameplay commands", () => {
        const { doc, node } = fixture(); let world = worldFrom(doc);
        world = animateWorld2D(doc, stepWorld(doc, world, { controlled: node.id, input: { left: false, right: true, jump: false } }));
        expect(world.animations?.get(node.id)?.state).toBe("walk");
        node.animation!.transitions.unshift({ from: "walk", to: "idle", when: "lost" });
        world = worldFrom(doc);
        world = animateWorld2D(doc, { ...world, time: 1 / 60, bodies: new Map([[node.id, { ...world.bodies.get(node.id)!, vx: 20 }]]) });
        world = animateWorld2D(doc, applyCommands({ ...world, time: 2 / 60 }, [{ kind: "endRun", outcome: "lost" }]));
        expect(world.animations?.get(node.id)?.state).toBe("idle");
        expect(restartRun(doc).animations?.get(node.id)?.frame).toBe(0);
        expect(respawnRun(doc, world, node.id).animations?.get(node.id)?.frame).toBe(0);
        node.animation!.driver = "source";
        node.animation!.transitions = [{ from: "idle", to: "walk", when: "enter" }];
        const start = worldFrom(doc);
        const triggered = animateWorld2D(doc, { ...start, time: 1 / 60, events: [{ kind: "enter", bodyId: "source", nodeId: "trigger", className: "" }] });
        expect(triggered.animations?.get(node.id)?.state).toBe("walk");
    });
    test("3D playback is invariant to redraw batches, and restart/respawn reset it", () => {
        const { doc, node } = fixture();
        node.spatial3d = { transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
            composition2d: { mode: "billboard", pixelsPerUnit: 10, lit: false } };
        const input = new Map([[node.id, { x: 1, y: 0, z: 0 }]]);
        const batch = advanceWorld3D(doc, restartRun3D(doc), 1 / 30, input);
        const split = advanceWorld3D(doc, advanceWorld3D(doc, restartRun3D(doc), 1 / 60, input), 1 / 60, input);
        expect(batch.animations).toEqual(split.animations);
        expect(batch.animations?.get(node.id)?.state).toBe("walk");
        const frame = buildFrame3D(applyAnimations(doc, batch.animations), new Map(), 64, 64);
        expect(frame.draws[0].color).toEqual([0, 1, 0, 1]);
        expect(restartRun3D(doc).animations?.get(node.id)?.frame).toBe(0);
        expect(respawnRun3D(doc, batch, node.id).animations?.get(node.id)?.frame).toBe(0);
        expect(node.style.fill).toBe("#ff0000");
    });
});
