/**
 * emitCanvas tests — the canvas backend verified via a RECORDING-MOCK
 * CanvasRenderingContext2D. Canvas is immediate-mode, so its entire output IS the
 * ordered sequence of ctx calls; capturing that sequence (with a mock, no jsdom, no
 * node-canvas dep) is the truest node-env assertion of "the backend issued the right
 * primitive, with the right paint, in the right order, under the right transform".
 * Pixel-level SVG↔canvas parity stays a browser smoke test.
 */

import { emitCanvas, setImageReadyCallback } from "./emitCanvas";
import { buildRenderModel } from "./RenderModel";
import { RendererState } from "./RendererState";
import { createEmptyDocument, ProjectDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { computeGeometry } from "../core/geometry/GeometryEngine";
import { compose } from "../core/geometry/Matrix";
import { bouncingBall } from "../core/document/Demos";
import { planSheet, drawSheet } from "../core/export/SpriteSheet";

const SIZE = { width: 800, height: 600 };

// ─── Recording mock ctx ──────────────────────────────────────────────────────
type Call = { op: string; args: unknown[] };

/** What `createLinear/RadialGradient` hands back — its stops are part of the recorded output. */
class MockGradient {
    stops: [number, string][] = [];
    constructor(private ctx: MockCtx) {}
    addColorStop(offset: number, color: string) {
        this.stops.push([offset, color]);
        this.ctx.calls.push({ op: "addColorStop", args: [offset, color] });
    }
    describe(): string { return `gradient(${this.stops.map(s => s.join("@")).join(",")})`; }
}

class MockCtx {
    calls: Call[] = [];
    canvas = { width: 800, height: 600 };
    private log(op: string, ...args: unknown[]) { this.calls.push({ op, args }); }

    setTransform(...a: number[]) { this.log("setTransform", ...a); }
    transform(...a: number[]) { this.log("transform", ...a); }
    translate(x: number, y: number) { this.log("translate", x, y); }
    save() { this.log("save"); }
    restore() { this.log("restore"); }
    clearRect(...a: number[]) { this.log("clearRect", ...a); }
    fillRect(...a: number[]) { this.log("fillRect", ...a); }
    beginPath() { this.log("beginPath"); }
    moveTo(x: number, y: number) { this.log("moveTo", x, y); }
    lineTo(x: number, y: number) { this.log("lineTo", x, y); }
    bezierCurveTo(...a: number[]) { this.log("bezierCurveTo", ...a); }
    quadraticCurveTo(...a: number[]) { this.log("quadraticCurveTo", ...a); }
    closePath() { this.log("closePath"); }
    rect(...a: number[]) { this.log("rect", ...a); }
    roundRect(...a: number[]) { this.log("roundRect", ...a); }
    ellipse(...a: number[]) { this.log("ellipse", ...a); }
    fill() { this.log("fill"); }
    stroke() { this.log("stroke"); }
    clip() { this.log("clip"); }
    fillText(t: string, x: number, y: number) { this.log("fillText", t, x, y); }
    // Deterministic metrics for the wrap tests: 10px per character (measurement isn't logged —
    // it's a query, not output; the resulting LINE BREAKS are what the call sequence asserts).
    measureText(t: string) { return { width: t.length * 10 }; }
    drawImage(...a: unknown[]) { this.log("drawImage", ...a); }
    setLineDash(a: number[]) { this.log("setLineDash", a); }
    // A gradient is an OBJECT here, not a string, so the recorded `set fillStyle` shows which ramp
    // was built and with which stops — the stops are what a wrong colour or a dropped opacity
    // shows up in, and they never reach the call log any other way.
    createLinearGradient(...a: number[]) { this.log("createLinearGradient", ...a); return new MockGradient(this); }
    createRadialGradient(...a: number[]) { this.log("createRadialGradient", ...a); return new MockGradient(this); }

    private _fillStyle: unknown = ""; get fillStyle() { return this._fillStyle; } set fillStyle(v: unknown) { this._fillStyle = v; this.log("set fillStyle", v instanceof MockGradient ? v.describe() : v); }
    private _strokeStyle = ""; get strokeStyle() { return this._strokeStyle; } set strokeStyle(v: string) { this._strokeStyle = v; this.log("set strokeStyle", v); }
    private _lineWidth = 1; get lineWidth() { return this._lineWidth; } set lineWidth(v: number) { this._lineWidth = v; this.log("set lineWidth", v); }
    private _globalAlpha = 1; get globalAlpha() { return this._globalAlpha; } set globalAlpha(v: number) { this._globalAlpha = v; this.log("set globalAlpha", v); }
    private _font = ""; get font() { return this._font; } set font(v: string) { this._font = v; this.log("set font", v); }
    private _textAlign = ""; get textAlign() { return this._textAlign; } set textAlign(v: string) { this._textAlign = v; this.log("set textAlign", v); }
    private _textBaseline = ""; get textBaseline() { return this._textBaseline; } set textBaseline(v: string) { this._textBaseline = v; this.log("set textBaseline", v); }
    private _shadowColor = ""; get shadowColor() { return this._shadowColor; } set shadowColor(v: string) { this._shadowColor = v; this.log("set shadowColor", v); }
    private _shadowBlur = 0; get shadowBlur() { return this._shadowBlur; } set shadowBlur(v: number) { this._shadowBlur = v; this.log("set shadowBlur", v); }
    private _shadowOffsetX = 0; get shadowOffsetX() { return this._shadowOffsetX; } set shadowOffsetX(v: number) { this._shadowOffsetX = v; this.log("set shadowOffsetX", v); }
    private _shadowOffsetY = 0; get shadowOffsetY() { return this._shadowOffsetY; } set shadowOffsetY(v: number) { this._shadowOffsetY = v; this.log("set shadowOffsetY", v); }
    private _filter = ""; get filter() { return this._filter; } set filter(v: string) { this._filter = v; this.log("set filter", v); }
}

function run(doc: ProjectDocument, over?: Partial<RendererState>, dpr?: number): MockCtx {
    const state: RendererState = {
        selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
        computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 1 }, ...over
    };
    const ctx = new MockCtx();
    emitCanvas(ctx as unknown as CanvasRenderingContext2D, buildRenderModel(SIZE, doc, state), dpr);
    return ctx;
}

function docWith(node: Partial<Node> & Pick<Node, "type" | "style">): ProjectDocument {
    const doc = createEmptyDocument();
    const full: Node = { id: "n1", parent: null, children: [], geometry: { x: 5, y: 7, width: 200, height: 100 }, layout: {}, ...node };
    doc.nodes.set(full.id, full);
    doc.rootNodeUuids = [full.id];
    return doc;
}

const ops = (calls: Call[]) => calls.map(c => c.op);
/** The flat save…restore bracket containing the first call matching (op, argsPred). Items never nest. */
function bracket(calls: Call[], op: string, argsPred?: (a: unknown[]) => boolean): Call[] {
    const idx = calls.findIndex(c => c.op === op && (!argsPred || argsPred(c.args)));
    if (idx < 0) return [];
    let s = idx; while (s > 0 && calls[s].op !== "save") s--;
    let e = idx; while (e < calls.length - 1 && calls[e].op !== "restore") e++;
    return calls.slice(s, e + 1);
}
const call = (calls: Call[], op: string) => calls.find(c => c.op === op);

// ─── Frame scaffold ──────────────────────────────────────────────────────────
describe("emitCanvas — frame scaffold", () => {
    test("clears in device space, fills the background, then sets the viewport CTM", () => {
        const c = run(createEmptyDocument()).calls;
        // First four ops: identity, clear, bg colour, bg fill.
        expect(ops(c).slice(0, 4)).toEqual(["setTransform", "clearRect", "set fillStyle", "fillRect"]);
        expect(c[0].args).toEqual([1, 0, 0, 1, 0, 0]);
        expect(c[2].args).toEqual(["#1a1a2e"]);
        // Then the base viewport CTM (z=1, dpr=1).
        const base = c[4];
        expect(base.op).toBe("setTransform");
        expect(base.args).toEqual([1, 0, 0, 1, -0, -0]);
    });

    test("DPR is folded into the base CTM (setTransform resets, so it can't be a separate scale)", () => {
        const doc = createEmptyDocument();
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed: computeGeometry(doc), viewport: { x: 30, y: 40, zoom: 2 } };
        const ctx = new MockCtx();
        emitCanvas(ctx as unknown as CanvasRenderingContext2D, buildRenderModel(SIZE, doc, state), 3);
        const base = ctx.calls[4];
        expect(base.args).toEqual([2 * 3, 0, 0, 2 * 3, -30 * 3, -40 * 3]); // z·dpr and -vp·dpr
    });

    test("draw order is grid → content → overlay", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#f00", opacity: 1 } });
        const c = run(doc, { selectedNodeIds: ["n1"] }).calls;
        const gridStroke = c.findIndex(x => x.op === "stroke");             // first grid line stroke
        const contentRect = c.findIndex(x => x.op === "rect" && JSON.stringify(x.args) === "[0,0,200,100]");
        const handle = c.findIndex(x => x.op === "rect" && JSON.stringify(x.args) === "[1,3,8,8]"); // nw handle at bounds(5,7)-4
        expect(gridStroke).toBeLessThan(contentRect);
        expect(contentRect).toBeLessThan(handle);
    });
});

// ─── Shapes ──────────────────────────────────────────────────────────────────
describe("emitCanvas — shapes", () => {
    test("rectangle (fill + stroke): translate, path, fill then stroke", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#f00", opacity: 0.5, stroke: "#000" } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(ops(b)).toEqual(["save", "translate", "beginPath", "rect", "set globalAlpha", "set fillStyle", "fill", "set strokeStyle", "set lineWidth", "setLineDash", "stroke", "restore"]);
        expect(call(b, "translate")!.args).toEqual([5, 7]);       // world = translation(5,7)
        expect(call(b, "set fillStyle")!.args).toEqual(["#f00"]);
        expect(call(b, "set globalAlpha")!.args).toEqual([0.5]);
        expect(call(b, "set lineWidth")!.args).toEqual([1]);      // 1/z at z=1
    });

    test("rectangle without stroke issues NO stroke (but still fills)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(ops(b)).not.toContain("stroke");
        expect(ops(b)).not.toContain("set strokeStyle");
        expect(ops(b)).toContain("fill");
    });

    test("rounded rectangle routes to roundRect, not rect", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, radius: 12 } });
        const b = bracket(run(doc).calls, "roundRect");
        expect(ops(b)).toContain("roundRect");
        expect(ops(b)).not.toContain("rect");
        expect(call(b, "roundRect")!.args).toEqual([0, 0, 200, 100, 12]);
    });

    test("ellipse issues ctx.ellipse", () => {
        const doc = docWith({ type: "core.ellipse", style: { fill: "#0f0", opacity: 1 } });
        const b = bracket(run(doc).calls, "ellipse");
        expect(ops(b)).toEqual(["save", "translate", "beginPath", "ellipse", "set globalAlpha", "set fillStyle", "fill", "restore"]);
        expect(call(b, "ellipse")!.args).toEqual([100, 50, 100, 50, 0, 0, Math.PI * 2]);
    });

    test("line strokes a moveTo→lineTo, never fills", () => {
        const doc = docWith({ type: "core.line", style: { fill: "#00f", opacity: 1 } });
        // Anchor on lineTo(200,100) — a content-local coord no grid line emits (grid lineTo is (x,640)/(840,y)).
        const b = bracket(run(doc).calls, "lineTo", a => JSON.stringify(a) === "[200,100]");
        expect(ops(b)).toEqual(["save", "translate", "beginPath", "moveTo", "lineTo", "set globalAlpha", "set strokeStyle", "set lineWidth", "setLineDash", "stroke", "restore"]);
        expect(ops(b)).not.toContain("fill");
        expect(call(b, "lineTo")!.args).toEqual([200, 100]);
        expect(call(b, "set strokeStyle")!.args).toEqual(["#00f"]); // colour falls back to fill
    });

    test("path walks the STRUCTURED commands to canvas curve calls (not the d string)", () => {
        const doc = docWith({ type: "core.path", path: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 0 }, { c: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }, { c: "Q", x1: 7, y1: 8, x: 9, y: 10 }, { c: "Z" }], style: { fill: "#abc", opacity: 1 } });
        // Anchor on bezierCurveTo — unique to paths (no grid line or other shape emits it).
        const b = bracket(run(doc).calls, "bezierCurveTo");
        expect(ops(b)).toEqual(["save", "translate", "beginPath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo", "closePath", "set globalAlpha", "set fillStyle", "fill", "restore"]);
        expect(call(b, "bezierCurveTo")!.args).toEqual([1, 2, 3, 4, 5, 6]);
        expect(call(b, "quadraticCurveTo")!.args).toEqual([7, 8, 9, 10]);
    });

    test("text: a short line stays a SINGLE fillText, top baseline, clipped to the box", () => {
        const doc = docWith({ type: "core.text", text: "hi", style: { fill: "#111", opacity: 1, fontSize: 20 } });
        const b = bracket(run(doc).calls, "fillText");
        expect(ops(b)).toEqual(["save", "translate", "set font", "set globalAlpha", "set fillStyle", "set textBaseline", "beginPath", "rect", "clip", "set textAlign", "fillText", "restore"]);   // textAlign is set after the clip, before the first line (schema 34)
        expect(call(b, "set font")!.args).toEqual(["400 20px sans-serif"]);   // weight + size + family (schema 34)
        expect(call(b, "set textBaseline")!.args).toEqual(["top"]);
        expect(call(b, "fillText")!.args).toEqual(["hi", 0, 0]);
    });

    test("text WRAPS greedily at the box width; lines advance by 1.2 × fontSize", () => {
        // Mock metrics: 10px/char. Box 100 wide: "aaaa bbbb" = 90 fits, "+ cccc" = 140 breaks.
        const doc = docWith({
            type: "core.text", text: "aaaa bbbb cccc",
            geometry: { x: 5, y: 7, width: 100, height: 100 },
            style: { fill: "#111", opacity: 1, fontSize: 20 }
        });
        const b = bracket(run(doc).calls, "fillText");
        const fills = b.filter(c => c.op === "fillText").map(c => c.args);
        expect(fills).toEqual([
            ["aaaa bbbb", 0, 0],
            ["cccc", 0, 24]      // 20px font × 1.2 line height
        ]);
    });

    test("an exactly-fitting line does NOT break (the comparison is strictly greater-than)", () => {
        const doc = docWith({
            type: "core.text", text: "aaaa bbbb",           // 90px — exactly the box width
            geometry: { x: 0, y: 0, width: 90, height: 100 },
            style: { fill: "#111", opacity: 1, fontSize: 20 }
        });
        const b = bracket(run(doc).calls, "fillText");
        expect(b.filter(c => c.op === "fillText").map(c => c.args)).toEqual([["aaaa bbbb", 0, 0]]);
    });

    test("a single over-wide word gets its own line and overflows into the clip (never split, never dropped)", () => {
        const doc = docWith({
            type: "core.text", text: "aa verylongwordhere aa", // 20 / 160 / 20 px in a 100px box
            geometry: { x: 0, y: 0, width: 100, height: 200 },
            style: { fill: "#111", opacity: 1, fontSize: 10 }
        });
        const b = bracket(run(doc).calls, "fillText");
        const fills = b.filter(c => c.op === "fillText").map(c => c.args);
        // The over-wide word starts its OWN line (first word of a line always stays — no empty
        // lines, no mid-word split) and the following word wraps again.
        expect(fills).toEqual([
            ["aa", 0, 0],
            ["verylongwordhere", 0, 12],  // 10px font × 1.2
            ["aa", 0, 24]
        ]);
        expect(ops(b)).toContain("clip"); // overflow is cropped by the box clip, not dropped
    });

    test("a NEWLINE is a hard break; tabs and runs still collapse", () => {
        // "aaaa\nbbbb\tcccc" with box 100 (10px/char): words [aaaa,bbbb,cccc] exactly like
        // spaces — a \n inside a "word" would have made one overlong unwrapped line.
        const doc = docWith({
            type: "core.text", text: "aaaa\nbbbb\tcccc  dddd",
            geometry: { x: 0, y: 0, width: 100, height: 200 },
            style: { fill: "#111", opacity: 1, fontSize: 10 }
        });
        const b = bracket(run(doc).calls, "fillText");
        expect(b.filter(c => c.op === "fillText").map(c => c.args)).toEqual([
            ["aaaa", 0, 0],        // the \n ends the line, short though it is
            ["bbbb cccc", 0, 12],  // \t and the double space are still just separators
            ["dddd", 0, 24]        // …and the paragraph still wraps on the box width
        ]);
    });

    test("line height scales the line STEP, so leading is a real control", () => {
        // 10px font at 2.0 -> a 20px step, not the browser-normal 12. The wrap itself is
        // unchanged: line height moves lines apart, it does not decide where they break.
        const doc = docWith({
            type: "core.text", text: "aaaa bbbb cccc",
            geometry: { x: 0, y: 0, width: 100, height: 200 },
            style: { fill: "#111", opacity: 1, fontSize: 10, lineHeight: 2 }
        });
        const b = bracket(run(doc).calls, "fillText");
        expect(b.filter(c => c.op === "fillText").map(c => c.args)).toEqual([
            ["aaaa bbbb", 0, 0],
            ["cccc", 0, 20]
        ]);
    });

    test("alignment moves the ANCHOR, because that is how canvas aligns", () => {
        // Canvas draws about an anchor point rather than inside a box, so alignment has to move
        // the x it is given as well as set `textAlign` -- otherwise centred text draws centred
        // ON the left edge, half of it outside the node.
        const mk = (textAlign: string) => docWith({
            type: "core.text", text: "aa",
            geometry: { x: 0, y: 0, width: 100, height: 50 },
            style: { fill: "#111", opacity: 1, fontSize: 10, textAlign } as never
        });
        const at = (align: string) => {
            const b = bracket(run(mk(align)).calls, "fillText");
            return { align: (call(b, "set textAlign") || { args: ["left"] }).args[0], x: b.filter(c => c.op === "fillText")[0].args[1] };
        };
        expect(at("left")).toEqual({ align: "left", x: 0 });
        expect(at("center")).toEqual({ align: "center", x: 50 });
        expect(at("right")).toEqual({ align: "right", x: 100 });
        // `justify` has no canvas equivalent -- it falls back to left rather than inventing one.
        expect(at("justify")).toEqual({ align: "left", x: 0 });
    });

    test("empty / whitespace-only text emits ONE empty fillText (draws nothing, never throws)", () => {
        const doc = docWith({ type: "core.text", text: "   ", geometry: { x: 0, y: 0, width: 100, height: 50 }, style: { fill: "#111", opacity: 1, fontSize: 10 } });
        const b = bracket(run(doc).calls, "fillText");
        expect(b.filter(c => c.op === "fillText").map(c => c.args)).toEqual([["", 0, 0]]);
    });

    test("a text STARTING with an over-wide word emits no empty first line", () => {
        // The first word arrives with line == "" — without the first-word-stays guard the wrap
        // would push an empty line first (fillText("") at y 0 and everything shifted down).
        const doc = docWith({
            type: "core.text", text: "verylongwordhere aa", // 160 / 20 px in a 100px box
            geometry: { x: 0, y: 0, width: 100, height: 200 },
            style: { fill: "#111", opacity: 1, fontSize: 10 }
        });
        const b = bracket(run(doc).calls, "fillText");
        expect(b.filter(c => c.op === "fillText").map(c => c.args)).toEqual([
            ["verylongwordhere", 0, 0],  // the over-wide word IS line one — no "" before it
            ["aa", 0, 12]
        ]);
    });

    test("image is deferred: draws nothing (empty save/restore)", () => {
        const doc = docWith({ type: "core.image", src: "data:x", style: { fill: "#000", opacity: 1 } });
        // The content item's bracket is a bare save→(translate)→restore with no draw ops.
        const c = run(doc).calls;
        // No drawImage, no fillText, and no content rect(0,0,200,100).
        expect(ops(c)).not.toContain("drawImage");
        expect(c.some(x => x.op === "rect" && JSON.stringify(x.args) === "[0,0,200,100]")).toBe(false);
    });

    test("unknown type → magenta fallback rect (no globalAlpha, opacity is null)", () => {
        const node = { id: "x", type: "core.mystery", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {} } as unknown as Node;
        const doc = createEmptyDocument(); doc.nodes.set("x", node); doc.rootNodeUuids = ["x"];
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,10,10]");
        expect(call(b, "set fillStyle")!.args).toEqual(["#ff006e33"]);
        expect(call(b, "set strokeStyle")!.args).toEqual(["#ff006e"]);
        expect(ops(b)).not.toContain("set globalAlpha"); // fallback paint opacity is null
    });
});

// ─── Paint edges + transform + grid ──────────────────────────────────────────
describe("emitCanvas — paint, transform, grid", () => {
    test("a selection outline (fill 'none') skips fill, and world:null items get NO transform", () => {
        const doc = docWith({ type: "core.rectangle", geometry: { x: 10, y: 20, width: 30, height: 40 }, style: { fill: "#fff", opacity: 1 } });
        const c = run(doc, { selectedNodeIds: ["n1"] }).calls;
        // The frame is the node's own box as a closed QUAD, so it arrives as a path starting at
        // the padded top-left (7,17) — not as a rect. It must NOT fill (fill:"none") and NOT transform.
        const b = bracket(c, "moveTo", a => JSON.stringify(a) === "[7,17]");
        expect(ops(b)).toContain("closePath");
        expect(ops(b)).not.toContain("fill");
        expect(ops(b)).not.toContain("translate");
        expect(ops(b)).not.toContain("transform");
        expect(ops(b)).toContain("stroke");
    });

    test("a rotated content node uses ctx.transform with the raw 6 world numbers (not translate)", () => {
        const world = compose(5, 7, 0.5, 1, 1, 100, 50); // rotation → not translation-only
        const doc = docWith({ type: "core.rectangle", geometry: { x: 5, y: 7, width: 200, height: 100 }, transform: { rotation: 0.5 }, style: { fill: "#f00", opacity: 1 } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(ops(b)).toContain("transform");
        expect(ops(b)).not.toContain("translate");
        expect(call(b, "transform")!.args).toEqual([world.a, world.b, world.c, world.d, world.e, world.f]);
    });

    test("grid lines are drawn every frame — no data-sig cache on canvas", () => {
        const doc = createEmptyDocument();
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 1 } };
        const model = buildRenderModel(SIZE, doc, state);
        const ctx = new MockCtx();
        emitCanvas(ctx as unknown as CanvasRenderingContext2D, model, 1);
        const first = ctx.calls.filter(x => x.op === "stroke").length;
        emitCanvas(ctx as unknown as CanvasRenderingContext2D, model, 1); // same model, second frame
        const total = ctx.calls.filter(x => x.op === "stroke").length;
        expect(first).toBe(74);          // one stroke per grid line
        expect(total).toBe(2 * first);   // redrawn, not cached
    });

    test("the rect-tool preview dashes (setLineDash from the dash string)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const b = bracket(run(doc, { previewRect: { x: 1, y: 2, width: 50, height: 30 } }).calls, "rect", a => JSON.stringify(a) === "[1,2,50,30]");
        expect(ops(b)).toContain("setLineDash");
        expect(call(b, "setLineDash")!.args).toEqual([[4, 4]]); // "4 4" → [4,4]
    });

    test("a dash does NOT leak onto the next stroked item", () => {
        // `setLineDash` is context state and it is sticky. Setting it only when an item HAS a dash
        // leaves every later item wearing the last one's pattern for the rest of the frame — the
        // box-select marquee came out dashed because the rectangle preview had run before it, two
        // overlays with nothing to do with each other. Found by measuring pixels in the live app
        // while trying to verify something else entirely.
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const calls = run(doc, {
            previewRect: { x: 1, y: 2, width: 50, height: 30 },
            marqueeRect: { x: 200, y: 200, width: 40, height: 40 }
        }).calls;
        const dashes = calls.filter(c => c.op === "setLineDash").map(c => JSON.stringify(c.args));
        // Both overlays reach `setLineDash`: the preview with its pattern, the marquee with the
        // EMPTY array that clears it. Before the fix the marquee issued no call at all.
        expect(dashes).toContain("[[4,4]]");
        expect(dashes).toContain("[[]]");
        // Every stroked item sets it, so no item can inherit another's.
        const strokes = calls.filter(c => c.op === "stroke").length;
        expect(calls.filter(c => c.op === "setLineDash").length).toBe(strokes);
    });
});

// ─── Effects ─────────────────────────────────────────────────────────────────
describe("emitCanvas — effects", () => {
    const SH = { dx: 2, dy: 5, blur: 3, color: "#f00" };

    test("shadow sets shadowColor/Blur/OffsetX/Y before the shape draws", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, shadow: SH } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(call(b, "set shadowColor")!.args).toEqual(["#f00"]);
        // DOUBLED: `Shadow.blur` is a gaussian SIGMA everywhere else in this engine -- it is what
        // SVG's `feDropShadow stdDeviation` and CSS `filter: blur()` both take -- but the canvas
        // shadow property is defined as TWICE the deviation. Passing sigma straight through drew
        // every shadow half as soft as the SVG backend drew the same document.
        expect(call(b, "set shadowBlur")!.args).toEqual([3 * 2]);    // × z·dpr = 1, × 2 for sigma
        expect(call(b, "set shadowOffsetX")!.args).toEqual([2]);
        expect(call(b, "set shadowOffsetY")!.args).toEqual([5]);
        expect(ops(b).indexOf("set shadowColor")).toBeLessThan(ops(b).indexOf("fill"));
    });

    test("shadow magnitudes scale by z·dpr (device-space, untouched by the CTM)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, shadow: SH } });
        const ctx = new MockCtx();
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 2 } };
        emitCanvas(ctx as unknown as CanvasRenderingContext2D, buildRenderModel(SIZE, doc, state), 3); // scale = 2·3 = 6
        const b = bracket(ctx.calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(call(b, "set shadowBlur")!.args).toEqual([3 * 6 * 2]);
        expect(call(b, "set shadowOffsetX")!.args).toEqual([2 * 6]);
        // The OFFSETS are NOT doubled -- they are distances, not deviations. A fix that scaled the
        // whole shadow block would move every shadow twice as far as the SVG backend puts it.
        expect(call(b, "set shadowOffsetY")!.args).toEqual([5 * 6]);
    });

    test("the shadow's SOFTNESS matches SVG, and its OFFSET is untouched", () => {
        // Measured in the real renderer, as the reach of a shadow's alpha in pixels from a square's
        // edge -- spec-reading is not measurement and this was found by comparing backends:
        //
        //     sigma:            4    8   20   40
        //     SVG feDropShadow: 8   17   45   89
        //     canvas, raw:      4    8   22   46     <- half as soft
        //     canvas, doubled:  8   18   46   87     <- matches
        //
        // The ratio is asserted rather than the literal, so this states the RELATIONSHIP that has
        // to hold between the two backends rather than a number that happens to be right today.
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, shadow: SH } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        const blurArg = call(b, "set shadowBlur")!.args[0] as number;
        const dxArg = call(b, "set shadowOffsetX")!.args[0] as number;
        const dyArg = call(b, "set shadowOffsetY")!.args[0] as number;
        expect(blurArg / SH.blur).toBe(2);
        expect(dxArg / SH.dx).toBe(1);
        expect(dyArg / SH.dy).toBe(1);

        // And BLUR is not doubled: `ctx.filter: blur()` already takes a sigma, so it agrees with
        // SVG untouched. Doubling both would have been the easy wrong fix.
        const blurred = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, blur: 4 } });
        const bb = bracket(run(blurred).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(call(bb, "set filter")!.args).toEqual(["blur(4px)"]);
    });

    test("blur sets ctx.filter = blur(radius·scale px)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, blur: 4 } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(call(b, "set filter")!.args).toEqual(["blur(4px)"]);
    });

    test("an effect-less item sets no shadow/filter", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(ops(b)).not.toContain("set shadowColor");
        expect(ops(b)).not.toContain("set filter");
    });
});

// ─── Image (async bitmap load) ────────────────────────────────────────────────
describe("emitCanvas — image", () => {
    const imgDoc = (src?: string) => docWith({ type: "core.image", style: { fill: "#000", opacity: 1 }, ...(src !== undefined ? { src } : {}) });

    test("a null-href image draws nothing (no drawImage, no crash)", () => {
        expect(ops(run(imgDoc()).calls)).not.toContain("drawImage");
    });

    test("without a DOM (no global Image) a bitmap can't load, so nothing is drawn", () => {
        // The node test env has no `Image`; resolveImage returns null → no drawImage.
        expect(typeof (globalThis as { Image?: unknown }).Image).toBe("undefined");
        expect(ops(run(imgDoc("some-href.png")).calls)).not.toContain("drawImage");
    });

    test("an image whose bitmap hasn't decoded yet draws nothing (waits for onload)", () => {
        const g = globalThis as { Image?: unknown };
        const orig = g.Image;
        class SlowImage { onload: (() => void) | null = null; set src(_v: string) { /* onload never fires */ } }
        g.Image = SlowImage as unknown as typeof Image;
        try {
            expect(ops(run(imgDoc("fake://never-decodes.png")).calls)).not.toContain("drawImage"); // not loaded → nothing
        } finally {
            g.Image = orig;
        }
    });

    test("a decoded bitmap is drawn at the shape box and fires the ready callback", () => {
        // Inject a fake Image that decodes synchronously when its src is set.
        const g = globalThis as { Image?: unknown };
        const orig = g.Image;
        class FakeImage { onload: (() => void) | null = null; set src(_v: string) { this.onload?.(); } }
        g.Image = FakeImage as unknown as typeof Image;
        let ready = false;
        setImageReadyCallback(() => { ready = true; });
        try {
            const calls = run(imgDoc("fake://decoded-once.png")).calls; // unique href → no cache pollution
            const draw = call(calls, "drawImage");
            expect(draw).toBeTruthy();
            expect(draw!.args.slice(1)).toEqual([0, 0, 200, 100]); // shape box (local origin + size)
            expect(draw!.args[0]).toBeInstanceOf(FakeImage);
            expect(ready).toBe(true); // the load fired the repaint callback
        } finally {
            g.Image = orig;
            setImageReadyCallback(null);
        }
    });

    test("canvas FOLDS the group alphas — it cannot composite a group, and says so", () => {
        // SVG nests a real `<g opacity>` and fades the subtree once. Canvas has no layer here,
        // so it multiplies each item by the groups around it — the documented approximation.
        // Two overlapping children therefore show through each other on canvas and not in SVG;
        // this test pins the approximation so the gap is a decision rather than a surprise.
        const doc = createEmptyDocument();
        const mk = (id: string, kids: string[], parent: string | null, opacity: number) =>
            doc.nodes.set(id, { id, type: "core.rectangle", parent, children: kids, geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#4a90d9", opacity }, layout: {} } as Node);
        mk("G", ["A"], null, 0.5); mk("A", [], "G", 0.5);
        doc.rootNodeUuids = ["G"];

        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed: computeGeometry(doc as ProjectDocument), viewport: { x: 0, y: 0, zoom: 1 } };
        const model = buildRenderModel(SIZE, doc as ProjectDocument, state);
        const ctx = new MockCtx();
        emitCanvas(ctx as unknown as CanvasRenderingContext2D, model, 1);

        const alphas = ctx.calls.filter(c => c.op === "set globalAlpha").map(c => c.args[0] as number);
        // G draws inside its own group (1 x 0.5) and A inside it too (0.5 x 0.5).
        expect(alphas).toContain(0.5);
        expect(alphas.some(a => Math.abs(a - 0.25) < 1e-9)).toBe(true);
    });
});

// ─── Image regions and pixel art (schema 51) ─────────────────────────────────
describe("IMAGE REGIONS and pixel art", () => {
    const imageDoc = (over: Record<string, unknown>) => {
        const doc = createEmptyDocument();
        doc.nodes.set("i", {
            id: "i", type: "core.image", parent: null, children: [], name: "i",
            geometry: { x: 10, y: 20, width: 96, height: 96 },
            style: { fill: "#fff", opacity: 1 }, layout: {},
            src: "data:image/png;base64,AAA", ...over
        } as Node);
        doc.rootNodeUuids = ["i"];
        return doc;
    };

    it("draws a SOURCE RECT with the nine-argument form, and the whole image without one", () => {
        // The mock has no decoder, so `resolveImage` returns null and nothing is drawn — which is
        // why this asserts on the display list, the half that decides, rather than on ctx calls.
        // The nine-argument call itself is pinned by the shape reaching the backend intact.
        const tile = buildRenderModel(SIZE, imageDoc({ sourceRect: { x: 72, y: 48, width: 24, height: 24 } }), {
            selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
            computed: computeGeometry(imageDoc({ sourceRect: { x: 72, y: 48, width: 24, height: 24 } })),
            viewport: { x: 0, y: 0, zoom: 1 }
        });
        const shape = tile.content[0].shape;
        // The shape is LOCAL — placement rides in the item's matrix, as it does for every shape
        // here — so the DESTINATION is the node's box at the origin while the SOURCE is in the
        // image's own pixels. Two rectangles in two different spaces, which is the thing about
        // this feature most likely to be confused.
        expect(shape).toMatchObject({
            kind: "image", x: 0, y: 0, width: 96, height: 96,
            source: { x: 72, y: 48, width: 24, height: 24 }
        });

        const whole = buildRenderModel(SIZE, imageDoc({}), {
            selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
            computed: computeGeometry(imageDoc({})), viewport: { x: 0, y: 0, zoom: 1 }
        });
        // NULL, not undefined — a backend must be able to tell "whole image" without guessing.
        expect((whole.content[0].shape as { source: unknown }).source).toBeNull();
    });

    it("carries `pixelated` on EVERY image, so a sticky filter cannot be forgotten", () => {
        const model = (over: Record<string, unknown>) => {
            const d = imageDoc(over);
            return buildRenderModel(SIZE, d, {
                selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
                computed: computeGeometry(d), viewport: { x: 0, y: 0, zoom: 1 }
            }).content[0].shape as { pixelated: boolean };
        };
        // Present and FALSE by default, rather than absent. `imageSmoothingEnabled` is sticky
        // context state — the same shape of bug this backend already shipped with `setLineDash`,
        // where a dash set for one item leaked onto every item after it. A flag that is always
        // there is what makes "set it only when true" impossible to write by accident.
        expect(model({}).pixelated).toBe(false);
        expect(model({ pixelated: true }).pixelated).toBe(true);
        expect(model({ pixelated: false }).pixelated).toBe(false);
    });
});

// ─── Sprite sheet: the DRAWING half ──────────────────────────────────────────
//
// The plan is arithmetic and asserted in `document.test.ts`. This is the other half — the one that
// only exists as a sequence of ctx calls — and it is here because the live sheet got it wrong in a
// way no plan assertion could see: 48 cells drew their backdrop and exactly ONE drew a ball.
describe("SPRITE SHEET drawing", () => {
    it("draws EVERY cell's own frame, not the same frame 48 times", () => {
        const doc = bouncingBall();
        const plan = planSheet(doc, { columns: 4 });
        const ctx = new MockCtx();
        ctx.canvas = { width: plan.width, height: plan.height };
        drawSheet(ctx as unknown as CanvasRenderingContext2D, doc, plan);

        // The ball is the only ellipse in the document, so every `ellipse` call is one cell's ball.
        // Its ARGUMENTS carry the position and the squash — which is exactly what has to differ
        // frame to frame, and exactly what was identical on the live sheet.
        const balls = ctx.calls.filter(c => c.op === "ellipse");
        expect(balls.length).toBe(plan.cells.length);

        // Distinct POSITIONS, counted rather than compared pairwise: a bouncing ball revisits the
        // floor, so "all 48 differ" is false while "the ball moves" is true. A single drawn frame
        // repeated 48 times collapses this to 1, which is the failure being pinned.
        // The ball's PLACE is in the transform, not in the ellipse arguments — `emitCanvas`
        // draws every ellipse at its own local origin and carries position in the CTM. Asserting
        // the ellipse args instead would pass on a sheet with forty-eight identical frames.
        const places = new Set(balls.map(b => {
            const t = ctx.calls.slice(0, ctx.calls.indexOf(b)).reverse().find(c => c.op === "transform" || c.op === "setTransform");
            const a = (t?.args ?? []) as number[];
            return `${t?.op}:${Math.round(a[4])},${Math.round(a[5])}`;
        }));
        expect(places.size).toBeGreaterThan(20);

        // And every cell's base CTM must differ, which is the part that was broken: the offset
        // reaches `emitCanvas` as a target rather than as a `ctx.translate` it would discard.
        const bases = new Set(ctx.calls.filter(c => c.op === "setTransform" && (c.args as number[])[0] === 1 && (c.args as number[])[4] !== 0)
            .map(c => (c.args as number[]).slice(4).join(",")));
        expect(bases.size).toBe(plan.cells.length)
    });

    it("leaves the sheet TRANSPARENT and free of editor furniture", () => {
        const doc = bouncingBall();
        const plan = planSheet(doc, { columns: 4 });
        const ctx = new MockCtx();
        ctx.canvas = { width: plan.width, height: plan.height };
        drawSheet(ctx as unknown as CanvasRenderingContext2D, doc, plan);

        // NO full-canvas fill. The editor's backdrop baked into a texture makes every sprite a
        // solid rectangle, which is the difference between a sheet a game can use and one it
        // cannot — and it is invisible in any assertion about where the frames sit.
        const backdrops = ctx.calls.filter(c => c.op === "fillRect"
            && (c.args as number[])[2] === plan.width && (c.args as number[])[3] === plan.height);
        expect(backdrops).toHaveLength(0);

        // NO GRID. Non-vacuous first: the same document drawn the editor's way DOES stroke grid
        // lines, so the absence below is the blanking working rather than a document with no grid.
        const editor = new MockCtx();
        const model = buildRenderModel({ width: plan.cellWidth, height: plan.cellHeight }, doc, {
            selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
            computed: computeGeometry(doc), viewport: { x: plan.frame.x, y: plan.frame.y, zoom: 1 }
        });
        expect(model.grid.lines.length).toBeGreaterThan(0);
        emitCanvas(editor as unknown as CanvasRenderingContext2D, model);
        expect(editor.calls.filter(c => c.op === "stroke").length).toBeGreaterThan(0);
        expect(ctx.calls.filter(c => c.op === "stroke")).toHaveLength(0);
    });

    it("gives emitCanvas's target both an offset and a background it can switch off", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("r", { id: "r", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 10, y: 10, width: 20, height: 20 }, style: { fill: "#fff", opacity: 1 }, layout: {} } as Node);
        doc.rootNodeUuids = ["r"];
        const model = buildRenderModel(SIZE, doc, {
            selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
            computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 1 }
        });

        // A target's OFFSET must reach the base CTM. It cannot arrive as a caller's `ctx.translate`
        // because `setTransform` is absolute and would discard it — the whole reason this parameter
        // exists rather than the caller simply translating first.
        const moved = new MockCtx();
        emitCanvas(moved as unknown as CanvasRenderingContext2D, model, 1, { x: 70, y: 40, background: null });
        const base = moved.calls.find(c => c.op === "setTransform" && (c.args as number[])[0] === 1
            && ((c.args as number[])[4] !== 0 || (c.args as number[])[5] !== 0));
        expect((base?.args as number[]).slice(4)).toEqual([70, 40]);
        expect(moved.calls.filter(c => c.op === "fillRect" && (c.args as number[])[2] === 800)).toHaveLength(0);

        // A target with a COLOUR still paints one, and no target at all keeps the editor's own.
        const painted = new MockCtx();
        emitCanvas(painted as unknown as CanvasRenderingContext2D, model, 1, { x: 0, y: 0, background: "#123456" });
        expect(painted.calls.some(c => c.op === "set fillStyle" && c.args[0] === "#123456")).toBe(true);
        const plain = new MockCtx();
        emitCanvas(plain as unknown as CanvasRenderingContext2D, model);
        expect(plain.calls.some(c => c.op === "set fillStyle" && c.args[0] === "#1a1a2e")).toBe(true);
    });

    it("puts each cell's ink INSIDE its own cell", () => {
        const doc = bouncingBall();
        const plan = planSheet(doc, { columns: 4 });
        const ctx = new MockCtx();
        ctx.canvas = { width: plan.width, height: plan.height };
        drawSheet(ctx as unknown as CanvasRenderingContext2D, doc, plan);

        // Every cell is clipped to its OWN rect before anything is drawn into it. Without this a
        // frame whose ink exceeds the measured union corrupts its neighbour rather than itself.
        const clips = ctx.calls.filter(c => c.op === "rect").map(c => c.args.slice(0, 2).join(","));
        for (const cell of plan.cells) expect(clips).toContain(`${cell.x},${cell.y}`);
        // The rect ALONE is not a clip — it is a path nobody used. One `clip` per cell, or a
        // frame that overflows its measured union corrupts its neighbour instead of itself.
        expect(ctx.calls.filter(c => c.op === "clip")).toHaveLength(plan.cells.length);
    });
});

// ─── Gradient fills (schema 56) ──────────────────────────────────────────────
/**
 * Canvas paints a ramp by MOVING THE CTM, not by clipping and flooding.
 *
 * The path's coordinates are fixed when each segment is added; a gradient is evaluated in the
 * space live at the FILL. Those are two different moments, and the whole mechanism lives in the
 * gap: transform after the path is built and the ramp moves while the shape does not. What this
 * file can see is the CALL SEQUENCE — that the transforms are issued between the path and the
 * fill, in SVG's order, and are undone afterwards. Whether the pixels then MATCH the SVG backend
 * is a browser check; see TESTING.md.
 */
describe("emitCanvas — a gradient fill", () => {
    const RAMP = {
        kind: "linear" as const, units: "objectBoundingBox" as const,
        transform: { a: 2, b: 0, c: 0, d: 3, e: 5, f: 7 },
        x1: 0, y1: 0.5, x2: 1, y2: 0.5, cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5,
        stops: [{ offset: 0, color: "#ff0000", opacity: 1 },
            { offset: 1, color: "#0000ff", opacity: 0.5 }]
    };
    const gradientDoc = (fill: unknown) =>
        docWith({ type: "core.rectangle", style: { fill: fill as never, opacity: 1 } });

    test("the CTM moves between the path and the fill, and is undone after it", () => {
        const c = run(gradientDoc(RAMP)).calls;
        const from = c.findIndex(x => x.op === "rect");
        const seq = ops(c.slice(from)).slice(0, 8);
        // The box first, then the ramp's own matrix — SVG's order — and both AFTER the path. The
        // node's own opacity is still set once for the whole fill, outside the ramp's bracket,
        // exactly as it is for a flat colour.
        expect(seq).toEqual(["rect", "set globalAlpha", "save", "transform", "transform",
            "createLinearGradient", "addColorStop", "addColorStop"]);
        const t = c.slice(from).filter(x => x.op === "transform");
        // The node is 200x100 (`docWith`), so the box fold is exactly that and nothing else.
        expect(t[0].args).toEqual([200, 0, 0, 100, 0, 0]);
        expect(t[1].args).toEqual([2, 0, 0, 3, 5, 7]);
        // The gradient is built in its OWN coordinates — 0..1, not 0..200. The CTM does the rest.
        expect(c.slice(from).find(x => x.op === "createLinearGradient")!.args).toEqual([0, 0.5, 1, 0.5]);
        // …and the fill happens under that CTM, with the restore after it, or the next shape
        // inherits a matrix that has nothing to do with it.
        const tail = ops(c.slice(from));
        expect(tail.indexOf("fill")).toBeGreaterThan(tail.indexOf("createLinearGradient"));
        expect(tail.indexOf("restore")).toBeGreaterThan(tail.indexOf("fill"));
    });

    test("stop-opacity is folded into the colour, because Canvas has one string per stop", () => {
        const c = run(gradientDoc(RAMP)).calls;
        const stops = c.filter(x => x.op === "addColorStop").map(x => x.args);
        // Full opacity passes the colour through untouched; anything less becomes rgba. SVG keeps
        // the two apart, so this is the one place they have to be combined.
        expect(stops).toEqual([[0, "#ff0000"], [1, "rgba(0, 0, 255, 0.5)"]]);
    });

    test("a RADIAL is built as SVG defines it: radius zero AT THE FOCUS, growing to r", () => {
        const c = run(gradientDoc({ ...RAMP, kind: "radial", fx: 0.25, fy: 0.3 })).calls;
        const g = c.find(x => x.op === "createRadialGradient")!;
        // Not (cx, cy, 0, cx, cy, r): the inner circle sits on the FOCUS, which is what makes the
        // highlight off-centre. With the focus at the centre the two spellings agree, which is why
        // this fixture moves it.
        expect(g.args).toEqual([0.25, 0.3, 0, 0.5, 0.5, 0.5]);
    });

    test("userSpaceOnUse gets NO box fold — one transform, not two", () => {
        const c = run(gradientDoc({ ...RAMP, units: "userSpaceOnUse" })).calls;
        const from = c.findIndex(x => x.op === "rect");
        const t = c.slice(from).filter(x => x.op === "transform");
        expect(t.map(x => x.args)).toEqual([[2, 0, 0, 3, 5, 7]]);
    });

    test("a plain colour still takes the short path — no transform, no save", () => {
        // Without this, every assertion above could equally describe a backend that wraps EVERY
        // fill in a save/transform pair, which would be a real cost on every shape in the frame.
        const c = run(gradientDoc("#123456")).calls;
        const from = c.findIndex(x => x.op === "rect");
        expect(ops(c.slice(from)).slice(0, 4)).toEqual(["rect", "set globalAlpha", "set fillStyle", "fill"]);
        expect(c.slice(from).find(x => x.op === "createLinearGradient")).toBeUndefined();
    });

    test("save and restore stay BALANCED, so the next shape does not inherit the ramp's matrix", () => {
        // Deleting the ramp's own `restore` passed every assertion above: the item's outer
        // restore also comes after the fill, so "a restore happens later" is satisfied by the
        // wrong one. What it actually leaves behind is an unpopped state — the CTM leaks into
        // every shape drawn after it, which is the sort of fault that shows up three shapes away
        // from its cause.
        const doc = gradientDoc(RAMP);
        doc.nodes.set("n2", { id: "n2", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 300, y: 20, width: 50, height: 50 },
            style: { fill: "#00ff00", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["n1", "n2"];
        const c = run(doc).calls;
        expect(ops(c).filter(o => o === "save").length).toBe(ops(c).filter(o => o === "restore").length);
        // And a restore sits between the ramp and the NEXT shape's path, so the bracket closed
        // rather than merely being balanced somewhere later in the frame.
        const o = ops(c);
        const built = o.indexOf("createLinearGradient");
        const nextPath = o.indexOf("rect", built);
        expect(nextPath).toBeGreaterThan(built);
        expect(o.slice(built, nextPath)).toContain("restore");
    });

    test("a STROKE is not drawn under the ramp's matrix", () => {
        // The ramp's transform brackets the FILL alone. A stroke inside it would be skewed by the
        // gradient's own matrix — a border that changes width and angle with the fill's direction.
        const c = run(docWith({ type: "core.rectangle",
            style: { fill: RAMP as never, opacity: 1, stroke: "#ffffff", strokeWidth: 4 } })).calls;
        // Scoped to this item: the GRID is stroked long before any content is filled, so a
        // whole-frame `indexOf("stroke")` answers a different question entirely.
        const o = ops(c.slice(c.findIndex(x => x.op === "rect")));
        expect(o.indexOf("stroke")).toBeGreaterThan(o.indexOf("fill"));
        // And the ramp's bracket closes BETWEEN them, so the stroke runs under the item's own
        // matrix rather than the gradient's.
        expect(o.slice(o.indexOf("fill"), o.indexOf("stroke"))).toContain("restore");
    });

    test("a zero-radius radial paints the LAST stop, which is what SVG does with one", () => {
        // Canvas paints nothing for a zero-radius gradient; SVG paints the last stop everywhere,
        // and files use exactly that to flatten a fill. A hole would be the wrong answer.
        const c = run(gradientDoc({ ...RAMP, kind: "radial", r: 0 })).calls;
        expect(c.find(x => x.op === "createRadialGradient")).toBeUndefined();
        const from = c.findIndex(x => x.op === "rect");
        expect(c.slice(from).find(x => x.op === "set fillStyle")!.args).toEqual(["#0000ff"]);
    });
});
