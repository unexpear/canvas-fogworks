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

/** The decoded bitmap for an href, or null while it loads / fails (or with no DOM, e.g. node tests). */
/**
 * A raster surface as a drawable image, decoded once and cached under its own key.
 *
 * ONE NOTION OF "LOADED" ACROSS ALL THREE BACKENDS. A raster could have been handed to each backend
 * as raw pixels — `putImageData` for Canvas, `texImage2D` for the GPU — but SVG has no such path and
 * would still need a URL, so the three would have disagreed about when a surface was ready. Turning
 * it into the same `HTMLImageElement` every other href resolves to means they cannot.
 *
 * DECODED LAZILY, ON A MISS. The alternatives both cost more: decoding inside `buildRenderModel`
 * would make the model impure, and decoding on every document change would run whether or not
 * anything drew the node. A miss costs one frame without the picture — which is exactly what an
 * ordinary image load already costs, so it is the established behaviour rather than a new one.
 */
export function resolveSurface(
    href: string, surface: { data: string; width: number; height: number }
): HTMLImageElement | null {
    if (typeof Image === "undefined" || typeof document === "undefined") return null;
    const held = imageCache.get(href);
    if (held) return held.loaded ? held.img : null;

    const buffer = decodeSurface(surface.data, surface.width, surface.height);
    // A payload that will not decode is cached as a PERMANENT miss rather than retried every frame
    // — the entry exists, so this branch is never reached again for that key.
    const img = new Image();
    const entry = { img, loaded: false };
    imageCache.set(href, entry);
    if (!buffer) return null;

    const canvas = document.createElement("canvas");
    canvas.width = surface.width;
    canvas.height = surface.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // `data` is already straight RGBA in exactly the order `ImageData` wants, which is why the
    // paint layer is not premultiplied — handing it over is a copy rather than a conversion.
    ctx.putImageData(new ImageData(buffer.data, surface.width, surface.height), 0, 0);
    // The SAME onload path as a fetched image, so the generation bump and the repaint request come
    // from one place and cannot disagree about whether a frame has new pixels in it.
    img.onload = () => { entry.loaded = true; generation++; onImageReady?.(); };
    img.src = canvas.toDataURL();
    return null;
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
