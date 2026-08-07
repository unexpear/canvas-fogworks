/**
 * @module emitSVG.test
 * @description The SVG backend's image branch, driven through a FAKE DOM.
 *
 * There is no jsdom here — `emitCanvas.test.ts` set the precedent by capturing a mock context's
 * call sequence, and this does the same with a mock element tree. The point is not to test SVG;
 * it is to pin ONE regression that shipped and that nothing in a 1300-test suite could see.
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
