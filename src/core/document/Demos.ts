/**
 * @module Demos
 * @description The exercises animators actually learn on, as real documents.
 *
 * A square sliding across the canvas proves the tween runs. It does not prove the engine can make
 * anything an animator would recognise, and those are different claims — the second one is only
 * settled by building the things people build. So these are the canonical teaching exercises, in
 * the order they are usually taught, each chosen because it stresses a DIFFERENT capability:
 *
 *   - BOUNCING BALL — the first exercise everybody does. Timing, spacing, arcs, squash and
 *     stretch, and the fact that horizontal motion is UNIFORM while vertical is not.
 *   - JUMPING SQUARE — anticipation, follow-through and weight. The crouch before the launch is
 *     the whole lesson, and it is the exercise that shows whether easing can be authored per
 *     keyframe rather than per animation.
 *   - PENDULUM — arcs and overlapping action, driven by rotation rather than position.
 *   - CEL SEQUENCE — frame-by-frame drawing with HELD keyframes, which is how sprite animation
 *     and traditional cel work are made, and the opposite of tweening.
 *
 * They are BUILDERS rather than saved files so they migrate with the schema like anything else, and
 * so the tests can assert what the motion actually does rather than that a fixture parsed. A demo
 * that cannot be checked is a screenshot, and this codebase already has enough of those.
 *
 * WHAT THEY ARE FOR, stated so nobody mistakes them for samples: finding HOLES. Building the
 * bouncing ball is what shows whether the engine can hold a ball's horizontal speed steady while
 * its vertical speed changes — and if it cannot, that is a feature gap discovered by an exercise
 * rather than by a user.
 */

import { ProjectDocument, createEmptyDocument } from "./Document";
import { Node } from "./Node";
import { Keyframe } from "./Timeline";
import { CubicBezier } from "./Bezier";
import { MotionPath } from "./MotionPath";
import { IkConstraint } from "./Rig";

/** Frames a demo runs for, and the rate it is authored at. 24 is the film convention. */
const FPS = 24;

/**
 * The anchor a standing thing deforms about: centred horizontally, on the GROUND vertically.
 *
 * Squash and stretch is a scale about the feet. Anything else lifts a character off the floor as
 * it compresses, which reads as a hop rather than as weight.
 */
const FEET = { x: 0.5, y: 1 };

/** The anchor a limb swings about — the top end, where the joint is. */
const JOINT = { x: 0.5, y: 0 };

/** Gravity's shape: fast at the bottom of a fall, slow at the top of a rise. */
const FALL: CubicBezier = { x1: 0.55, y1: 0, x2: 0.85, y2: 0.35 };      // accelerating
const RISE: CubicBezier = { x1: 0.15, y1: 0.65, x2: 0.45, y2: 1 };      // decelerating

function demo(name: string, frames: number, nodes: Node[]): ProjectDocument {
    const d = createEmptyDocument();
    d.metadata.project_name = name;
    d.timeline = { frames, fps: FPS };
    for (const n of nodes) d.nodes.set(n.id, n);
    d.rootNodeUuids = nodes.map(n => n.id);
    return d;
}

function ellipse(id: string, x: number, y: number, size: number, fill: string, track: Keyframe[]): Node {
    return { id, type: "core.ellipse", parent: null, children: [], name: id,
        geometry: { x, y, width: size, height: size },
        style: { fill, opacity: 1 }, layout: {}, track } as Node;
}

function rect(id: string, x: number, y: number, w: number, h: number, fill: string, track: Keyframe[]): Node {
    return { id, type: "core.rectangle", parent: null, children: [], name: id,
        geometry: { x, y, width: w, height: h },
        style: { fill, opacity: 1 }, layout: {}, track } as Node;
}

/**
 * THE BOUNCING BALL, two bounces losing height.
 *
 * The exercise every course opens with, and it is not chosen for being easy. It asks for two
 * different timings at once: the ball crosses the floor at a CONSTANT horizontal speed while its
 * vertical speed changes continuously — fast through the bottom, slow at the top. That is the whole
 * lesson about spacing, and it is why the drawings bunch up at the apex.
 *
 * SQUASH is at the contact frames only, and it conserves the ball's area rather than merely
 * flattening it: a ball that squashes without widening reads as deflating.
 */
export function bouncingBall(): ProjectDocument {
    const floor = 420, size = 80;
    // A FRACTION of the ball's size, because it is a scale rather than a distance now.
    const squash = 0.32;
    // Contact frames, chosen so each arc is shorter than the last — the ball is losing energy.
    const beats = [0, 12, 20, 28, 34, 40, 44];
    const apexes = [200, 300, 370];
    // X advances at a constant rate per FRAME, not a constant distance per BOUNCE. The beats get
    // shorter as the ball loses height, so a fixed step per beat would make it speed up sideways
    // exactly as it slows down vertically — which is the error the exercise is meant to teach
    // against. Caught by measuring the demo in the app after the engine was already right.
    const SPEED = 5;
    const track: Keyframe[] = [];
    for (let i = 0; i < beats.length; i++) {
        const x = 60 + SPEED * beats[i];
        const onGround = i % 2 === 0;
        const y = onGround ? floor : apexes[(i - 1) / 2];
        track.push({
            frame: beats[i],
            easing: onGround ? RISE : FALL,
            // The whole point of the exercise: the ball's HORIZONTAL speed never changes, while
            // its vertical speed changes constantly. One curve for the keyframe cannot say that,
            // and before `easings` existed this ball decelerated sideways as it rose.
            easings: { "geometry.x": "linear" },
            values: {
                geometry: { x, y },
                // SQUASH is a TRANSFORM about the ball's FEET, not a resize of its box. Scaling
                // about `origin: {0.5, 1}` keeps the contact point planted while the ball
                // flattens; resizing the box instead grows it out of its top-left corner and
                // every keyframe has to hand-compensate x and y to hide that. Wider by as much
                // as it is shorter, so the ball keeps its volume — squashing alone reads as a
                // puncture rather than an impact.
                transform: onGround
                    // VOLUME-CONSERVING, so the widening is the RECIPROCAL of the flattening
                    // rather than the same number added back. `1 + s` paired with `1 - s` loses
                    // area — at s = 0.32 the ball ends up a tenth smaller at every impact, which
                    // reads as it deflating a little each bounce.
                    ? { scaleX: 1 / (1 - squash), scaleY: 1 - squash, origin: FEET }
                    : { scaleX: 1, scaleY: 1, origin: FEET }
            }
        });
    }
    return demo("Bouncing ball", 48, [ellipse("ball", 60, floor, size, "#e0533d", track)]);
}

/**
 * THE JUMPING SQUARE — anticipation, launch, follow-through.
 *
 * The exercise that teaches weight. The crouch BEFORE the jump is anticipation, the stretch on the
 * way up is follow-through, and the landing squash is what makes the thing feel heavy rather than
 * floaty. Nothing here is about the shape; it is entirely about timing, which is why a square is
 * the right subject.
 */
export function jumpingSquare(): ProjectDocument {
    const ground = 400, w = 90, h = 90;
    // Deformation is TRANSFORM about the feet; placement is GEOMETRY. Authoring the crouch as a
    // width change instead would grow the square out of its left edge, and every keyframe would
    // carry arithmetic to hide it.
    const pose = (x: number, y: number, sx: number, sy: number) =>
        ({ geometry: { x, y }, transform: { scaleX: sx, scaleY: sy, origin: FEET } });
    const track: Keyframe[] = [
        { frame: 0, values: pose(120, ground, 1, 1) },
        // ANTICIPATION: squat and widen. The pause before a movement is what tells the eye it is
        // coming; without it the jump reads as a teleport.
        { frame: 8, easing: "ease-out", values: pose(120, ground, 1.25, 0.75) },
        // LAUNCH: stretch along the direction of travel.
        { frame: 12, easing: RISE, easings: { "geometry.x": "linear" }, values: pose(150, ground - 40, 0.82, 1.3) },
        { frame: 20, easing: FALL, easings: { "geometry.x": "linear" }, values: pose(230, 180, 1, 1) },
        { frame: 28, easing: "ease-out", easings: { "geometry.x": "linear" }, values: pose(310, ground, 0.88, 1.18) },
        // LANDING squash, then the settle — follow-through.
        { frame: 31, easing: "ease-out", values: pose(310, ground, 1.3, 0.7) },
        { frame: 40, values: pose(310, ground, 1, 1) }
    ];
    return demo("Jumping square", 48, [rect("jumper", 120, ground, w, h, "#4a90d9", track)]);
}

/**
 * A PENDULUM — arcs and overlapping action, through ROTATION rather than position.
 *
 * The other half of the timing lesson: a swing eases at both ends and is fastest through the
 * middle, and it is authored as a rotation so the arc is exact rather than approximated by
 * positions. It is also the smallest thing that shows whether rotation animates at all.
 */
export function pendulum(): ProjectDocument {
    const swing = (deg: number, frame: number, easing?: "ease-in-out"): Keyframe =>
        ({ frame, easing: easing ?? "ease-in-out", values: { transform: { rotation: deg } } });
    const arm: Node = { id: "arm", type: "core.rectangle", parent: null, children: [], name: "arm",
        geometry: { x: 380, y: 120, width: 16, height: 220 },
        style: { fill: "#c8a35a", opacity: 1 }, layout: {},
        track: [swing(-38, 0), swing(38, 18), swing(-38, 36)] } as Node;
    return demo("Pendulum", 37, [arm]);
}

/**
 * A CEL SEQUENCE — four drawings, each HELD until the next replaces it.
 *
 * How sprite animation and traditional cel work are actually made, and the opposite of tweening:
 * nothing moves between drawings, the drawing CHANGES. Held keyframes are what express that, and a
 * loop of four on twos is the shape of most game sprite animation.
 */
export function celSequence(): ProjectDocument {
    const colours = ["#e0533d", "#e8a33d", "#63b95e", "#4a90d9"];
    const track: Keyframe[] = colours.map((fill, i) => ({
        frame: i * 2,
        hold: true,
        values: { style: { fill }, geometry: { x: 200 + i * 8, y: 220 - (i % 2) * 18 } }
    }));
    return demo("Cel sequence", 8, [rect("cel", 200, 220, 120, 120, colours[0], track)]);
}

/**
 * A WAVING LIMB — rotation about a JOINT rather than about a shape's middle.
 *
 * The smallest thing that is recognisably character animation, and the primitive skeletal rigging
 * will be built out of: an arm swings from its shoulder, so the anchor is the top END of the box
 * and not its centre. Rotating about the middle makes a limb pivot in the air like a propeller,
 * which is the tell that a rig has no joints.
 *
 * It also overlaps: the forearm lags the upper arm by a few frames, which is what makes a wave
 * read as flesh rather than as a hinge — the same overlapping-action lesson the pendulum teaches,
 * applied to a chain.
 */
export function wavingLimb(): ProjectDocument {
    const swing = (deg: number, frame: number): Keyframe =>
        ({ frame, easing: "ease-in-out", values: { transform: { rotation: (deg * Math.PI) / 180, origin: JOINT } } });
    const upper: Node = { id: "upper", type: "core.rectangle", parent: null, children: [], name: "upper arm",
        geometry: { x: 400, y: 160, width: 26, height: 130 },
        style: { fill: "#c86a4a", opacity: 1 }, layout: {},
        track: [swing(-24, 0), swing(24, 12), swing(-24, 24)] } as Node;
    // LAGGING by three frames — the follow-through that makes a chain read as connected.
    const fore: Node = { id: "fore", type: "core.rectangle", parent: null, children: [], name: "forearm",
        geometry: { x: 400, y: 290, width: 22, height: 110 },
        style: { fill: "#e08a63", opacity: 1 }, layout: {},
        track: [swing(-34, 3), swing(34, 15), swing(-34, 27)] } as Node;
    return demo("Waving limb", 28, [upper, fore]);
}

/**
 * OVERLAPPING ACTION — the cart stops, the flag does not.
 *
 * The exercise that cannot be authored with one track per node, which is why it is here. A keyframe
 * holds a whole state, so before channels every property a node animated had to key on the SAME
 * frames — and overlapping action is precisely the case where one property's timing must outlive
 * another's. The body arrives and stops at frame 14; the flag keeps swinging through 20, 26 and 32,
 * settling after the thing carrying it has already come to rest. That is what makes weight read.
 *
 * Written the only way it can be: POSITION on the node's track, ROTATION on a channel with its own
 * keyframes. Saying it with one track would need position keys at 20, 26 and 32 that restate a
 * value that is not changing — which is not the same animation, it is a workaround that an editor
 * then shows as six keyframes the animator never authored.
 */
export function overlappingAction(): ProjectDocument {
    const deg = (d: number) => (d * Math.PI) / 180;
    // THE BODY: accelerates away, arrives, stops. Nothing after frame 14.
    const body: Keyframe[] = [
        { frame: 0, easing: "ease-in", values: { geometry: { x: 120, y: 300 } } },
        { frame: 14, easing: "ease-out", values: { geometry: { x: 460, y: 300 } } }
    ];
    // THE FLAG: keyed where the body has no keyframe at all. It lags into the move, overshoots
    // when the body stops, and oscillates down to rest — decreasing amplitude, which is what
    // separates follow-through from a wobble.
    // The ANCHOR is not in the keyframes. A channel says what ONE property is at a frame, and the
    // pivot a flag swings about is a fact about the flag rather than about any moment in it —
    // `materializeNode` merges the group, so a static `origin` survives every keyframe that sets
    // only a rotation. The channel validator refused the first version of this for exactly that
    // reason, which is the rule doing its job rather than getting in the way.
    const flag: Keyframe[] = [
        { frame: 0, easing: "ease-in-out", values: { transform: { rotation: deg(0) } } },
        { frame: 8, easing: "ease-in-out", values: { transform: { rotation: deg(-28) } } },
        { frame: 20, easing: "ease-in-out", values: { transform: { rotation: deg(22) } } },
        { frame: 26, easing: "ease-in-out", values: { transform: { rotation: deg(-11) } } },
        { frame: 32, easing: "ease-in-out", values: { transform: { rotation: deg(0) } } }
    ];
    const cart: Node = { id: "cart", type: "core.rectangle", parent: null, children: [], name: "cart",
        geometry: { x: 120, y: 300, width: 96, height: 60 },
        style: { fill: "#4a90d9", opacity: 1 }, layout: {}, track: body } as Node;
    const pole: Node = { id: "pole", type: "core.rectangle", parent: "cart", children: [], name: "flag",
        geometry: { x: 40, y: -90, width: 12, height: 92 },
        style: { fill: "#e8a33d", opacity: 1 }, layout: {},
        transform: { rotation: 0, scaleX: 1, scaleY: 1, origin: JOINT },
        // POSITION from the parent's track (the flag is a child, so it is carried), ROTATION from
        // its own channel on frames the parent never mentions. That is the whole feature.
        channels: { "transform.rotation": flag } } as Node;
    cart.children = ["pole"];
    const d = demo("Overlapping action", 36, [cart, pole]);
    d.rootNodeUuids = ["cart"];
    return d;
}

/**
 * THE ARC — a thrown ball, in TWO keyframes.
 *
 * The exercise that shows what a motion path is for. A ball thrown across the screen travels on an
 * arc, and until now saying so meant putting keyframes along the curve: a polyline the author
 * re-fits by hand whenever either end moves, and one an editor shows as six keyframes nobody
 * authored. Here the whole flight is a throw and a landing, and the route between them is one
 * curve.
 *
 * SET AGAINST ITS OWN CONTROL. The pale ball has the same two keyframes, the same easing and no
 * path, so it slides along the chord while the other arcs over it — the difference is the feature,
 * visible in one glance rather than argued for.
 *
 * The handles reach UP from both ends, which is what makes a throw: steep departure, steep arrival,
 * and the apex in between. `easing` is untouched by any of this — the path decides the route and
 * the curve decides the spacing, which is the separation that lets a ball hang at the top.
 */
export function arcToss(): ProjectDocument {
    const start = { x: 90, y: 380 }, end = { x: 560, y: 380 };
    // OFFSETS from their own ends, so moving either keyframe carries the curve with it. Negative y
    // is up: both handles reach for the apex.
    const arc: MotionPath = { c1: { x: 60, y: -300 }, c2: { x: -60, y: -300 } };
    const flight = (motion?: MotionPath): Keyframe[] => [
        { frame: 0, easing: "linear", motion, values: { geometry: { x: start.x, y: start.y } } },
        { frame: 30, values: { geometry: { x: end.x, y: end.y } } }
    ];
    // LINEAR easing on purpose. Any ease would muddle the demonstration — a viewer could not tell
    // the arc from the timing — and it is also the honest test of arc-length progress: with even
    // spacing in time, even spacing along the ROUTE is what proves the parameter was reparameterised.
    const chord = ellipse("chord", start.x, start.y, 44, "#3a4a63", flight());
    const ball = ellipse("ball", start.x, start.y, 44, "#e0533d", flight(arc));
    return demo("Arc toss", 32, [chord, ball]);
}

/**
 * A PLANTED FOOT — the exercise inverse kinematics exists for.
 *
 * The hip rises and falls; the foot stays exactly where it was put. With forward kinematics that
 * means hand-tuning two angles on every frame and re-tuning both whenever the hip moves at all,
 * because the foot's position is a CONSEQUENCE of the angles rather than something that can be
 * stated. Here the foot's position IS the statement and the knee works itself out — which is the
 * whole reason a walk cycle is authored this way, and why one survives its character being
 * re-proportioned.
 *
 * SET AGAINST ITS OWN CONTROL, like the arc toss: the pale leg is the same three nodes with the
 * same hip animation and NO constraint, so it swings its foot through the floor while the solved
 * one keeps its heel planted. The difference is the feature, visible in a glance.
 *
 * THE BEND IS STATED. A knee folds one way, and this is the demo that would show a guessed bend
 * flipping: the chain passes close to straight at the top of the rise, which is exactly where an
 * inferred direction loses its mind.
 */
export function plantedFoot(): ProjectDocument {
    const FOOT = { x: 250, y: 400 };
    // The HIP rises and falls. Nothing here mentions an angle: this is the only authored motion.
    // The range is chosen to stay INSIDE the leg's reach at both ends. Thigh and shin are 110 each,
    // so a hip above y = 180 could not touch a foot at 400 however it folded — and the chain would
    // straighten and hang short, which is the correct answer to an impossible request but a poor
    // demonstration of a planted foot. A crouch to 260 and a rise to 185 spans nearly the whole
    // fold without ever asking for the impossible.
    const hipTrack: Keyframe[] = [
        { frame: 0, easing: "ease-in-out", values: { geometry: { x: 250, y: 260 } } },
        { frame: 12, easing: "ease-in-out", values: { geometry: { x: 250, y: 185 } } },
        { frame: 24, easing: "ease-in-out", values: { geometry: { x: 250, y: 260 } } }
    ];
    // A leg as three nodes: hip (the chain root), knee, foot. Offsets ARE the bone lengths, which
    // is why none are stored — thigh 110 long, shin 110, both drawn straight down in rest.
    const leg = (suffix: string, ink: string, ik?: IkConstraint): Node[] => {
        const hip: Node = { id: `hip${suffix}`, type: "core.rectangle", parent: null, children: [`knee${suffix}`],
            name: `hip${suffix}`, geometry: { x: 250, y: 260, width: 22, height: 110 },
            style: { fill: ink, opacity: 1 }, layout: {},
            transform: { rotation: 0, scaleX: 1, scaleY: 1, origin: JOINT }, track: hipTrack } as Node;
        const knee: Node = { id: `knee${suffix}`, type: "core.rectangle", parent: `hip${suffix}`, children: [`foot${suffix}`],
            name: `knee${suffix}`, geometry: { x: 0, y: 110, width: 20, height: 110 },
            style: { fill: ink, opacity: 1 }, layout: {},
            transform: { rotation: 0, scaleX: 1, scaleY: 1, origin: JOINT } } as Node;
        const foot: Node = { id: `foot${suffix}`, type: "core.rectangle", parent: `knee${suffix}`, children: [],
            name: `foot${suffix}`, geometry: { x: 0, y: 110, width: 46, height: 16 },
            style: { fill: ink, opacity: 1 }, layout: {},
            // The pivot is the ANKLE — the node's own corner — not the middle of the foot. The
            // chain ends at a JOINT, and a box hung off that joint has its centre somewhere that
            // swings as the knee turns. Measuring the centre made a perfectly planted foot look
            // like it drifted 11px, which is the offset rotating rather than the solve being loose.
            transform: { rotation: 0, scaleX: 1, scaleY: 1, origin: { x: 0, y: 0 } }, ik } as Node;
        return [hip, knee, foot];
    };
    // BEND -1 puts the knee forward, which is the one a leg has.
    const solved = leg("", "#4a90d9", { x: FOOT.x, y: FOOT.y, bend: -1 });
    const control = leg("X", "#3a4a63");
    const d = demo("Planted foot", 26, [...control, ...solved]);
    d.rootNodeUuids = ["hipX", "hip"];
    return d;
}

/**
 * A CURLING TAIL — six bones reaching for a point that moves.
 *
 * The case a triangle cannot express. Two bones have exactly two poses that reach a target and
 * `bend` picks one; six have infinitely many, so the solver's job stops being "find the answer" and
 * becomes "find a natural one". FABRIK does that by dragging the chain back from the target and
 * forward from the root in turn, and because every step places a joint at exactly its bone's length
 * from the previous one, a half-converged chain is still a tail rather than a stretched one.
 *
 * THE TARGET IS ANIMATED, which is the point: a tail is not posed once, it follows something. The
 * tip is keyed around an arc while the base stays put, and every segment between them redistributes
 * on its own — six rotations nobody authored, from two keyframes that mention only a position.
 *
 * Drawn as segments that TAPER, because a tail whose links are all the same size reads as a chain
 * rather than as part of an animal, and because unequal bones are also the honest test: equal ones
 * make a chain that hides which segment absorbed the bend.
 */
export function curlingTail(): ProjectDocument {
    const BASE = { x: 180, y: 260 };
    const SEGMENTS = 6;
    const nodes: Node[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
        const length = 62 - i * 6;                       // tapering: 62, 56, 50, 44, 38, 32, 26
        const width = 26 - i * 3;
        const first = i === 0;
        nodes.push({
            id: `tail${i}`,
            type: "core.rectangle",
            parent: first ? null : `tail${i - 1}`,
            children: i < SEGMENTS ? [`tail${i + 1}`] : [],
            name: `tail${i}`,
            // Each segment hangs off the end of the one before it, so the offsets ARE the bones.
            geometry: first ? { x: BASE.x, y: BASE.y, width, height: length }
                            : { x: 0, y: 62 - (i - 1) * 6, width, height: length },
            style: { fill: i % 2 === 0 ? "#5aa06a" : "#6cb87c", opacity: 1 }, layout: {},
            transform: { rotation: 0, scaleX: 1, scaleY: 1, origin: JOINT }
        } as Node);
    }
    // THE BASE MOVES and the TIP is pinned — the six-bone analogue of the planted foot, and the
    // only authored motion in the document. Every rotation in between is derived.
    nodes[0].track = [
        { frame: 0, easing: "ease-in-out", values: { geometry: { x: BASE.x, y: BASE.y } } },
        { frame: 15, easing: "ease-in-out", values: { geometry: { x: BASE.x + 130, y: BASE.y + 40 } } },
        { frame: 30, easing: "ease-in-out", values: { geometry: { x: BASE.x, y: BASE.y } } }
    ];
    // The TIP is the effector and it drives all six bones. Nothing here mentions an angle.
    nodes[SEGMENTS].ik = { x: 150, y: 120, chain: SEGMENTS };
    const d = demo("Curling tail", 32, nodes);
    // ONE root. The helper treats every node it is handed as a root, which is right for demos made
    // of siblings and wrong for a chain — each segment here is a child of the one before it.
    d.rootNodeUuids = ["tail0"];
    return d;
}

/**
 * A TILE SHEET, taken apart — the exercise for image regions and pixel-art filtering.
 *
 * Real game art ships as grids inside single files: the packs measured for schema 51 were a
 * creature strip of 20x4 cells at 32x32, an RPG tileset of 15x7 at 24x24, a weapon set of 24
 * columns. Until a node could name a sub-rectangle, none of it could be used at all — every
 * backend drew whole images, so a tileset was one picture.
 *
 * THE SHEET IS PROCEDURAL, sixteen pixels square, four flat tiles with darker borders, embedded as
 * a 131-byte PNG. Deliberately not one of the measured packs: a demo that shipped somebody else's
 * art would tie this repository to their licence, and the feature is about addressing a grid rather
 * than about which grid.
 *
 * IT DRAWS THE SAME FILE FIVE TIMES. Once WHOLE at the top, which is all the engine could ever do
 * before, and then each of the four tiles on its own — so the difference between "a region" and "a
 * scaled-down sheet" is visible rather than argued. The whole-sheet copy is also the control for
 * the filter: it is drawn SMOOTH while the tiles are drawn PIXELATED, and at this magnification a
 * 16px sheet interpolated is unmistakably mush beside the same pixels sampled nearest.
 */
export function tileSheet(): ProjectDocument {
    // A 2x2 grid of 8x8 tiles. Region coordinates are in the SOURCE image's own pixels, which is
    // the unit the art is authored in — "the tile at column 1, row 0" is x=8, y=0, w=8, h=8.
    const SHEET = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASklEQVR4nGOo1lP6jw9r+pfjxQwgRQ+CbbFimAFeE25ixaMGUNMAiqLRKMLqPz7cEKWEF4MNiFqQhRXDDHix2BYrHjWAmgZQEo0Aht5Dkx5mCysAAAAASUVORK5CYII=";
    const TILE = 8;
    const image = (id: string, x: number, y: number, size: number,
                   sourceRect: { x: number; y: number; width: number; height: number } | undefined,
                   pixelated: boolean): Node =>
        ({ id, type: "core.image", parent: null, children: [], name: id,
            geometry: { x, y, width: size, height: size },
            style: { fill: "#ffffff", opacity: 1 }, layout: {},
            src: SHEET, sourceRect, pixelated } as Node);

    const nodes: Node[] = [
        // THE CONTROL: the whole sheet, smoothed, exactly what every backend used to do.
        image("whole", 60, 60, 160, undefined, false)
    ];
    // The four tiles, each addressed by its own region and drawn with nearest-neighbour.
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]];
    corners.forEach(([col, row], i) => {
        nodes.push(image(`tile${i}`, 260 + col * 170, 60 + row * 170, 160,
            { x: col * TILE, y: row * TILE, width: TILE, height: TILE }, true));
    });
    return demo("Tile sheet", 1, nodes);
}

/**
 * A SHEET PLAYING — the point of addressing a grid in the first place.
 *
 * Regions made a tileset usable; keyframing one makes a sprite sheet an ANIMATION, which is how
 * every 2D engine plays a walk cycle: one image, one keyframe per cell. Nothing here mentions a
 * position or an angle — the shape never moves. Only the region changes, and the picture changes
 * with it, which is the whole of frame-by-frame sprite animation.
 *
 * THE KEYFRAMES ARE NOT HELD, deliberately. A held keyframe would step correctly by never blending
 * at all, and would therefore prove nothing about the rule that matters: a region STEPS even
 * through an ordinary tween, because interpolating one would slide a window across the sheet and
 * smear two cells together. Leaving `hold` off is what puts that rule under test.
 */
export function spriteWalk(): ProjectDocument {
    const SHEET = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAASklEQVR4nGOo1lP6jw9r+pfjxQwgRQ+CbbFimAFeE25ixaMGUNMAiqLRKMLqPz7cEKWEF4MNiFqQhRXDDHix2BYrHjWAmgZQEo0Aht5Dkx5mCysAAAAASUVORK5CYII=";
    const TILE = 8;
    // The four cells in reading order, one every four frames, then back to the first.
    const cells = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const track: Keyframe[] = cells.map(([col, row], i) => ({
        frame: i * 4,
        values: { sourceRect: { x: col * TILE, y: row * TILE, width: TILE, height: TILE } }
    }));
    const sprite: Node = { id: "sprite", type: "core.image", parent: null, children: [], name: "sprite",
        geometry: { x: 200, y: 140, width: 200, height: 200 },
        style: { fill: "#ffffff", opacity: 1 }, layout: {},
        src: SHEET, pixelated: true,
        sourceRect: { x: 0, y: 0, width: TILE, height: TILE }, track } as Node;
    return demo("Sprite walk", 17, [sprite]);
}

/** Every demo, for a menu and for the tests that check each one actually animates. */
export const DEMOS: readonly { name: string; build: () => ProjectDocument }[] = [
    { name: "Bouncing ball", build: bouncingBall },
    { name: "Jumping square", build: jumpingSquare },
    { name: "Pendulum", build: pendulum },
    { name: "Cel sequence", build: celSequence },
    { name: "Waving limb", build: wavingLimb },
    { name: "Overlapping action", build: overlappingAction },
    { name: "Arc toss", build: arcToss },
    { name: "Planted foot", build: plantedFoot },
    { name: "Curling tail", build: curlingTail },
    { name: "Tile sheet", build: tileSheet },
    { name: "Sprite walk", build: spriteWalk }
];
