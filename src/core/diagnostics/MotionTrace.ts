/**
 * @module MotionTrace
 * @description Where every node ACTUALLY is, at every frame — the accuracy instrument.
 *
 * This exists because for a whole session the only way to answer "did it move, and by how much"
 * was to drive the running app over a debugger and read bounding boxes off the DOM by hand. That
 * found real defects — a tweened shape that never moved at all, a ball that sped up sideways as it
 * slowed vertically, a squash that drifted its own centre eleven pixels — and every one of them
 * was caught by measuring positions frame by frame. Making that a tested instrument is worth more
 * than the next feature, because it is how the next feature gets checked.
 *
 * IT SAMPLES THE COMPUTED WORLD, NOT THE STORED DOCUMENT. Stored `geometry` is an intent; a node's
 * ink lands where `computeGeometry` puts it after layout, constraints, instance expansion, the
 * parent chain and its own transform have all had their say. A trace of stored values would agree
 * with the document and disagree with the screen, which is the exact opposite of what an accuracy
 * instrument is for. So every sample runs the real pipeline.
 *
 * PURE AND DETERMINISTIC: same document, same frames, same trace. That is what makes it diffable —
 * two traces of one animation before and after a change are a regression test that needs no
 * screenshots and no eyes. Wall-clock time is deliberately absent; elapsed milliseconds are a
 * property of the machine rather than of the animation, and mixing them in would make every trace
 * differ from every other. What a PERSON did, with timestamps, is `ActionJournal` — a different
 * question, kept separate so this one stays comparable.
 *
 * MOVEMENT IS DERIVED from position rather than recorded beside it, because two records of the
 * same thing drift apart. `traceVelocity` differences consecutive samples, so a reported speed
 * cannot disagree with the positions it came from.
 */

import { ReadonlyDocument } from "../document/Document";
import { applyFrame } from "../document/Timeline";
import { computeGeometry } from "../geometry/GeometryEngine";

/**
 * Samples one call may produce. Frames times nodes grows in a way a design document does not, and
 * a trace is a diagnostic — running out of memory to measure something is the wrong trade.
 */
export const TRACE_MAX_SAMPLES = 200_000;

/** One node at one frame: where its ink is, and the deformation that put it there. */
export interface Sample {
    frame: number;
    nodeId: string;
    /** WORLD-space bounds — the axis-aligned box the ink actually occupies. */
    x: number;
    y: number;
    width: number;
    height: number;
    /**
     * World position of the node's transform ORIGIN — where the node IS, as opposed to how big it
     * has become.
     *
     * Carried alongside the bounds because they are different measurements and only one of them is
     * a position. A squashing ball widens about its feet, so its bounding box's left edge moves
     * outward while the ball travels at a perfectly steady speed. `traceVelocity` differences this,
     * not the box — otherwise it reports the squash as sideways motion.
     */
    anchorX: number;
    anchorY: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
}

/** How a node moved BETWEEN two consecutive samples of it. */
export interface Velocity {
    nodeId: string;
    /** The frame arrived AT — a velocity describes the step that ended here. */
    frame: number;
    dx: number;
    dy: number;
    /** Distance travelled, which is what "spacing" means to an animator. */
    speed: number;
    dRotation: number;
}

/** A frame range in the units an animator thinks in, and the seconds it occupies. */
export interface Timing {
    frames: number;
    fps: number;
    seconds: number;
}

/**
 * Every node's placement across a frame range.
 *
 * `from`/`to` are INCLUSIVE frame numbers and default to the document's own timeline — or to frame
 * zero alone when it has none, which is the honest answer for a document that is not animated
 * rather than an error.
 *
 * `nodeIds` narrows to the nodes worth watching. It is a parameter rather than a default over the
 * whole document because the interesting question is almost always about one or two shapes, and
 * tracing everything to answer it is how a diagnostic becomes too slow to reach for.
 */
export function traceMotion(
    doc: ReadonlyDocument,
    opts?: { from?: number; to?: number; nodeIds?: readonly string[] }
): Sample[] {
    const timeline = doc.timeline;
    const from = Math.round(opts?.from ?? 0);
    const to = Math.round(opts?.to ?? (timeline ? timeline.frames - 1 : 0));
    // The `to < from` half is a COST short-circuit rather than a guard, and a mutation of it
    // changed no answer: the loop below is `frame <= to`, so a backwards range simply never runs
    // and returns the same empty array. It stays because a caller asking for a reversed range has
    // made a mistake, and returning immediately is clearer than arriving there by not looping.
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];

    const wanted = opts?.nodeIds ? new Set(opts.nodeIds) : null;
    const out: Sample[] = [];
    for (let frame = from; frame <= to; frame++) {
        // THE REAL PIPELINE, per frame. `applyFrame` places the document in time and
        // `computeGeometry` resolves everything that decides where the ink lands. Running both is
        // the whole point — anything cheaper would be measuring a different thing.
        // ONCE per frame, not once per value read off it. `applyFrame` rebuilds every node in the
        // document, so calling it again for the transform and again for the opacity would triple
        // the cost of the instrument — and an instrument expensive enough to avoid is one that
        // stops being used.
        const timed = applyFrame(doc, frame);
        const computed = computeGeometry(timed);
        computed.nodes.forEach((c, id) => {
            if (wanted && !wanted.has(id)) return;
            if (out.length >= TRACE_MAX_SAMPLES) return;
            // Non-finite bounds mean a degenerate node, and a NaN in a trace poisons every
            // difference computed from it — so it is skipped rather than recorded as a hole.
            if (!Number.isFinite(c.bounds.x) || !Number.isFinite(c.bounds.width)) return;
            const node = timed.nodes.get(id);
            const t = node?.transform;
            // The ANCHOR in world space: the transform origin, expressed as a fraction of the
            // node's own box, pushed through the matrix the engine already computed. Reading it
            // off `c.world` rather than recomputing keeps it the same point the renderer uses.
            const ox = (t?.origin?.x ?? 0.5) * c.local.width;
            const oy = (t?.origin?.y ?? 0.5) * c.local.height;
            out.push({
                frame,
                nodeId: id,
                x: c.bounds.x,
                y: c.bounds.y,
                width: c.bounds.width,
                height: c.bounds.height,
                anchorX: c.world.a * ox + c.world.c * oy + c.world.e,
                anchorY: c.world.b * ox + c.world.d * oy + c.world.f,
                rotation: t?.rotation ?? 0,
                scaleX: t?.scaleX ?? 1,
                scaleY: t?.scaleY ?? 1,
                opacity: node?.style.opacity ?? 1
            });
        });
        if (out.length >= TRACE_MAX_SAMPLES) break;
    }
    return out;
}

/**
 * How far each node moved between consecutive samples.
 *
 * Derived rather than recorded, so speed and position cannot disagree. Samples are grouped by node
 * and differenced in frame order; the FIRST sample of each node produces no velocity, because
 * there is nothing before it to have moved from — an entry there would have to invent a zero and
 * would read as "it was still" rather than "it had not started".
 */
export function traceVelocity(samples: readonly Sample[]): Velocity[] {
    const byNode = new Map<string, Sample[]>();
    for (const s of samples) {
        const list = byNode.get(s.nodeId);
        if (list) list.push(s); else byNode.set(s.nodeId, [s]);
    }
    const out: Velocity[] = [];
    byNode.forEach((list, nodeId) => {
        const ordered = [...list].sort((a, b) => a.frame - b.frame);
        for (let i = 1; i < ordered.length; i++) {
            const prev = ordered[i - 1], cur = ordered[i];
            // The ANCHOR, not the bounds — see `Sample.anchorX`. Differencing the box would count
            // a squash as travel, which is the one thing a spacing measurement must not do.
            const dx = cur.anchorX - prev.anchorX, dy = cur.anchorY - prev.anchorY;
            out.push({
                nodeId, frame: cur.frame, dx, dy,
                speed: Math.hypot(dx, dy),
                dRotation: cur.rotation - prev.rotation
            });
        }
    });
    return out;
}

/**
 * What a frame range costs in seconds, at the document's own rate.
 *
 * Here so an animator can ask "how long is this beat" without doing arithmetic against a frame
 * rate they have to remember, and so a test can assert a duration rather than a frame count — the
 * two differ the moment somebody changes the fps, and a duration is what an audience experiences.
 *
 * A document with no timeline has no rate, so the answer is zero seconds rather than a guess.
 */
export function traceTiming(doc: ReadonlyDocument, from?: number, to?: number): Timing {
    const timeline = doc.timeline;
    if (!timeline) return { frames: 0, fps: 0, seconds: 0 };
    const a = Math.round(from ?? 0);
    const b = Math.round(to ?? timeline.frames - 1);
    // INCLUSIVE of both ends, so frames 0..11 at 12 fps is one second — the count of frames that
    // will be SHOWN, which is what a duration means. An exclusive range would report eleven
    // twelfths and quietly contradict the timeline strip.
    const frames = Math.max(0, b - a + 1);
    return { frames, fps: timeline.fps, seconds: timeline.fps > 0 ? frames / timeline.fps : 0 };
}

/**
 * A short, stable string standing for a whole trace.
 *
 * For comparing two runs cheaply: identical digests mean identical motion, and different ones say
 * where to look. Positions are ROUNDED before hashing, at a thousandth of a unit — far finer than
 * anything visible and coarse enough that a change in floating-point summation order does not
 * report itself as an animation change. A digest that flickers is worse than no digest, because it
 * trains you to ignore it.
 */
export function traceDigest(samples: readonly Sample[]): string {
    const q = (n: number) => Math.round(n * 1000) / 1000;
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (const s of samples) {
        const text = `${s.frame}|${s.nodeId}|${q(s.x)}|${q(s.y)}|${q(s.width)}|${q(s.height)}|${q(s.rotation)}|${q(s.scaleX)}|${q(s.scaleY)}|${q(s.opacity)}`;
        for (let i = 0; i < text.length; i++) {
            // TWO accumulators rather than one 32-bit FNV: a single 32-bit hash over a trace of
            // tens of thousands of samples collides often enough to matter, and a collision here
            // reads as "nothing changed" — the one wrong answer this must not give.
            h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
            h2 = Math.imul(h2 + text.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
        }
    }
    return `${samples.length}:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
