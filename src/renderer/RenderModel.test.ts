/**
 * RenderModel tests — the renderer's first automated coverage.
 * Covers: the pure `buildRenderModel` display list — content shapes/paint,
 * world pass-through (reads only ComputedState), overlay outlines/handles/preview,
 * grid signature + by-reference reuse, determinism, and the finite-skip.
 *
 * The `emitSVG` backend is intentionally NOT unit-tested here: it needs a DOM and
 * contains no draw decisions (all resolved in the model), so it is covered by the
 * browser smoke tests. Everything that can be logically wrong lives in this pure
 * layer, asserted on plain data in the `node` environment like the layout engine.
 */

import { buildRenderModel, DisplayList, HANDLE_SIZE_PX } from "./RenderModel";
import { RendererState } from "./RendererState";
import { createEmptyDocument, ProjectDocument, ReadonlyDocument } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { computeGeometry, ComputedState } from "../core/geometry/GeometryEngine";
import { IDENTITY } from "../core/geometry/Matrix";

const SIZE = { width: 800, height: 600 };

function stateFor(doc: ProjectDocument, over?: Partial<RendererState>): RendererState {
    return {
        selectedNodeIds: [],
        hoveredNodeId: null,
        previewRect: null,
        computed: computeGeometry(doc),
        viewport: { x: 0, y: 0, zoom: 1 },
        ...over
    };
}

function docWith(node: Partial<Node> & Pick<Node, "type" | "style">): ProjectDocument {
    const doc = createEmptyDocument();
    const full: Node = {
        id: "n1", parent: null, children: [],
        geometry: { x: 5, y: 7, width: 200, height: 100 }, layout: {},
        ...node
    };
    doc.nodes.set(full.id, full);
    doc.rootNodeUuids = [full.id];
    return doc;
}

// ─── Content ─────────────────────────────────────────────────────────────────
describe("buildRenderModel — content", () => {
    test("rectangle → one rect item with resolved paint, placed by computed world", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#ff0000", opacity: 0.5, radius: 8, stroke: "#000" } });
        const state = stateFor(doc);
        const model = buildRenderModel(SIZE, doc, state);

        expect(model.content.length).toBe(1);
        const item = model.content[0];
        expect(item.shape).toEqual({ kind: "rect", x: 0, y: 0, width: 200, height: 100 });
        expect(item.paint.fill).toBe("#ff0000");
        expect(item.paint.opacity).toBe(0.5);
        expect(item.paint.radius).toBe(8);
        expect(item.paint.stroke).toBe("#000");
        expect(item.paint.strokeWidth).toBe(1); // 1/z at z=1
        expect(item.paint.cursor).toBe("pointer");
        expect(item.paint.pointerEvents).toBe(true);
        expect(item.nodeId).toBe("n1");
        // The renderer invariant: world comes straight from ComputedState, unmodified.
        expect(item.world).toBe(state.computed.nodes.get("n1")!.world);
    });

    test("rectangle without stroke/radius omits those (null = no attribute)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.paint.stroke).toBeNull();
        expect(item.paint.strokeWidth).toBeNull();
        expect(item.paint.radius).toBeNull();
    });

    test("text → text shape carrying content + fontSize, fill as color", () => {
        const doc = docWith({ type: "core.text", text: "Hello", style: { fill: "#0af", opacity: 1, fontSize: 20 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.shape).toEqual({ kind: "text", x: 0, y: 0, width: 200, height: 100, text: "Hello", fontSize: 20 });
        expect(item.paint.fill).toBe("#0af");
        expect(item.paint.opacity).toBe(1);
    });

    test("text defaults: missing text → 'Text', missing fontSize → 14", () => {
        const doc = docWith({ type: "core.text", style: { fill: "#fff", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.shape).toMatchObject({ kind: "text", text: "Text", fontSize: 14 });
    });

    test("image → image shape with href from src; missing src → null href", () => {
        const withSrc = docWith({ type: "core.image", src: "data:image/png;base64,AAA", style: { fill: "#000", opacity: 1 } });
        const a = buildRenderModel(SIZE, withSrc, stateFor(withSrc)).content[0];
        expect(a.shape).toEqual({ kind: "image", x: 0, y: 0, width: 200, height: 100, href: "data:image/png;base64,AAA" });
        expect(a.paint.opacity).toBe(1);

        const noSrc = docWith({ type: "core.image", style: { fill: "#000", opacity: 1 } });
        const b = buildRenderModel(SIZE, noSrc, stateFor(noSrc)).content[0];
        expect(b.shape).toMatchObject({ kind: "image", href: null });
    });

    test("unknown node type → magenta fallback rect with NO opacity attr", () => {
        // Unreachable through the validated API (NODE_TYPES is closed), so build inputs by hand.
        const node = {
            id: "x", type: "core.mystery", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {}
        } as unknown as Node;
        const doc = { nodes: new Map([["x", node]]) } as unknown as ReadonlyDocument;
        const computed: ComputedState = {
            order: ["x"],
            nodes: new Map([["x", { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: 10, height: 10 } }]])
        };
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed, viewport: { x: 0, y: 0, zoom: 1 } };
        const item = buildRenderModel(SIZE, doc, state).content[0];
        expect(item.shape.kind).toBe("rect");
        expect(item.paint.fill).toBe("#ff006e33");
        expect(item.paint.stroke).toBe("#ff006e");
        expect(item.paint.opacity).toBeNull();
        expect(item.nodeId).toBe("x");
    });

    test("non-finite bounds → no content item", () => {
        const node = {
            id: "x", type: "core.rectangle", parent: null, children: [],
            geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#fff", opacity: 1 }, layout: {}
        } as unknown as Node;
        const doc = { nodes: new Map([["x", node]]) } as unknown as ReadonlyDocument;
        const computed: ComputedState = {
            order: ["x"],
            nodes: new Map([["x", { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: NaN, height: 10 } }]])
        };
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed, viewport: { x: 0, y: 0, zoom: 1 } };
        expect(buildRenderModel(SIZE, doc, state).content.length).toBe(0);
    });
});

// ─── Overlay ─────────────────────────────────────────────────────────────────
describe("buildRenderModel — overlay", () => {
    test("selected node → one outline plus four handles at its world bounds", () => {
        const doc = docWith({ type: "core.rectangle", geometry: { x: 10, y: 20, width: 30, height: 40 }, style: { fill: "#fff", opacity: 1 } });
        const state = stateFor(doc, { selectedNodeIds: ["n1"] });
        const model = buildRenderModel(SIZE, doc, state);
        const b = state.computed.nodes.get("n1")!.bounds;

        const outlines = model.overlay.filter(i => i.role === "outline");
        const handles = model.overlay.filter(i => i.role === "handle");
        expect(outlines.length).toBe(1);
        expect(handles.length).toBe(4);

        expect(outlines[0].shape).toEqual({ kind: "rect", x: b.x - 3, y: b.y - 3, width: b.width + 6, height: b.height + 6 });
        expect(outlines[0].paint).toMatchObject({ fill: "none", stroke: "#00bfff", strokeWidth: 1.5, pointerEvents: false });
        expect(outlines[0].world).toBeNull();

        const hs = HANDLE_SIZE_PX; // z = 1
        expect(handles.map(h => h.handle)).toEqual(["nw", "ne", "sw", "se"]);
        expect(handles[0].shape).toEqual({ kind: "rect", x: b.x - hs / 2, y: b.y - hs / 2, width: hs, height: hs });
        expect(handles[3].shape).toMatchObject({ x: b.x + b.width - hs / 2, y: b.y + b.height - hs / 2 });
        expect(handles.every(h => h.nodeId === "n1")).toBe(true);
        expect(handles[1].paint.cursor).toBe("nesw-resize");
        expect(handles[0].paint.cursor).toBe("nwse-resize");
    });

    test("hovered (not selected) → a fainter outline, no handles", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { hoveredNodeId: "n1" }));
        const outlines = model.overlay.filter(i => i.role === "outline");
        expect(outlines.length).toBe(1);
        expect(outlines[0].paint).toMatchObject({ stroke: "#ffffff44", strokeWidth: 1 });
        expect(model.overlay.filter(i => i.role === "handle").length).toBe(0);
    });

    test("selection wins over hover for the outline style", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["n1"], hoveredNodeId: "n1" }));
        const outlines = model.overlay.filter(i => i.role === "outline");
        expect(outlines.length).toBe(1);
        expect(outlines[0].paint.stroke).toBe("#00bfff");
    });

    test("preview rect only when it has positive extent", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const shown = buildRenderModel(SIZE, doc, stateFor(doc, { previewRect: { x: 1, y: 2, width: 50, height: 30 } }));
        const previews = shown.overlay.filter(i => i.role === "preview");
        expect(previews.length).toBe(1);
        expect(previews[0].shape).toEqual({ kind: "rect", x: 1, y: 2, width: 50, height: 30 });
        expect(previews[0].paint).toMatchObject({ fill: "#4a90d933", stroke: "#4a90d9", strokeDash: "4 4", pointerEvents: false });

        const zero = buildRenderModel(SIZE, doc, stateFor(doc, { previewRect: { x: 0, y: 0, width: 0, height: 30 } }));
        expect(zero.overlay.filter(i => i.role === "preview").length).toBe(0);
    });
});

// ─── Grid ────────────────────────────────────────────────────────────────────
describe("buildRenderModel — grid", () => {
    test("line count matches the visible-range math at zoom 1", () => {
        const doc = createEmptyDocument();
        const model = buildRenderModel(SIZE, doc, stateFor(doc));
        // z=1: vpW=800,vpH=600,gridSize=20; verticals 0..820 (42), horizontals 0..620 (32).
        expect(model.grid.lines.length).toBe(74);
        expect(model.grid.lines.every(l => l.shape.kind === "line")).toBe(true);
    });

    test("sig is a deterministic function of the visible range", () => {
        const doc = createEmptyDocument();
        const a = buildRenderModel(SIZE, doc, stateFor(doc));
        const b = buildRenderModel(SIZE, doc, stateFor(doc));
        expect(b.grid.sig).toBe(a.grid.sig);
    });

    test("unchanged viewport reuses prev grid lines BY REFERENCE", () => {
        const doc = createEmptyDocument();
        const state = stateFor(doc);
        const m1 = buildRenderModel(SIZE, doc, state);
        expect(m1.grid.unchanged).toBe(false);

        const m2 = buildRenderModel(SIZE, doc, state, m1);
        expect(m2.grid.unchanged).toBe(true);
        expect(m2.grid.lines).toBe(m1.grid.lines); // same reference — allocation avoided
    });

    test("moved viewport rebuilds: fresh sig, fresh lines (non-vacuous companion)", () => {
        const doc = createEmptyDocument();
        const m1 = buildRenderModel(SIZE, doc, stateFor(doc));
        const m3 = buildRenderModel(SIZE, doc, stateFor(doc, { viewport: { x: 1000, y: 0, zoom: 1 } }), m1);
        expect(m3.grid.sig).not.toBe(m1.grid.sig);
        expect(m3.grid.unchanged).toBe(false);
        expect(m3.grid.lines).not.toBe(m1.grid.lines);
    });
});

// ─── Whole-model invariants ──────────────────────────────────────────────────
describe("buildRenderModel — invariants", () => {
    function docTree(): ProjectDocument {
        const doc = createEmptyDocument();
        const parent: Node = { id: "p", type: "core.rectangle", parent: null, children: ["c1", "c2"], geometry: { x: 0, y: 0, width: 400, height: 300 }, style: { fill: "#00f", opacity: 1 }, layout: {} };
        const c1: Node = { id: "c1", type: "core.rectangle", parent: "p", children: [], geometry: { x: 10, y: 10, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} };
        const c2: Node = { id: "c2", type: "core.text", parent: "p", children: [], geometry: { x: 70, y: 10, width: 50, height: 50 }, style: { fill: "#0f0", opacity: 1 }, text: "hi", layout: {} };
        doc.nodes.set("p", parent); doc.nodes.set("c1", c1); doc.nodes.set("c2", c2);
        doc.rootNodeUuids = ["p"];
        return doc;
    }

    test("exactly one content item per drawable id (all on-screen), in computed order, world by reference", () => {
        const doc = docTree();
        const state = stateFor(doc);
        const model = buildRenderModel(SIZE, doc, state);

        expect(model.content.map(i => i.nodeId)).toEqual(state.computed.order);
        model.content.forEach(item => {
            expect(item.world).toBe(state.computed.nodes.get(item.nodeId!)!.world);
        });
    });

    test("the model is a deterministic function of its inputs", () => {
        const doc = docTree();
        const state = stateFor(doc, { selectedNodeIds: ["c1"], previewRect: { x: 1, y: 1, width: 5, height: 5 } });
        const a = buildRenderModel(SIZE, doc, state);
        const b = buildRenderModel(SIZE, doc, state);
        expect(b).toEqual(a);
    });
});

// ─── Viewport culling ────────────────────────────────────────────────────────
// The visible world rect at SIZE {800,600} is {x: vp.x/z, y: vp.y/z, w: 800/z, h: 600/z}.
// Content whose world bounds don't (inclusively) overlap it is dropped. Boundaries are
// pinned EXACTLY (800/0/600, +1 outside); the /z factor is only exercised by the zoom
// and pan+zoom cases; the width/height swap only by the asymmetric bands.
describe("buildRenderModel — culling", () => {
    /** Root rectangles: for a root with no transform, world bounds === its geometry. */
    function rects(specs: { id: string; x: number; y: number; width: number; height: number }[]): ProjectDocument {
        const doc = createEmptyDocument();
        for (const s of specs) {
            doc.nodes.set(s.id, { id: s.id, type: "core.rectangle", parent: null, children: [], geometry: { x: s.x, y: s.y, width: s.width, height: s.height }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        }
        doc.rootNodeUuids = specs.map(s => s.id);
        return doc;
    }
    const one = (x: number, y: number, width = 50, height = 50) => rects([{ id: "n1", x, y, width, height }]);
    function contentIds(doc: ProjectDocument, over?: Partial<RendererState>): string[] {
        return buildRenderModel(SIZE, doc, stateFor(doc, over)).content.map(i => i.nodeId!);
    }

    test("T2 fully inside → present", () => expect(contentIds(one(100, 100))).toEqual(["n1"]));
    test("T3 fully outside on x → absent", () => expect(contentIds(one(1000, 100))).toEqual([]));
    test("T4 fully outside on y → absent (exercises the y inequalities)", () => expect(contentIds(one(100, 1000))).toEqual([]));
    test("T5 straddling the right edge → present", () => expect(contentIds(one(780, 100))).toEqual(["n1"]));

    // Exact-boundary pairs pin each comparison to <= / >= (a strict mutant drops the touch case).
    test("T6 edge-touch right (bounds.x === 800) → present", () => expect(contentIds(one(800, 100))).toEqual(["n1"]));
    test("T7 just outside right (+1) → absent", () => expect(contentIds(one(801, 100))).toEqual([]));
    test("T8 edge-touch left (bounds.right === 0) → present", () => expect(contentIds(one(-50, 100))).toEqual(["n1"]));
    test("T9 just outside left (-1) → absent", () => expect(contentIds(one(-51, 100))).toEqual([]));
    test("T10 edge-touch bottom (bounds.y === 600) → present", () => expect(contentIds(one(100, 600))).toEqual(["n1"]));
    test("T11 edge-touch top (bounds.bottom === 0) → present; +1 past → absent", () => {
        expect(contentIds(one(100, -50))).toEqual(["n1"]);
        expect(contentIds(one(100, 601))).toEqual([]);
    });

    // Width/height swap guard: asymmetric bands (600,800] — a near-origin node is blind to the swap.
    test("T12 x in the (600,800] band → present (swapped width 600 would cull it)", () => expect(contentIds(one(700, 100))).toEqual(["n1"]));
    test("T13 y in the (600,800] band → absent (swapped height 800 would keep it)", () => expect(contentIds(one(100, 700))).toEqual([]));

    test("T14 zoom-in shrinks the visible world rect (kills dropped /z on extent)", () => {
        // vp{0,0,2} → visible {0,0,400,300}. Only B (inside) survives.
        const doc = rects([{ id: "B", x: 100, y: 100, width: 50, height: 50 }, { id: "A", x: 500, y: 100, width: 50, height: 50 }, { id: "C", x: 100, y: 400, width: 50, height: 50 }]);
        expect(contentIds(doc, { viewport: { x: 0, y: 0, zoom: 2 } })).toEqual(["B"]);
    });
    test("T15 zoom-out grows it (kills dropped /z from the other side)", () => {
        // vp{0,0,0.5} → visible {0,0,1600,1200}; a node at x=1000 (outside un-zoomed 800) is now visible.
        expect(contentIds(one(1000, 100), { viewport: { x: 0, y: 0, zoom: 0.5 } })).toEqual(["n1"]);
    });
    test("T16 pan offsets the visible origin (kills origin→0)", () => {
        // vp{1000,0,1} → visible [1000,1800]. Only ON survives.
        const doc = rects([{ id: "OFF", x: 100, y: 100, width: 50, height: 50 }, { id: "ON", x: 1200, y: 100, width: 50, height: 50 }]);
        expect(contentIds(doc, { viewport: { x: 1000, y: 0, zoom: 1 } })).toEqual(["ON"]);
    });
    test("T17 pan+zoom — the ONLY case that catches a dropped /z on the origin", () => {
        // vp{1000,0,2} → visible origin x=1000/2=500, width=400 → [500,900]. Only mid survives.
        const doc = rects([{ id: "near", x: 100, y: 100, width: 50, height: 50 }, { id: "mid", x: 600, y: 100, width: 50, height: 50 }, { id: "far", x: 950, y: 100, width: 50, height: 50 }]);
        expect(contentIds(doc, { viewport: { x: 1000, y: 0, zoom: 2 } })).toEqual(["mid"]);
    });
    test("T18 axis-distinct pan (kills an x/y axis swap in the predicate)", () => {
        // vp{1000,2000,1} → visible x[1000,1800], y[2000,2600].
        const doc = rects([{ id: "OFF", x: 100, y: 100, width: 50, height: 50 }, { id: "ON", x: 1200, y: 2100, width: 50, height: 50 }]);
        expect(contentIds(doc, { viewport: { x: 1000, y: 2000, zoom: 1 } })).toEqual(["ON"]);
    });

    test("T19 overlay is NOT culled for an off-screen SELECTED node (content-only scope)", () => {
        const doc = one(2000, 2000);
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["n1"] }));
        expect(model.content.length).toBe(0); // content culled...
        expect(model.overlay.filter(i => i.role === "outline").length).toBe(1); // ...but overlay kept
        expect(model.overlay.filter(i => i.role === "handle").length).toBe(4);
    });
    test("T20 the grid is NOT culled when all content is off-screen", () => {
        const doc = one(2000, 2000);
        const model = buildRenderModel(SIZE, doc, stateFor(doc));
        expect(model.content.length).toBe(0);
        expect(model.grid.lines.length).toBe(74);
    });
    test("T21 size-0 falls back to 800×600 (else everything would cull)", () => {
        const doc = one(100, 100);
        expect(buildRenderModel({ width: 0, height: 0 }, doc, stateFor(doc)).content.map(i => i.nodeId)).toEqual(["n1"]);
    });
    test("T22 culling introduces no nondeterminism (mixed on/off scene)", () => {
        const doc = rects([{ id: "in", x: 100, y: 100, width: 50, height: 50 }, { id: "out", x: 1000, y: 100, width: 50, height: 50 }]);
        const state = stateFor(doc);
        expect(buildRenderModel(SIZE, doc, state)).toEqual(buildRenderModel(SIZE, doc, state));
    });

    test("culling reads the WORLD bounds, not the local origin box", () => {
        // Hand-built: local box sits at the origin (would look 'inside'), but world bounds are far off-screen.
        const node = { id: "x", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#fff", opacity: 1 }, layout: {} } as unknown as Node;
        const doc = { nodes: new Map([["x", node]]) } as unknown as ReadonlyDocument;
        const computed: ComputedState = {
            order: ["x"],
            nodes: new Map([["x", { world: { ...IDENTITY, e: 2000, f: 2000 }, local: { x: 0, y: 0, width: 40, height: 40 }, bounds: { x: 2000, y: 2000, width: 40, height: 40 } }]])
        };
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed, viewport: { x: 0, y: 0, zoom: 1 } };
        expect(buildRenderModel(SIZE, doc, state).content.length).toBe(0);
    });
});

// ─── Shape kinds: ellipse + line ─────────────────────────────────────────────
describe("buildRenderModel — ellipse + line", () => {
    test("ellipse → centre + radii from its box, rect-like paint (no rx)", () => {
        const doc = docWith({ type: "core.ellipse", style: { fill: "#f0f", opacity: 0.8, stroke: "#111" } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.shape).toEqual({ kind: "ellipse", cx: 100, cy: 50, rx: 100, ry: 50 }); // box 200×100
        expect(item.paint.fill).toBe("#f0f");
        expect(item.paint.opacity).toBe(0.8);
        expect(item.paint.stroke).toBe("#111");
        expect(item.paint.strokeWidth).toBe(1); // 1/z at z=1
        expect(item.paint.radius).toBeNull(); // no `rx` — would collide with the ellipse's x-radius
    });

    test("ellipse without stroke omits it", () => {
        const doc = docWith({ type: "core.ellipse", style: { fill: "#fff", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.paint.stroke).toBeNull();
        expect(item.paint.strokeWidth).toBeNull();
    });

    test("line → box diagonal (0,0)→(w,h); colour falls back to fill when no stroke", () => {
        const doc = docWith({ type: "core.line", style: { fill: "#0ff", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.shape).toEqual({ kind: "line", x1: 0, y1: 0, x2: 200, y2: 100 });
        expect(item.paint.stroke).toBe("#0ff"); // fill as the line colour
        expect(item.paint.fill).toBeNull();
        expect(item.paint.strokeWidth).toBe(1);
        expect(item.paint.opacity).toBe(1);
    });

    test("line uses an explicit stroke over the fill fallback, and carries opacity", () => {
        const doc = docWith({ type: "core.line", style: { fill: "#0ff", stroke: "#f00", opacity: 0.4 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.paint.stroke).toBe("#f00");
        expect(item.paint.opacity).toBe(0.4);
    });

    test("line with an EMPTY-string stroke still falls back to fill (|| not ??)", () => {
        const doc = docWith({ type: "core.line", style: { fill: "#0ff", stroke: "", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.paint.stroke).toBe("#0ff");
    });

    test("a horizontal line (height 0) → a flat diagonal, still one content item", () => {
        const doc = docWith({ type: "core.line", geometry: { x: 0, y: 0, width: 120, height: 0 }, style: { fill: "#000", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.shape).toEqual({ kind: "line", x1: 0, y1: 0, x2: 120, y2: 0 });
    });
});
