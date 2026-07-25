/**
 * emitCanvas tests — the canvas backend verified via a RECORDING-MOCK
 * CanvasRenderingContext2D. Canvas is immediate-mode, so its entire output IS the
 * ordered sequence of ctx calls; capturing that sequence (with a mock, no jsdom, no
 * node-canvas dep) is the truest node-env assertion of "the backend issued the right
 * primitive, with the right paint, in the right order, under the right transform".
 * Pixel-level SVG↔canvas parity stays a browser smoke test.
 */

import { emitCanvas } from "./emitCanvas";
import { buildRenderModel } from "./RenderModel";
import { RendererState } from "./RendererState";
import { createEmptyDocument, ProjectDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { computeGeometry } from "../core/geometry/GeometryEngine";
import { compose } from "../core/geometry/Matrix";

const SIZE = { width: 800, height: 600 };

// ─── Recording mock ctx ──────────────────────────────────────────────────────
type Call = { op: string; args: unknown[] };

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
    setLineDash(a: number[]) { this.log("setLineDash", a); }

    private _fillStyle = ""; get fillStyle() { return this._fillStyle; } set fillStyle(v: string) { this._fillStyle = v; this.log("set fillStyle", v); }
    private _strokeStyle = ""; get strokeStyle() { return this._strokeStyle; } set strokeStyle(v: string) { this._strokeStyle = v; this.log("set strokeStyle", v); }
    private _lineWidth = 1; get lineWidth() { return this._lineWidth; } set lineWidth(v: number) { this._lineWidth = v; this.log("set lineWidth", v); }
    private _globalAlpha = 1; get globalAlpha() { return this._globalAlpha; } set globalAlpha(v: number) { this._globalAlpha = v; this.log("set globalAlpha", v); }
    private _font = ""; get font() { return this._font; } set font(v: string) { this._font = v; this.log("set font", v); }
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
        expect(ops(b)).toEqual(["save", "translate", "beginPath", "rect", "set globalAlpha", "set fillStyle", "fill", "set strokeStyle", "set lineWidth", "stroke", "restore"]);
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
        expect(ops(b)).toEqual(["save", "translate", "beginPath", "moveTo", "lineTo", "set globalAlpha", "set strokeStyle", "set lineWidth", "stroke", "restore"]);
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

    test("text: single-line fillText, top baseline, clipped to the box", () => {
        const doc = docWith({ type: "core.text", text: "hi", style: { fill: "#111", opacity: 1, fontSize: 20 } });
        const b = bracket(run(doc).calls, "fillText");
        expect(ops(b)).toEqual(["save", "translate", "set font", "set globalAlpha", "set fillStyle", "set textBaseline", "beginPath", "rect", "clip", "fillText", "restore"]);
        expect(call(b, "set font")!.args).toEqual(["20px sans-serif"]);
        expect(call(b, "set textBaseline")!.args).toEqual(["top"]);
        expect(call(b, "fillText")!.args).toEqual(["hi", 0, 0]);
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
        // Outline rect is at bounds±pad = (7,17,36,46); it must NOT fill (fill:"none") and NOT transform.
        const b = bracket(c, "rect", a => JSON.stringify(a) === "[7,17,36,46]");
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
});

// ─── Effects ─────────────────────────────────────────────────────────────────
describe("emitCanvas — effects", () => {
    const SH = { dx: 2, dy: 5, blur: 3, color: "#f00" };

    test("shadow sets shadowColor/Blur/OffsetX/Y before the shape draws", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, shadow: SH } });
        const b = bracket(run(doc).calls, "rect", a => JSON.stringify(a) === "[0,0,200,100]");
        expect(call(b, "set shadowColor")!.args).toEqual(["#f00"]);
        expect(call(b, "set shadowBlur")!.args).toEqual([3]);    // × z·dpr = 1
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
        expect(call(b, "set shadowBlur")!.args).toEqual([3 * 6]);
        expect(call(b, "set shadowOffsetX")!.args).toEqual([2 * 6]);
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
