import { createEmptyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";
import { resolveScene } from "../document/Components";
import {
    FIXED_STEP, DEFAULT_GRAVITY, jumpLaunchSpeed,
    worldFrom, stepWorld, applyWorld, applyCommands, movedIds, WorldState
} from "./World";
import { marioRules } from "./Rules";
import { applyCells, cellKey, applySpawns, regionsOf, facedIds, playBounds } from "./World";
import { partOf } from "./Parts";
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

    it("ignores a MOVE for a body that is not there rather than inventing one", () => {
        const w = worldFrom(twoBodies());
        const after = applyCommands(w, [{ kind: "setVelocity", bodyId: "ghost", vy: 1 }]);
        expect(after.bodies.size).toBe(2);
        expect(after).toBe(w);                     // nothing to change, so nothing was copied
    });

    it("DESPAWN IS ABOUT A NODE, NOT A BODY — which is what lets a spawned coin be collected", () => {
        // It used to require the id to be a live body, so a spawned REGION could be made and never
        // taken away: bodies are established once, by `worldFrom`, at Play. Despawn is a node
        // leaving the run, and only some nodes are bodies.
        const w = worldFrom(twoBodies());
        const gone = applyCommands(w, [{ kind: "despawn", bodyId: "not-a-body" }]);
        expect([...gone.despawned]).toEqual(["not-a-body"]);
        expect(gone.bodies.size).toBe(2);          // it removed no body, because it named none
        // …and despawning a real body still removes it, which is the half that already worked.
        const both = applyCommands(gone, [{ kind: "despawn", bodyId: "a" }]);
        expect(both.bodies.has("a")).toBe(false);
        expect([...both.despawned].sort()).toEqual(["a", "not-a-body"]);
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

    it("THE TEMPLATE'S OWN bodyType decides whether the spawn moves", () => {
        // A mutant survived a fixture that called `applyCommands` directly with a body: that never
        // asks the RULE anything. This bumps a real block whose tile names a template, twice, with
        // the only difference being what the template declares about itself.
        const build = (declares: UserData | undefined) => {
            const doc = room("2");
            const set = (doc.tilesets as unknown as { tiles: { id: number; userData: UserData }[] }[])[0];
            set.tiles[0].userData["vde.spawns"] = prop("thing");
            doc.nodes.set("thing", {
                id: "thing", type: "core.rectangle", parent: null, children: [],
                geometry: { x: 0, y: -200, width: 6, height: 6 },
                style: { fill: "#ffd75e", opacity: 1 }, layout: {}, className: "coin",
                ...(declares ? { userData: declares } : {})
            } as Node);
            doc.rootNodeUuids.push("thing");
            return doc;
        };
        // DECLARES NOTHING: a region, which appears and stays where it was put.
        const still = bumpIt(build(undefined));
        expect(still.spawns.map(s => s.templateId)).toEqual(["thing"]);
        expect(still.bodies.has("thing#0")).toBe(false);
        // DECLARES `dynamic`: a body, minted moving upward at a jump's launch speed.
        const moving = bumpIt(build({ bodyType: prop("dynamic") }));
        expect(moving.bodies.has("thing#0")).toBe(true);
        expect(moving.bodies.get("thing#0")!.vy).toBeLessThan(0);
    });

    it("and the APP stamps them — a derivation nothing calls is not a feature", () => {
        const app = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(app).toMatch(/applyCells\(/);
    });
});

describe("power and breaking — Mario's own eligibility rules (M18 slice 34)", () => {
    /**
     * A 3x3 tilemap standing over the player: row 2 is the floor (tile 0, solid), and cell (1,0)
     * two rows up carries whatever tile the test declares. The player at (20,26) under it can jump
     * into it. Tile indices declare their own behaviour on the TILESET, exactly as the app's do.
     */
    const TILE = 18;
    const blockLevel = (blockTile: { [k: string]: { type: string; value: string } },
                        templates: Parameters<typeof docWith>[0] = []) => {
        const doc = docWith([
            // ON the floor, not IN it: the floor row's top is 36 and the body is 16 tall, so 20
            // exactly. Seeded 6px deep, the HORIZONTAL resolver reads the overlap as a wall and
            // shoves the body sideways out from under the block — an hour of debugging that turned
            // out to be the fixture, with the engine right all along.
            { id: "player", x: 20, y: 20, w: 12, h: 16, userData: { bodyType: prop("dynamic") } },
            ...templates
        ]);
        const tiles = [
            -1, 1, -1,
            -1, -1, -1,
            0, 0, 0
        ];
        doc.nodes.set("map", {
            id: "map", type: "core.tilemap", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 3 * TILE, height: 3 * TILE },
            style: { fill: "#888", opacity: 1 }, layout: {},
            tilemap: { cols: 3, rows: 3, tileWidth: TILE, tileHeight: TILE,
                       tilesetId: "ts", tiles }
        } as unknown as Node);
        doc.rootNodeUuids.push("map");
        (doc as ProjectDocument).tilesets = [{
            id: "ts", name: "ts", src: "t.png",
            sheet: { columns: 4, tileWidth: TILE, tileHeight: TILE, spacing: 0, margin: 0 },
            tiles: [
                { id: 0, userData: { bodyType: prop("static") } },
                { id: 1, userData: { bodyType: prop("static"), ...blockTile } },
                { id: 2, userData: { bodyType: prop("static") } }
            ],
            offsetX: 0, offsetY: 0
        }] as unknown as ProjectDocument["tilesets"];
        return doc;
    };

    /** Jump into the block and apply the rules per step, against the CELL-STAMPED document. */
    const hitIt = (doc: ProjectDocument, power = 0, steps = 90) => {
        let w = worldFrom(doc);
        if (power > 0) w = applyCommands(w, [{ kind: "setPower", bodyId: "player", power }]);
        for (let i = 0; i < steps; i++) {
            const live = applyCells(applySpawns(doc, w), w);
            w = stepWorld(live, w, { controlled: "player",
                input: { left: false, right: false, jump: i >= 2 && i < 20 } });
            w = applyCommands(w, marioRules(live, w, { controlled: "player" }));
        }
        return w;
    };

    it("a HIDDEN node is not in the world: no body, no solid, no region", () => {
        // Found the first time a level parked a DYNAMIC template: `worldFrom` minted the hidden
        // mushroom template as a live body, it fell from its parking spot through the sky, and the
        // player collected the TEMPLATE mid-level. Hidden already means "out of the displayed
        // scene"; the world now honours the same word.
        const doc = docWith([
            { id: "floor", x: 0, y: 400, w: 200, h: 20, userData: { bodyType: prop("static") } },
            { id: "hero", x: 50, y: 384, w: 12, h: 16, userData: { bodyType: prop("dynamic") } },
            { id: "tpl", x: 52, y: 386, w: 12, h: 12, className: "mushroom",
              userData: { bodyType: prop("dynamic"), "vde.collect": prop("true") } },
            { id: "wall", x: 60, y: 380, w: 10, h: 20, userData: { bodyType: prop("static") } }
        ]);
        (doc.nodes.get("tpl") as Node).hidden = true;
        (doc.nodes.get("wall") as Node).hidden = true;
        const w = worldFrom(doc);
        expect(w.bodies.has("tpl")).toBe(false);         // no body minted from a mould
        expect(regionsOf(doc).map(r => r.nodeId)).toEqual([]);
        // …and the hidden wall stops nothing: the hero walks through where it stands.
        let w2 = w;
        for (let i = 0; i < 30; i++) w2 = stepWorld(doc, w2,
            { controlled: "hero", input: { left: false, right: true, jump: false } });
        expect(w2.bodies.get("hero")!.x).toBeGreaterThan(70);
        // The SPAWNED COPY is different from its mould — applySpawns clears the flag, so a copy
        // draws and is in the world. (This template is DYNAMIC, so its copy is a body-to-be, not
        // a region — regionsOf demands a class and NO bodyType, and asserting a region here was
        // this test's own first defect.)
        const sp = applyCommands(w, [{ kind: "spawn", templateId: "tpl", x: 100, y: 100 }]);
        const copy = applySpawns(doc, sp).nodes.get("tpl#0");
        expect(copy).toBeDefined();
        expect(copy!.hidden).toBeUndefined();
    });

    it("setPower is a channel verb: absolute, body-scoped, and a no-op when nothing changes", () => {
        const doc = docWith([{ id: "a", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const w = worldFrom(doc);
        expect(w.bodies.get("a")!.power).toBe(0);            // every body starts small
        const up = applyCommands(w, [{ kind: "setPower", bodyId: "a", power: 1 }]);
        expect(up.bodies.get("a")!.power).toBe(1);
        expect(applyCommands(up, [{ kind: "setPower", bodyId: "a", power: 1 }])).toBe(up);
        // …and the STEP carries it — the seventh field-by-field body literal, and the sixth one
        // dropped fields, so this is the assertion that sees the drop.
        const stepped = stepWorld(doc, up);
        expect(stepped.bodies.get("a")!.power).toBe(1);
    });

    it("COLLECTING a part that declares vde.powers raises the collector — higher tier kept", () => {
        // The mushroom: collectible AND powering. The player stands inside it, so the enter fires
        // on the first step and both commands come out of one pickup.
        const doc = docWith([
            { id: "floor", x: 0, y: 400, w: 200, h: 20, userData: { bodyType: prop("static") } },
            { id: "hero", x: 50, y: 384, w: 12, h: 16, userData: { bodyType: prop("dynamic") } },
            // CLASSED, because a region is "a class and no bodyType" — the corpus's own split.
            { id: "shroom", x: 52, y: 386, w: 12, h: 12, className: "mushroom",
              userData: { "vde.collect": prop("true"), "vde.powers": prop("1") } }
        ]);
        let w = stepWorld(doc, worldFrom(doc), { controlled: "hero" });
        const commands = marioRules(doc, w, { controlled: "hero" });
        expect(commands).toEqual([
            { kind: "despawn", bodyId: "shroom" },
            { kind: "setPower", bodyId: "hero", power: 1 }
        ]);
        w = applyCommands(w, commands);
        expect(w.bodies.get("hero")!.power).toBe(1);
        // THE HIGHER TIER IS KEPT — SMB1's mushroom does nothing for Fire Mario. A second, weaker
        // part despawns but grants nothing: no setPower command at all.
        const again = docWith([
            { id: "floor", x: 0, y: 400, w: 200, h: 20, userData: { bodyType: prop("static") } },
            { id: "hero", x: 50, y: 384, w: 12, h: 16, userData: { bodyType: prop("dynamic") } },
            { id: "weak", x: 52, y: 386, w: 12, h: 12, className: "mushroom",
              userData: { "vde.collect": prop("true"), "vde.powers": prop("1") } }
        ]);
        let w2 = applyCommands(worldFrom(again), [{ kind: "setPower", bodyId: "hero", power: 2 }]);
        w2 = stepWorld(again, w2, { controlled: "hero" });
        const c2 = marioRules(again, w2, { controlled: "hero" });
        expect(c2).toEqual([{ kind: "despawn", bodyId: "weak" }]);
    });

    it("a MULTI-PAY block pays per hit inside its window, then pays AND converts (M18 s35)", () => {
        // THE NUMBERS ARE THE DISASSEMBLY'S, derived not quoted: BrickCoinTimer = $0B ticks of an
        // interval timer that fires every 21 frames = 231 frames = 3.85s. The fixture uses 1.5s so
        // three one-second arcs cross the boundary: hits at ~0.32s, ~1.32s, ~2.32s — the first two
        // pay and leave the block, the third pays and spends it. That spacing is also what kills
        // the clock-REFRESH mutant: measured from the third hit back to the SECOND, 1.0s is inside
        // the window, so a clock that restarts per hit never expires and the block never converts.
        const doc = blockLevel({ "vde.bumpsTo": prop("2"), "vde.spawns": prop("gift"),
                                 "vde.paysFor": prop("1.5") },
            [{ id: "gift", x: 200, y: -40, w: 8, h: 8, className: "coin",
               userData: { "vde.collect": prop("true") } }]);
        let w = worldFrom(doc);
        const arcs: { spawns: number; cell: number | undefined }[] = [];
        for (let arc = 0; arc < 3; arc++) {
            for (let i = 0; i < 60; i++) {
                const live = applyCells(applySpawns(doc, w), w);
                w = stepWorld(live, w, { controlled: "player",
                    input: { left: false, right: false, jump: i >= 2 && i < 20 } });
                w = applyCommands(w, marioRules(live, w, { controlled: "player" }));
            }
            arcs.push({ spawns: w.spawns.length, cell: w.cells.get(cellKey("map", 1, 0)) });
        }
        // EVERY hit pays — including the expiring one, exactly as the original's does.
        expect(arcs.map(a => a.spawns)).toEqual([1, 2, 3]);
        // …and only the expiring hit converts.
        expect(arcs.map(a => a.cell)).toEqual([undefined, undefined, 2]);
        // The clock is the run's, keyed like the overrides, started once.
        expect(w.cellClocks.size).toBe(1);
        // A spent block's own tile declares nothing, so a FOURTH arc changes nothing more.
        const spent = w.spawns.length;
        for (let i = 0; i < 60; i++) {
            const live = applyCells(applySpawns(doc, w), w);
            w = stepWorld(live, w, { controlled: "player",
                input: { left: false, right: false, jump: i >= 2 && i < 20 } });
            w = applyCommands(w, marioRules(live, w, { controlled: "player" }));
        }
        expect(w.spawns.length).toBe(spent);
    });

    it("startCellClock is IDEMPOTENT and per cell — the declared divergence from SMB1", () => {
        // SMB1's BrickCoinTimerFlag is GLOBAL: every coin brick in an area joins one countdown —
        // one flag byte's quirk. Ours is per cell, and a clock already running is left alone.
        const doc = blockLevel({ "vde.bumpsTo": prop("2") });
        let w = worldFrom(doc);
        for (let i = 0; i < 30; i++) w = stepWorld(doc, w, { controlled: "player" });
        const early = w.time;
        w = applyCommands(w, [{ kind: "startCellClock", nodeId: "map", col: 1, row: 0 }]);
        for (let i = 0; i < 30; i++) w = stepWorld(doc, w, { controlled: "player" });
        w = applyCommands(w, [
            { kind: "startCellClock", nodeId: "map", col: 1, row: 0 },   // must NOT restart
            { kind: "startCellClock", nodeId: "map", col: 2, row: 0 }    // its own clock
        ]);
        expect(w.cellClocks.get(cellKey("map", 1, 0))).toBeCloseTo(early, 9);
        expect(w.cellClocks.get(cellKey("map", 2, 0))).toBeCloseTo(early + 0.5, 9);
        expect(w.cellClocks.size).toBe(2);
    });

    it("a SMALL bumper breaks nothing: the brick gives nothing at all", () => {
        const w = hitIt(blockLevel({ "vde.breaks": prop("true") }), 0);
        expect(w.cells.size).toBe(0);                        // the brick is exactly as authored
        expect(w.spawns).toHaveLength(0);                    // and nothing came out — SMB1's jiggle
    });

    it("a SUPER bumper breaks an empty brick: the cell empties and stops being solid", () => {
        const doc = blockLevel({ "vde.breaks": prop("true") });
        const w = hitIt(doc, 1);
        expect(w.cells.get(cellKey("map", 1, 0))).toBe(-1);  // broken to EMPTY, not to a tile
        // …and the physics sees the hole: a fresh jump from rest passes straight through where
        // the brick was. The stamped document is what the step reads — the same chain the app runs.
        let w2 = w;
        let peak = Infinity;
        for (let i = 0; i < 60; i++) {
            const live = applyCells(applySpawns(doc, w2), w2);
            w2 = stepWorld(live, w2, { controlled: "player",
                input: { left: false, right: false, jump: i < 18 } });
            peak = Math.min(peak, w2.bodies.get("player")!.y);
        }
        // The brick's underside is at y=18; a 16-tall body whose top passes it has y < 2. With the
        // brick present the first jump bumped and stopped there — without it the arc continues.
        expect(peak).toBeLessThan(0);
    });

    it("? BLOCKS NEVER BREAK, whoever hits them — they do not declare vde.breaks", () => {
        // A ? block declares its CONTENTS; a super bumper pops them and the block becomes spent.
        // No declaration of vde.breaks means no eligibility, which is Mario's own taxonomy.
        const w = hitIt(blockLevel({ "vde.bumpsTo": prop("2") }), 1);
        expect(w.cells.get(cellKey("map", 1, 0))).toBe(2);   // spent, not gone
    });

    it("CONTENTS WIN: a brick that pays out becomes spent even under a Super bumper", () => {
        // SMB1's coin brick never shatters while it has coins. A tile declaring BOTH contents and
        // breaks delivers the contents — the break clause never fires on the same hit.
        const w = hitIt(blockLevel(
            { "vde.bumpsTo": prop("2"), "vde.breaks": prop("true") }), 1);
        expect(w.cells.get(cellKey("map", 1, 0))).toBe(2);
    });

    it("a SPENT block answers the next bump with ITS OWN tile — the infinite ? block is closed", () => {
        // MEASURED IN THE APP BEFORE THE FIX: 2 spawns where the level authored 1, because the
        // step and the rules read a document nothing had stamped the override onto, so the
        // original ? tile still declared its contents on the second hit. The chain
        // `applyCells(applySpawns(base))` is what this fixture steps against — the app's own.
        const doc = blockLevel({ "vde.bumpsTo": prop("2"), "vde.spawns": prop("gift") },
            [{ id: "gift", x: 200, y: -40, w: 8, h: 8,
               userData: { "vde.collect": prop("true") } }]);
        let w = worldFrom(doc);
        for (let i = 0; i < 200; i++) {
            const live = applyCells(applySpawns(doc, w), w);
            // two full jump arcs into the same cell: press, release, press again
            const jump = (i >= 2 && i < 20) || (i >= 100 && i < 118);
            w = stepWorld(live, w, { controlled: "player",
                input: { left: false, right: false, jump } });
            w = applyCommands(w, marioRules(live, w, { controlled: "player" }));
        }
        expect(w.spawns).toHaveLength(1);
        expect(w.cells.get(cellKey("map", 1, 0))).toBe(2);
    });
});

describe("playBounds — a declared screen pins the run's vertical extent", () => {
    it("closes the slice-30 defect: decoration below the floor stops moving the death plane", () => {
        // MEASURED TWICE BEFORE THIS EXISTED: an empty trailing scenery row moved `contentBounds`
        // from 252 to 270, and a floor deepened for looks moved it to 900 — tripling how long a
        // pit took to kill (0.47s to 1.27s). The play area must be a STATEMENT, not a measurement.
        const decorated = { x: -18, y: 0, width: 3618, height: 900 };
        const held = playBounds(decorated, { width: 432, height: 252 });
        expect(held).toEqual({ x: -18, y: 0, width: 3618, height: 252 });
        // The HORIZONTAL span stays measured — a side-scroller is as LONG as its content but as
        // TALL as one screen; SMB1 scrolls five screens of length and not one pixel of height.
        expect(held!.x).toBe(decorated.x);
        expect(held!.width).toBe(decorated.width);
    });

    it("without a screen it IS the content — every pre-72 level plays identically", () => {
        const content = { x: -18, y: 0, width: 3618, height: 270 };
        expect(playBounds(content)).toBe(content);
        expect(playBounds(content, undefined)).toBe(content);
        expect(playBounds(null)).toBeNull();
        // …and an empty document with a screen is one screen — there is nothing else to measure.
        expect(playBounds(null, { width: 432, height: 252 }))
            .toEqual({ x: 0, y: 0, width: 432, height: 252 });
    });

    it("REACHES THE RUN: the fall that took three times as long is short again", () => {
        // The same fixture shape the deepened level had — a floor with a pit, and dirt drawn far
        // below it — stepped through the REAL rules with and without a declared screen. Without,
        // the body must fall past the decoration's bottom to die; with, it dies at the screen's.
        const doc = docWith([
            { id: "floorL", x: 0, y: 200, w: 100, h: 700, userData: { bodyType: prop("static") } },
            { id: "floorR", x: 150, y: 200, w: 100, h: 700, userData: { bodyType: prop("static") } },
            { id: "hero", x: 110, y: 180, w: 18, h: 18, userData: { bodyType: prop("dynamic") } }
        ]);
        const content = { x: 0, y: 0, width: 250, height: 900 };   // the decoration's extent
        const fallTime = (bounds: { x: number; y: number; width: number; height: number }) => {
            let w = worldFrom(doc);
            for (let i = 0; i < 600; i++) {
                w = stepWorld(doc, w, { controlled: "hero", input: { left: false, right: false, jump: false } });
                w = applyCommands(w, marioRules(doc, w, { controlled: "hero", bounds }));
                if (w.outcome !== "running") return i;
            }
            return -1;
        };
        const slow = fallTime(content);
        const fast = fallTime(playBounds(content, { width: 250, height: 220 })!);
        expect(fast).toBeGreaterThan(0);
        // Dying at the screen's bottom instead of the decoration's is what "faster" means here —
        // the margin is real (hundreds of pixels of extra fall), not a rounding artefact.
        expect(fast).toBeLessThan(slow / 2);
    });

    it("…and the APP asks it, or the field changes nothing anybody can see", () => {
        const app = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(app).toMatch(/playBounds\(contentBounds\(computed\), dispatcher\.getDocument\(\)\.screen\)/);
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
        // A HIDDEN TEMPLATE SPAWNS VISIBLE COPIES. Hiding it is the only way to keep a template out
        // of the picture, and the spread copied the flag through — so every spawn was invisible and
        // `dropHidden` took it out of the scene entirely. The one field a copy must not inherit.
        const tucked = withTemplate();
        (tucked.nodes.get("coin") as Node).hidden = true;
        const tw = applyCommands(worldFrom(tucked), [{ kind: "spawn", templateId: "coin", x: 1, y: 2 }]);
        expect((applySpawns(tucked, tw).nodes.get("coin#0") as Node).hidden).toBeUndefined();
        // …and the template itself stays hidden, which is the whole reason it was marked.
        expect((applySpawns(tucked, tw).nodes.get("coin") as Node).hidden).toBe(true);
    });

    it("IS NAMED IN THE DIRTY SET, or it draws where it was thrown for ever", () => {
        // MEASURED IN THE RUNNING APP, not reasoned about: a coin thrown out of a block arced
        // through its whole flight in the world — 24px up and back down over half a second — and did
        // not move one pixel on screen. `applyWorld` had written the right position on every one of
        // those frames; `movedIds` was asked against the STORED document, a spawned node is in no
        // stored document, and so it answered "no such node" for the one node the frame had just
        // invented. The incremental geometry then kept the matrix it first drew.
        //
        // THE FIFTH STALE-DIRTY-SET DEFECT HERE, which is why the fix is inside the question rather
        // than at the call site: this passes the STORED document, exactly as `App` does, and still
        // expects the coin to be named.
        const doc = withTemplate();
        const spawned = applyCommands(worldFrom(doc), [
            { kind: "spawn", templateId: "coin", x: 100, y: 50, body: { vx: 0, vy: -200 } }]);
        // On the frame it appears it IS at its spawn point, so there is nothing stale to redraw.
        expect(movedIds(doc, spawned).has("coin#0")).toBe(false);
        const moved = stepWorld(applySpawns(doc, spawned), spawned);
        expect(moved.bodies.get("coin#0")!.y).toBeLessThan(50);          // it really did move…
        expect(movedIds(doc, moved, spawned).has("coin#0")).toBe(true);  // …and the set says so
        expect(doc.nodes.has("coin#0")).toBe(false);                     // nothing written back
    });

    it("…and a spawned body that TURNS is named by the other half", () => {
        // `facedIds` was blind the same way, and a thrown thing facing the way it was thrown has
        // not moved a pixel on the frame it appears — so `movedIds` alone could never name it.
        const doc = withTemplate();
        const w = applyCommands(worldFrom(doc), [
            { kind: "spawn", templateId: "coin", x: 100, y: 50, body: { vx: -30, vy: 0 } }]);
        expect(w.bodies.get("coin#0")!.facing).toBe(-1);
        expect(facedIds(doc, w).has("coin#0")).toBe(true);
        // …AND IT IS STILL COMPARING, rather than naming every spawn it finds. A template already
        // authored mirrored spawns a copy that is already facing the right way, and a set that
        // named it anyway would be a dirty set nobody could trust to be small.
        const mirrored = withTemplate();
        (mirrored.nodes.get("coin") as Node).transform = { scaleX: -1 };
        const mw = applyCommands(worldFrom(mirrored), [
            { kind: "spawn", templateId: "coin", x: 100, y: 50, body: { vx: -30, vy: 0 } }]);
        expect(facedIds(mirrored, mw).has("coin#0")).toBe(false);
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

    it("A SPAWNED COIN CAN BE COLLECTED, which is the loop closing", () => {
        // MADE AND THEN TAKEN AWAY, through the whole chain: spawn puts a classed region where the
        // body already is, the enter edge fires, the rule reads the part's own `vde.collect`, and
        // the despawn stops `applySpawns` materialising it at all.
        const doc = docWith([
            { id: "coin", x: 0, y: 0, w: 8, h: 8, className: "coin",
              userData: { "vde.collect": prop("true") } },
            { id: "a", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = applyCommands(worldFrom(doc), [{ kind: "spawn", templateId: "coin", x: 0, y: 0 }]);
        expect(applySpawns(doc, w).nodes.has("coin#0")).toBe(true);

        const live = applySpawns(doc, w);
        w = stepWorld(live, w, { controlled: "a" });
        expect(w.events.filter(e => e.kind === "enter" && e.nodeId === "coin#0")).toHaveLength(1);
        w = applyCommands(w, marioRules(live, w, { controlled: "a" }));
        expect([...w.despawned]).toContain("coin#0");
        // GONE FROM THE SCENE ENTIRELY, not merely hidden: stamping `hidden` the way `applyWorld`
        // does would leave an invisible region still reporting enters.
        expect(applySpawns(doc, w).nodes.has("coin#0")).toBe(false);
        // …and it is not reported as a region any more, which is what "collected" has to mean.
        expect(regionsOf(applySpawns(doc, w)).map(r => r.nodeId)).toEqual(["coin"]);
        // A TEMPLATE THAT DECLARES NOTHING IS NOT COLLECTIBLE, so a spawned platform stays put.
        expect(partOf(doc.nodes.get("coin")!).collectible).toBe(true);
    });

    it("A SPAWN THAT ASKED TO MOVE BECOMES A BODY, minted like every other one", () => {
        // `worldFrom` establishes bodies ONCE, at Play, so a node that appears later never becomes
        // one — and `applySpawns` cannot fix that, because it returns a DOCUMENT. Letting a derive
        // write to `world.bodies` would give the runtime a second producer of world state, and
        // `stepWorld` plus `applyCommands` being the only two is what makes a run replayable.
        const doc = withTemplate();
        const w = applyCommands(worldFrom(doc), [
            { kind: "spawn", templateId: "coin", x: 40, y: 60, body: { vx: 0, vy: -216 } }
        ]);
        const made = w.bodies.get("coin#0")!;
        expect(made).toEqual({ x: 40, y: 60, vx: 0, vy: -216, onGround: false,
                               groundFriction: 1, blockedX: false, facing: 1, travelled: 0, power: 0 });
        // …and it MOVES, which is the whole difference from a region appearing.
        const stepped = stepWorld(applySpawns(doc, w), w);
        expect(stepped.bodies.get("coin#0")!.y).toBeLessThan(60);

        // A SPAWN THAT ASKED FOR NOTHING IS NOT A BODY, so a coin sitting in a niche stays a region.
        const still = applyCommands(worldFrom(doc), [{ kind: "spawn", templateId: "coin", x: 0, y: 0 }]);
        expect(still.bodies.has("coin#0")).toBe(false);
        // FACING COMES FROM THE VELOCITY, like every other body's does.
        const left = applyCommands(worldFrom(doc), [
            { kind: "spawn", templateId: "coin", x: 0, y: 0, body: { vx: -50, vy: 0 } }
        ]);
        expect(left.bodies.get("coin#0")!.facing).toBe(-1);
    });

    it("A BODY coin is collected too, not only a region one", () => {
        // Slice 27 let a spawned thing MOVE, and a moving thing is a BODY — so touching it reports
        // `contact`, not `enter`. Reading only enters made exactly the coin the block throws out
        // uncollectable, which is the shape a level actually uses.
        const doc = docWith([
            { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "coin", x: 0, y: 88, w: 10, h: 10, className: "coin",
              userData: { bodyType: prop("dynamic"), "vde.collect": prop("true") } },
            { id: "hero", x: 4, y: 88, w: 10, h: 10, userData: { bodyType: prop("dynamic") } }
        ]);
        let w = worldFrom(doc);
        let got = false;
        for (let i = 0; i < 30 && !got; i++) {
            w = stepWorld(doc, w, { controlled: "hero" });
            const cmds = marioRules(doc, w, { controlled: "hero" });
            got = cmds.some(c => c.kind === "despawn" && c.bodyId === "coin");
            w = applyCommands(w, cmds);
        }
        expect(got).toBe(true);
        expect(w.bodies.has("coin")).toBe(false);
        expect([...w.despawned]).toContain("coin");
        // AND A BODY THAT DECLARES NOTHING IS NOT COLLECTED, so an ordinary crate survives being
        // walked into — the declaration is what decides, not the fact of touching.
        const plain = docWith([
            { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "crate", x: 0, y: 88, w: 10, h: 10, userData: { bodyType: prop("dynamic") } },
            { id: "hero", x: 4, y: 88, w: 10, h: 10, userData: { bodyType: prop("dynamic") } }
        ]);
        let p2 = worldFrom(plain);
        for (let i = 0; i < 30; i++) {
            p2 = stepWorld(plain, p2, { controlled: "hero" });
            p2 = applyCommands(p2, marioRules(plain, p2, { controlled: "hero" }));
        }
        expect(p2.bodies.has("crate")).toBe(true);
    });

    it("and the APP steps against the spawned document, not the stored one", () => {
        const app = readFileSync(resolve(__dirname, "../../app/App.tsx"), "utf8");
        expect(app).toMatch(/const live = applyCells\(applySpawns\(base, world\), world\)/);
        expect(app).toMatch(/stepWorld\(live, world/);
        // BOTH halves: it must feed the picture too, or a coin is collided with and never seen.
        expect(app).toMatch(/applyWorld\(applySpawns\(timed, world\)/);
    });
});
