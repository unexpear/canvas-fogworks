/**
 * @module ImageCache
 * @description Decoded bitmaps, shared by every backend that draws one.
 *
 * The one piece of state an immediate-mode renderer cannot avoid: a document holds an `href`, and
 * both `drawImage` and `texImage2D` need a DECODED bitmap. Decoding is asynchronous, so the first
 * frame that wants an image cannot have it, and something has to remember the request and ask for
 * a repaint when it arrives.
 *
 * ONE cache for all backends, not one each, and that is worth the module rather than a copy in
 * each: switching from Canvas to WebGL mid-session would otherwise re-download and re-decode every
 * image in the document, and the switch is a toolbar button somebody presses to compare the two.
 *
 * A FAILED load is remembered as a failure and never retried. The entry exists, so `resolveImage`
 * does not start a second request — a broken href on a shape drawn every frame would otherwise be
 * a request every frame.
 */

type ImageEntry = { img: HTMLImageElement; loaded: boolean };

const imageCache = new Map<string, ImageEntry>();
let onImageReady: (() => void) | null = null;
import { decodeSurface } from "../core/paint/PixelCodec";

let generation = 0;

/** Register the callback invoked when a lazily-loaded image finishes decoding (so the view repaints). */
export function setImageReadyCallback(cb: (() => void) | null): void {
    onImageReady = cb;
}

/**
 * How many images have DECODED so far — a version number for "the pixels available have changed".
 *
 * The GPU backend needs this and the Canvas one does not, which is the whole reason it exists.
 * Canvas hands `drawImage` a live element every frame, so a load finishing is picked up for free.
 * A texture is a COPY: re-uploading every frame would re-encode every image on screen, and
 * uploading once would leave the texture holding the blank bitmap that existed before the load
 * finished. A generation number is what lets the backend upload exactly when there is something
 * new to upload.
 */
export function imageGeneration(): number {
    return generation;
}

/**
 * A decoded raster surface, drawn straight from the canvas it was decoded into.
 *
 * SYNCHRONOUS, AND THAT IS THE WHOLE POINT. The first version routed the pixels through
 * `canvas.toDataURL()` into an `HTMLImageElement` and waited for `onload`, so the picture arrived a
 * frame late. For an image that arrives once, one frame is nothing — it is what an ordinary load
 * already costs. FOR A BRUSH IT IS EVERY STROKE: the cache key folds in a checksum of the pixels,
 * so painting changes the key on every move and every move was a fresh miss. The lag was measured
 * in the running app, where the first sample after a stroke found nothing and only a settled
 * repaint showed the paint.
 *
 * A canvas needs no load, and all three backends take one: `drawImage` accepts a
 * `CanvasImageSource`, `texImage2D` accepts a canvas, and SVG takes `toDataURL()` — which is where
 * the URL still gets built, once, in `surfaceUrl` below.
 *
 * KEYED BY NODE, NOT BY HREF. The href changes with every stroke, so an href-keyed cache would keep
 * one full-size canvas PER STROKE for the life of the session — a 512-square surface is a megabyte,
 * and a few minutes of drawing is hundreds. One entry per node, replaced when the payload changes,
 * is the only version of this that does not leak while someone paints.
 */
type SurfaceEntry = { key: string; canvas: HTMLCanvasElement | null; url: string | null };

const surfaceCache = new Map<string, SurfaceEntry>();

/**
 * The node id inside a `raster:<id>:<w>x<h>:<len>:<sum>` key.
 *
 * Falls back to the WHOLE href when the shape is not recognised, which degrades to the old
 * href-keyed behaviour rather than collapsing every unrecognised surface onto one entry — being
 * wrong about identity is worse than being wrong about memory.
 */
function surfaceNodeId(href: string): string {
    const parts = href.split(":");
    return parts.length >= 3 && parts[0] === "raster" && parts[1].length > 0 ? parts[1] : href;
}

function surfaceEntry(
    href: string, surface: { data: string; width: number; height: number }
): SurfaceEntry | null {
    if (typeof document === "undefined") return null;
    const id = surfaceNodeId(href);
    const held = surfaceCache.get(id);
    // SAME PAYLOAD, SAME PICTURE — the key carries the dimensions, the length and a checksum, so an
    // unchanged key means unchanged pixels and the decode is skipped.
    if (held && held.key === href) return held;

    const buffer = decodeSurface(surface.data, surface.width, surface.height);
    if (!buffer) {
        // A payload that will not decode is remembered as a failure for THAT key, so it is not
        // retried every frame — but a later, different payload for the same node still decodes.
        const dead: SurfaceEntry = { key: href, canvas: null, url: null };
        surfaceCache.set(id, dead);
        return dead;
    }
    const canvas = document.createElement("canvas");
    canvas.width = surface.width;
    canvas.height = surface.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // `data` is already straight RGBA in exactly the order `ImageData` wants, which is why the
    // paint layer is not premultiplied — handing it over is a copy rather than a conversion.
    ctx.putImageData(new ImageData(buffer.data, surface.width, surface.height), 0, 0);
    const entry: SurfaceEntry = { key: href, canvas, url: null };
    // REPLACES the node's previous entry, which is what stops a stroke-per-entry leak.
    surfaceCache.set(id, entry);
    // The generation moves because the pixels available really did change — a future GPU path
    // re-uploads on it. `onImageReady` is deliberately NOT called: this runs inside a draw, and
    // asking for a repaint from there is a loop.
    generation++;
    return entry;
}

/** The surface as something to draw, ready THIS frame, or null when it cannot be decoded. */
export function resolveSurface(
    href: string, surface: { data: string; width: number; height: number }
): HTMLCanvasElement | null {
    return surfaceEntry(href, surface)?.canvas ?? null;
}

/**
 * The surface as a `data:` URL, for the one backend that can only take a URL.
 *
 * BUILT LAZILY AND CACHED, because `toDataURL` re-encodes the whole surface to PNG — cheap once per
 * stroke, ruinous once per frame.
 */
export function surfaceUrl(
    href: string, surface: { data: string; width: number; height: number }
): string | null {
    const entry = surfaceEntry(href, surface);
    if (!entry || !entry.canvas) return null;
    if (entry.url === null) entry.url = entry.canvas.toDataURL();
    return entry.url;
}

export function resolveImage(href: string): HTMLImageElement | null {
    if (typeof Image === "undefined") return null; // no DOM (unit tests) — draw nothing, exactly as before
    let entry = imageCache.get(href);
    if (!entry) {
        const img = new Image();
        entry = { img, loaded: false };
        imageCache.set(href, entry);
        // The generation is bumped from the SAME place the repaint is requested, so the two can
        // never disagree about whether a frame has new pixels in it.
        img.onload = () => { entry!.loaded = true; generation++; onImageReady?.(); };
        // A failed load stays `loaded: false` and is never retried (the entry exists) — draws nothing.
        img.src = href;
    }
    return entry.loaded ? entry.img : null;
}

/**
 * The same size, but WAITED FOR — the one caller that cannot draw a frame later and try again.
 *
 * `naturalSize` answers null until a decode finishes, which is exactly right for a renderer: it
 * draws nothing this frame and the load asks for a repaint. An IMPORT has no next frame. It has to
 * know how wide a tileset's image is before it can work out how many columns the sheet has, and
 * that number decides whether 79 cells become tiles or become nothing — so here the decode is
 * awaited rather than polled.
 *
 * IT GOES THROUGH THE SAME CACHE, so the bitmap an import decodes is the one the backends draw:
 * asking a second decoder would mean two answers to "how big is this", and the whole reason
 * `naturalSize` exists is that a DERIVED size and a measured one had already disagreed once.
 *
 * NULL RATHER THAN A THROW for a broken or undecodable href, because the caller's job is to report
 * a tileset it could not measure, not to fail the import of every other layer in the map.
 */
export async function imageSizeAsync(href: string): Promise<{ width: number; height: number } | null> {
    if (typeof Image === "undefined") return null;      // no DOM (unit tests): nothing to decode
    const ready = naturalSize(href);
    if (ready) return ready;
    const entry = imageCache.get(href);
    // `resolveImage` has already started the load and remembers a FAILURE as an entry, so a second
    // call here would never retry it — an entry that exists and is not loaded is either in flight
    // or dead, and both are answered by waiting for the element's own events.
    const img = entry ? entry.img : null;
    if (!img) return null;
    // ALREADY FINISHED, AND FINISHED BADLY. `complete` is true once a load has settled either way,
    // so an href that failed BEFORE this was called has already fired its `error` and would never
    // fire another — a listener attached now waits for an event that cannot arrive, and the import
    // hangs rather than reporting a tileset it could not measure. Since the entry is never retried,
    // this is the only place that can notice.
    if (img.complete) return naturalSize(href);
    return new Promise(resolve => {
        const done = () => {
            img.removeEventListener("load", done);
            img.removeEventListener("error", fail);
            resolve(naturalSize(href));
        };
        const fail = () => {
            img.removeEventListener("load", done);
            img.removeEventListener("error", fail);
            resolve(null);
        };
        img.addEventListener("load", done);
        img.addEventListener("error", fail);
    });
}

/**
 * A decoded image's own pixel dimensions, or null while it is not ready.
 *
 * Exists because a SOURCE RECT is expressed in source pixels, and SVG can only honour that through
 * a `viewBox` over an image placed at its natural size. Reading it from the SAME cache the Canvas
 * and GPU backends draw from is what keeps the three agreeing about when an image is ready — a
 * second notion of "loaded" is a second thing that can be wrong.
 */
export function naturalSize(href: string): { width: number; height: number } | null {
    const img = resolveImage(href);
    if (!img) return null;
    const width = img.naturalWidth, height = img.naturalHeight;
    // A decoded image with no dimensions is not something to divide by. It is possible for an SVG
    // href with no intrinsic size, and every consumer here builds a ratio out of these.
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
}

/**
 * The tight box around a decoded image's non-transparent pixels, or null when it has none.
 *
 * The impure half of trimming — it needs the actual pixels, which is why it lives here beside the
 * decode cache rather than in `core/import/Trim`, and why that module takes the measurement as an
 * argument. The same split `SpriteSheet` makes between planning a sheet and drawing one.
 *
 * `within` narrows the scan to one cell of a sheet; absent, the whole image. Coordinates in and out
 * are the SOURCE image's own pixels, so the answer can be handed straight to `trimmedPlacement`
 * with no conversion — a rounding step between a measurement and its use is a place to be wrong.
 *
 * THE THRESHOLD DEFAULTS TO FULLY TRANSPARENT, and is a parameter because the measured packs
 * disagree: the pixel-art sets are hard-alpha while the stick figure is antialiased, so a fixed
 * cutoff would either keep a halo of near-invisible pixels or eat the antialiasing off an outline.
 */
export function imageInkBounds(
    href: string,
    within?: { x: number; y: number; width: number; height: number },
    alphaThreshold: number = 0
): { x: number; y: number; width: number; height: number } | null {
    const img = resolveImage(href);
    if (!img) return null;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!(iw > 0) || !(ih > 0)) return null;
    // CLAMPED to the image, because a caller may hand in a cell from a grid that does not fit —
    // `sliceGrid` refuses those, but a hand-authored `sourceRect` is deliberately not checked
    // against the pixels, so one can arrive here reaching outside them.
    const rx = Math.max(0, Math.floor(within?.x ?? 0));
    const ry = Math.max(0, Math.floor(within?.y ?? 0));
    const rw = Math.min(iw - rx, Math.ceil(within?.width ?? iw));
    const rh = Math.min(ih - ry, Math.ceil(within?.height ?? ih));
    if (!(rw > 0) || !(rh > 0)) return null;

    // A canvas is the only way to read pixels out of a decoded image. Created per call rather than
    // cached: trimming happens at import, not per frame, and a retained backing store the size of
    // the largest sheet seen is a worse trade than one allocation on a cold path.
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);
    let data: Uint8ClampedArray;
    try {
        data = ctx.getImageData(0, 0, rw, rh).data;
    } catch {
        // A cross-origin image TAINTS the canvas and reading it throws. Nothing can be measured, so
        // nothing is trimmed — which leaves the frame exactly as it was rather than half-cropped.
        return null;
    }

    let x0 = rw, y0 = rh, x1 = -1, y1 = -1;
    for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
            if (data[(y * rw + x) * 4 + 3] <= alphaThreshold) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < x0 || y1 < y0) return null;
    // Back into the SOURCE image's coordinates, which is the space the caller asked in.
    return { x: rx + x0, y: ry + y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
