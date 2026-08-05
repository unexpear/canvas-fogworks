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
