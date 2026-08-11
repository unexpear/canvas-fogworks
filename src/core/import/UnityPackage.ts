/**
 * @module UnityPackage
 * @description A `.unitypackage`, opened — seven of them sit in this tree and nothing could read one.
 *
 * WHAT IT IS, measured rather than recalled: a gzipped tar in which every asset is a folder named by
 * its GUID, holding `asset` (the bytes), `asset.meta` (the importer settings) and `pathname` (the
 * path the file had in the project). A folder entry has a `pathname` and no `asset`. Measured over
 * the packages here: 115 entries, 6 of them folders, and `pathname` is one line with NO trailing
 * newline — so a reader that trims by stripping a final `\\n` works by luck and one that splits on
 * lines and takes `[0]` works for the right reason.
 *
 * THE PATH IS THE ANSWER AND THE GUID IS THE QUESTION. A package's folder names are Unity's internal
 * identity, which is what a `.meta` file's references point at; the `pathname` is what a person
 * recognises. Both are returned, because dropping the GUID would make it impossible to resolve a
 * reference later and dropping the path would hand somebody 96 files called `asset`.
 *
 * DECOMPRESSION IS INJECTED, exactly as `TiledMap` and `Aseprite` inject theirs, so this module
 * stays pure and testable without a runtime that has `zlib`. Without it the package is reported as
 * unreadable rather than half-read.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not parse `asset.meta`, and the reason is a
 * measurement rather than an omission: the interesting thing in a sprite's meta would be its
 * SLICING RECTS, and every one of the 96 sprites in the 2D package here is `spriteMode: 0` with
 * `sprites: []`. There are no rects in any file in this tree, so a reader for them would be written
 * against nothing. It also does not read Unity's PREFABS, which in these packages are binary
 * serialized type-trees rather than YAML — and the same models ship beside them as FBX and glTF,
 * which this engine already imports.
 */

/** Caps, in the `TILED_MAX_CELLS` tradition: a hostile or corrupt archive must not exhaust memory. */
export const UNITY_MAX_ENTRIES = 20_000;
export const UNITY_MAX_BYTES = 512 * 1024 * 1024;

/** One file recovered from a package. */
export interface UnityAsset {
    /** The path it had in the project, e.g. `Assets/Kenney/Particle samples/Sprites/star_04.png`. */
    path: string;
    /** Unity's identity for it — the archive folder's name, and what a `.meta` reference points at. */
    guid: string;
    /** The file's own bytes. */
    bytes: Uint8Array;
}

/** What a package held, and what could not be read. */
export interface UnityPackageContents {
    assets: UnityAsset[];
    /** Folder entries: a path and no bytes. Kept so an importer can rebuild the tree it came from. */
    folders: string[];
    /** Everything skipped, counted rather than dropped in silence. */
    notes: string[];
}

/**
 * What is wrong with these bytes, or null — checked BEFORE decompressing, so a caller can refuse a
 * file without allocating whatever it claims to expand to.
 */
export function unityPackageError(bytes: Uint8Array): string | null {
    if (!(bytes instanceof Uint8Array)) return "a .unitypackage must be bytes";
    if (bytes.length < 3) return "a .unitypackage is too short to be one";
    // GZIP'S MAGIC, which is the only thing a `.unitypackage` announces about itself — the extension
    // is the rest of the claim, and an extension is not evidence.
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return "a .unitypackage must be gzip-compressed";
    if (bytes[2] !== 8) return "a .unitypackage must use gzip's deflate method";
    return null;
}

/** One tar entry: its name, its bytes, and where the next header starts. */
interface TarEntry { name: string; data: Uint8Array; next: number }

/** ASCII from a NUL- or space-terminated field, which is how tar writes every string it has. */
function field(bytes: Uint8Array, at: number, len: number): string {
    let end = at;
    while (end < at + len && bytes[end] !== 0 && bytes[end] !== 0x20) end++;
    let out = "";
    for (let i = at; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

/**
 * The header at `at`, or null at the end of the archive.
 *
 * THE CHECKSUM IS VERIFIED, because the alternative is reading a truncated archive as a very strange
 * one: a header whose size field is garbage names an entry of some arbitrary length, and everything
 * after it is read at the wrong offset. Tar computes it with the checksum field itself read as
 * spaces, which is the one part of the format that cannot be guessed from a hex dump.
 */
function tarHeader(bytes: Uint8Array, at: number): TarEntry | null | "corrupt" {
    if (at + 512 > bytes.length) return null;
    let allZero = true;
    for (let i = at; i < at + 512; i++) if (bytes[i] !== 0) { allZero = false; break; }
    if (allZero) return null;                       // the two zero blocks that end an archive

    let sum = 0;
    for (let i = at; i < at + 512; i++) {
        // Bytes 148..155 are the checksum FIELD, counted as spaces while checking it.
        sum += (i >= at + 148 && i < at + 156) ? 0x20 : bytes[i];
    }
    const stated = parseInt(field(bytes, at + 148, 8), 8);
    if (!Number.isFinite(stated) || stated !== sum) return "corrupt";

    const name = field(bytes, at, 100);
    // USTAR SPLITS A LONG PATH across a prefix field, and joining them is the whole of its long-name
    // support. A GUID folder is 32 characters so nothing here needs it — handled anyway, because the
    // cost is one line and the failure is a silently truncated path.
    const prefix = field(bytes, at + 345, 155);
    const size = parseInt(field(bytes, at + 124, 12), 8) || 0;
    const type = bytes[at + 156];
    const full = prefix === "" ? name : `${prefix}/${name}`;
    const start = at + 512;
    const padded = Math.ceil(size / 512) * 512;
    // A DIRECTORY entry ('5') has a size of 0 and is not one of ours: the archive's folders are
    // GUID directories, and the ASSET's own folder-ness is stated by having no `asset` file.
    return {
        name: type === 0x35 ? `${full}/` : full,
        data: bytes.subarray(start, Math.min(start + size, bytes.length)),
        next: start + padded
    };
}

/**
 * The files inside a `.unitypackage`.
 *
 * PURE, and decompression is the caller's: pass `gunzip` or get a package reported as unreadable.
 */
export function parseUnityPackage(
    bytes: Uint8Array, opts?: { gunzip?: (data: Uint8Array) => Uint8Array }
): UnityPackageContents {
    const notes: string[] = [];
    const err = unityPackageError(bytes);
    if (err !== null) return { assets: [], folders: [], notes: [err] };
    if (!opts?.gunzip) {
        return { assets: [], folders: [], notes: ["a .unitypackage is gzipped and nothing was supplied to expand it"] };
    }

    let tar: Uint8Array;
    try {
        tar = opts.gunzip(bytes);
    } catch (e) {
        return { assets: [], folders: [], notes: [`a .unitypackage could not be expanded: ${String(e)}`] };
    }
    if (tar.length > UNITY_MAX_BYTES) {
        return { assets: [], folders: [], notes: [`a .unitypackage expands to ${tar.length} bytes, over the ${UNITY_MAX_BYTES} limit`] };
    }

    // GATHERED BY GUID FOLDER FIRST, because tar states no order and the three files of one asset
    // are three separate entries — a reader that assumed `pathname` arrives before `asset` would
    // work on the packages it was written against and lose files on the next one.
    const byGuid = new Map<string, { path?: string; data?: Uint8Array }>();
    let at = 0, count = 0;
    for (;;) {
        const entry = tarHeader(tar, at);
        if (entry === null) break;
        if (entry === "corrupt") {
            notes.push(`a .unitypackage entry at byte ${at} has a bad checksum; the rest was not read`);
            break;
        }
        at = entry.next;
        if (++count > UNITY_MAX_ENTRIES) {
            notes.push(`a .unitypackage holds more than ${UNITY_MAX_ENTRIES} entries; the rest was not read`);
            break;
        }
        const slash = entry.name.indexOf("/");
        if (slash <= 0) continue;                                  // the GUID folder's own entry
        const guid = entry.name.slice(0, slash);
        const leaf = entry.name.slice(slash + 1);
        if (leaf === "" ) continue;
        const slot = byGuid.get(guid) ?? {};
        // ONE LINE, TAKEN AS A LINE — and this is DEFENSIVE, not measured. Every `pathname` in
        // every package here is a single line with no trailing newline, so `trim()` alone would be
        // indistinguishable: a mutant replacing the split with a bare trim survives the whole
        // battery, and is recorded as equivalent rather than papered over with a fixture invented
        // to kill it. The split stays because a line-oriented file read whole would yield a path
        // with a newline IN it, which fails later as "no such file" rather than as a parse error.
        if (leaf === "pathname") slot.path = ascii(entry.data).split("\n")[0].trim();
        else if (leaf === "asset") slot.data = entry.data;
        byGuid.set(guid, slot);
    }

    const assets: UnityAsset[] = [];
    const folders: string[] = [];
    for (const [guid, slot] of byGuid) {
        if (slot.path === undefined || slot.path === "") {
            notes.push(`asset ${guid} has no pathname and was not read`);
            continue;
        }
        // NO `asset` MEANS A FOLDER, which is how the format says it — measured: 6 of 115 entries.
        if (slot.data === undefined) { folders.push(slot.path); continue; }
        assets.push({ path: slot.path, guid, bytes: slot.data });
    }
    // SORTED BY PATH, because a tar states no order and a caller listing what it found should not
    // show a different order for the same file on two machines.
    assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    folders.sort();
    return { assets, folders, notes };
}

function ascii(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
}
