/**
 * @module World.test
 * @description The runtime's first slice — every number here is hand-computed from the constants.
 *
 * WHY HAND-COMPUTED: the alternative is asserting whatever the implementation printed, which agrees
 * with a wrong implementation by construction. Gravity is 900 px/s² and a step is 1/60s, so one step
 * adds exactly 15 px/s of downward speed and moves a resting body 0.25 px. Those two numbers are the
 * whole of the arithmetic and every expectation below is built from them.
 */
import { createEmptyDocument, ProjectDocument } from "../document/Document";
import { Node, UserData } from "../document/Node";
import {
    FIXED_STEP, MAX_STEPS_PER_FRAME, DEFAULT_GRAVITY, MAX_FALL_SPEED, MOVE_SPEED, JUMP_HEIGHT,
    NO_INPUT, Input, WorldState, jumpSpeedFor,
    bodyTypeOf, worldFrom, solidsOf, stepWorld, applyWorld, movedIds, stepsFor, propertyOf
} from "./World";

const prop = (v: string, type = "string") => ({ type, value: v });

function docWith(nodes: { id: string; x: number; y: number; w?: number; h?: number;
                          userData?: UserData }[]): ProjectDocument {
    const doc = createEmptyDocument();
    for (const n of nodes) {
        doc.nodes.set(n.id, {
            id: n.id, type: "core.rectangle", parent: null, children: [],
            geometry: { x: n.x, y: n.y, width: n.w ?? 10, height: n.h ?? 10 },
            style: { fill: "#888", opacity: 1 }, layout: {},
            ...(n.userData ? { userData: n.userData } : {})
        } as Node);
        doc.rootNodeUuids.push(n.id);
    }
    return doc;
}

/** Run `n` steps, which is what a caller's accumulator does. */
function steps(doc: ProjectDocument, world: WorldState, n: number): WorldState {
    let w = world;
    for (let i = 0; i < n; i++) w = stepWorld(doc, w);
    return w;
}

describe("what counts as a body", () => {
    it("reads bodyType from userData — the field the art already uses", () => {
        // MEASURED: `bodyType` is the most-declared property in the corpus (51 of 138), and the
        // level's real collision geometry carries nothing else at all.
        expect(bodyTypeOf({ userData: { bodyType: prop("static") } })).toBe("static");
        expect(bodyTypeOf({ userData: { bodyType: prop("dynamic") } })).toBe("dynamic");
        // 216 of the corpus's 248 objects say nothing — they must cost nothing and be no body.
        expect(bodyTypeOf({})).toBeNull();
        expect(bodyTypeOf({ userData: { friction: prop("1.00") } })).toBeNull();
        // A VALUE THAT IS NOT A BODY TYPE is not a body either, rather than a third kind.
        expect(bodyTypeOf({ userData: { bodyType: prop("kinematic") } })).toBeNull();
    });

    it("reads the value however the file declared it — the corpus disagrees with itself", () => {
        // The same NAME is declared with two types inside one map: friction is `type="float"` 17
        // times and untyped 28 times. A reader keyed on the declared type drops most of the data.
        expect(propertyOf({ friction: prop("0.45", "float") }, "friction")).toBe("0.45");
        expect(propertyOf({ friction: prop("0.45") }, "friction")).toBe("0.45");
        expect(propertyOf(undefined, "friction")).toBeNull();
        // …and casing and stray space are the author's, not the runtime's business.
        expect(bodyTypeOf({ userData: { bodyType: prop(" Static ") } })).toBe("static");
    });

    it("puts only DYNAMIC bodies in the world, and only STATIC ones in the solids", () => {
        const doc = docWith([
            { id: "crate", x: 10, y: 20, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: 0, y: 100, w: 200, h: 10, userData: { bodyType: prop("static") } },
            { id: "decor", x: 5, y: 5 }
        ]);
        const world = worldFrom(doc);
        expect([...world.bodies.keys()]).toEqual(["crate"]);
        // AT REST, WHERE THE DOCUMENT PUTS IT — the world does not invent a position.
        expect(world.bodies.get("crate")).toEqual({ x: 10, y: 20, vx: 0, vy: 0, onGround: false });
        expect(world.time).toBe(0);
        // A STATIC BODY IS NOT IN THE WORLD, because its position is the document's to state and
        // two copies of one fact can disagree the moment somebody edits the level.
        expect(solidsOf(doc)).toEqual([{ x: 0, y: 100, width: 200, height: 10 }]);
    });

    it("ignores a zero-area solid, which an author passes through while dragging one out", () => {
        const doc = docWith([{ id: "flat", x: 0, y: 0, w: 100, h: 0,
            userData: { bodyType: prop("static") } }]);
        expect(solidsOf(doc)).toEqual([]);
    });
});

describe("one step of gravity", () => {
    it("adds exactly g*dt to the speed and moves by the NEW speed", () => {
        // 900 * 1/60 = 15 px/s after one step; the position moves by 15 * 1/60 = 0.25 px.
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const one = stepWorld(doc, worldFrom(doc));
        expect(one.bodies.get("b")!.vy).toBeCloseTo(15, 10);
        expect(one.bodies.get("b")!.y).toBeCloseTo(0.25, 10);
        expect(one.time).toBeCloseTo(FIXED_STEP, 10);
        // …and a second step: 30 px/s, and 0.25 + 0.5 = 0.75 px down.
        const two = stepWorld(doc, one);
        expect(two.bodies.get("b")!.vy).toBeCloseTo(30, 10);
        expect(two.bodies.get("b")!.y).toBeCloseTo(0.75, 10);
    });

    it("is FRAME-RATE INDEPENDENT, which is the whole reason the step is fixed", () => {
        // Sixty steps is one second whoever asked for them. A variable delta would make this
        // depend on how the caller chopped the second up — the classic way a game plays
        // differently on a fast machine.
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const after = steps(doc, worldFrom(doc), 60);
        expect(after.bodies.get("b")!.vy).toBeCloseTo(DEFAULT_GRAVITY, 6);
        expect(after.time).toBeCloseTo(1, 10);
        // Sum of 0.25*k for k=1..60 = 0.25 * 60*61/2 = 457.5 — the discrete integral, not 450.
        // Stating the DISCRETE answer is the point: 450 would be the continuous one, and a test
        // asserting it would be quietly wrong about what a fixed step does.
        expect(after.bodies.get("b")!.y).toBeCloseTo(457.5, 6);
    });

    it("takes the gravity it is given, so a test is not hostage to the default", () => {
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        expect(stepWorld(doc, worldFrom(doc), { gravity: 0 }).bodies.get("b")!.vy).toBe(0);
        expect(stepWorld(doc, worldFrom(doc), { gravity: 600 }).bodies.get("b")!.vy).toBeCloseTo(10, 10);
    });
});

describe("landing on something solid", () => {
    /** A 10x10 body 100 above a floor at y=100. */
    const level = () => docWith([
        { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
        { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } }
    ]);

    it("stops ON the floor rather than in it, and says it is on the ground", () => {
        const doc = level();
        const after = steps(doc, worldFrom(doc), 120);       // two seconds: long past landing
        const b = after.bodies.get("b")!;
        // THE BODY'S BOTTOM IS THE FLOOR'S TOP: y = 100 - 10. Not 100, which would bury it by its
        // own height, and not 90.25, which would be "stopped near the floor".
        expect(b.y).toBe(90);
        expect(b.vy).toBe(0);
        expect(b.onGround).toBe(true);
    });

    it("does not fall THROUGH the floor at speed", () => {
        // A DEEP-ENOUGH floor, which is the case that must work: by impact the body is doing about
        // 1200 px/s — 20 px per step — and the floor is 20 px thick, so the overlap is caught. The
        // test below pins what happens when a floor is THINNER than that.
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 800, w: 400, h: 20, userData: { bodyType: prop("static") } }
        ]);
        const after = steps(doc, worldFrom(doc), 300);
        expect(after.bodies.get("b")!.y).toBe(790);
        expect(after.bodies.get("b")!.onGround).toBe(true);
    });

    it("TUNNELS through a solid thinner than one step's travel — a known, measured limit", () => {
        // Collision here is discrete: move, then resolve. Nothing sweeps the path, so a solid
        // thinner than the distance covered in one step is never overlapped and never seen. This
        // test exists so the limit is a KNOWN SHAPE rather than something found in a level later.
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "hairline", x: -100, y: 800, w: 400, h: 2, userData: { bodyType: prop("static") } }
        ]);
        const after = steps(doc, worldFrom(doc), 300);
        expect(after.bodies.get("b")!.y).toBeGreaterThan(800);      // straight through it
        expect(after.bodies.get("b")!.onGround).toBe(false);

        // AND THE RULE THAT MAKES A LEVEL SAFE, asserted rather than described: the same fall onto
        // a solid DEEPER than the per-step travel lands. At impact the body is doing about
        // sqrt(2*900*800) = 1200 px/s, which is 20px per step — so 24px is enough and 2px is not.
        const thick = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 800, w: 400, h: 24, userData: { bodyType: prop("static") } }
        ]);
        const landed = steps(thick, worldFrom(thick), 300);
        expect(landed.bodies.get("b")!.y).toBe(790);
        expect(landed.bodies.get("b")!.onGround).toBe(true);
        // Every solid in the measured corpus is thicker than this — the `bounds` rectangles are
        // 32px and up — so real levels are inside the rule and a hairline drawn by hand is not.
    });

    it("a body that is NOT resting says so, which is what a jump would ask", () => {
        const doc = level();
        const one = stepWorld(doc, worldFrom(doc));
        expect(one.bodies.get("b")!.onGround).toBe(false);
    });

    it("resolves the two axes separately, so a body slides along a seam", () => {
        // TWO FLOOR TILES SIDE BY SIDE with a shared edge at x=100 — the ordinary way a level is
        // built. A body moving right along them must not catch on the seam. Resolving both axes at
        // once cannot tell which one caused an overlap, and snags here.
        const doc = docWith([
            { id: "b", x: 90, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "t1", x: 0, y: 100, w: 100, h: 20, userData: { bodyType: prop("static") } },
            { id: "t2", x: 100, y: 100, w: 100, h: 20, userData: { bodyType: prop("static") } }
        ]);
        let w = worldFrom(doc);
        w = { ...w, bodies: new Map(w.bodies).set("b", { ...w.bodies.get("b")!, vx: 60 }) };
        w = steps(doc, w, 60);                                // one second at 60 px/s
        const b = w.bodies.get("b")!;
        expect(b.onGround).toBe(true);
        expect(b.y).toBe(90);
        // IT KEPT MOVING: 90 + 60 = 150, straight across the seam at x=100.
        expect(b.x).toBeCloseTo(150, 6);
        expect(b.vx).toBe(60);
    });

    it("stops against a WALL and keeps its footing", () => {
        const doc = docWith([
            { id: "b", x: 0, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } },
            { id: "wall", x: 50, y: 0, w: 20, h: 120, userData: { bodyType: prop("static") } }
        ]);
        let w = worldFrom(doc);
        w = { ...w, bodies: new Map(w.bodies).set("b", { ...w.bodies.get("b")!, vx: 300 }) };
        w = steps(doc, w, 60);
        const b = w.bodies.get("b")!;
        // Its right edge meets the wall's left: x = 50 - 10.
        expect(b.x).toBe(40);
        expect(b.vx).toBe(0);
        expect(b.onGround).toBe(true);
    });
});

describe("the world reaches the document without touching it", () => {
    it("returns a NEW document, leaves the stored one alone, and copies only what moved", () => {
        const doc = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "still", x: 7, y: 7 }
        ]);
        const world = steps(doc, worldFrom(doc), 4);          // 0.25+0.5+0.75+1.0 = 2.5 px down
        const shown = applyWorld(doc, world);
        expect(shown).not.toBe(doc);
        expect(shown.nodes.get("b")!.geometry.y).toBeCloseTo(2.5, 10);
        // THE STORED DOCUMENT IS UNTOUCHED — this is the whole bargain, and undo depends on it.
        expect(doc.nodes.get("b")!.geometry.y).toBe(0);
        // AND THE NODE THAT DID NOT MOVE IS THE SAME OBJECT, which is what lets the caller hand
        // `computeGeometry` a dirty set and reuse everything else — measured at 3-4.6x.
        expect(shown.nodes.get("still")).toBe(doc.nodes.get("still"));
        expect(movedIds(doc, world)).toEqual(new Set(["b"]));
    });

    it("hands BACK THE SAME DOCUMENT when nothing moved, so an idle run costs nothing", () => {
        const doc = docWith([{ id: "still", x: 7, y: 7 }]);
        const world = worldFrom(doc);
        expect(world.bodies.size).toBe(0);
        expect(applyWorld(doc, world)).toBe(doc);
        expect(movedIds(doc, world).size).toBe(0);
        // …and a body that has not yet moved is the same case, not a copy of the whole map.
        const resting = docWith([{ id: "b", x: 1, y: 2, userData: { bodyType: prop("dynamic") } }]);
        expect(applyWorld(resting, worldFrom(resting))).toBe(resting);
    });

    it("a body whose node was deleted mid-run freezes rather than taking the run down", () => {
        // The inert-reference rule this schema follows everywhere: a reference that stops resolving
        // does nothing. Deleting a node while playing must not throw.
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        const world = steps(doc, worldFrom(doc), 3);
        const gone = docWith([]);
        const after = stepWorld(gone, world);
        expect(after.bodies.get("b")).toEqual(world.bodies.get("b"));
        expect(applyWorld(gone, after)).toBe(gone);
    });
});

describe("the accumulator", () => {
    it("spends whole steps and CARRIES the remainder", () => {
        // A 59.94Hz display gives 16.68ms frames. Dropping the remainder each time makes the world
        // run measurably slow; carrying it spends a whole extra step every few seconds.
        const a = stepsFor(0, 0.01668);
        expect(a.steps).toBe(1);
        expect(a.accumulator).toBeCloseTo(0.01668 - FIXED_STEP, 10);
        const b = stepsFor(a.accumulator, 0.01668);
        expect(b.steps).toBe(1);
        expect(b.accumulator).toBeCloseTo(2 * 0.01668 - 2 * FIXED_STEP, 10);
        // A gap shorter than a step spends nothing and owes it forward.
        const c = stepsFor(0, 0.001);
        expect(c.steps).toBe(0);
        expect(c.accumulator).toBeCloseTo(0.001, 10);
    });

    it("CAPS a long gap and reports what it dropped, rather than spiralling", () => {
        // A backgrounded tab: ten seconds is 600 steps, each of which costs a derivation. Running
        // them all would hang the frame that resumes and earn an even bigger gap next time.
        const r = stepsFor(0, 10);
        expect(r.steps).toBe(MAX_STEPS_PER_FRAME);
        expect(r.dropped).toBe(600 - MAX_STEPS_PER_FRAME);
        // THE DEBT IS NOT OWED BACK. Keeping it would spend the cap again next frame, for as many
        // frames as it takes — the same spiral, in instalments.
        expect(r.accumulator).toBe(0);
    });

    it("refuses a clock that went backwards or produced nonsense", () => {
        // `Date.now()` can step backwards over an NTP correction, and a first frame can arrive with
        // no previous timestamp at all. Neither may run the world in reverse.
        expect(stepsFor(0.005, -1)).toEqual({ steps: 0, accumulator: 0.005, dropped: 0 });
        expect(stepsFor(0.005, Number.NaN)).toEqual({ steps: 0, accumulator: 0.005, dropped: 0 });
    });
});

describe("input — the controlled body, and only it", () => {
    /** Two dynamic bodies on a wide floor, so "only the controlled one" is checkable. */
    const level = () => docWith([
        { id: "hero", x: 100, y: 90, userData: { bodyType: prop("dynamic") } },
        { id: "other", x: 300, y: 90, userData: { bodyType: prop("dynamic") } },
        { id: "floor", x: -500, y: 100, w: 2000, h: 20, userData: { bodyType: prop("static") } }
    ]);
    /** Settle onto the floor first, so `onGround` is true before any input arrives. */
    const grounded = (doc: ProjectDocument) => steps(doc, worldFrom(doc), 5);
    const drive = (doc: ProjectDocument, w: WorldState, input: Input, n: number) => {
        let out = w;
        for (let i = 0; i < n; i++) out = stepWorld(doc, out, { input, controlled: "hero" });
        return out;
    };

    it("walks at a SET speed while held, and stops the moment it is not", () => {
        const doc = level();
        const w = grounded(doc);
        expect(w.bodies.get("hero")!.onGround).toBe(true);
        // 60 steps at 220 px/s is one second and 220 px — a speed you HAVE, not one you build up.
        const walked = drive(doc, w, { left: false, right: true, jump: false }, 60);
        expect(walked.bodies.get("hero")!.x).toBeCloseTo(100 + MOVE_SPEED, 6);
        expect(walked.bodies.get("hero")!.vx).toBe(MOVE_SPEED);
        // RELEASED it stops dead rather than sliding — the difference between a platformer and ice.
        expect(drive(doc, walked, NO_INPUT, 1).bodies.get("hero")!.vx).toBe(0);
        // …and left mirrors right, which is what makes MOVE_SPEED a speed rather than an offset.
        expect(drive(doc, w, { left: true, right: false, jump: false }, 60).bodies.get("hero")!.x)
            .toBeCloseTo(100 - MOVE_SPEED, 6);
        // BOTH AT ONCE cancels, rather than one winning by an accident of evaluation order.
        expect(drive(doc, w, { left: true, right: true, jump: false }, 10).bodies.get("hero")!.vx).toBe(0);
    });

    it("ONLY the controlled body is driven — the rest fall as they always did", () => {
        const doc = level();
        const w = drive(doc, grounded(doc), { left: false, right: true, jump: true }, 30);
        expect(w.bodies.get("hero")!.vx).toBe(MOVE_SPEED);
        // The other dynamic body took no input at all: still where it landed, still grounded.
        expect(w.bodies.get("other")!.vx).toBe(0);
        expect(w.bodies.get("other")!.x).toBe(300);
        expect(w.bodies.get("other")!.onGround).toBe(true);
    });

    it("jumps to the stated HEIGHT, which is the number a level is built from", () => {
        const doc = level();
        const w = grounded(doc);
        const y0 = w.bodies.get("hero")!.y;
        // v = sqrt(2*g*h): the speed that reaches exactly JUMP_HEIGHT under this gravity.
        expect(jumpSpeedFor(72, 900)).toBeCloseTo(360, 6);
        let jumping = stepWorld(doc, w, {
            input: { left: false, right: false, jump: true }, controlled: "hero" });
        // EXACTLY the launch speed: the jump SETS vy rather than adding to it, so that step's
        // gravity is discarded. That is what makes `jumpSpeedFor` mean what it says — adding would
        // make the real launch speed depend on the step size, and the peak below would drift.
        expect(jumping.bodies.get("hero")!.vy).toBeCloseTo(-jumpSpeedFor(), 6);
        let peak = jumping.bodies.get("hero")!.y;
        for (let i = 0; i < 60; i++) {
            jumping = stepWorld(doc, jumping, { input: NO_INPUT, controlled: "hero" });
            peak = Math.min(peak, jumping.bodies.get("hero")!.y);
        }
        // WITHIN A STEP'S WORTH of the stated height: a discrete integrator overshoots slightly,
        // and asserting the exact continuous number would be asserting the wrong model.
        expect(y0 - peak).toBeGreaterThan(JUMP_HEIGHT - 6);
        expect(y0 - peak).toBeLessThan(JUMP_HEIGHT + 6);
        // …and it comes back down to exactly where it started, on the ground.
        expect(jumping.bodies.get("hero")!.y).toBe(y0);
        expect(jumping.bodies.get("hero")!.onGround).toBe(true);
    });

    it("a HELD jump is ONE jump — the press is an edge, not a state", () => {
        const doc = level();
        const w = grounded(doc);
        const y0 = w.bodies.get("hero")!.y;
        // Hold it for two seconds. Without the edge the body re-launches on every grounded step
        // and bunny-hops for as long as the button is down.
        let held = w;
        let landings = 0, wasAir = false;
        for (let i = 0; i < 120; i++) {
            held = stepWorld(doc, held, {
                input: { left: false, right: false, jump: true }, controlled: "hero" });
            const b = held.bodies.get("hero")!;
            if (wasAir && b.onGround) landings++;
            wasAir = !b.onGround;
        }
        expect(landings).toBe(1);
        expect(held.bodies.get("hero")!.y).toBe(y0);

        // RELEASE AND PRESS AGAIN jumps a second time, or the edge would be a one-shot.
        let again = stepWorld(doc, held, { input: NO_INPUT, controlled: "hero" });
        again = stepWorld(doc, again, {
            input: { left: false, right: false, jump: true }, controlled: "hero" });
        expect(again.bodies.get("hero")!.vy).toBeLessThan(-300);
    });

    it("cannot jump in mid-air, which is what `onGround` was for", () => {
        const doc = level();
        let w = grounded(doc);
        w = stepWorld(doc, w, { input: { left: false, right: false, jump: true }, controlled: "hero" });
        const rising = w.bodies.get("hero")!.vy;
        for (let i = 0; i < 10; i++) {
            w = stepWorld(doc, w, { input: NO_INPUT, controlled: "hero" });
            w = stepWorld(doc, w, {
                input: { left: false, right: false, jump: true }, controlled: "hero" });
        }
        // Still falling under gravity from the ONE jump — never re-launched mid-air.
        expect(w.bodies.get("hero")!.vy).toBeGreaterThan(rising);
        expect(w.bodies.get("hero")!.onGround).toBe(false);
    });

    it("no controlled id means nothing is driven, which is the default", () => {
        const doc = level();
        const w = stepWorld(doc, grounded(doc), { input: { left: false, right: true, jump: true } });
        expect(w.bodies.get("hero")!.vx).toBe(0);
    });
});

describe("terminal velocity, a COLLISION bound before it is a feel decision", () => {
    it("caps the fall, so one step's travel is a constant rather than a function of the drop", () => {
        const doc = docWith([{ id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } }]);
        // Uncapped, ten seconds of falling is 9,000 px/s — 150 px a step, and a solid would need to
        // be 150 px thick to catch it. Capped, the travel is 20 px however long the fall.
        expect(steps(doc, worldFrom(doc), 600).bodies.get("b")!.vy).toBe(MAX_FALL_SPEED);
        expect(MAX_FALL_SPEED * FIXED_STEP).toBe(20);
    });

    it("makes a 20px solid safe at ANY speed, which the 2px one still is not", () => {
        // Slice 1's limit was "as deep as the fastest body's travel", which grew with the fall.
        // It is now a constant, and this is the pair that says so.
        const deep = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 4000, w: 400, h: 20, userData: { bodyType: prop("static") } }
        ]);
        const landed = steps(deep, worldFrom(deep), 1200);      // twenty seconds of falling
        expect(landed.bodies.get("b")!.y).toBe(3990);
        expect(landed.bodies.get("b")!.onGround).toBe(true);
        // …and the hairline is still passed through, which is the honest half of the same rule.
        const thin = docWith([
            { id: "b", x: 0, y: 0, userData: { bodyType: prop("dynamic") } },
            { id: "hair", x: -100, y: 4000, w: 400, h: 2, userData: { bodyType: prop("static") } }
        ]);
        expect(steps(thin, worldFrom(thin), 1200).bodies.get("b")!.y).toBeGreaterThan(4000);
    });

    it("does not cap the RISE, or a falling rule would clip a jump", () => {
        const doc = docWith([
            { id: "b", x: 0, y: 90, userData: { bodyType: prop("dynamic") } },
            { id: "floor", x: -100, y: 100, w: 400, h: 20, userData: { bodyType: prop("static") } }
        ]);
        const w = stepWorld(doc, steps(doc, worldFrom(doc), 5),
            { input: { left: false, right: false, jump: true }, controlled: "b" });
        expect(w.bodies.get("b")!.vy).toBeLessThan(-300);

        // AND THE CAP MUST BE DIRECTIONAL, which the assertion above CANNOT see: the ordinary jump
        // launches at 360 px/s and the cap is 1200, so a cap written `Math.abs(vy) > MAX` never
        // fires and survives. A mutant said so. Seeing it needs a rise FASTER than the cap, which
        // a strong gravity produces — sqrt(2 * 20000 * 72) is about 1697 px/s. Applied to the rise,
        // the cap would turn that launch into a fall at +1200 on the very step it happened.
        const strong = { gravity: 20000, input: { left: false, right: false, jump: true },
            controlled: "b" };
        const hard = stepWorld(doc, steps(doc, worldFrom(doc), 5), strong);
        expect(jumpSpeedFor(JUMP_HEIGHT, 20000)).toBeGreaterThan(MAX_FALL_SPEED);
        expect(hard.bodies.get("b")!.vy).toBeCloseTo(-jumpSpeedFor(JUMP_HEIGHT, 20000), 6);
        expect(hard.bodies.get("b")!.vy).toBeLessThan(-MAX_FALL_SPEED);
    });
});
