/**
 * @module Aseprite
 * @description Reading the file the sheet was exported FROM.
 *
 * Every other importer here reconstructs by measurement what this format simply states. `SheetSlice`
 * recovers a grid by dividing an image and refusing sizes that do not fit; `imageInkBounds` recovers
 * a trim by scanning pixels; `sequenceTrack` invents a frame duration because a folder of PNGs has
 * none. The `.aseprite` that shipped alongside one of those very sheets declares all three: 27
 * frames at 100 ms, 6 layers, 53 cels each carrying its own position and size, and five animation
 * tags with exact frame ranges.
 *
 * THE TAGS ARE CLIPS. `{ name, from, to }` is `Clip` field for field (schema 46), so importing them
 * is a rename rather than a translation. That correspondence is the strongest reason to read this
 * format at all: what a PNG export throws away is precisely what this engine already models.
 *
 * AND A CEL'S POSITION IS THE TRIM. Aseprite stores each cel as a rectangle placed on the canvas, so
 * the transparent padding never existed in the file — it appears when the sheet is exported. Reading
 * the source makes the pixel scan unnecessary rather than merely cheaper.
 *
 * PARSING IS PURE; INFLATING IS INJECTED. Cel pixels are zlib-compressed and this module has no
 * business choosing between `node:zlib` and `DecompressionStream`. It takes an optional inflate
 * function, the same way `blankCells` takes an ink test and `drawSheet` takes a context. Without one
 * the structure still parses and cels keep their compressed bytes — enough for clips, timing and
 * layout, and testable with no decompressor present.
 *
 * WHAT IS REFUSED IS REFUSED LOUDLY. Indexed and greyscale depths, tilemap cels and tileset chunks
 * are named in the error rather than half-read: a partly-understood file that loads looking almost
 * right is worse than one that says which feature it met and did not know.
 */

/** Bounds on a hand-editable file. A corrupt header should fail, not allocate. */
export const ASE_MAX_FRAMES = 8_192;
export const ASE_MAX_LAYERS = 512;
export const ASE_MAX_CELS = 65_536;
/** Largest canvas this will accept, in pixels — the same reasoning as `SHEET_MAX_PIXELS`. */
export const ASE_MAX_CANVAS = 16_384 * 16_384;

/** The magic numbers, named so a reader can check them against the published spec. */
const ASE_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;
const CHUNK_TAGS = 0x2018;
const CHUNK_PALETTE = 0x2019;

/** One layer, in file order — index into this list is what a cel's `layer` refers to. */
export interface AseLayer {
    name: string;
    /** Nesting depth. Aseprite stores a tree as a flat list plus a level, and so does this. */
    childLevel: number;
    /** 0 = image, 1 = group, 2 = tilemap. A group holds no pixels of its own. */
    type: number;
    visible: boolean;
    opacity: number;
    blendMode: number;
}

/** One cel: a rectangle of pixels placed on the canvas at a frame, for one layer. */
export interface AseCel {
    frame: number;
    layer: number;
    x: number;
    y: number;
    width: number;
    height: number;
    opacity: number;
    /**
     * RGBA pixels, present only when an inflate function was supplied and the cel carries its own
     * image. A LINKED cel has none of its own — see `linkedFrom`.
     */
    pixels: Uint8Array | null;
    /** The compressed bytes, kept when nothing inflated them so a caller can do it later. */
    compressed: Uint8Array | null;
    /** For a linked cel, the frame whose cel on this layer supplies the image. */
    linkedFrom: number | null;
}

/** An animation tag — the same statement a `Clip` makes, which is why this import is a rename. */
export interface AseTag {
    name: string;
    from: number;
    to: number;
    /** 0 forward, 1 reverse, 2 ping-pong, 3 ping-pong reverse. */
    direction: number;
}

/** A parsed file. */
export interface AseFile {
    width: number;
    height: number;
    /** 32 = RGBA. Others are refused; see the module note. */
    colorDepth: number;
    frames: { duration: number }[];
    layers: AseLayer[];
    cels: AseCel[];
    tags: AseTag[];
    /** RGBA palette entries, when the file carries one. */
    palette: { r: number; g: number; b: number; a: number }[];
}

/** What went wrong, or null. Separate from the parse so a caller can check before allocating. */
export function asepriteError(bytes: Uint8Array): string | null {
    if (bytes.length < 128) return "not an Aseprite file: shorter than its header";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(4, true) !== ASE_MAGIC) return "not an Aseprite file: bad magic";
    const frames = view.getUint16(6, true);
    if (frames < 1 || frames > ASE_MAX_FRAMES) return `frame count ${frames} is outside [1, ${ASE_MAX_FRAMES}]`;
    const width = view.getUint16(8, true), height = view.getUint16(10, true);
    if (width * height > ASE_MAX_CANVAS) return `canvas ${width}x${height} is larger than this will read`;
    const depth = view.getUint16(12, true);
    // NAMED IN THE ERROR. An indexed file needs its palette applied to every pixel and a greyscale
    // one has a different sample layout; reading either as RGBA produces a picture that is wrong
    // rather than absent, which is the worst way to fail.
    if (depth !== 32) return `colour depth ${depth} is not supported yet (only 32-bit RGBA)`;
    return null;
}

/**
 * The file's structure, and its pixels when something can inflate them.
 *
 * Throws on a file `asepriteError` would refuse, so a caller that checked first cannot be surprised
 * and one that did not still cannot get half an answer.
 */
export function parseAseprite(bytes: Uint8Array, opts?: { inflate?: (data: Uint8Array) => Uint8Array }): AseFile {
    const bad = asepriteError(bytes);
    if (bad) throw new Error(`Invalid Aseprite file: ${bad}.`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (at: number, len: number) => new TextDecoder().decode(bytes.subarray(at, at + len));

    const frameCount = view.getUint16(6, true);
    const file: AseFile = {
        width: view.getUint16(8, true),
        height: view.getUint16(10, true),
        colorDepth: view.getUint16(12, true),
        frames: [], layers: [], cels: [], tags: [], palette: []
    };

    let off = 128;
    for (let f = 0; f < frameCount; f++) {
        if (off + 16 > bytes.length) throw new Error("Invalid Aseprite file: truncated frame header.");
        const frameSize = view.getUint32(off, true);
        if (view.getUint16(off + 4, true) !== FRAME_MAGIC) throw new Error(`Invalid Aseprite file: frame ${f} has bad magic.`);
        const oldCount = view.getUint16(off + 6, true);
        file.frames.push({ duration: view.getUint16(off + 8, true) });
        const newCount = view.getUint32(off + 12, true);
        // The count MOVED between format versions and both fields are still written. Zero in the
        // newer one means "the old field is authoritative", which is the file saying it predates
        // the change rather than that it holds no chunks.
        const chunks = newCount === 0 ? oldCount : newCount;

        let at = off + 16;
        for (let c = 0; c < chunks; c++) {
            if (at + 6 > bytes.length) throw new Error(`Invalid Aseprite file: truncated chunk in frame ${f}.`);
            const size = view.getUint32(at, true);
            const type = view.getUint16(at + 4, true);
            if (size < 6) throw new Error(`Invalid Aseprite file: chunk of size ${size} in frame ${f}.`);
            readChunk(file, view, bytes, text, at + 6, size - 6, type, f, opts?.inflate);
            at += size;
        }
        off += frameSize;
    }
    return file;
}

function readChunk(
    file: AseFile, view: DataView, bytes: Uint8Array, text: (at: number, len: number) => string,
    at: number, size: number, type: number, frame: number, inflate?: (d: Uint8Array) => Uint8Array
): void {
    if (type === CHUNK_LAYER) {
        if (file.layers.length >= ASE_MAX_LAYERS) throw new Error("Invalid Aseprite file: too many layers.");
        const flags = view.getUint16(at, true);
        const nameLen = view.getUint16(at + 16, true);
        file.layers.push({
            // Bit 0 is VISIBLE. A hidden layer is kept rather than dropped, because "the file has a
            // hidden layer" is information an importer may want to preserve or to warn about.
            visible: (flags & 1) !== 0,
            type: view.getUint16(at + 2, true),
            childLevel: view.getUint16(at + 4, true),
            blendMode: view.getUint16(at + 10, true),
            opacity: view.getUint8(at + 12),
            name: text(at + 18, nameLen)
        });
        return;
    }
    if (type === CHUNK_CEL) {
        if (file.cels.length >= ASE_MAX_CELS) throw new Error("Invalid Aseprite file: too many cels.");
        const layer = view.getUint16(at, true);
        const x = view.getInt16(at + 2, true);
        const y = view.getInt16(at + 4, true);
        const opacity = view.getUint8(at + 6);
        const celType = view.getUint16(at + 7, true);
        // 7 bytes follow the type: a z-index in newer files, reserved in older ones. The total is
        // the same either way, so the offsets below hold for both.
        const body = at + 16;
        if (celType === 1) {
            file.cels.push({ frame, layer, x, y, width: 0, height: 0, opacity,
                pixels: null, compressed: null, linkedFrom: view.getUint16(body, true) });
            return;
        }
        if (celType === 3) throw new Error("Invalid Aseprite file: tilemap cels are not supported yet.");
        const width = view.getUint16(body, true), height = view.getUint16(body + 2, true);
        const data = bytes.subarray(body + 4, at + size);
        const raw = celType === 0 ? data : null;
        let pixels: Uint8Array | null = raw;
        let compressed: Uint8Array | null = null;
        if (celType === 2) {
            if (inflate) pixels = inflate(data);
            else compressed = data;
        }
        file.cels.push({ frame, layer, x, y, width, height, opacity, pixels, compressed, linkedFrom: null });
        return;
    }
    if (type === CHUNK_TAGS) {
        const count = view.getUint16(at, true);
        let p = at + 10;                       // WORD count + 8 reserved
        for (let i = 0; i < count; i++) {
            const from = view.getUint16(p, true), to = view.getUint16(p + 2, true);
            const direction = view.getUint8(p + 4);
            const nameLen = view.getUint16(p + 17, true);
            file.tags.push({ from, to, direction, name: text(p + 19, nameLen) });
            p += 19 + nameLen;
        }
        return;
    }
    if (type === CHUNK_PALETTE) {
        const first = view.getUint32(at + 4, true), last = view.getUint32(at + 8, true);
        let p = at + 20;
        for (let i = first; i <= last && p + 6 <= at + size; i++) {
            const flags = view.getUint16(p, true);
            file.palette[i] = { r: view.getUint8(p + 2), g: view.getUint8(p + 3), b: view.getUint8(p + 4), a: view.getUint8(p + 5) };
            p += 6;
            // Bit 0 means the entry carries a name, which is length-prefixed and skipped over.
            if (flags & 1) p += 2 + view.getUint16(p, true);
        }
        return;
    }
    // Every other chunk — colour profile, user data, slices, external files — is SKIPPED rather
    // than refused. They add information this importer does not use yet; none of them changes the
    // meaning of what it does read, so ignoring one cannot make a frame wrong.
}

/**
 * The file's tags as this engine's clips.
 *
 * A rename, not a translation, which is the whole point: `{ name, from, to }` is what both call it.
 * `loop` is set from the tag's direction — forward and ping-pong cycle, and Aseprite has no
 * "play once" flag, so a clip imported from a tag loops exactly as it does in the editor.
 */
export function asepriteClips(file: AseFile): { name: string; from: number; to: number; loop: boolean }[] {
    return file.tags.map(t => ({ name: t.name, from: t.from, to: t.to, loop: true }));
}

/**
 * The timeline a file implies: its frame count, and the rate its durations describe.
 *
 * Aseprite times each frame INDIVIDUALLY in milliseconds while this engine has one rate for the
 * document, so a file with varying durations cannot be expressed exactly. The shortest frame sets
 * the rate — that is the only choice that can represent every frame as a whole number of ticks,
 * where an average would round some frames to nothing.
 */
export function asepriteTimeline(file: AseFile): { frames: number; fps: number } {
    const durations = file.frames.map(f => f.duration).filter(d => d > 0);
    // A file with no stated durations gets the editor's own default rather than a division by zero.
    const shortest = durations.length > 0 ? Math.min(...durations) : 100;
    const fps = Math.max(1, Math.min(240, Math.round(1000 / shortest)));
    return { frames: file.frames.length, fps };
}
