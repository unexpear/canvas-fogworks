import { createEmptyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";
import { resolveScene } from "../document/Components";
import {
    FIXED_STEP, DEFAULT_GRAVITY, jumpLaunchSpeed,
    worldFrom, stepWorld, applyWorld, applyCommands, movedIds, WorldState
} from "./World";
import { marioRules } from "./Rules";
import { applyCells, cellKey, applySpawns, regionsOf } from "./World";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Every number is hand-computed. A bounce launches at `jumpLaunchSpeed(900)`, which is the speed
 * that reaches 9/25 of `JUMP_HEIGHT` under a full gravity — `sqrt(2*900*25.92)` = `sqrt(46656)` =
 * 216 EXACTLY — so a bounce is `vy = -216` and the step after it is `-216 + 15 = -201`.
 *
 * IT WAS 360 UNTIL SLICE 16, and the change is the point rather than an accident: a bounce and a
 * jump start at the SAME speed, and since a jump's height became something the player buys by
 * holding the key, that shared speed is the SHORTEST jump's. These steps hold nothing, so they
 * measure the floor of the range — the ceiling is `World.test.ts`'s business, where the key is held.
 */

const prop = (v: string) => ({ type: "string", value: v });

function docWith(nodes: { id: string; x: number; y: number; w?: number; h?: number;
                          className?: string; userData?: UserData }[]): ProjectDocument {
    const doc = createEmptyDocument();
    for (const n of nodes) {
        doc.nodes.set(n.id, {
            id: n.id, type: "core.rectangle", parent: null, children: [],
            geometry: { x: n.x, y: n.y, width: n.w ?? 10, height: n.h ?? 10 },
            style: { fill: "#888", opacity: 1 }, layout: {},
            ...(n.className ? { className: n.className } : {}),
            ...(n.userData ? { userData: n.userData } : {})
        } as Node);
        doc.rootNodeUuids.push(n.id);
    }
    return doc;
}

const FLOOR_TOP = 700;
/** Hero 12x16 above a 20x8 enemy resting on the floor, and the enemy is INSIDE the hero's x span. */
const level = (stompable?: boolean, heroY = 600) => docWith([
    { id: "floor", x: 900, y: FLOOR_TOP, w: 400, h: 20, userData: { bodyType: prop("static") } },
    // CLASSED EITHER WAY, so the test proves the class is no longer what decides — only the
    // declaration is. Slice 10 read className !== "" as "authored as an actor"; slice 12 does not.
    { id: "enemy", x: 1000, y: 692, w: 20, h: 8, className: "enemy",
      userData: stompable
          ? { bodyType: prop("dynamic"), "vde.stompable": prop("true") }
          : { bodyType: prop("dynamic") } },
    { id: "hero", x: 1004, y: heroY, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
]);

/** Step until the rules fire, applying them per step exactly as the app does. */
const runUntilStomp = (doc: ProjectDocument, controlled: string | null = "hero") => {
    let w = worldFrom(doc);
    for (let i = 0; i < 120; i++) {
        w = stepWorld(doc, w, { controlled });
        const commands = marioRules(doc, w, { controlled });
        w = applyCommands(w, commands);
        if (commands.length > 0) return { world: w, step: i + 1, commands };
    }
    return { world: w, step: -1, commands: [] as ReturnType<typeof marioRules> };
};

describe("applyCommands — the channel, with no policy in it", () => {
    const twoBodies = () => docWith([
        { id: "a", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
        { id: "b", x: 100, y: 0, userData: { bodyType: prop("dynamic") } }
    ]);

    it("returns the SAME world for an empty command list", () => {
        const w = worldFrom(twoBodies());
        expect(applyCommands(w, [])).toBe(w);
    });

    it("despawn removes the body from the simulation and records it", () => {
        const w = applyCommands(worldFrom(twoBodies()), [{ kind: "despawn", bodyId: "a" }]);
        expect(w.bodies.has("a")).toBe(false);
        expect(w.bodies.has("b")).toBe(true);
        expect([...w.despawned]).toEqual(["a"]);
    });

    it("setVelocity writes only the components it names", () => {
        const base = worldFrom(twoBodies());
        const moving = applyCommands(base, [{ kind: "setVelocity", bodyId: "a", vx: 50, vy: 20 }]);
        const only = applyCommands(moving, [{ kind: "setVelocity", bodyId: "a", vy: -360 }]);
        expect(only.bodies.get("a")!.vx).toBe(50);       // untouched
        expect(only.bodies.get("a")!.vy).toBe(-360);
    });

    it("an UPWARD setVelocity clears onGround, or the bounce hands out a free second jump", () => {
        const doc = docWith([
            { id: "floor", x: 0, y: 400, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "a", x: 0, y: 390, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = stepWorld(doc, worldFrom(doc));
        expect(w.bodies.get("a")!.onGround).toBe(true);
        w = applyCommands(w, [{ kind: "setVelocity", bodyId: "a", vy: -360 }]);
        expect(w.bodies.get("a")!.onGround).toBe(false);
        // …and a DOWNWARD one does not, because landing is what sets it.
        const down = applyCommands(w, [{ kind: "setVelocity", bodyId: "a", vy: 5 }]);
        expect(down.bodies.get("a")!.onGround).toBe(false);
    });

    it("DESPAWN WINS over a later setVelocity for the same body", () => {
        // Reading `world.bodies` fresh per command instead of the map being built is what leaves a
        // body in BOTH sets at once: an invisible thing with full physics.
        const w = applyCommands(worldFrom(twoBodies()), [
            { kind: "despawn", bodyId: "a" },
            { kind: "setVelocity", bodyId: "a", vy: -360 }
        ]);
        expect(w.bodies.has("a")).toBe(false);
        expect([...w.despawned]).toEqual(["a"]);
    });

    it("ignores a body that is not there rather than inventing one", () => {
        const w = worldFrom(twoBodies());
        const after = applyCommands(w, [{ kind: "despawn", bodyId: "ghost" },
                                        { kind: "setVelocity", bodyId: "ghost", vy: 1 }]);
        expect(after.bodies.size).toBe(2);
        expect(after.despawned.size).toBe(0);
    });
});

describe("marioRules — the game, which the engine does not know about", () => {
    it("A STOMP issues exactly two commands: the enemy goes, the hero bounces", () => {
        const { commands, step } = runUntilStomp(level(true));
        expect(step).toBe(25);                       // free fall from 600 reaches the enemy here
        expect(commands).toEqual([
            { kind: "despawn", bodyId: "enemy" },
            { kind: "setVelocity", bodyId: "hero", vy: -jumpLaunchSpeed(DEFAULT_GRAVITY) }
        ]);
        expect(jumpLaunchSpeed(DEFAULT_GRAVITY)).toBe(216);
    });

    it("does NOTHING to a body that DECLARES NOTHING, however it is classed", () => {
        // The enemy here is still className "enemy" — it simply never declared `vde.stompable`,
        // and that is now the whole of the difference. Slice 10 would have deleted it. This is what
        // protects sticker-knight's 96x96 push-block, and it protects it by the block's own silence
        // rather than by an inference about what a class means.
        const { step, commands } = runUntilStomp(level(false));
        expect(step).toBe(-1);
        expect(commands).toEqual([]);
    });

    it("does NOTHING when the contact is from the side", () => {
        // Both resting on the floor, hero walking right into the enemy: side is `right`, not `below`.
        const doc = docWith([
            { id: "floor", x: 900, y: FLOOR_TOP, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "enemy", x: 1102, y: 692, w: 20, h: 8, className: "enemy",
              userData: { bodyType: prop("dynamic"), "vde.stompable": prop("true") } },
            { id: "hero", x: 1000, y: 684, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = worldFrom(doc);
        let fired = 0;
        for (let i = 0; i < 40; i++) {
            w = stepWorld(doc, w, { input: { left: false, right: true, jump: false }, controlled: "hero" });
            const c = marioRules(doc, w, { controlled: "hero" });
            fired += c.length;
            w = applyCommands(w, c);
        }
        expect(fired).toBe(0);
        expect(w.bodies.has("enemy")).toBe(true);
    });

    it("does NOTHING for a REGION, or the player bounces off every coin it lands on", () => {
        // A classed node that is NOT a body is a Region, and its `enter` event carries a `side` too
        // — so a rule that forgot to check `kind` would fire on all 21 of the corpus's classed
        // actors while the shipped rule fires on none of them.
        const doc = docWith([
            { id: "floor", x: 900, y: FLOOR_TOP, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "coin", x: 1000, y: 692, w: 20, h: 8, className: "coin" },   // no bodyType
            { id: "hero", x: 1004, y: 600, w: 12, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = worldFrom(doc);
        let sawEnter = false, fired = 0;
        for (let i = 0; i < 120; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            if (w.events.some(e => e.kind === "enter")) sawEnter = true;
            fired += marioRules(doc, w, { controlled: "hero" }).length;
        }
        expect(sawEnter).toBe(true);        // the event really happened, or this proves nothing
        expect(fired).toBe(0);
    });

    it("does NOTHING when the contact is reported to somebody else, or with nothing driven", () => {
        const doc = level(true);
        let w = worldFrom(doc);
        let asEnemy = 0, asNobody = 0;
        for (let i = 0; i < 40; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            asEnemy += marioRules(doc, w, { controlled: "enemy" }).length;
            asNobody += marioRules(doc, w, { controlled: null }).length;
        }
        expect(asEnemy).toBe(0);
        expect(asNobody).toBe(0);
    });

    it("TWO enemies landed on in one step give two despawns and ONE bounce", () => {
        // A velocity is a state, not an accumulation — two bounces would double the launch speed.
        const doc = docWith([
            { id: "floor", x: 900, y: FLOOR_TOP, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "e1", x: 1000, y: 692, w: 20, h: 8, className: "enemy",
              userData: { bodyType: prop("dynamic"), "vde.stompable": prop("true") } },
            { id: "e2", x: 1020, y: 692, w: 20, h: 8, className: "enemy",
              userData: { bodyType: prop("dynamic"), "vde.stompable": prop("true") } },
            // 30 wide, straddling both: 1005..1035 covers e1's 1000..1020 and e2's 1020..1040.
            { id: "hero", x: 1005, y: 600, w: 30, h: 16, userData: { bodyType: prop("dynamic") } }
        ]);
        const { commands } = runUntilStomp(doc);
        expect(commands.flatMap(c => (c.kind === "despawn" ? [c.bodyId] : [])).sort())
            .toEqual(["e1", "e2"]);
        expect(commands.filter(c => c.kind === "setVelocity")).toHaveLength(1);
    });
});

describe("the stomp, end to end", () => {
    it("the enemy leaves the PICTURE and the hero leaves the ground", () => {
        const doc = level(true);
        const { world, step } = runUntilStomp(doc);
        expect(step).toBe(25);
        // The hero is where the step left it — a command moves nothing — and rising.
        expect(world.bodies.get("hero")!.y).toBe(681.25);
        expect(world.bodies.get("hero")!.vy).toBe(-216);
        expect(world.bodies.get("hero")!.onGround).toBe(false);

        // The DERIVED document hides it; the STORED one is untouched, so Stop brings it back.
        const played = applyWorld(doc, world);
        expect((played.nodes.get("enemy") as Node).hidden).toBe(true);
        expect((doc.nodes.get("enemy") as Node).hidden).toBeUndefined();
        // …and `dropHidden` then takes it out of the scene entirely, which is what "gone" means.
        expect(resolveScene(played).nodes.has("enemy")).toBe(false);
        expect(resolveScene(played).nodes.has("hero")).toBe(true);

        // One more step and the bounce is really carrying it upward: -216 + 15 = -201.
        const after = stepWorld(doc, world, { controlled: "hero" });
        expect(after.bodies.get("hero")!.vy).toBe(-201);
        expect(after.bodies.get("hero")!.y).toBe(681.25 - 201 * FIXED_STEP);
        expect(after.bodies.get("hero")!.y).toBe(677.9);
        // …AND THE KEY DOES NOT MAKE THE BOUNCE HIGHER, which is the half of slice 16 that would be
        // easy to get backwards. A stomp requires FALLING onto the thing, and `stepWorld`'s jump
        // latch closes the moment a body stops rising — so this arc is already committed to full
        // gravity and leaning on the button buys nothing. Identical to the step above, to the pixel,
        // and identical for the same reason the original's stomps do not answer the A button.
        const heldBounce = stepWorld(doc, world,
            { controlled: "hero", input: { left: false, right: false, jump: true } });
        expect(heldBounce.bodies.get("hero")!.vy).toBe(-201);
        expect(heldBounce.bodies.get("hero")!.y).toBe(after.bodies.get("hero")!.y);
    });

    it("HIDES A DESPAWNED NODE ON A FRAME WHERE NOTHING MOVED", () => {
        // `applyWorld` has two early returns — "no bodies" and "nothing moved" — and both are about
        // POSITIONS. Hanging the stamp off them drops it on exactly the frames where the survivors
        // are sitting still, which after a stomp is most of them.
        const doc = docWith([
            { id: "floor", x: 0, y: 400, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "rest", x: 100, y: 380, w: 20, h: 20, userData: { bodyType: prop("dynamic") } },
            { id: "gone", x: 200, y: 380, w: 20, h: 20, className: "enemy",
              userData: { bodyType: prop("dynamic"), "vde.stompable": prop("true") } }
        ]);
        let w = stepWorld(doc, worldFrom(doc));
        w = stepWorld(doc, w);
        // Both bodies rest exactly where the document put them, so nothing is dirty.
        expect([...movedIds(doc, w)]).toEqual([]);
        w = applyCommands(w, [{ kind: "despawn", bodyId: "gone" }]);
        const played = applyWorld(doc, w);
        expect((played.nodes.get("gone") as Node).hidden).toBe(true);
        expect(played).not.toBe(doc);
    });

    it("a despawn SURVIVES the steps that follow it", () => {
        // `despawned` is carried by stepWorld; without that the enemy reappears one frame later.
        const doc = level(true);
        let { world } = runUntilStomp(doc);
        for (let i = 0; i < 10; i++) world = stepWorld(doc, world, { controlled: "hero" });
        expect([...world.despawned]).toEqual(["enemy"]);
        expect((applyWorld(doc, world).nodes.get("enemy") as Node).hidden).toBe(true);
    });

    it("STOP brings it back, because a run owns nothing", () => {
        const doc = level(true);
        runUntilStomp(doc);
        // Stop throws the world away and the editor derives the STORED document again.
        const fresh: WorldState = worldFrom(doc);
        expect(fresh.despawned.size).toBe(0);
        expect(applyWorld(doc, fresh).nodes.has("enemy")).toBe(true);
        expect(resolveScene(doc).nodes.has("enemy")).toBe(true);
    });
});

describe("setCell — a bumped block BECOMES something, without editing the level", () => {
    const CELL = 16;
    /** A one-cell ceiling of tile 1, a floor, and a hero under it. Tile 1 declares what it becomes. */
    const room = (bumpsTo?: string) => {
        const doc = createEmptyDocument();
        doc.tilesets = [{
            id: "ts", name: "T", src: "t.png", offsetX: 0, offsetY: 0,
            sheet: { columns: 4, tileWidth: CELL, tileHeight: CELL, spacing: 0, margin: 0 },
            tiles: [{ id: 1, userData: {
                bodyType: prop("static"),
                ...(bumpsTo !== undefined ? { "vde.bumpsTo": prop(bumpsTo) } : {})
            } }]
        }] as unknown as ProjectDocument["tilesets"];
        doc.nodes.set("blocks", {
            id: "blocks", type: "core.tilemap", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 32, height: 16 },
            style: { fill: "none", opacity: 1 }, layout: {},
            tilemap: { cols: 2, rows: 1, tileWidth: CELL, tileHeight: CELL, tilesetId: "ts",
                       tiles: [1, 0] }
        } as unknown as Node);
        doc.nodes.set("floor", {
            id: "floor", type: "core.rectangle", parent: null, children: [],
            geometry: { x: -100, y: 100, width: 400, height: 20 },
            style: { fill: "#888888", opacity: 1 }, layout: {},
            userData: { bodyType: prop("static") }
        } as Node);
        doc.nodes.set("hero", {
            id: "hero", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 2, y: 88, width: 12, height: 12 },
            style: { fill: "#888888", opacity: 1 }, layout: {},
            userData: { bodyType: prop("dynamic") }
        } as Node);
        doc.rootNodeUuids.push("blocks", "floor", "hero");
        return doc;
    };
    /** Launch the hero into the ceiling and run the rules, exactly as the app does. */
    const bumpIt = (doc: ProjectDocument) => {
        const w0 = worldFrom(doc);
        let w: WorldState = { ...w0,
            bodies: new Map(w0.bodies).set("hero", { ...w0.bodies.get("hero")!, y: 30, vy: -300 }) };
        for (let i = 0; i < 12; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            w = applyCommands(w, marioRules(doc, w, { controlled: "hero" }));
        }
        return w;
    };

    it("THE TILE SAYS WHAT IT BECOMES, so no index is hard-coded in the rule", () => {
        const w = bumpIt(room("2"));
        expect(w.cells.get(cellKey("blocks", 0, 0))).toBe(2);
        // …and the STORED level is untouched, which is what makes Stop restore it.
        expect(room("2").nodes.get("blocks")!.tilemap!.tiles[0]).toBe(1);
    });

    it("a tile that declares NOTHING does not change — a brick is not a question block", () => {
        expect(bumpIt(room()).cells.size).toBe(0);
        // `Number("")` IS 0 AND FINITE, and 0 is a real tile index, so an empty declaration would
        // silently turn a bumped block into tile zero. The trap this project has paid for twice.
        expect(bumpIt(room("")).cells.size).toBe(0);
        expect(bumpIt(room("   ")).cells.size).toBe(0);
        expect(bumpIt(room("nonsense")).cells.size).toBe(0);
        // …but a declared ZERO is a real answer and must go through.
        expect(bumpIt(room("0")).cells.get(cellKey("blocks", 0, 0))).toBe(0);
    });

    it("STAMPS ONTO A COPY, and returns the same reference when nothing changed", () => {
        const doc = room("2");
        const w = bumpIt(doc);
        const played = applyCells(doc, w);
        expect(played.nodes.get("blocks")!.tilemap!.tiles[0]).toBe(2);
        // THE STORED DOCUMENT IS UNTOUCHED — the whole bargain, and the reason a run leaves nothing
        // on the undo stack.
        expect(doc.nodes.get("blocks")!.tilemap!.tiles[0]).toBe(1);
        // …and the neighbouring cell is carried through rather than lost to the rebuild.
        expect(played.nodes.get("blocks")!.tilemap!.tiles[1]).toBe(0);
        // A run that bumped nothing pays nothing: same reference, no copied tile array.
        expect(applyCells(doc, worldFrom(doc))).toBe(doc);
        // …AND NEITHER DOES A CELL ALREADY SHOWING THE WANTED TILE. A mutant survived here: without
        // the equality check the array is rebuilt on every frame of the whole run for a change that
        // already happened, and the picture stays perfectly correct while doing it. Only a
        // REFERENCE check can see that, which is why this asserts identity and not contents.
        const already: WorldState = { ...worldFrom(doc), cells: new Map([[cellKey("blocks", 0, 0), 1]]) };
        expect(applyCells(doc, already)).toBe(doc);
    });

    it("KEEPS EVERY CELL, not just the last one bumped", () => {
        // A mutant survived a fixture that bumped exactly one block: starting a fresh map per
        // command loses every earlier change, and with one change there is nothing to lose. Two
        // cells is the smallest number that can tell the difference.
        const doc = room("2");
        const w = applyCommands(worldFrom(doc), [
            { kind: "setCell", nodeId: "blocks", col: 0, row: 0, tile: 2 },
            { kind: "setCell", nodeId: "blocks", col: 1, row: 0, tile: 3 }
        ]);
        expect(w.cells.size).toBe(2);
        expect(w.cells.get(cellKey("blocks", 0, 0))).toBe(2);
        expect(w.cells.get(cellKey("blocks", 1, 0))).toBe(3);
        // …and across SEPARATE calls too, which is how a real run arrives at them: one per step.
        const later = applyCommands(w, [{ kind: "setCell", nodeId: "blocks", col: 0, row: 0, tile: 9 }]);
        expect(later.cells.size).toBe(2);
        expect(later.cells.get(cellKey("blocks", 0, 0))).toBe(9);   // last write wins for one cell
        expect(later.cells.get(cellKey("blocks", 1, 0))).toBe(3);   // …and the other survives
        // Both reach the derived document, which is the point of keeping them.
        const played = applyCells(doc, later);
        expect(played.nodes.get("blocks")!.tilemap!.tiles).toEqual([9, 3]);
    });

    it("an override naming a cell that is GONE is inert, not a crash", () => {
        // The dangling-reference rule this schema follows everywhere. A level edited or resized
        // mid-run must not take the run down.
        const doc = room("2");
        const w: WorldState = { ...worldFrom(doc),
            cells: new Map([[cellKey("blocks", 99, 99), 3], [cellKey("ghost", 0, 0), 3]]) };
        expect(applyCells(doc, w)).toBe(doc);
    });

    it("and the APP stamps them — a derivation nothing calls is not a feature", () => {
        const app = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(app).toMatch(/applyCells\(/);
    });
});

describe("spawn — the fifth verb, and the only one that ADDS", () => {
    const withTemplate = () => {
        const doc = docWith([
            { id: "coin", x: 0, y: 0, w: 8, h: 8, className: "coin" },
            { id: "a", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }
        ]);
        return doc;
    };

    it("mints ids from the INDEX, so a replayed run produces the same ones", () => {
        // `generateUUID` here would make a pure, replayable runtime unreplayable — the one thing
        // this module has refused to give up. The nth spawn is at index n however the run got there.
        const w = applyCommands(worldFrom(withTemplate()), [
            { kind: "spawn", templateId: "coin", x: 10, y: 20 },
            { kind: "spawn", templateId: "coin", x: 30, y: 40 }
        ]);
        expect(w.spawns.map(s => s.id)).toEqual(["coin#0", "coin#1"]);
        // …and a later batch continues the count rather than restarting it.
        const more = applyCommands(w, [{ kind: "spawn", templateId: "coin", x: 50, y: 60 }]);
        expect(more.spawns.map(s => s.id)).toEqual(["coin#0", "coin#1", "coin#2"]);
    });

    it("MATERIALISES a copy of the template, positioned, and leaves the stored doc alone", () => {
        const doc = withTemplate();
        const w = applyCommands(worldFrom(doc), [{ kind: "spawn", templateId: "coin", x: 100, y: 50 }]);
        const live = applySpawns(doc, w);
        const made = live.nodes.get("coin#0")!;
        expect(made.geometry).toEqual({ x: 100, y: 50, width: 8, height: 8 });
        // THE TEMPLATE'S OWN FIELDS SURVIVE, because it is copied by spread rather than rebuilt —
        // the sixth instance of the enumerated-literal bug in this codebase lost a document's
        // tilesets, and a spawner that enumerated would drop whatever the schema grows next.
        expect(made.className).toBe("coin");
        expect(made.type).toBe(doc.nodes.get("coin")!.type);
        // A SPAWNED THING IS A ROOT and is drawn: keeping the template's parent would compose a
        // frame's offset it was never positioned against.
        expect(made.parent).toBeNull();
        expect(live.rootNodeUuids).toContain("coin#0");
        // AND IT MATTERS ONLY WHEN THE TEMPLATE IS NESTED, which the fixture above is not — a
        // mutant survived on exactly that. A template inside a frame at (500,300): the spawn asks
        // for world (100,50), and keeping the parent would make `worldOffsetOf` add the frame's
        // offset on top, putting the coin at (600,350) — slice 6's defect by a new route.
        const nested = withTemplate();
        (nested.nodes.get("coin") as Node).parent = "frame";
        nested.nodes.set("frame", {
            id: "frame", type: "core.rectangle", parent: null, children: ["coin"],
            geometry: { x: 500, y: 300, width: 400, height: 400 },
            style: { fill: "#888888", opacity: 1 }, layout: {}
        } as Node);
        nested.rootNodeUuids = ["frame", "a"];
        const nw = applyCommands(worldFrom(nested), [{ kind: "spawn", templateId: "coin", x: 100, y: 50 }]);
        const nlive = applySpawns(nested, nw);
        expect((nlive.nodes.get("coin#0") as Node).parent).toBeNull();
        // The REGION it becomes is where the spawn asked for it, not where the frame would put it.
        const region = regionsOf(nlive).find(r => r.nodeId === "coin#0")!;
        expect({ x: region.x, y: region.y }).toEqual({ x: 100, y: 50 });
        // …and the STORED document never had a coin in it.
        expect(doc.nodes.has("coin#0")).toBe(false);
        expect(applySpawns(doc, worldFrom(doc))).toBe(doc);
    });

    it("REACHES THE PHYSICS, which is the whole reason it runs before the step", () => {
        // A spawned REGION is reported the step after it exists. Fed only to the picture it would
        // be drawn and untouchable — the defect this ordering exists to prevent.
        const doc = withTemplate();
        let w = worldFrom(doc);
        expect(regionsOf(applySpawns(doc, w)).map(r => r.nodeId)).toEqual(["coin"]);
        w = applyCommands(w, [{ kind: "spawn", templateId: "coin", x: 0, y: 0 }]);
        const live = applySpawns(doc, w);
        expect(regionsOf(live).map(r => r.nodeId).sort()).toEqual(["coin", "coin#0"]);
        // The body sits on the spawned coin, so stepping against the LIVE document enters it…
        const entered = stepWorld(live, w).events.filter(e => e.kind === "enter" && e.nodeId === "coin#0");
        expect(entered).toHaveLength(1);
        // …and stepping against the STORED one does not, which is the two halves of the same point.
        expect(stepWorld(doc, w).events.filter(e => e.nodeId === "coin#0")).toEqual([]);
    });

    it("a MISSING template spawns nothing, inertly", () => {
        // The dangling-reference rule this schema follows everywhere: a level whose template was
        // deleted keeps playing rather than throwing.
        const doc = withTemplate();
        const w = applyCommands(worldFrom(doc), [{ kind: "spawn", templateId: "ghost", x: 1, y: 2 }]);
        expect(w.spawns).toHaveLength(1);          // the channel recorded it…
        expect(applySpawns(doc, w)).toBe(doc);     // …and the derive resolved it to nothing
    });

    it("and the APP steps against the spawned document, not the stored one", () => {
        const app = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(app).toMatch(/const live = applySpawns\(base, world\)/);
        expect(app).toMatch(/stepWorld\(live, world/);
        // BOTH halves: it must feed the picture too, or a coin is collided with and never seen.
        expect(app).toMatch(/applyWorld\(applySpawns\(timed, world\)/);
    });
});
