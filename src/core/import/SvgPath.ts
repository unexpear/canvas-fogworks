/**
 * @module SvgPath
 * @description Turning an SVG `d` attribute into this engine's path commands.
 *
 * The one import that is a CONVERSION rather than a reading. A sheet's atlas states rectangles this
 * engine already models; SVG's path grammar has twenty letters, relative forms, implicit repetition
 * and elliptical arcs, while `PathCommand` is `M`/`L`/`C`/`Q`/`Z` and absolute. Everything between
 * the two has to be normalised, and every one of those letters appears in the measured art.
 *
 * WHAT TO BUILD WAS MEASURED, NOT ASSUMED. Across 5,279 files and 95,160 `<path>` elements:
 * `L` 478,757 · `Q` 377,390 · `M` 227,024 · `Z` 40,263 · `l` 35,475 · `c` 28,273 · `a` 16,205 ·
 * `h` 7,371 · `v` 5,547 · `z` 5,205 · `C` 4,183 · `A` 2,788 · `V` 2,589 · `H` 1,884 · `s` 1,400 ·
 * `S` 444 · `m` 366 · `q` 311. Arcs number about nineteen thousand — the piece it would have been
 * most tempting to skip, and the one that would have quietly dropped a fifth of the shapes.
 *
 * ARCS BECOME CUBICS, SPLIT AT QUARTER TURNS. An elliptical arc has no exact cubic form, so the
 * sweep is divided into segments of at most 90 degrees and each approximated with the standard
 * `4/3·tan(Δ/4)` handle length. The splitting matters more than the constant: one cubic across a
 * half turn is visibly not a circle, while at a quarter turn the error is under a thousandth of the
 * radius — below what any canvas resolves.
 *
 * THE SUBPATH ORIGIN IS TRACKED, because `Z` returns to it. Not to the document origin, and not to
 * the most recent `M` if several subpaths have been closed since. Getting that wrong closes every
 * shape to the wrong corner, which reads as a rendering fault rather than a parsing one.
 */

import { PathCommand } from "../document/Node";

/** Commands one path may produce. Mirrors `PATH_MAX_COMMANDS`, which the document enforces. */
export const SVG_PATH_MAX_COMMANDS = 100_000;

/** Largest turn approximated by a single cubic. A quarter is the usual, and the error argument. */
const MAX_ARC_SEGMENT = Math.PI / 2;

/** Every letter the grammar defines, so an unknown one can be named rather than skipped. */
const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";

/** How many numbers each letter consumes per repetition. */
const ARITY: Record<string, number> = {
    M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0
};

/**
 * A cursor over a `d` string, driven BY the parser rather than run ahead of it.
 *
 * It has to be this way round because of one rule: an arc's two flags are SINGLE DIGITS, so
 * `a10 10 0 015 5` is rx=10 ry=10 rot=0 large=0 sweep=1 x=5 y=5 — seven arguments where a general
 * number scanner sees `015` as one. Nothing in the token stream marks which position a flag is in,
 * so only a reader that knows it is partway through an arc can split it correctly. Written as a
 * pre-pass first, and this test is what caught it.
 *
 * The number syntax is awkward enough to want hand-scanning anyway: `1-2` is two numbers, `.5.5` is
 * two numbers, and exponents carry their own signs. A split on whitespace and commas gets all three
 * wrong, and gets them wrong silently.
 */
class Reader {
    private i = 0;
    constructor(private readonly d: string) {}

    /** Whitespace and commas are the same thing to this grammar. */
    public skip(): void {
        while (this.i < this.d.length && " ,\t\n\r\f".includes(this.d[this.i])) this.i++;
    }

    public done(): boolean { this.skip(); return this.i >= this.d.length; }

    /** The next character if it is a command letter, else null. Does not consume. */
    public peekCommand(): string | null {
        this.skip();
        const ch = this.d[this.i];
        return ch !== undefined && COMMANDS.includes(ch) ? ch : null;
    }

    public takeCommand(): string { this.skip(); return this.d[this.i++]; }

    /** Whether a number could start here — how the parser knows a command repeats. */
    public hasNumber(): boolean {
        this.skip();
        const ch = this.d[this.i];
        return ch !== undefined && (ch === "+" || ch === "-" || ch === "." || (ch >= "0" && ch <= "9"));
    }

    public readNumber(): number | null {
        this.skip();
        const start = this.i;
        // ONE sign, and taking more would be EQUIVALENT rather than wrong: consecutive signs
        // appear in no valid path, so a mutation looping here survives. It is `if` because one is
        // what the grammar allows, not because a second would break something.
        if (this.d[this.i] === "+" || this.d[this.i] === "-") this.i++;
        let digits = 0;
        while (this.i < this.d.length && this.d[this.i] >= "0" && this.d[this.i] <= "9") { this.i++; digits++; }
        if (this.d[this.i] === ".") {
            this.i++;
            while (this.i < this.d.length && this.d[this.i] >= "0" && this.d[this.i] <= "9") { this.i++; digits++; }
        }
        if (digits === 0) { this.i = start; return null; }
        if (this.d[this.i] === "e" || this.d[this.i] === "E") {
            const save = this.i;
            this.i++;
            if (this.d[this.i] === "+" || this.d[this.i] === "-") this.i++;
            let expDigits = 0;
            while (this.i < this.d.length && this.d[this.i] >= "0" && this.d[this.i] <= "9") { this.i++; expDigits++; }
            // An `e` with no digits after it is not an exponent; it belongs to whatever follows.
            if (expDigits === 0) this.i = save;
        }
        const n = Number(this.d.slice(start, this.i));
        return Number.isFinite(n) ? n : null;
    }

    /** ONE character, `0` or `1`. The rule the pre-tokenizer could not know about. */
    public readFlag(): number | null {
        this.skip();
        const ch = this.d[this.i];
        if (ch !== "0" && ch !== "1") return null;
        this.i++;
        return ch === "1" ? 1 : 0;
    }
}

/** What went wrong, or null. Shared shape with the other importers so a caller can check first. */
export function svgPathError(d: unknown): string | null {
    if (typeof d !== "string") return "path data must be a string";
    if (d.trim().length === 0) return "path data is empty";
    const reader = new Reader(d);
    const first = reader.peekCommand();
    if (first === null) return "path data must begin with a command";
    // MUST OPEN WITH A MOVETO, which is the document's own rule as well: without a current point
    // the first draw has no start, and `pathError` would refuse the result anyway.
    if (first !== "M" && first !== "m") return "path data must begin with a moveto";
    // Anything the grammar does not define is named rather than skipped — a shape quietly missing a
    // stroke is harder to notice than one that refuses to load.
    for (const ch of d) {
        if (COMMANDS.includes(ch) || " ,\t\n\r\f+-.eE".includes(ch) || (ch >= "0" && ch <= "9")) continue;
        return "path data contains something that is neither a command nor a number";
    }
    return null;
}

/** One arc segment as a cubic, in the ellipse's own rotated frame. */
function arcSegment(
    cx: number, cy: number, rx: number, ry: number, phi: number, from: number, delta: number
): { x1: number; y1: number; x2: number; y2: number; x: number; y: number } {
    // The standard handle length for a circular arc of this sweep. It is exact at zero and within a
    // thousandth of the radius at a quarter turn, which is why the sweep is split before this runs.
    const alpha = (4 / 3) * Math.tan(delta / 4);
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
    const at = (angle: number) => {
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        return {
            x: cx + rx * cosA * cosPhi - ry * sinA * sinPhi,
            y: cy + rx * cosA * sinPhi + ry * sinA * cosPhi
        };
    };
    const derivative = (angle: number) => {
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        return {
            x: -rx * sinA * cosPhi - ry * cosA * sinPhi,
            y: -rx * sinA * sinPhi + ry * cosA * cosPhi
        };
    };
    const p1 = at(from), p2 = at(from + delta);
    const d1 = derivative(from), d2 = derivative(from + delta);
    return {
        x1: p1.x + alpha * d1.x, y1: p1.y + alpha * d1.y,
        x2: p2.x - alpha * d2.x, y2: p2.y - alpha * d2.y,
        x: p2.x, y: p2.y
    };
}

/** An elliptical arc from the current point, as cubics. */
function arcToCubics(
    x0: number, y0: number, rxIn: number, ryIn: number, degrees: number,
    largeArc: boolean, sweep: boolean, x: number, y: number
): PathCommand[] {
    // A ZERO RADIUS is a straight line by the spec, not an error — and dividing by it below would
    // otherwise put NaN into every following point.
    let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
    if (!(rx > 0) || !(ry > 0) || (x0 === x && y0 === y)) return [{ c: "L", x, y }];

    const phi = (degrees * Math.PI) / 180;
    const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
    const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
    const x1 = cosPhi * dx + sinPhi * dy;
    const y1 = -sinPhi * dx + cosPhi * dy;

    // RADII TOO SMALL to span the endpoints are scaled up until they just reach, which the spec
    // requires — the alternative is a negative square root and a shape that vanishes.
    const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lambda > 1) {
        const s = Math.sqrt(lambda);
        rx *= s; ry *= s;
    }

    const sign = largeArc === sweep ? -1 : 1;
    const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    // Clamped at zero: with the radii just scaled to fit, this is zero in exact arithmetic and can
    // land a hair below it in floating point, where the root would be NaN.
    const coefficient = sign * Math.sqrt(Math.max(0, numerator / denominator));
    const cx1 = (coefficient * rx * y1) / ry;
    const cy1 = (-coefficient * ry * x1) / rx;
    const cx = cosPhi * cx1 - sinPhi * cy1 + (x0 + x) / 2;
    const cy = sinPhi * cx1 + cosPhi * cy1 + (y0 + y) / 2;

    const angle = (ux: number, uy: number, vx: number, vy: number) => {
        const dot = ux * vx + uy * vy;
        const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
        const a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
        return ux * vy - uy * vx < 0 ? -a : a;
    };
    const startX = (x1 - cx1) / rx, startY = (y1 - cy1) / ry;
    const endX = (-x1 - cx1) / rx, endY = (-y1 - cy1) / ry;
    const theta = angle(1, 0, startX, startY);
    let sweepAngle = angle(startX, startY, endX, endY);
    // The two flags between them decide which of the four arcs joining the endpoints is meant, and
    // this is where the sweep flag earns its keep: the same triangle, traversed the other way.
    if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
    if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

    const steps = Math.max(1, Math.ceil(Math.abs(sweepAngle) / MAX_ARC_SEGMENT));
    const delta = sweepAngle / steps;
    const out: PathCommand[] = [];
    for (let i = 0; i < steps; i++) {
        const seg = arcSegment(cx, cy, rx, ry, phi, theta + i * delta, delta);
        out.push({ c: "C", x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, x: seg.x, y: seg.y });
    }
    // The LAST point is snapped to the stated endpoint. The approximation is close but not exact,
    // and a subpath that ends a hair off its own `Z` leaves a hairline gap when filled.
    const last = out[out.length - 1];
    if (last && last.c === "C") { last.x = x; last.y = y; }
    return out;
}

/**
 * An SVG `d` attribute as this engine's commands — absolute, and only `M`/`L`/`C`/`Q`/`Z`.
 *
 * Throws on anything `svgPathError` refuses. A letter the grammar does not define ends the parse
 * rather than being skipped: silently ignoring one produces a shape that is subtly wrong, which is
 * harder to notice than one that is missing.
 */
export function parseSvgPath(d: string): PathCommand[] {
    const bad = svgPathError(d);
    if (bad) throw new Error(`Invalid SVG path: ${bad}.`);
    const reader = new Reader(d);

    const out: PathCommand[] = [];
    let x = 0, y = 0;                 // current point
    let startX = 0, startY = 0;       // the SUBPATH's origin, which is where `Z` returns to
    let lastControl: { x: number; y: number } | null = null;
    let lastCurve = "";               // which curve produced `lastControl`, for S/T reflection
    let letter = "";

    while (!reader.done()) {
        if (reader.peekCommand() !== null) letter = reader.takeCommand();
        else if (letter === "") throw new Error("Invalid SVG path: expected a command.");
        // A letter followed by more numbers REPEATS, which is what makes `M 0 0 10 10` a moveto
        // followed by a lineto.
        const upper = letter.toUpperCase();
        const relative = letter !== upper;
        const arity = ARITY[upper];
        if (arity === undefined) throw new Error(`Invalid SVG path: unknown command "${letter}".`);

        if (upper === "Z") {
            out.push({ c: "Z" });
            x = startX; y = startY;
            lastControl = null; lastCurve = "";
            // A `Z` cannot repeat — it takes no arguments, so a bare letter after it would spin.
            letter = "";
            continue;
        }
        const args: number[] = [];
        for (let k = 0; k < arity; k++) {
            // POSITIONS 3 AND 4 OF AN ARC ARE FLAGS: one character each, `0` or `1`. Reading them
            // as ordinary numbers swallows the argument after them — `015` is three arguments, not
            // one, and this is the whole reason the reader is driven rather than pre-run.
            const isFlag = upper === "A" && (k === 3 || k === 4);
            const v = isFlag ? reader.readFlag() : reader.readNumber();
            if (v === null) throw new Error(`Invalid SVG path: "${letter}" wants ${arity} numbers.`);
            args.push(v);
        }
        const px = relative ? x : 0, py = relative ? y : 0;

        if (upper === "M") {
            x = args[0] + px; y = args[1] + py;
            startX = x; startY = y;
            out.push({ c: "M", x, y });
            // AFTER A MOVETO the repeat is a LINETO, not another moveto — the single most
            // surprising rule in the grammar, and the one that turns a polygon into a dotted mess
            // if it is missed.
            letter = relative ? "l" : "L";
            lastControl = null; lastCurve = "";
        } else if (upper === "L") {
            x = args[0] + px; y = args[1] + py;
            out.push({ c: "L", x, y });
            lastControl = null; lastCurve = "";
        } else if (upper === "H") {
            x = args[0] + px;
            out.push({ c: "L", x, y });
            lastControl = null; lastCurve = "";
        } else if (upper === "V") {
            y = args[0] + py;
            out.push({ c: "L", x, y });
            lastControl = null; lastCurve = "";
        } else if (upper === "C") {
            const c1x = args[0] + px, c1y = args[1] + py, c2x = args[2] + px, c2y = args[3] + py;
            x = args[4] + px; y = args[5] + py;
            out.push({ c: "C", x1: c1x, y1: c1y, x2: c2x, y2: c2y, x, y });
            lastControl = { x: c2x, y: c2y }; lastCurve = "C";
        } else if (upper === "S") {
            // REFLECTED, but only off a cubic. After anything else the spec says the first control
            // point IS the current point — a straight start into the curve, not a mirrored one.
            const r: { x: number; y: number } = lastCurve === "C" && lastControl
                ? { x: 2 * x - lastControl.x, y: 2 * y - lastControl.y } : { x, y };
            const c2x = args[0] + px, c2y = args[1] + py;
            x = args[2] + px; y = args[3] + py;
            out.push({ c: "C", x1: r.x, y1: r.y, x2: c2x, y2: c2y, x, y });
            lastControl = { x: c2x, y: c2y }; lastCurve = "C";
        } else if (upper === "Q") {
            const cx = args[0] + px, cy = args[1] + py;
            x = args[2] + px; y = args[3] + py;
            out.push({ c: "Q", x1: cx, y1: cy, x, y });
            lastControl = { x: cx, y: cy }; lastCurve = "Q";
        } else if (upper === "T") {
            const r: { x: number; y: number } = lastCurve === "Q" && lastControl
                ? { x: 2 * x - lastControl.x, y: 2 * y - lastControl.y } : { x, y };
            x = args[0] + px; y = args[1] + py;
            out.push({ c: "Q", x1: r.x, y1: r.y, x, y });
            lastControl = { x: r.x, y: r.y }; lastCurve = "Q";
        } else if (upper === "A") {
            const ex = args[5] + px, ey = args[6] + py;
            // The flags are written as bare digits and mean nothing else — anything non-zero is
            // true, which is how they appear compressed as `a5 5 0 015 5`.
            for (const cmd of arcToCubics(x, y, args[0], args[1], args[2], args[3] !== 0, args[4] !== 0, ex, ey)) {
                out.push(cmd);
            }
            x = ex; y = ey;
            lastControl = null; lastCurve = "";
        }
        if (out.length > SVG_PATH_MAX_COMMANDS) {
            throw new Error(`Invalid SVG path: more than ${SVG_PATH_MAX_COMMANDS} commands.`);
        }
    }
    return out;
}
