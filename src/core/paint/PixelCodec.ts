/**
 * @module PixelCodec
 * @description A surface as text a document can hold.
 *
 * A document is JSON, so a buffer has to become a string. The obvious answer is to hand it to the
 * platform's PNG encoder — and that is the wrong one HERE, because it needs a DOM. Every reader in
 * this codebase is pure with compression INJECTED, and serialization is the one place that rule
 * would hurt most to break: a document format that only round-trips inside a browser cannot be
 * tested in node, cannot be diffed deterministically, and makes `serializeDocument` impure.
 *
 * SO THE CODEC IS RUN-LENGTH ENCODING, which pixel art happens to be ideal for. Flat regions —
 * which is most of a sprite — collapse to a count and a colour, and the whole thing is arithmetic
 * a test can check exactly.
 *
 * IT IS NOT ALWAYS SMALLER, and that is stated rather than hidden. Per-pixel noise encodes LARGER
 * than raw, because every run costs a length byte for one pixel. `encodeSurface` therefore reports
 * what it achieved and a caller can decide; a codec that silently inflated a photograph while
 * claiming to compress it would be the quiet kind of wrong this codebase keeps finding.
 */

import { PixelBuffer, createPixelBuffer, pixelBufferError } from "./PixelBuffer";

/**
 * The format's version, first byte of every payload.
 *
 * A stored surface outlives the code that wrote it. Without this, a later change to the run format
 * would decode old documents into plausible garbage rather than refusing them.
 */
export const PIXEL_CODEC_VERSION = 1;

/** The longest run one length byte can carry. */
export const PIXEL_RUN_MAX = 255;

/** A surface encoded, with what it cost. */
export interface EncodedSurface {
    /** Base64 of the run-length payload. */
    data: string;
    /** Bytes before encoding — `width * height * 4`. */
    rawBytes: number;
    /** Bytes after, BEFORE base64 (which adds a third regardless of the codec). */
    packedBytes: number;
}

/** Base64 without a platform: `btoa` is a DOM function and this must run in node too. */
function toBase64(bytes: Uint8Array): string {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function fromBase64(text: string): Uint8Array | null {
    try {
        if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(text, "base64"));
        return Uint8Array.from(atob(text), c => c.charCodeAt(0));
    } catch { return null; }
}

/**
 * A surface as runs of identical pixels.
 *
 * The payload is `[version][runs...]`, each run `[count][r][g][b][a]`. Dimensions are NOT stored —
 * they live on the node beside this, so a surface resized in the document and a payload written
 * before it cannot disagree about which is authoritative. `decodeSurface` is told the size.
 */
export function encodeSurface(buffer: PixelBuffer): EncodedSurface {
    const out: number[] = [PIXEL_CODEC_VERSION];
    const total = buffer.width * buffer.height;
    let at = 0;
    while (at < total) {
        const o = at * 4;
        const r = buffer.data[o], g = buffer.data[o + 1], b = buffer.data[o + 2], a = buffer.data[o + 3];
        let run = 1;
        // A RUN STOPS AT THE LENGTH LIMIT, which a small fixture never reaches — a flat surface
        // longer than 255 pixels must split, or the count overflows its byte.
        //
        // The `at + run < total` bound is BELT AND BRACES: reading past a Uint8ClampedArray yields
        // undefined, which fails the comparison below and breaks the run anyway. It is kept
        // because relying on that is relying on a coincidence of JS rather than on a rule.
        while (run < PIXEL_RUN_MAX && at + run < total) {
            const n = (at + run) * 4;
            if (buffer.data[n] !== r || buffer.data[n + 1] !== g
                || buffer.data[n + 2] !== b || buffer.data[n + 3] !== a) break;
            run++;
        }
        out.push(run, r, g, b, a);
        at += run;
    }
    const bytes = Uint8Array.from(out);
    return {
        data: toBase64(bytes),
        rawBytes: total * 4,
        packedBytes: bytes.length
    };
}

/**
 * A surface decoded at a known size, or null when the payload does not describe one.
 *
 * REFUSES RATHER THAN PADS. A payload holding fewer pixels than the size claims would otherwise
 * leave a transparent band at the bottom of a sprite, which reads as an art mistake; one holding
 * more would silently drop the tail. Both are refused so a corrupt document fails at the boundary,
 * the same rule `validateDocumentIntegrity` already applies to everything else.
 */
export function decodeSurface(data: string, width: number, height: number): PixelBuffer | null {
    if (pixelBufferError(width, height) !== null) return null;
    const bytes = fromBase64(data);
    if (!bytes || bytes.length < 1) return null;
    if (bytes[0] !== PIXEL_CODEC_VERSION) return null;
    // A run is five bytes, so anything else is truncated or from another format.
    if ((bytes.length - 1) % 5 !== 0) return null;

    const buffer = createPixelBuffer(width, height);
    const total = width * height;
    let at = 0;
    for (let i = 1; i < bytes.length; i += 5) {
        const run = bytes[i];
        // BOTH GUARDS ARE REDUNDANT with the `at === total` check at the end, which already refuses
        // a payload that does not fill the surface exactly — and an out-of-range write to a
        // Uint8ClampedArray is silently ignored, so neither can corrupt anything. They are kept
        // because they say WHERE the payload went wrong; the final check only says that it did.
        //
        // (An earlier comment here claimed a zero run could loop forever. It cannot — the `for`
        // always advances `i`. The guard is worth having, the reason given for it was not.)
        if (run === 0) return null;
        if (at + run > total) return null;
        for (let n = 0; n < run; n++) {
            const o = (at + n) * 4;
            buffer.data[o] = bytes[i + 1];
            buffer.data[o + 1] = bytes[i + 2];
            buffer.data[o + 2] = bytes[i + 3];
            buffer.data[o + 3] = bytes[i + 4];
        }
        at += run;
    }
    return at === total ? buffer : null;
}
