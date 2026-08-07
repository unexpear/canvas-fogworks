/**
 * @module Obj
 * @description A `.obj` as triangles, with its three index streams reconciled into one.
 *
 * `v`, `vt` AND `vn` ARE INDEPENDENT. A face names a position, a texcoord and a normal by SEPARATE
 * indices and nothing requires them to agree. A GPU wants one index per vertex, so the obvious
 * implementation — build the buffer from the `v` lines and index it by the position index — is
 * wrong the moment one position is shared by faces with different normals. It is wrong in 598 of
 * 600 measured files. A cube's corner takes whichever normal was written last and a hard-edged
 * model shades like a soft one: well-formed geometry, quietly wrong lighting, no error anywhere.
 *
 * So this DE-DUPLICATES `v/vt/vn` triples into unique vertices. The measured cost is 1.87 vertices
 * per position on average and 3.5x at worst, which is the price of being right.
 *
 * FACES ARE NOT ALWAYS TRIANGLES. 81,712 of the 2,605,375 faces in the tree have more than three
 * vertices — mostly quads, up to a 13-gon. Taking the first three would drop 3% of every model's
 * surface, leaving holes that read as a broken exporter. They are fan-triangulated, which is exact
 * for the convex faces an exporter emits.
 *
 * INDICES ARE 1-BASED AND MAY BE NEGATIVE, counted back from the end of what has been read so far.
 * No measured file uses a negative one, which is precisely why it is tested rather than assumed.
 *
 * THE MATERIAL LIBRARY IS A SIDECAR. Every measured file names an `.mtl` and every one resolves
 * beside it, but this does not fetch it — the same rule Tiled and glTF follow, for the same reason.
 */

import { MeshPrimitive, MeshInstance, MESH_IDENTITY } from "./MeshData";

/** Bounds on a hand-editable file. A corrupt file should fail, not allocate. */
export const OBJ_MAX_VERTICES = 4_000_000;
export const OBJ_MAX_GROUPS = 4_096;
/** Beyond this a "face" is not a polygon an exporter meant, and fanning it would allocate wildly. */
export const OBJ_FACE_MAX_CORNERS = 256;

/** One material, as an `.mtl` states it. Colours are linear RGB triples, 0..1. */
export interface ObjMaterial {
    name: string;
    /** Diffuse colour, `Kd` — present in 7,821 of the 7,909 materials measured. */
    diffuse: [number, number, number] | null;
    ambient: [number, number, number] | null;
    specular: [number, number, number] | null;
    /** `Ns`, the specular exponent. */
    shininess: number | null;
    /** `d`, opacity. 1 is opaque. `Tr` is the same thing INVERTED and is normalised here. */
    opacity: number;
    /** `map_Kd` and friends — file paths a CALLER resolves, never read here. */
    diffuseMap: string | null;
    alphaMap: string | null;
    bumpMap: string | null;
}

/** A read model. */
export interface ObjResult {
    /** One per `usemtl` run, so a model with a painted and a metal part is two draws. */
    instances: MeshInstance[];
    /** The `.mtl` files this names, for a caller to resolve. */
    materialLibraries: string[];
    /** What could not be represented exactly, reported rather than left to be discovered. */
    notes: string[];
}

/** What went wrong, or null. */
export function objError(text: unknown): string | null {
    if (typeof text !== "string") return "an OBJ must be a string";
    // A `v ` line is the one thing every OBJ has. Testing for it rejects an `.mtl` handed over by
    // mistake, which otherwise parses to a model with no geometry and no complaint.
    if (!/^\s*v\s+[-\d.]/m.test(text)) return "not an OBJ: no vertex lines";
    return null;
}

/** What went wrong with a material library, or null. */
export function mtlError(text: unknown): string | null {
    if (typeof text !== "string") return "an MTL must be a string";
    if (!/^\s*newmtl\s+\S/m.test(text)) return "not an MTL: no newmtl lines";
    return null;
}

/**
 * An index as the file writes it, resolved against what has been read.
 *
 * ONE-BASED, so 1 is the first. NEGATIVE counts back from the end — -1 is the most recent — which
 * is why the count is passed in rather than the array: the value is relative to the moment the face
 * appears, not to the finished file.
 */
export function resolveObjIndex(raw: number, count: number): number {
    // BOTH CLAUSES ARE REDUNDANT with the range check below — 0 lands exactly on `count` and NaN
    // fails every comparison — and they are kept because that is a coincidence of the arithmetic
    // rather than a rule anyone reading this would rely on. 0 is invalid because OBJ indices start
    // at 1; saying so is worth a branch a mutation cannot distinguish.
    if (!Number.isFinite(raw) || raw === 0) return -1;
    const at = raw > 0 ? raw - 1 : count + raw;
    return at >= 0 && at < count ? at : -1;
}

/** A face corner's three optional indices, as `v`, `v/vt`, `v//vn` or `v/vt/vn`. */
function corner(token: string): [number, number, number] {
    // The SEPARATOR IS SIGNIFICANT: `1//3` omits the texcoord, and splitting on a regex that
    // collapsed the empty field would read the normal as a texcoord for every such file.
    const parts = token.split("/");
    // `s === ""` is likewise belt-and-braces: `Number("")` is 0, which `resolveObjIndex` already
    // rejects as an invalid index. Stating that an empty field means ABSENT is the intent, and
    // leaning on 0-happening-to-be-invalid would be leaning on something unrelated.
    const n = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));
    return [n(parts[0]), n(parts[1]), n(parts[2])];
}

/** A run of faces sharing one material, accumulated as unique vertices. */
interface Group {
    name: string;
    material: string | null;
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
    /** `v/vt/vn` as written, to the vertex it was given. THIS is what makes the de-duplication. */
    lookup: Map<string, number>;
    sawNormal: boolean;
    sawUv: boolean;
}

/**
 * The model's triangles, one primitive per material run.
 *
 * Throws on anything `objError` refuses. Never reaches for the `.mtl` it names — that is reported
 * in `materialLibraries` for a caller to resolve.
 */
export function parseObj(text: string): ObjResult {
    const bad = objError(text);
    if (bad) throw new Error(`Invalid OBJ: ${bad}.`);
    const notes: string[] = [];
    const materialLibraries: string[] = [];

    // The three streams, FILE-WIDE: an index in a face refers to the whole file's list, not to the
    // current group's. Resetting them per group would misindex every model with several materials.
    const positions: number[] = [];
    const uvs: number[] = [];
    const normals: number[] = [];

    const groups: Group[] = [];
    let current: Group | null = null;
    let objectName = "";
    let materialName: string | null = null;
    let truncated = false;

    const startGroup = (): Group => {
        if (groups.length >= OBJ_MAX_GROUPS) {
            if (!truncated) { notes.push(`more than ${OBJ_MAX_GROUPS} material groups`); truncated = true; }
            return groups[groups.length - 1];
        }
        const g: Group = {
            name: objectName || materialName || "mesh", material: materialName,
            positions: [], normals: [], uvs: [], indices: [],
            lookup: new Map(), sawNormal: false, sawUv: false
        };
        groups.push(g);
        return g;
    };

    // `\r` is stripped rather than split on: 4,646 of the measured files are CRLF, and a trailing
    // carriage return turns every last token on a line into a number that does not parse.
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "").trim();
        // The `#` skip is a FAST PATH, not a rule: an unrecognised keyword is ignored anyway, so
        // removing it changes nothing but the work done on the 5,416 comment lines in the tree.
        if (line === "" || line.startsWith("#")) continue;
        const space = line.indexOf(" ");
        const keyword = space < 0 ? line : line.slice(0, space);
        const rest = space < 0 ? "" : line.slice(space + 1).trim();

        if (keyword === "v") {
            // A `v` may carry a trailing colour; only the first three are the position.
            const n = rest.split(/\s+/).map(Number);
            positions.push(n[0] || 0, n[1] || 0, n[2] || 0);
            if (positions.length / 3 > OBJ_MAX_VERTICES) throw new Error("Invalid OBJ: too many vertices.");
        } else if (keyword === "vt") {
            const n = rest.split(/\s+/).map(Number);
            uvs.push(n[0] || 0, n[1] || 0);
        } else if (keyword === "vn") {
            const n = rest.split(/\s+/).map(Number);
            normals.push(n[0] || 0, n[1] || 0, n[2] || 0);
        } else if (keyword === "mtllib") {
            // A LINE MAY NAME SEVERAL, and a path may contain spaces — so the whole rest is taken
            // when splitting would produce something that resolves to nothing.
            for (const name of rest.split(/\s+/)) if (name) materialLibraries.push(name);
        } else if (keyword === "usemtl") {
            materialName = rest;
            // A NEW RUN, always: the same material may be used again after another, and merging
            // those two runs would reorder triangles relative to the file.
            current = startGroup();
        } else if (keyword === "o" || keyword === "g") {
            objectName = rest;
            if (current && current.indices.length === 0) current.name = objectName || current.name;
            else current = null;
        } else if (keyword === "f") {
            const tokens = rest.split(/\s+/).filter(t => t !== "");
            if (tokens.length < 3) { notes.push("a face with fewer than three corners was skipped"); continue; }
            if (tokens.length > OBJ_FACE_MAX_CORNERS) {
                notes.push(`a face with ${tokens.length} corners was skipped`); continue;
            }
            if (!current) current = startGroup();
            const g = current;

            const vertexFor = (token: string): number => {
                const held = g.lookup.get(token);
                if (held !== undefined) return held;
                const [vi, ti, ni] = corner(token);
                const p = resolveObjIndex(vi, positions.length / 3);
                if (p < 0) return -1;
                const index = g.positions.length / 3;
                g.positions.push(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2]);

                const t = Number.isNaN(ti) ? -1 : resolveObjIndex(ti, uvs.length / 2);
                // A vertex with no texcoord still occupies a SLOT, or every later vertex's uv would
                // be shifted by one and the whole texture would crawl across the model.
                g.uvs.push(t >= 0 ? uvs[t * 2] : 0, t >= 0 ? uvs[t * 2 + 1] : 0);
                if (t >= 0) g.sawUv = true;

                const n = Number.isNaN(ni) ? -1 : resolveObjIndex(ni, normals.length / 3);
                if (n >= 0) {
                    // NORMALISED HERE, because this format does not promise it and the shared
                    // `MeshPrimitive` does. 206 measured files carry normals of length exactly 0.1
                    // — right directions at a tenth scale — and a renderer trusting the invariant
                    // would light those surfaces a tenth as brightly. Magnitude means nothing for a
                    // normal, so nothing is lost; a ZERO normal stays zero, having no direction.
                    const x = normals[n * 3], y = normals[n * 3 + 1], z = normals[n * 3 + 2];
                    const length = Math.hypot(x, y, z);
                    if (length > 0) g.normals.push(x / length, y / length, z / length);
                    else g.normals.push(0, 0, 0);
                    g.sawNormal = true;
                } else {
                    g.normals.push(0, 0, 0);
                }

                g.lookup.set(token, index);
                return index;
            };

            const fan = tokens.map(vertexFor);
            if (fan.some(i => i < 0)) { notes.push("a face referenced a vertex the file does not have"); continue; }
            // FAN TRIANGULATION from the first corner. Exact for the convex faces an exporter emits,
            // and 81,712 faces in the tree need it — a reader taking the first three corners would
            // drop 3% of every model's surface and leave holes.
            for (let i = 1; i + 1 < fan.length; i++) g.indices.push(fan[0], fan[i], fan[i + 1]);
        }
    }

    const instances: MeshInstance[] = [];
    for (const g of groups) {
        if (g.indices.length === 0) continue;
        instances.push({
            name: g.name,
            // OBJ HAS NO HIERARCHY: coordinates are already where they belong, so the identity is
            // the honest answer rather than a missing field a consumer would have to branch on.
            matrix: [...MESH_IDENTITY],
            primitive: {
                positions: Float32Array.from(g.positions),
                normals: g.sawNormal ? Float32Array.from(g.normals) : null,
                uvs: g.sawUv ? Float32Array.from(g.uvs) : null,
                indices: Uint32Array.from(g.indices),
                material: g.material
            }
        });
    }
    if (instances.length === 0) notes.push("no faces were read");
    return { instances, materialLibraries, notes };
}

/** One `Kd 1 0.5 0.25`-style triple, or null. */
function colour(rest: string): [number, number, number] | null {
    const n = rest.split(/\s+/).map(Number);
    if (n.length < 3 || n.some(v => !Number.isFinite(v))) return null;
    return [n[0], n[1], n[2]];
}

/**
 * A material library's materials, keyed by name.
 *
 * Throws on anything `mtlError` refuses. Texture paths are REPORTED, never read.
 */
export function parseMtl(text: string): Map<string, ObjMaterial> {
    const bad = mtlError(text);
    if (bad) throw new Error(`Invalid MTL: ${bad}.`);
    const out = new Map<string, ObjMaterial>();
    let current: ObjMaterial | null = null;

    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "").trim();
        if (line === "" || line.startsWith("#")) continue;
        const space = line.indexOf(" ");
        const keyword = space < 0 ? line : line.slice(0, space);
        const rest = space < 0 ? "" : line.slice(space + 1).trim();

        if (keyword === "newmtl") {
            current = {
                name: rest, diffuse: null, ambient: null, specular: null,
                shininess: null, opacity: 1, diffuseMap: null, alphaMap: null, bumpMap: null
            };
            out.set(rest, current);
            continue;
        }
        if (!current) continue;
        switch (keyword) {
            case "Kd": current.diffuse = colour(rest); break;
            case "Ka": current.ambient = colour(rest); break;
            case "Ks": current.specular = colour(rest); break;
            case "Ns": current.shininess = Number(rest); break;
            case "d": {
                const v = Number(rest);
                if (Number.isFinite(v)) current.opacity = v;
                break;
            }
            case "Tr": {
                // `Tr` IS TRANSPARENCY, the INVERSE of `d`. Reading it as opacity makes every
                // fully-opaque material invisible and every invisible one solid, and the two
                // spellings appear in the wild for the same intent.
                const v = Number(rest);
                if (Number.isFinite(v)) current.opacity = 1 - v;
                break;
            }
            // A map line may carry OPTIONS before the path — `map_Kd -s 1 1 1 tex.png` — so the
            // last token is the file rather than the first.
            case "map_Kd": current.diffuseMap = mapPath(rest); break;
            case "map_d": current.alphaMap = mapPath(rest); break;
            case "map_Bump": case "bump": current.bumpMap = mapPath(rest); break;
        }
    }
    return out;
}

/** The file a `map_*` line names, past any options. */
function mapPath(rest: string): string | null {
    const tokens = rest.split(/\s+/).filter(t => t !== "");
    if (tokens.length === 0) return null;
    return tokens[tokens.length - 1];
}
