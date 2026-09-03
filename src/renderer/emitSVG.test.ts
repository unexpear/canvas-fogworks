/**
 * @module emitSVG.test
 * @description The SVG backend's image branch, driven through a FAKE DOM.
 *
 * There is no jsdom here — `emitCanvas.test.ts` set the precedent by capturing a mock context's
 * call sequence, and this does the same with a mock element tree. The point is not to test SVG;
 * it is to pin what only this file can get wrong, on the DEFAULT backend, where nothing in a
 * 1300-test suite could see it: a raster's href (below), and a gradient's `<defs>` (schema 56).
 *
 * THE BUG: a `core.raster`'s href is an identity key (`raster:<id>:<w>x<h>:<len>:<sum>`), not a
 * URL. Setting it directly produced an `<image>` that was correctly placed, correctly sized,
 * carried `image-rendering="pixelated"` — and loaded nothing. A painted canvas was INVISIBLE on
 * the DEFAULT backend while behaving normally everywhere else. It was found by driving the real
 * app, not by any test.
 *
 * In a node environment `resolveSurface` returns null (it needs `Image` and a canvas), so what is
 * asserted here is the half that matters and that a DOM-less run CAN see: **the raster key is
 * never emitted as an href**. The ordinary-image assertion beside it is what makes that meaningful
 * — without it, "no href" could equally mean the emitter had stopped working.
 */

import { emitSVG } from "./emitSVG";
import { DisplayList, DrawItem } from "./RenderModel";

/** A DOM small enough to read and large enough for `emitSVG`: attributes, children, `:scope > x`. */
function fakeDom() {
    const mk = (tag: string): any => {
        const el: any = {
            tagName: tag,
            attrs: {} as Record<string, string>,
            children: [] as any[],
            style: {} as Record<string, string>,
            setAttribute: (k: string, v: string) => { el.attrs[k] = v; },
            getAttribute: (k: string) => (k in el.attrs ? el.attrs[k] : null),
            appendChild: (c: any) => { el.children.push(c); return c; },
            insertBefore: (c: any) => { el.children.unshift(c); return c; },
            removeChild: (c: any) => { el.children = el.children.filter((x: any) => x !== c); return c; },
            get firstChild() { return el.children[0] ?? null; },
            // Only the two selector shapes `emitSVG` uses: "svg", and ":scope > g#id".
            querySelector: (sel: string) => {
                const direct = /^:scope > (\w+)(?:#(\S+))?$/.exec(sel);
                if (direct) {
                    return el.children.find((c: any) =>
                        c.tagName === direct[1] && (!direct[2] || c.attrs.id === direct[2])) ?? null;
                }
                return el.children.find((c: any) => c.tagName === sel) ?? null;
            }
        };
        return el;
    };
    const g = globalThis as unknown as { document?: unknown };
    const saved = g.document;
    g.document = { createElementNS: (_ns: string, tag: string) => mk(tag) };
    return { container: mk("div"), restore: () => { g.document = saved; }, mk };
}

/** Every element in the tree, flattened — the emitter nests, and the assertion should not care. */
function walk(el: any, out: any[] = []): any[] {
    out.push(el);
    for (const c of el.children ?? []) walk(c, out);
    return out;
}

function listOf(items: DrawItem[]): DisplayList {
    return {
        viewport: { x: 0, y: 0, zoom: 1 },
        grid: { sig: "s", lines: [] },
        content: items,
        overlay: [],
        defs: [],
        gradients: [],
        groups: []
    } as unknown as DisplayList;
}

function imageItem(over: Record<string, unknown>): DrawItem {
    return {
        world: null,
        nodeId: "n1",
        shape: { kind: "image", x: 0, y: 0, width: 8, height: 4, href: null, source: null,
            pixelated: true, surface: null, ...over },
        paint: { opacity: null }
    } as unknown as DrawItem;
}

describe("emitSVG — a raster's identity key must never become an href", () => {
    test("an ORDINARY image still gets its href, so the check below means something", () => {
        const dom = fakeDom();
        try {
            emitSVG(dom.container, listOf([imageItem({ href: "https://example.test/a.png" })]));
            const img = walk(dom.container).find(e => e.tagName === "image");
            expect(img).toBeDefined();
            expect(img.getAttribute("href")).toBe("https://example.test/a.png");
        } finally { dom.restore(); }
    });

    test("a RASTER never carries the raster: key as its href", () => {
        const dom = fakeDom();
        try {
            const key = "raster:abc:8x4:12:34567";
            emitSVG(dom.container, listOf([imageItem({
                href: key,
                surface: { data: "AAAA", width: 8, height: 4 }
            })]));
            const img = walk(dom.container).find(e => e.tagName === "image");
            expect(img).toBeDefined();
            // The element is EMITTED — placement, size and the pixel-art flag are all still right;
            // it is only the source that must not be the key.
            expect(img.getAttribute("width")).toBe("8");
            expect(img.getAttribute("image-rendering")).toBe("pixelated");
            // THE REGRESSION. Before the fix this was exactly `key`, and the picture never loaded.
            expect(img.getAttribute("href")).not.toBe(key);
            // With no DOM the cache cannot decode, so there is NO href at all — which draws
            // nothing, rather than a broken-image glyph. `ImageCache` bumps its generation on load
            // and asks for the repaint that fills it in.
            expect(img.getAttribute("href")).toBeNull();
            // And nothing anywhere in the tree smuggled the key onto some other attribute.
            const all = walk(dom.container)
                .flatMap(e => Object.values(e.attrs ?? {}) as string[])
                .filter(v => typeof v === "string" && v.includes("raster:"));
            expect(all).toEqual([]);
        } finally { dom.restore(); }
    });
});

describe("emitSVG — scene lighting", () => {
    test("builds an sRGB channel transfer and applies it to content", () => {
        const dom = fakeDom();
        try {
            const item = {
                world: null, nodeId: "lit", role: "content",
                shape: { kind: "rect", x: 0, y: 0, width: 8, height: 4 },
                paint: { fill: "#ffffff", opacity: 1, stroke: null, strokeWidth: null,
                    strokeDash: null, radius: null, cursor: null, pointerEvents: true,
                    shadow: null, blur: null, blendMode: null }
            } as unknown as DrawItem;
            const list = listOf([item]);
            list.lights = [{ x: 0, y: 0, z: -1, color: "#00ff00", intensity: 0.5 }];
            list.ambient = 0.25;
            emitSVG(dom.container, list);
            const all = walk(dom.container);
            const filter = all.find(e => e.tagName === "filter" && String(e.attrs.id).startsWith("lighting_"));
            expect(filter).toBeDefined();
            expect(filter.getAttribute("color-interpolation-filters")).toBe("sRGB");
            const funcs = filter.children[0].children;
            expect(funcs.map((f: any) => [f.tagName, f.getAttribute("slope")]))
                .toEqual([["feFuncR", "0.25"], ["feFuncG", "0.75"], ["feFuncB", "0.25"]]);
            const rect = all.find(e => e.tagName === "rect" && e.attrs.width === "8");
            expect(rect.getAttribute("filter")).toBe(`url(#${filter.attrs.id})`);
        } finally { dom.restore(); }
    });
});

/**
 * The gradient defs (schema 56), through the same fake DOM.
 *
 * This is the ONLY backend that paints a ramp exactly, and it is the DEFAULT one — so "does a
 * gradient reach the screen" is a question about this file. The model tests prove the ramp is
 * resolved; they cannot see whether the backend writes a `<linearGradient>` or an `<image>`.
 */
describe("emitSVG — a gradient reaches the screen as a def and a reference", () => {
    const RAMP = {
        kind: "linear" as const,
        id: "grad_test",
        units: "userSpaceOnUse" as const,
        stops: [
            { offset: 0, color: "#ff0000", opacity: 1 },
            { offset: 0.4, color: "#00ff00", opacity: 0.5 }
        ],
        transform: { a: 2, b: 0, c: 0, d: 3, e: 5, f: 7 },
        x1: 0, y1: 0.25, x2: 0.75, y2: 1,
        cx: 0, cy: 0, r: 0, fx: 0, fy: 0,
        flat: "#ff0000"
    };
    const rectItem = (fill: unknown): DrawItem => ({
        world: null,
        nodeId: "n1",
        shape: { kind: "rect", x: 0, y: 0, width: 8, height: 4 },
        paint: { fill, opacity: null, stroke: null, strokeWidth: null, strokeDash: null,
            radius: null, cursor: null, pointerEvents: true, shadow: null, blur: null }
    } as unknown as DrawItem);

    test("a gradient fill becomes a <defs> entry and a url() reference, not a colour", () => {
        const dom = fakeDom();
        try {
            const list = listOf([rectItem(RAMP)]);
            (list as unknown as { gradients: unknown[] }).gradients = [RAMP];
            emitSVG(dom.container, list);
            const all = walk(dom.container);
            const def = all.find(e => e.tagName === "linearGradient");
            expect(def).toBeDefined();
            expect(def.getAttribute("id")).toBe("grad_test");
            // Carried VERBATIM — the whole reason the model does not fold the box in.
            expect(def.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
            expect(def.getAttribute("gradientTransform")).toBe("matrix(2 0 0 3 5 7)");
            // All four, so an x/y swap cannot hide behind a fixture whose ends agree.
            expect([def.getAttribute("x1"), def.getAttribute("y1"),
                def.getAttribute("x2"), def.getAttribute("y2")]).toEqual(["0", "0.25", "0.75", "1"]);
            // The stops, in order, with the one non-default opacity written and the default one not.
            const stops = def.children.filter((c: any) => c.tagName === "stop");
            expect(stops.map((s: any) => [s.getAttribute("offset"), s.getAttribute("stop-color"),
                s.getAttribute("stop-opacity")]))
                .toEqual([["0", "#ff0000", null], ["0.4", "#00ff00", "0.5"]]);
            // And the SHAPE points at it. A def nothing references renders as no fill at all, so
            // asserting only the def above would pass on an invisible rectangle.
            const rect = all.find(e => e.tagName === "rect");
            expect(rect.getAttribute("fill")).toBe("url(#grad_test)");
        } finally { dom.restore(); }
    });

    test("a plain colour is still written straight through", () => {
        // Without this, "the fill is url(...)" could equally mean the emitter now writes url() for
        // everything — the same pairing the raster test above uses.
        const dom = fakeDom();
        try {
            emitSVG(dom.container, listOf([rectItem("#123456")]));
            const rect = walk(dom.container).find(e => e.tagName === "rect");
            expect(rect.getAttribute("fill")).toBe("#123456");
            expect(walk(dom.container).find(e => e.tagName === "linearGradient")).toBeUndefined();
        } finally { dom.restore(); }
    });
});

/**
 * A dashed LINE, on the backend that forgot it.
 *
 * Every other shape here gets its paint from `applyRectPaint`; the line branch spells it out by
 * hand, because a line has no fill and no corner radius — and that is how it became the one shape
 * that dropped `strokeDash`. Canvas dashes it and the exporter dashes it, so the three disagreed
 * about the same display list. It went unnoticed because nothing asked for a dashed line until the
 * gradient axis (schema 56) did.
 */
describe("emitSVG — a dashed line is dashed", () => {
    const lineItem = (dash: string | null): DrawItem => ({
        world: null, nodeId: null, role: "outline",
        shape: { kind: "line", x1: 0, y1: 0, x2: 10, y2: 4 },
        paint: { fill: null, opacity: null, stroke: "#ffffff", strokeWidth: 1, strokeDash: dash,
            radius: null, cursor: null, pointerEvents: false, shadow: null, blur: null }
    } as unknown as DrawItem);

    test("stroke-dasharray reaches the element, and is ABSENT when there is no dash", () => {
        const dom = fakeDom();
        try {
            emitSVG(dom.container, listOf([lineItem("3 3")]));
            expect(walk(dom.container).find(e => e.tagName === "line").getAttribute("stroke-dasharray")).toBe("3 3");
        } finally { dom.restore(); }
        // The pairing matters: without it, "the attribute is there" could equally mean the
        // emitter now writes a dash on every line.
        const plain = fakeDom();
        try {
            emitSVG(plain.container, listOf([lineItem(null)]));
            const el = walk(plain.container).find(e => e.tagName === "line");
            expect(el.getAttribute("stroke-dasharray")).toBeNull();
            expect(el.getAttribute("stroke")).toBe("#ffffff");
        } finally { plain.restore(); }
    });
});

/**
 * A TILEMAP'S SHEET IS SIZED FROM THE BITMAP, not from the grid description.
 *
 * THE BUG, which shipped and drew whole maps from the wrong rows: the inner `<image>` is placed at
 * NATURAL size so the nested `viewBox` measures source pixels, and it was sized by a `sheetHeight`
 * that took the row count from the highest index the map happened to use. A real 968x526 sheet whose
 * map reaches row 18 was called 305 tall, so every tile was sampled 1.7x too far down.
 *
 * IT WAS FOUND BY IMPORTING A REAL MAP and putting it beside the node-per-cell import of the same
 * file — 0 of 1,552,386 content pixels differ now, and the whole picture differed before. This test
 * is the cheap guard that keeps it fixed, and it needs a fixture that CANNOT pass by accident: a
 * sheet whose real height (526) differs from the implied one, and a map using only low indices.
 */
describe("emitSVG — a tilemap samples its sheet at the sheet's real size", () => {
    /** An `Image` that reports a decoded 968x526 sheet the moment a src is assigned. */
    function fakeImages(width: number, height: number) {
        const g = globalThis as unknown as { Image?: unknown };
        const saved = g.Image;
        g.Image = class {
            naturalWidth = width;
            naturalHeight = height;
            onload: (() => void) | null = null;
            set src(_v: string) { this.onload?.(); }
        };
        return () => { g.Image = saved; };
    }

    const tilemapItem = (href: string): DrawItem => ({
        world: null,
        nodeId: "t1",
        shape: {
            kind: "tilemap", x: 0, y: 0, width: 32, height: 16, href, pixelated: true,
            // A 57-column sheet of 16px tiles with a 1px gutter — the real Roguelike sheet, whose
            // 968x526 image holds 31 rows. The map uses indices in row 0 and row 1 ONLY, so the
            // implied height is 33 and the real one is 526: a fixture whose highest tile sat in the
            // last row could not tell the two apart.
            // THE SHEET RIDES ON THE ITEM (schema 67), resolved from the document's tileset by
            // the render model — so all three backends read it the way they read `href` and cannot
            // disagree about which picture a layer draws from.
            sheet: { columns: 57, tileWidth: 16, tileHeight: 16, spacing: 1, margin: 0 },
            map: { cols: 2, rows: 1, tileWidth: 16, tileHeight: 16,
                   tilesetId: "ts", tiles: [0, 58] },
            cells: { col0: 0, row0: 0, col1: 1, row1: 0 }
        },
        paint: { opacity: null }
    } as unknown as DrawItem);

    test("the inner <image> is the BITMAP's size, and the viewBox still measures source pixels", () => {
        const restoreImages = fakeImages(968, 526);
        const dom = fakeDom();
        try {
            emitSVG(dom.container, listOf([tilemapItem("https://example.test/sheet-real.png")]));
            const images = walk(dom.container).filter(e => e.tagName === "image");
            expect(images).toHaveLength(2);                       // one per visible cell
            for (const img of images) {
                expect(img.getAttribute("width")).toBe("968");
                // 526, NOT the 33 the two used rows imply.
                expect(img.getAttribute("height")).toBe("526");
            }
            // The viewBoxes are the two tiles' source rects, in the sheet's own pixels: index 0 at
            // the origin and index 58 one row down and one column across, gutter included.
            const boxes = walk(dom.container).filter(e => e.tagName === "svg")
                .map(e => e.getAttribute("viewBox"))
                // The ROOT svg has none; it is in the walk because the emitter creates it too.
                .filter(v => v !== null);
            expect(boxes).toEqual(["0 0 16 16", "17 17 16 16"]);
        } finally { dom.restore(); restoreImages(); }
    });

    test("an undecoded sheet draws NOTHING, rather than guessing a size", () => {
        // No `Image` at all — which is what a fresh cache looks like on the first frame. The Canvas
        // backend already returns early here, and the two must agree about when a sheet is ready.
        const dom = fakeDom();
        try {
            emitSVG(dom.container, listOf([tilemapItem("https://example.test/sheet-undecoded.png")]));
            expect(walk(dom.container).filter(e => e.tagName === "image")).toHaveLength(0);
        } finally { dom.restore(); }
    });
});

/**
 * …and neither backend may go back to deriving that size.
 *
 * A TEXT GUARD, deliberately: the WebGL half of this fix cannot be exercised here at all (there is
 * no GL context in a unit test, and none in this machine's Electron either — `renderWebGL` falls
 * back to Canvas), so the alternative to reading the source is no check whatsoever. What it pins is
 * exactly the thing that was wrong: a sheet size computed from the grid rather than read from the
 * decoded bitmap.
 */
describe("no backend derives a tilemap sheet's pixel size", () => {
    test("`sheetWidth`/`sheetHeight` are gone, and both backends read `naturalSize`", () => {
        const fs = require("fs") as typeof import("fs");
        const path = require("path") as typeof import("path");
        const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf8");
        for (const rel of ["./emitSVG.ts", "./emitWebGL.ts", "../core/document/Tilemap.ts"]) {
            const src = read(rel);
            // Mentioned in the comments that explain the bug; what must not come back is a CALL.
            expect(src).not.toMatch(/\bsheetWidth\s*\(/);
            expect(src).not.toMatch(/\bsheetHeight\s*\(/);
        }
        // The pairing that makes the absence mean something: both backends ask the shared cache.
        expect(read("./emitSVG.ts")).toMatch(/naturalSize\(shape\.href\)/);
        expect(read("./emitWebGL.ts")).toMatch(/naturalSize\(tm\.href\)/);
    });
});

/**
 * A COLLECTION tileset — the other half of `sheet`, and the anchoring is the whole test.
 *
 * A collection set gives every tile its own file at its own size (1,207 such images in the measured
 * corpus), so there is no sheet to cut. The fixture's tiles are THREE CELLS TALL on purpose: the
 * corpus's collection tiles are 256x352 and 256x512 on cells of 232x110 and 256x128, and a fixture
 * whose tiles happened to be exactly cell-sized could not tell bottom-left anchoring from top-left
 * — which is the one thing here that can be wrong in a way that looks like bad art rather than bad
 * arithmetic.
 */
describe("emitSVG — a collection tileset draws one image per cell, anchored bottom-left", () => {
    const CELL = 16;
    const TALL = 48;                                   // three cells: the overhang is the point
    const pictures = new Map([
        [0, { href: "a.png", width: CELL, height: TALL }],
        [2, { href: "b.png", width: CELL, height: CELL }]
    ]);
    const item = (tiles: number[], flips?: number[]): DrawItem => ({
        world: null,
        nodeId: "t1",
        shape: {
            kind: "tilemap", x: 100, y: 200, width: 32, height: 16, href: null, pixelated: true,
            sheet: null, pictures,
            map: { cols: 2, rows: 1, tileWidth: CELL, tileHeight: CELL, tilesetId: "coll", tiles,
                   ...(flips ? { flips } : {}) },
            cells: { col0: 0, row0: 0, col1: 1, row1: 0 }
        },
        paint: { opacity: null }
    } as unknown as DrawItem);

    test("each cell gets its OWN picture at its own size, hanging ABOVE the cell", () => {
        const dom = fakeDom();
        try {
            emitSVG(dom.container, listOf([item([0, 2])]));
            const images = walk(dom.container).filter(e => e.tagName === "image");
            expect(images).toHaveLength(2);
            expect(images.map(i => i.getAttribute("href"))).toEqual(["a.png", "b.png"]);
            // THE TALL TILE: column 0 of a cell 16 high, drawn 48 high, so its top is 32 ABOVE the
            // cell's own top — 200 + 0 + 16 - 48 = 168. Top-aligning would put it at 200 and hang
            // the art through the floor instead of over the row behind it.
            expect([images[0].getAttribute("x"), images[0].getAttribute("y")]).toEqual(["100", "168"]);
            expect([images[0].getAttribute("width"), images[0].getAttribute("height")])
                .toEqual(["16", "48"]);
            // …and a tile that IS cell-sized lands exactly on its cell, which is what makes the
            // number above an anchoring rule rather than a constant.
            expect([images[1].getAttribute("x"), images[1].getAttribute("y")]).toEqual(["116", "200"]);
            expect(images[1].getAttribute("image-rendering")).toBe("pixelated");
            // NO NESTED <svg>: there is no crop to express, so the sheet path's viewBox trick is
            // absent — its presence would mean the wrong branch ran.
            expect(walk(dom.container).filter(e => e.tagName === "svg" && e.getAttribute("viewBox")))
                .toHaveLength(0);
        } finally { dom.restore(); }
    });

    test("an empty cell and a cell naming no tile both draw nothing", () => {
        const dom = fakeDom();
        try {
            // -1 is TILE_EMPTY; 1 is a real index this sparse set simply has no record for, which
            // is not hypothetical — one corpus set has no tile id 47 and another starts at 12.
            emitSVG(dom.container, listOf([item([-1, 1])]));
            expect(walk(dom.container).filter(e => e.tagName === "image")).toHaveLength(0);
        } finally { dom.restore(); }
    });

    test("a turned cell is turned in the TILE's box, not the cell's", () => {
        const dom = fakeDom();
        try {
            // FLIP_V, because FLIP_H's translation term is `w` for both the tile's box and the
            // cell's — an H-only fixture cannot see which box the matrix was built in. See the
            // Canvas test's note; the two backends must be checked against the same trap.
            emitSVG(dom.container, listOf([item([0, -1], [2, 0])]));   // FLIP_V on the tall tile
            const img = walk(dom.container).filter(e => e.tagName === "image")[0];
            // `flipMatrix(FLIP_V, 16, 48)` mirrors about the tile's own centre, so the translation
            // term is its own height — 48, where a cell-sized box would say 16. The placement is a
            // translate because an <image> takes x/y OR a transform, never both.
            expect(img.getAttribute("transform")).toBe("translate(100, 168) matrix(1 0 0 -1 0 48)");
            expect(img.getAttribute("x")).toBe("0");
        } finally { dom.restore(); }
    });
});
