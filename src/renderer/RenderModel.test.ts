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

import { readFileSync } from "fs";
import { resolve } from "path";
import { buildRenderModel, DisplayList, HANDLE_SIZE_PX, commandsToPathData, effectFilterId, rasterHref, layerTransition } from "./RenderModel";
import { gaussianKernel, gaussianOuterProduct, GAUSSIAN_MAX_RADIUS, GAUSSIAN_SIGMA_CUTOFF,
    blurPlan, GAUSSIAN_MAX_SIGMA, GAUSSIAN_MAX_DOWNSAMPLE } from "./Gaussian";
import { RendererState } from "./RendererState";
import { createEmptyDocument, ProjectDocument, ReadonlyDocument } from "../core/document/Document";
import { VARIABLE_FALLBACK_COLOR } from "../core/document/Variables";
import { Node } from "../core/document/Node";
import { computeGeometry, ComputedState } from "../core/geometry/GeometryEngine";
import { handleAtPoint, ROTATE_OFFSET_PX } from "../core/geometry/SelectionHandles";
import { IDENTITY } from "../core/geometry/Matrix";
import { rectSelection } from "../core/paint/Selection";
import { createPixelBuffer } from "../core/paint/PixelBuffer";
import { encodeSurface } from "../core/paint/PixelCodec";

const SIZE = { width: 800, height: 600 };
/** A hand-built ComputedNode's ink: a plain square box, the default for every non-shape type. */
const BOX = { kind: "box", radius: 0 } as const;

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
        // Every typography slot is RESOLVED here, defaults included, so both backends transcribe
        // and neither decides. The defaults reproduce what was drawn before schema 34.
        expect(item.shape).toEqual({
            kind: "text", x: 0, y: 0, width: 200, height: 100, text: "Hello", fontSize: 20,
            fontFamily: "sans-serif", fontWeight: 400, textAlign: "left", lineHeight: 1.2, letterSpacing: 0
        });
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
        // BOTH new fields are on every image shape, not only when set — a backend reading an
        // absent flag would have to invent a default, and the Canvas one must set its filter
        // for every image regardless, because the smoothing flag is sticky context state.
        expect(a.shape).toEqual({ kind: "image", x: 0, y: 0, width: 200, height: 100,
            href: "data:image/png;base64,AAA", source: null, pixelated: false, nineSlice: null, surface: null });
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
            nodes: new Map([["x", { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: 10, height: 10 }, shape: BOX }]]), locked: new Set<string>()
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
            nodes: new Map([["x", { world: IDENTITY, local: { x: 0, y: 0, width: 10, height: 10 }, bounds: { x: 0, y: 0, width: NaN, height: 10 }, shape: BOX }]]), locked: new Set<string>()
        };
        const state: RendererState = { selectedNodeIds: [], hoveredNodeId: null, previewRect: null, computed, viewport: { x: 0, y: 0, zoom: 1 } };
        expect(buildRenderModel(SIZE, doc, state).content.length).toBe(0);
    });
});

// ─── Overlay ─────────────────────────────────────────────────────────────────
describe("buildRenderModel — overlay", () => {
    test("selected node → one outline, four square resize handles, and a round rotate knob", () => {
        const doc = docWith({ type: "core.rectangle", geometry: { x: 10, y: 20, width: 30, height: 40 }, style: { fill: "#fff", opacity: 1 } });
        const state = stateFor(doc, { selectedNodeIds: ["n1"] });
        const model = buildRenderModel(SIZE, doc, state);
        const b = state.computed.nodes.get("n1")!.bounds;

        const outlines = model.overlay.filter(i => i.role === "outline");
        const handles = model.overlay.filter(i => i.role === "handle");
        expect(outlines.length).toBe(1);
        expect(handles.length).toBe(5); // 4 corners + rotate

        // The frame is the node's OWN box, closed — a quad, not an axis-aligned rect. Unrotated,
        // its corners land exactly where the padded AABB used to be.
        expect(outlines[0].shape).toEqual({
            kind: "path",
            commands: [
                { c: "M", x: b.x - 3, y: b.y - 3 },
                { c: "L", x: b.x + b.width + 3, y: b.y - 3 },
                { c: "L", x: b.x + b.width + 3, y: b.y + b.height + 3 },
                { c: "L", x: b.x - 3, y: b.y + b.height + 3 },
                { c: "Z" }
            ]
        });
        expect(outlines[0].paint).toMatchObject({ fill: "none", stroke: "#00bfff", strokeWidth: 1.5, pointerEvents: false });
        expect(outlines[0].world).toBeNull();

        const hs = HANDLE_SIZE_PX; // z = 1
        expect(handles.map(h => h.handle)).toEqual(["nw", "ne", "sw", "se", "rotate"]);
        expect(handles[0].shape).toEqual({ kind: "rect", x: b.x - hs / 2, y: b.y - hs / 2, width: hs, height: hs });
        expect(handles[3].shape).toMatchObject({ x: b.x + b.width - hs / 2, y: b.y + b.height - hs / 2 });
        // The rotate knob is a CIRCLE above the top-centre, offset up by ROTATE_OFFSET_PX (z = 1).
        expect(handles[4].shape).toEqual({ kind: "ellipse", cx: b.x + b.width / 2, cy: b.y - ROTATE_OFFSET_PX, rx: hs / 2, ry: hs / 2 });
        expect(handles.every(h => h.nodeId === "n1")).toBe(true);
        expect(handles[1].paint.cursor).toBe("nesw-resize");
        expect(handles[0].paint.cursor).toBe("nwse-resize");
        expect(handles[4].paint.cursor).toBe("grab");
    });

    test("handles scale with zoom, and the DRAWN square equals the GRABBABLE square", () => {
        const doc = docWith({ type: "core.rectangle", geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#fff", opacity: 1 } });
        const z = 2;
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["n1"], viewport: { x: 0, y: 0, zoom: z } }));
        const nw = model.overlay.find(i => i.role === "handle" && i.handle === "nw")!;
        const shape = nw.shape as { kind: "rect"; x: number; y: number; width: number; height: number };
        expect(shape.width).toBe(HANDLE_SIZE_PX / z); // drawn edge scales 1/z (not tested elsewhere — all other handle asserts are z=1)
        expect(nw.paint.strokeWidth).toBe(1 / z);
        // Drawn square must equal the grab square: picking with the SAME 1/z size at the drawn
        // edge hits, one epsilon past misses — so draw and pick can't drift at any zoom.
        const cs = computeGeometry(doc); // world geometry is zoom-independent; nw centre = (0,0)
        const cx = shape.x + shape.width / 2, half = shape.width / 2;
        expect(handleAtPoint(cs, ["n1"], cx + half, 0, z)!.handle).toBe("nw"); // same z → grab half == drawn half
        expect(handleAtPoint(cs, ["n1"], cx + half + 0.01, 0, z)).toBeNull();

        // The rotate knob's offset AND radius scale with zoom too (only asserted at z=1 elsewhere).
        const knob = model.overlay.find(i => i.role === "handle" && i.handle === "rotate")!;
        expect(knob.shape).toEqual({ kind: "ellipse", cx: 25, cy: -ROTATE_OFFSET_PX / z, rx: HANDLE_SIZE_PX / z / 2, ry: HANDLE_SIZE_PX / z / 2 });
        // And the drawn knob is grabbable: its centre hits at the same z.
        expect(handleAtPoint(cs, ["n1"], 25, -ROTATE_OFFSET_PX / z, z)!.handle).toBe("rotate");
    });

    test("a component INSTANCE draws its master's content (virtual nodes resolve in the model too)", () => {
        // The regression a live smoke caught: `computed` holds VIRTUAL ids (the engine expands),
        // but the model looked nodes up in the STORED document — so instance content silently
        // vanished. The model must resolve against the same expanded view.
        const doc = createEmptyDocument();
        doc.nodes.set("M", { id: "M", type: "core.rectangle", parent: null, children: ["MC"], geometry: { x: 60, y: 60, width: 160, height: 100 }, style: { fill: "#2266ff", opacity: 1 }, layout: {} });
        doc.nodes.set("MC", { id: "MC", type: "core.rectangle", parent: "M", children: [], geometry: { x: 20, y: 20, width: 60, height: 40 }, style: { fill: "#ffcc00", opacity: 1 }, layout: {} });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 400, y: 300, width: 160, height: 100 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "M" });
        doc.rootNodeUuids = ["M", "I"];
        const model = buildRenderModel(SIZE, doc, stateFor(doc));
        const ids = model.content.map(i => i.nodeId);
        expect(ids).toContain("I::M");    // the instance's copy of the master…
        expect(ids).toContain("I::MC");   // …and of its child
        expect(ids).not.toContain("I");   // the instance itself draws nothing
        // The copies carry the master's paint, and sit at the INSTANCE's world position.
        const copy = model.content.find(i => i.nodeId === "I::M")!;
        expect(copy.paint.fill).toBe("#2266ff");
        expect([copy.world!.e, copy.world!.f]).toEqual([400, 300]);
        const child = model.content.find(i => i.nodeId === "I::MC")!;
        expect(child.paint.fill).toBe("#ffcc00");
        expect([child.world!.e, child.world!.f]).toEqual([420, 320]); // instance + the child's own offset
    });

    test("every instance copy shows its handles — nested ones included, since a path key backs them", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("IM", { id: "IM", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: "#00f", opacity: 1 }, layout: {} });
        doc.nodes.set("OM", { id: "OM", type: "core.rectangle", parent: null, children: ["OI"], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#f00", opacity: 1 }, layout: {} });
        doc.nodes.set("OI", { id: "OI", type: "core.instance", parent: "OM", children: [], geometry: { x: 5, y: 5, width: 10, height: 10 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "IM" });
        doc.nodes.set("I", { id: "I", type: "core.instance", parent: null, children: [], geometry: { x: 200, y: 200, width: 50, height: 50 }, style: { fill: "none", opacity: 1 }, layout: {}, componentId: "OM" });
        doc.rootNodeUuids = ["IM", "OM", "I"];
        // A DIRECT copy: resize corners AND the rotate knob — schema 26 gave overrides a
        // `transform`, so the knob now has somewhere to write.
        const direct = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["I::OM"] }));
        expect(direct.overlay.filter(i => i.role === "handle").map(h => h.handle)).toEqual(["nw", "ne", "sw", "se", "rotate"]);
        // A NESTED copy gets them too (schema 28): the override lands on the owning stored
        // instance under a path key, so the handle has somewhere to write.
        const nested = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["I::OI::IM"] }));
        expect(nested.overlay.filter(i => i.role === "handle").map(h => h.handle)).toEqual(["nw", "ne", "sw", "se", "rotate"]);
        expect(nested.overlay.some(i => i.role === "outline")).toBe(true);
    });

    test("multi-select → ONE group box + GROUP corner handles + one group knob (never per-node handles)", () => {
        const doc = createEmptyDocument();
        const mk = (id: string, x: number, y: number) => doc.nodes.set(id, { id, type: "core.rectangle", parent: null, children: [], geometry: { x, y, width: 50, height: 50 }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        mk("A", 0, 0); mk("B", 100, 100); // union {0,0,150,150}, centre (75,75)
        doc.rootNodeUuids = ["A", "B"];
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["A", "B"] }));

        const handles = model.overlay.filter(i => i.role === "handle");
        // A plain (transform-free) group is resizable AND rotatable: 4 GROUP corners + the knob,
        // all nodeId "" (they belong to the group) — never per-node squares (would be 10).
        expect(handles.length).toBe(5);
        expect(handles.every(h => h.nodeId === "")).toBe(true);
        expect(handles.map(h => h.handle)).toEqual(["nw", "ne", "sw", "se", "rotate"]); // knob LAST (drawn on top)
        const corners = handles.filter(h => h.handle !== "rotate").map(h => h.shape) as { x: number; y: number; width: number }[];
        expect(corners[0]).toMatchObject({ kind: "rect" });
        // Corners sit on the UNION box corners (handle squares centred there), not any node's box.
        const hs = HANDLE_SIZE_PX;
        expect(corners.map(c => [c.x + hs / 2, (c as unknown as { y: number }).y + hs / 2])).toEqual([[0, 0], [150, 0], [0, 150], [150, 150]]);
        expect(handles[4].shape).toMatchObject({ kind: "ellipse", cx: 75, cy: -ROTATE_OFFSET_PX }); // knob above the union top-centre

        const outlines = model.overlay.filter(i => i.role === "outline");
        expect(outlines.length).toBe(3); // 2 per-node selection outlines (pad 3) + 1 tight group box (pad 0)
        expect(outlines).toContainEqual(expect.objectContaining({ shape: { kind: "rect", x: 0, y: 0, width: 150, height: 150 } }));
    });

    test("a ROTATED-member group draws the knob but NO corner handles (rotatable, not resizable)", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("A", { id: "A", type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 50, height: 50 }, style: { fill: "#fff", opacity: 1 }, layout: {}, transform: { rotation: 0.3 } });
        doc.nodes.set("B", { id: "B", type: "core.rectangle", parent: null, children: [], geometry: { x: 100, y: 100, width: 50, height: 50 }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["A", "B"];
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["A", "B"] }));
        const handles = model.overlay.filter(i => i.role === "handle");
        expect(handles.map(h => h.handle)).toEqual(["rotate"]); // scaling a rotated member would shear → no corners
    });

    test("a non-rotatable group (a root under a rotated parent) → the group box but NO rotate knob", () => {
        const doc = createEmptyDocument();
        doc.nodes.set("P", { id: "P", type: "core.rectangle", parent: null, children: ["C"], geometry: { x: 0, y: 0, width: 100, height: 100 }, style: { fill: "#fff", opacity: 1 }, layout: {}, transform: { rotation: 0.3 } });
        doc.nodes.set("C", { id: "C", type: "core.rectangle", parent: "P", children: [], geometry: { x: 0, y: 0, width: 40, height: 40 }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        doc.nodes.set("R", { id: "R", type: "core.rectangle", parent: null, children: [], geometry: { x: 200, y: 0, width: 100, height: 100 }, style: { fill: "#fff", opacity: 1 }, layout: {} });
        doc.rootNodeUuids = ["P", "R"];
        const model = buildRenderModel(SIZE, doc, stateFor(doc, { selectedNodeIds: ["C", "R"] }));
        expect(model.overlay.filter(i => i.role === "handle").length).toBe(0); // not rotatable → no knob
        expect(model.overlay.some(i => i.role === "outline")).toBe(true);      // group box still drawn
    });

    test("$token colors resolve against the store under the ACTIVE theme (fill, stroke, shadow)", () => {
        const doc = docWith({
            type: "core.rectangle",
            style: { fill: "$color/primary", stroke: "$color/edge", opacity: 1, shadow: { dx: 1, dy: 2, blur: 3, color: "$color/edge" } }
        });
        doc.variables = {
            "color/primary": { type: "color", value: "#111111", modes: { dark: "#999999" } },
            "color/edge": { type: "color", value: "$color/primary" } // alias chains through the theme
        };
        const light = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(light.paint.fill).toBe("#111111");
        expect(light.paint.stroke).toBe("#111111");         // alias resolved
        expect(light.paint.shadow!.color).toBe("#111111");  // shadow color resolved too
        doc.activeTheme = "dark";
        const dark = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(dark.paint.fill).toBe("#999999");            // theme switch re-resolves — no node changed
        expect(dark.paint.stroke).toBe("#999999");
        expect(dark.paint.shadow!.color).toBe("#999999");
        // Defs key on the RESOLVED color: the def id must embed the resolved hex, not the token.
        const model = buildRenderModel(SIZE, doc, stateFor(doc));
        expect(model.defs.length).toBe(1);
        expect(model.defs[0].shadow!.color).toBe("#999999");
    });

    test("a broken token renders the visible fallback; non-token colors pass through untouched", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "$color/missing", stroke: "#00ff00", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.paint.fill).toBe(VARIABLE_FALLBACK_COLOR); // dangling token → loud magenta
        expect(item.paint.stroke).toBe("#00ff00");             // concrete color untouched
    });

    test("NUMBER tokens resolve in radius and fontSize per theme; broken/out-of-range fall back (schema 20)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1, radius: "$radius/medium" } });
        doc.variables = {
            "radius/medium": { type: "spacing", value: 6, modes: { dark: 12 } },
            "type/body": { type: "spacing", value: 18 },
            "spacing/negative": { type: "spacing", value: -5 } // legal variable, illegal radius
        };
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.radius).toBe(6);
        doc.activeTheme = "dark";
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.radius).toBe(12); // theme override
        doc.nodes.get("n1")!.style.radius = "$missing";
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.radius).toBeNull(); // broken → no radius
        doc.nodes.get("n1")!.style.radius = "$spacing/negative";
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.radius).toBeNull(); // out of range → no radius
        // A CONCRETE radius of 0 still means "no corner radius" (the pre-20 truthiness).
        doc.nodes.get("n1")!.style.radius = 0;
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.radius).toBeNull();
        // fontSize: resolves; broken token → the 14 default (never NaN into the backend).
        const t = docWith({ type: "core.text", text: "x", style: { fill: "#fff", opacity: 1, fontSize: "$type/body" } });
        t.variables = doc.variables;
        expect((buildRenderModel(SIZE, t, stateFor(t)).content[0].shape as { fontSize: number }).fontSize).toBe(18);
        t.nodes.get("n1")!.style.fontSize = "$missing";
        expect((buildRenderModel(SIZE, t, stateFor(t)).content[0].shape as { fontSize: number }).fontSize).toBe(14);
        // A NEGATIVE-resolved fontSize token (a legal spacing variable) also falls back to 14 —
        // a negative font would emit "font: -5px" garbage into the backend.
        t.nodes.get("n1")!.style.fontSize = "$spacing/negative";
        expect((buildRenderModel(SIZE, t, stateFor(t)).content[0].shape as { fontSize: number }).fontSize).toBe(14);
    });

    test("a line's stroke||fill fallback picks the RAW winner, then resolves it", () => {
        const doc = docWith({ type: "core.line", geometry: { x: 0, y: 0, width: 100, height: 0 }, style: { fill: "$color/fill", stroke: "$color/stroke", opacity: 1 } });
        doc.variables = {
            "color/fill": { type: "color", value: "#0000ff" },
            "color/stroke": { type: "color", value: "#ff0000" }
        };
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.stroke).toBe("#ff0000"); // stroke wins
        doc.nodes.get("n1")!.style.stroke = ""; // empty-string stroke → falls back to the fill TOKEN
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint.stroke).toBe("#0000ff");
    });

    test("RenderModel composes no coordinates — its Matrix import is the Mat2D TYPE only (invariant, mechanically checked)", () => {
        const src = readFileSync(resolve(__dirname, "RenderModel.ts"), "utf8");
        const m = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/core\/geometry\/Matrix"/);
        expect(m).not.toBeNull(); // it must import Mat2D from Matrix…
        const names = m![1].split(",").map(s => s.trim().replace(/^type\s+/, "")).filter(Boolean);
        expect(names).toEqual(["Mat2D"]); // …and NOTHING else (no multiply/compose/etc.), or the model could compose coordinates
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

    test("box-select marquee renders a world-space overlay rect when present, and nothing when absent", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const shown = buildRenderModel(SIZE, doc, stateFor(doc, { marqueeRect: { x: 3, y: 4, width: 20, height: 10 } }));
        const marquees = shown.overlay.filter(i => i.role === "marquee");
        expect(marquees.length).toBe(1);
        expect(marquees[0].shape).toEqual({ kind: "rect", x: 3, y: 4, width: 20, height: 10 });
        expect(marquees[0].paint).toMatchObject({ fill: "#00bfff22", stroke: "#00bfff", strokeDash: null, pointerEvents: false });
        expect(marquees[0].world).toBeNull(); // world-space (drawn under the viewport transform)

        const count = (over: Partial<RendererState>) =>
            buildRenderModel(SIZE, doc, stateFor(doc, over)).overlay.filter(i => i.role === "marquee").length;
        expect(count({})).toBe(0);                                                    // absent
        expect(count({ marqueeRect: { x: 0, y: 0, width: 0, height: 20 } })).toBe(0);  // zero-area → dropped (like preview)
        expect(count({ marqueeRect: { x: NaN, y: 0, width: 10, height: 10 } })).toBe(0); // non-finite → dropped, never NaN attrs
    });

    test("snap guides render as world-space lines (vertical for axis x, horizontal for axis y)", () => {
        const doc = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        const model = buildRenderModel(SIZE, doc, stateFor(doc, {
            snapGuides: [{ axis: "x", pos: 100, start: 50, end: 200 }, { axis: "y", pos: 75, start: 10, end: 300 }]
        }));
        const guides = model.overlay.filter(i => i.role === "guide");
        expect(guides.length).toBe(2);
        expect(guides[0].shape).toEqual({ kind: "line", x1: 100, y1: 50, x2: 100, y2: 200 }); // vertical at x=100
        expect(guides[1].shape).toEqual({ kind: "line", x1: 10, y1: 75, x2: 300, y2: 75 });   // horizontal at y=75
        expect(guides[0].paint).toMatchObject({ stroke: "#ff2d9b", pointerEvents: false, fill: null });
        expect(guides[0].world).toBeNull();
        expect(buildRenderModel(SIZE, doc, stateFor(doc)).overlay.filter(i => i.role === "guide").length).toBe(0);
        // A non-finite guide is dropped (never emit a NaN line) — matches the marquee/preview guards.
        expect(buildRenderModel(SIZE, doc, stateFor(doc, { snapGuides: [{ axis: "x", pos: NaN, start: 0, end: 10 }] }))
            .overlay.filter(i => i.role === "guide").length).toBe(0);
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
        expect(model.overlay.filter(i => i.role === "handle").length).toBe(5); // 4 corners + rotate
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
            nodes: new Map([["x", { world: { ...IDENTITY, e: 2000, f: 2000 }, local: { x: 0, y: 0, width: 40, height: 40 }, bounds: { x: 2000, y: 2000, width: 40, height: 40 }, shape: BOX }]]), locked: new Set<string>()
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

// ─── Paths ───────────────────────────────────────────────────────────────────
describe("commandsToPathData (pure d-string join)", () => {
    test("joins each command verbatim, single-space separated", () => {
        expect(commandsToPathData([{ c: "M", x: 1, y: 2 }, { c: "L", x: 3, y: 4 }, { c: "Z" }])).toBe("M 1 2 L 3 4 Z");
    });
    test("cubic and quadratic emit their control points in order", () => {
        expect(commandsToPathData([{ c: "M", x: 0, y: 0 }, { c: "C", x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 }])).toBe("M 0 0 C 1 2 3 4 5 6");
        expect(commandsToPathData([{ c: "M", x: 0, y: 0 }, { c: "Q", x1: 1, y1: 2, x: 3, y: 4 }])).toBe("M 0 0 Q 1 2 3 4");
    });
    test("an empty command list is the empty string", () => {
        expect(commandsToPathData([])).toBe("");
    });
});

describe("buildRenderModel — path", () => {
    test("path → one path Shape carrying the exact commands, rect-like paint (no rx)", () => {
        const cmds = [{ c: "M" as const, x: 0, y: 0 }, { c: "L" as const, x: 10, y: 10 }, { c: "Z" as const }];
        const doc = docWith({ type: "core.path", path: cmds, style: { fill: "#abc", opacity: 0.6, stroke: "#111" } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.shape).toEqual({ kind: "path", commands: cmds });
        expect(item.paint.fill).toBe("#abc");
        expect(item.paint.opacity).toBe(0.6);
        expect(item.paint.stroke).toBe("#111");
        expect(item.paint.strokeWidth).toBe(1);
        expect(item.paint.radius).toBeNull();
    });

    test("path without stroke omits it", () => {
        const doc = docWith({ type: "core.path", path: [{ c: "M", x: 0, y: 0 }], style: { fill: "#fff", opacity: 1 } });
        const item = buildRenderModel(SIZE, doc, stateFor(doc)).content[0];
        expect(item.paint.stroke).toBeNull();
        expect(item.paint.strokeWidth).toBeNull();
    });

    test("an absent path → an empty command list, still ONE content item (box keeps its handles)", () => {
        const doc = docWith({ type: "core.path", style: { fill: "#fff", opacity: 1 } });
        const model = buildRenderModel(SIZE, doc, stateFor(doc));
        expect(model.content.length).toBe(1);
        expect(model.content[0].shape).toEqual({ kind: "path", commands: [] });
    });
});

// ─── Effects (shadow + blur) ─────────────────────────────────────────────────
describe("buildRenderModel — effects", () => {
    const SH = { dx: 2, dy: 5, blur: 3, color: "#f00" };
    const fx = (style: Node["style"]) => {
        const doc = docWith({ type: "core.rectangle", style });
        return buildRenderModel(SIZE, doc, stateFor(doc)).content[0].paint;
    };

    test("resolves shadow + blur onto the content Paint (a copy, not the doc reference)", () => {
        const p = fx({ fill: "#fff", opacity: 1, shadow: SH, blur: 7 });
        expect(p.shadow).toEqual(SH);
        expect(p.shadow).not.toBe(SH);
        expect(p.blur).toBe(7);
    });

    test("shadow-only / blur-only / neither / zero-blur resolve independently", () => {
        expect(fx({ fill: "#fff", opacity: 1, shadow: SH }).blur).toBeNull();
        expect(fx({ fill: "#fff", opacity: 1, shadow: SH }).shadow).toEqual(SH);
        expect(fx({ fill: "#fff", opacity: 1, blur: 7 }).shadow).toBeNull();
        expect(fx({ fill: "#fff", opacity: 1, blur: 7 }).blur).toBe(7);
        expect(fx({ fill: "#fff", opacity: 1 }).shadow).toBeNull();
        expect(fx({ fill: "#fff", opacity: 1, blur: 0 }).blur).toBeNull(); // 0 blur = none
    });

    test("effectFilterId: null with no effect, deterministic, injective, SVG-id-safe", () => {
        expect(effectFilterId(null, null)).toBeNull();
        expect(effectFilterId(null, 0)).toBeNull();
        const id = effectFilterId(SH, 7);
        expect(id).toBe(effectFilterId(SH, 7));                     // deterministic
        expect(id).toMatch(/^fx[A-Za-z0-9_]*$/);                    // id-safe: no # ( ) . % or space
        expect(effectFilterId(SH, 7)).not.toBe(effectFilterId({ ...SH, dx: 3 }, 7));          // injective (dx)
        expect(effectFilterId(SH, 7)).not.toBe(effectFilterId(SH, 8));                        // injective (blur)
        expect(effectFilterId(SH, 7)).not.toBe(effectFilterId({ ...SH, color: "#f01" }, 7));  // injective (color)
        // Non-ASCII colours (code point > 0xFF) must not collide with ASCII ones (hexColor pads to 4, not 2).
        expect(effectFilterId({ ...SH, color: "red" }, null)).not.toBe(effectFilterId({ ...SH, color: "ܦդ" }, null));
    });

    test("effects are DROPPED on a zero-extent box (SVG's filter region would collapse and hide it)", () => {
        const line = docWith({ type: "core.line", geometry: { x: 0, y: 0, width: 120, height: 0 }, style: { fill: "#000", opacity: 1, shadow: SH, blur: 4 } });
        const p = buildRenderModel(SIZE, line, stateFor(line)).content[0].paint;
        expect(p.shadow).toBeNull();
        expect(p.blur).toBeNull();
        // ...but a positive-area shape keeps them (the gate is on zero AREA, not on the type).
        expect(fx({ fill: "#fff", opacity: 1, shadow: SH }).shadow).toEqual(SH);
    });

    test("DisplayList.defs are deduped by id in content order; effect-less content → no defs", () => {
        const doc = createEmptyDocument();
        const rect = (id: string, x: number, style: Node["style"]): Node => ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x, y: 0, width: 20, height: 20 }, style, layout: {} });
        doc.nodes.set("a", rect("a", 0, { fill: "#fff", opacity: 1, shadow: SH }));
        doc.nodes.set("b", rect("b", 30, { fill: "#fff", opacity: 1, shadow: SH })); // SAME effect as a
        doc.nodes.set("c", rect("c", 60, { fill: "#fff", opacity: 1, blur: 5 }));     // distinct
        doc.rootNodeUuids = ["a", "b", "c"];
        const defs = buildRenderModel(SIZE, doc, stateFor(doc)).defs;
        expect(defs.length).toBe(2);                          // a + b share one def; c a second
        expect(defs[0].id).toBe(effectFilterId(SH, null));
        expect(defs[1].id).toBe(effectFilterId(null, 5));

        const plain = docWith({ type: "core.rectangle", style: { fill: "#fff", opacity: 1 } });
        expect(buildRenderModel(SIZE, plain, stateFor(plain)).defs).toEqual([]);
    });
});

describe("Gaussian — the blur kernel the GPU backend spends", () => {
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

    test("the weights are a gaussian, symmetric and summing to ONE", () => {
        const k = gaussianKernel(4);
        expect(k.weights).toHaveLength(2 * k.radius + 1);
        // NORMALISED AFTER TRUNCATION. A kernel cut at 3 sigma keeps 99.73% of the curve, and
        // spending 0.9973 of the light is a blur that DARKENS what it touches -- subtly, and more
        // the wider it gets, which reads as a shadow too weak rather than a kernel too short.
        expect(sum(k.weights)).toBeCloseTo(1, 10);
        // SYMMETRIC: a kernel that leaned would shift the picture sideways as it blurred, which
        // looks like a misplaced shadow rather than a wrong kernel.
        for (let i = 0; i < k.radius; i++) {
            expect(k.weights[i]).toBeCloseTo(k.weights[k.weights.length - 1 - i], 12);
        }
        // The centre is the largest tap and the ends the smallest, monotonically.
        const centre = k.radius;
        expect(k.weights[centre]).toBe(Math.max(...k.weights));
        for (let i = 1; i <= k.radius; i++) {
            expect(k.weights[centre - i]).toBeLessThan(k.weights[centre - i + 1]);
        }

        // The SHAPE is a gaussian, not merely a bump: the ratio of the tap one sigma out to the
        // centre is exp(-1/2) for any sigma. Asserting the curve rather than the numbers is what
        // separates this from restating whatever the implementation produced.
        for (const sigma of [2, 5, 10]) {
            const g = gaussianKernel(sigma);
            expect(g.weights[g.radius + sigma] / g.weights[g.radius]).toBeCloseTo(Math.exp(-0.5), 6);
            expect(g.weights[g.radius + 2 * sigma] / g.weights[g.radius]).toBeCloseTo(Math.exp(-2), 6);
        }
    });

    test("blurring twice in 1D EQUALS one 2D pass — which is why it is affordable", () => {
        // SEPARABILITY is the whole reason this costs 2r+1 taps instead of (2r+1)^2 -- at sigma 20,
        // 121 against 14,641. A separable blur that is subtly wrong still looks like a blur, so the
        // identity is asserted against a directly-computed 2D gaussian rather than assumed.
        const sigma = 3;
        const k = gaussianKernel(sigma);
        const separable = gaussianOuterProduct(k);

        const n = 2 * k.radius + 1;
        const direct: number[][] = [];
        let total = 0;
        for (let y = -k.radius; y <= k.radius; y++) {
            const row: number[] = [];
            for (let x = -k.radius; x <= k.radius; x++) {
                const w = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
                row.push(w); total += w;
            }
            direct.push(row);
        }
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            expect(separable[y][x]).toBeCloseTo(direct[y][x] / total, 9);
        }
        // And the 2D kernel sums to one too, which follows from each 1D one doing so.
        expect(sum(separable.flat())).toBeCloseTo(1, 9);
    });

    test("the radius follows sigma, and is CLAMPED rather than unbounded", () => {
        // 3 sigma is the truncation point, so the radius is ceil(3 * sigma).
        expect(gaussianKernel(1).radius).toBe(GAUSSIAN_SIGMA_CUTOFF);
        expect(gaussianKernel(4).radius).toBe(12);
        expect(gaussianKernel(2.5).radius).toBe(8);        // ceil(7.5)
        expect(gaussianKernel(4).clamped).toBe(false);

        // A big sigma is CLAMPED and SAYS SO. Zoom multiplies sigma, so this is reachable by
        // zooming in rather than by an absurd document -- and the result must stay a valid,
        // normalised kernel rather than an allocation of 500 taps per fragment.
        const huge = gaussianKernel(1000);
        expect(huge.radius).toBe(GAUSSIAN_MAX_RADIUS);

        expect(huge.clamped).toBe(true);
        expect(sum(huge.weights)).toBeCloseTo(1, 10);
        // Clamping cuts the curve early, so the kernel is FLATTER than an unclamped one would be:
        // every tap is a meaningful fraction of the centre rather than vanishing at the edge.
        expect(huge.weights[0] / huge.weights[huge.radius]).toBeGreaterThan(0.9);
        // Exactly at the limit is NOT clamped -- the boundary is asserted from both sides, since
        // that is where an off-by-one lives.
        const atLimit = gaussianKernel(GAUSSIAN_MAX_RADIUS / GAUSSIAN_SIGMA_CUTOFF);
        expect(atLimit.radius).toBe(GAUSSIAN_MAX_RADIUS);
        expect(atLimit.clamped).toBe(false);
    });

    test("a wide blur is computed SMALL rather than clamped flat", () => {
        // The clamp alone is a COLLAPSE: past GAUSSIAN_MAX_SIGMA the effective sigma pins, so a
        // blur of 40 and a blur of 160 come out identical and both far sharper than SVG and Canvas
        // draw them. A 20px blur at 1:1 on a Retina display already reaches that.
        expect(gaussianKernel(40).radius).toBe(gaussianKernel(160).radius);   // the collapse itself

        // Halving the resolution halves the sigma needed, and a gaussian is scale-covariant — so
        // the plan moves the work rather than truncating it.
        expect(blurPlan(4)).toMatchObject({ levels: 0, sigma: 4, clamped: false });
        expect(blurPlan(40).levels).toBe(1);
        expect(blurPlan(160).levels).toBe(3);

        // THE INVARIANT THAT MATTERS: the plan must describe the SAME blur, just computed
        // elsewhere. `sigma * 2^levels` has to reconstruct what was asked, or the picture is
        // quietly weaker at some zooms and not others.
        for (const sigma of [1, 7, 21, 40, 80, 160, 320]) {
            const p = blurPlan(sigma);
            expect(p.sigma * Math.pow(2, p.levels)).toBeCloseTo(sigma, 6);
            // And what it asks the kernel for must actually FIT, or nothing was gained.
            expect(p.sigma).toBeLessThanOrEqual(GAUSSIAN_MAX_SIGMA);
            expect(gaussianKernel(p.sigma).clamped).toBe(false);
        }

        // THE BOUNDARY, from both sides — exactly at the limit needs no downsample, a hair over
        // needs one. An off-by-one here would resample every blur in the app for no reason.
        expect(blurPlan(GAUSSIAN_MAX_SIGMA).levels).toBe(0);
        expect(blurPlan(GAUSSIAN_MAX_SIGMA + 0.01).levels).toBe(1);

        // Levels are BOUNDED: each costs a resample and loses detail the upsample cannot invent.
        expect(blurPlan(1e6).levels).toBe(GAUSSIAN_MAX_DOWNSAMPLE);
        expect(blurPlan(1e6).clamped).toBe(true);
        // And below the cap nothing is clamped — sigma 320 is a blur wider than most canvases.
        expect(blurPlan(320).clamped).toBe(false);

        // Zero and nonsense are the identity, not an error, so a caller has one path.
        expect(blurPlan(0)).toMatchObject({ levels: 0, sigma: 0, clamped: false });
        expect(blurPlan(-5).sigma).toBe(0);
        expect(blurPlan(NaN).sigma).toBe(0);
    });

    test("convolved with an edge it reproduces the browser's own blur", () => {
        // THE PARITY CHECK, and the reason this module can be trusted before any GL exists. The
        // kernel was convolved with a hard edge and compared PER PIXEL against what
        // `ctx.filter = blur(sigma)` actually draws, in the real renderer:
        //
        //     sigma:            2        5       12
        //     worst |diff|:  0.0017   0.0027   0.0026     (alpha, 0..1)
        //
        // Under 0.7 of one 8-bit level everywhere -- quantisation noise. So a GPU pass spending
        // these weights draws the same blur the Canvas and SVG backends already draw.
        //
        // Asserted here as the PROPERTIES that comparison confirmed, so the check survives without
        // a browser: a step convolved with this kernel is monotonic, antisymmetric about the edge,
        // and reaches the untouched values well outside the radius.
        const step = (i: number, edge: number) => (i < edge ? 1 : 0);
        for (const sigma of [2, 5, 12]) {
            const k = gaussianKernel(sigma);
            const EDGE = 200, N = 400;
            const profile: number[] = [];
            for (let i = 0; i < N; i++) {
                let acc = 0;
                for (let j = -k.radius; j <= k.radius; j++) {
                    const src = i + j;
                    acc += (src < 0 ? 1 : src >= N ? 0 : step(src, EDGE)) * k.weights[j + k.radius];
                }
                profile.push(acc);
            }
            // MONOTONIC: a blur that overshoots would ring, which is what a wrong kernel does.
            for (let i = 1; i < N; i++) expect(profile[i]).toBeLessThanOrEqual(profile[i - 1] + 1e-12);
            // Untouched well outside the radius, in BOTH directions -- a kernel that leaked would
            // dim the whole canvas rather than just the edge.
            expect(profile[EDGE - k.radius - 2]).toBeCloseTo(1, 9);
            expect(profile[EDGE + k.radius + 1]).toBeCloseTo(0, 9);
            // ANTISYMMETRIC about the edge: what one side loses the other gains, exactly, because
            // the weights sum to one. This is the property that fails first if they do not.
            for (let d = 1; d <= k.radius; d++) {
                expect(profile[EDGE - d] + profile[EDGE + d - 1]).toBeCloseTo(1, 9);
            }
        }
    });

    test("no blur is the IDENTITY kernel, not an error", () => {
        // A shape with no blur is the common case, so it yields a kernel a caller can spend
        // unconditionally rather than a null it must branch on.
        for (const sigma of [0, -1, NaN, Infinity]) {
            const k = gaussianKernel(sigma);
            expect(k).toEqual({ radius: 0, weights: [1], clamped: false });
        }
        // A sigma so small it rounds to a single tap still normalises to 1 rather than to its
        // untruncated weight -- otherwise the smallest blurs would be the ones that darkened most.
        const tiny = gaussianKernel(0.1);
        expect(tiny.radius).toBe(1);
        expect(sum(tiny.weights)).toBeCloseTo(1, 10);
        // Infinity is REFUSED rather than producing a kernel of NaNs, which would blank every
        // fragment it touched -- a blur that erases is worse than one that does nothing.
        expect(gaussianKernel(Infinity).weights.every(Number.isFinite)).toBe(true);
    });
});

describe("buildRenderModel — raster (schema 55)", () => {
    const rasterDoc = (surface: { data: string; width: number; height: number } | undefined) => {
        const doc = createEmptyDocument();
        doc.nodes.set("r", { id: "r", type: "core.raster", parent: null, children: [],
            geometry: { x: 4, y: 6, width: 8, height: 8 },
            style: { fill: "none", opacity: 1 }, layout: {}, surface } as Node);
        doc.rootNodeUuids = ["r"];
        return doc;
    };
    const state = (doc: ReadonlyDocument): RendererState => ({
        selectedNodeIds: [], hoveredNodeId: null, previewRect: null,
        computed: computeGeometry(doc), viewport: { x: 0, y: 0, zoom: 1 }
    });

    test("a raster node becomes an IMAGE, not an invisible rect", () => {
        // It used to fall through to a `rect` carrying the node's fill — which for a raster node is
        // "none", so the node validated, serialized, accepted paint, and drew nothing at all.
        const doc = rasterDoc({ data: "AQAAAAA=", width: 8, height: 8 });
        const item = buildRenderModel({ width: 400, height: 300 }, doc, state(doc)).content[0];
        expect(item.shape.kind).toBe("image");
        const shape = item.shape as { kind: "image"; href: string | null; pixelated: boolean;
            x: number; y: number; width: number; height: number };
        expect(shape.href).not.toBeNull();
        // The shape's box is LOCAL — the node's position rides on the item's world matrix, exactly
        // as it does for `core.image`. Asserting the geometry here rather than the placement.
        expect(shape.width).toBe(8);
        expect(shape.height).toBe(8);
        expect(item.world).not.toBeNull();

        // PIXEL ART IS NEAREST-NEIGHBOUR BY DEFAULT, unlike an image node — a painted surface
        // zoomed in is meant to show its pixels, and smoothing them is what a pixel artist never
        // wants. An image node defaults the other way because a photograph does.
        expect(shape.pixelated).toBe(true);

        // A node with NO surface names nothing rather than a broken href, so a backend skips it
        // exactly as it skips an image whose source has not decoded.
        const empty = rasterDoc(undefined);
        const emptyShape = buildRenderModel({ width: 400, height: 300 }, empty, state(empty))
            .content[0].shape as { kind: "image"; href: string | null };
        expect(emptyShape.kind).toBe("image");
        expect(emptyShape.href).toBeNull();
    });

    test("the href CHANGES when the pixels do, and only then", () => {
        // A cache key built from the node id alone would show the picture from before every
        // stroke, because the id is exactly what does not change when a surface is painted.
        const a = rasterHref("r", { data: "AQAAAAA=", width: 8, height: 8 });
        const same = rasterHref("r", { data: "AQAAAAA=", width: 8, height: 8 });
        const painted = rasterHref("r", { data: "AQD/AAA=", width: 8, height: 8 });
        expect(a).toBe(same);                 // stable, so nothing re-decodes every frame
        expect(a).not.toBe(painted);          // and changes the moment the payload does

        // Dimensions and node id are part of the identity too — two nodes holding identical
        // pixels must not share a key, or resizing one would show the other's picture.
        expect(rasterHref("s", { data: "AQAAAAA=", width: 8, height: 8 })).not.toBe(a);
        expect(rasterHref("r", { data: "AQAAAAA=", width: 4, height: 16 })).not.toBe(a);

        // A payload differing only in ORDER must still differ: a plain character sum would collide.
        expect(rasterHref("r", { data: "AB", width: 1, height: 1 }))
            .not.toBe(rasterHref("r", { data: "BA", width: 1, height: 1 }));
    });
});

describe("buildRenderModel — the pixel selection's marching ants", () => {
    /**
     * A raster whose box is NOT at the origin and NOT square, and whose surface is a different size
     * again: 4x2 pixels in a 40x10 box at (100, 40) means one surface pixel is 10 x 5 world units.
     * Every one of those differences is a mistake a fixture could otherwise hide.
     */
    const SURFACE = { data: encodeSurface(createPixelBuffer(4, 2)).data, width: 4, height: 2 };
    const doc = () => {
        const d = createEmptyDocument();
        d.nodes.set("r", { id: "r", type: "core.raster", parent: null, children: [],
            geometry: { x: 100, y: 40, width: 40, height: 10 },
            style: { fill: "none", opacity: 1 }, layout: {}, surface: SURFACE } as Node);
        d.rootNodeUuids = ["r"];
        return d;
    };
    const antsOf = (list: DisplayList) =>
        list.overlay.filter(i => i.role === "marquee" && i.shape.kind === "line")
            .map(i => i.shape as { kind: "line"; x1: number; y1: number; x2: number; y2: number });

    test("the outline is drawn in WORLD units, through the node's own matrix", () => {
        const d = doc();
        // Pixel (1,0) alone: in the surface's grid its edges run (1,0)-(2,1), which in world units is
        // (110,40)-(120,45). A transposed mapping would give (105,80) and a mapping that dropped the
        // node's origin would give (10,0) — both distinguishable because nothing here is square.
        const mask = rectSelection(4, 2, { x: 1, y: 0 }, { x: 1, y: 0 });
        const list = buildRenderModel(SIZE, d, stateFor(d, { pixelSelection: { nodeId: "r", mask } }));
        const ants = antsOf(list);
        // FOUR RUNS, TWICE OVER: a solid dark line and a dashed light one per segment, because a
        // single dashed line is invisible over half the artwork an author paints.
        expect(ants).toHaveLength(8);
        const solid = list.overlay.filter(i => i.role === "marquee" && i.paint.stroke === "#000000");
        const dashed = list.overlay.filter(i => i.role === "marquee" && i.paint.stroke === "#ffffff");
        expect(solid).toHaveLength(4);
        expect(dashed).toHaveLength(4);
        expect(dashed[0].paint.strokeDash).not.toBeNull();
        expect(solid[0].paint.strokeDash).toBeNull();
        // The four sides of one pixel, in world coordinates. Hand-computed from the box above.
        const drawn = new Set(ants.map(s => `${s.x1},${s.y1}→${s.x2},${s.y2}`));
        expect(drawn).toContain("110,40→120,40");   // top
        expect(drawn).toContain("110,45→120,45");   // bottom
        expect(drawn).toContain("110,40→110,45");   // left
        expect(drawn).toContain("120,40→120,45");   // right
        // NOT PICKABLE: an overlay that swallowed clicks would make the canvas inside a selection
        // unpaintable, which is the opposite of what a selection is for.
        expect(list.overlay.filter(i => i.role === "marquee").every(i => i.paint.pointerEvents === false))
            .toBe(true);
    });

    test("no selection draws no ants, and neither does one on a node that is not there", () => {
        const d = doc();
        expect(antsOf(buildRenderModel(SIZE, d, stateFor(d)))).toHaveLength(0);
        expect(antsOf(buildRenderModel(SIZE, d, stateFor(d, { pixelSelection: null })))).toHaveLength(0);
        // A selection naming a node this document does not hold — which is what an undo that deleted
        // the canvas leaves behind for one frame.
        const mask = rectSelection(4, 2, { x: 0, y: 0 }, { x: 0, y: 0 });
        expect(antsOf(buildRenderModel(SIZE, d, stateFor(d, { pixelSelection: { nodeId: "gone", mask } }))))
            .toHaveLength(0);
    });

    test("the ants follow a ROTATED canvas, because the placement is the node's matrix", () => {
        const d = doc();
        const node = d.nodes.get("r")!;
        // A quarter turn about the box's centre. The outline must turn with the artwork; a marquee
        // drawn from the mask's coordinates as though they were world units would stay upright, which
        // is exactly the bug that makes a selection look like it belongs to the screen.
        (node as Node).transform = { rotation: Math.PI / 2 };
        const mask = rectSelection(4, 2, { x: 0, y: 0 }, { x: 0, y: 0 });
        const ants = antsOf(buildRenderModel(SIZE, d, stateFor(d, { pixelSelection: { nodeId: "r", mask } })));
        expect(ants).toHaveLength(8);
        // The pixel's top edge is 10 units long and now runs VERTICALLY: dx is 0 and dy is 10.
        const top = ants[0];
        expect(Math.abs(top.x2 - top.x1)).toBeCloseTo(0, 6);
        expect(Math.abs(top.y2 - top.y1)).toBeCloseTo(10, 6);
    });
});

/**
 * `layerTransition` — the sequencing every backend shares for an opacity group (schema 32).
 *
 * Three backends express a group three ways (a `<g opacity>`, an offscreen canvas, a render
 * target) and agree on exactly one thing: which layers just ended and which just began. That is
 * the part that is easy to get subtly wrong, so it is stated once.
 */
describe("layerTransition", () => {
    test("a shared prefix STAYS OPEN — the common case, and the whole point", () => {
        // Two siblings inside the same group must not close and reopen it between them: that
        // would composite the group in two pieces and fade each separately, which is the bug the
        // layer exists to fix.
        expect(layerTransition(["G"], ["G"])).toEqual({ close: 0, open: [] });
        expect(layerTransition(["G", "H"], ["G", "H"])).toEqual({ close: 0, open: [] });
    });

    test("entering and leaving are counted from the OUTSIDE in", () => {
        expect(layerTransition([], ["G"])).toEqual({ close: 0, open: ["G"] });
        expect(layerTransition(["G"], [])).toEqual({ close: 1, open: [] });
        expect(layerTransition(["G"], ["G", "H"])).toEqual({ close: 0, open: ["H"] });
        expect(layerTransition(["G", "H"], ["G"])).toEqual({ close: 1, open: [] });
        // Deeper on both sides: three closed, two opened, and the shared "G" untouched.
        expect(layerTransition(["G", "H", "I", "J"], ["G", "K", "L"]))
            .toEqual({ close: 3, open: ["K", "L"] });
    });

    test("a DIFFERENT group at the same depth is a close AND an open, not a no-op", () => {
        // Equal lengths are the case a naive `prev.length !== next.length` check misses entirely,
        // and it is what two sibling groups produce.
        expect(layerTransition(["G"], ["H"])).toEqual({ close: 1, open: ["H"] });
        expect(layerTransition(["A", "G"], ["A", "H"])).toEqual({ close: 1, open: ["H"] });
    });

    test("a prefix match is by IDENTITY at each depth, not by membership", () => {
        // The same id reappearing at a DIFFERENT depth is a different layer. Matching by "is it in
        // the list" would leave a layer open that the new item is not actually inside.
        expect(layerTransition(["G", "H"], ["H", "G"])).toEqual({ close: 2, open: ["H", "G"] });
        expect(layerTransition(["G"], ["H", "G"])).toEqual({ close: 1, open: ["H", "G"] });
    });
});
