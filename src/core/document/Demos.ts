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

/** Frames a demo runs for, and the rate it is authored at. 24 is the film convention. */
const FPS = 24;

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
    const floor = 420, size = 80, squash = 26;
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
                geometry: onGround
                    // SQUASHED at contact, and WIDER by as much as it is shorter, so the ball
                    // keeps its volume. Squashing alone looks like a punctured ball.
                    ? { x, y: floor + squash, width: size + squash, height: size - squash }
                    : { x, y, width: size, height: size }
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
    const track: Keyframe[] = [
        { frame: 0, values: { geometry: { x: 120, y: ground, width: w, height: h } } },
        // ANTICIPATION: squat down and widen. The pause before a movement is what tells the eye
        // the movement is coming, and removing it makes the jump read as a teleport.
        { frame: 8, easing: "ease-out", values: { geometry: { x: 120, y: ground + 22, width: w + 22, height: h - 22 } } },
        // LAUNCH: stretch along the direction of travel.
        { frame: 12, easing: RISE, values: { geometry: { x: 150, y: ground - 40, width: w - 18, height: h + 30 } } },
        { frame: 20, easing: FALL, values: { geometry: { x: 230, y: 180, width: w, height: h } } },
        { frame: 28, easing: "ease-out", values: { geometry: { x: 310, y: ground, width: w - 12, height: h + 18 } } },
        // LANDING squash, then the settle back — follow-through.
        { frame: 31, easing: "ease-out", values: { geometry: { x: 316, y: ground + 26, width: w + 26, height: h - 26 } } },
        { frame: 40, values: { geometry: { x: 320, y: ground, width: w, height: h } } }
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

/** Every demo, for a menu and for the tests that check each one actually animates. */
export const DEMOS: readonly { name: string; build: () => ProjectDocument }[] = [
    { name: "Bouncing ball", build: bouncingBall },
    { name: "Jumping square", build: jumpingSquare },
    { name: "Pendulum", build: pendulum },
    { name: "Cel sequence", build: celSequence }
];
