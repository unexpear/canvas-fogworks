/**
 * @module Gltf
 * @description A `.glb` or `.gltf` as triangles, read correctly rather than approximately.
 *
 * Thousands of glTF files sit in the measured tree — 5,464 at the last count, and the count moves —
 * and nothing could open one. This reads them all; drawing
 * them is a schema, a node type and a pipeline, and doing the reading well first is what makes that
 * small — the same order every 2D format went in.
 *
 * THE VERTEX DATA IS INTERLEAVED. 9,596 bufferViews in the tree declare a `byteStride`, meaning a
 * primitive's positions, normals and UVs are woven together rather than stored one array after
 * another. A reader that walks an accessor tightly-packed produces coordinates out of whatever
 * happened to sit at that offset — a mesh that draws, made of nonsense. This is glTF's flip-flag:
 * the common case rather than the exotic one, and there is no error to notice.
 *
 * AN ACCESSOR IS TWO OFFSETS. It carries its own `byteOffset` into a bufferView that carries
 * another into the buffer. Adding one and not the other is off by a fixed amount, which looks like
 * a model built slightly wrong rather than one read wrongly.
 *
 * INDICES ARRIVE IN THREE WIDTHS — unsigned byte, short and int all appear in the tree — so the
 * reader is driven by the declared component type rather than by a guess that holds for most files.
 *
 * A REQUIRED EXTENSION IS REFUSED BY NAME unless it provably cannot touch the geometry. The spec
 * says a client MUST NOT load an asset requiring an extension it lacks, and that rule exists so
 * nothing is drawn confidently wrong. The only one required anywhere in the tree is
 * `KHR_materials_unlit`, in 246 files — a lighting hint, and nothing here lights anything, so
 * refusing on it would cost 4.7% of the corpus over something that cannot change what is read.
 * The exemption is an explicit ALLOW-LIST that must be revisited when materials land, and using it
 * is reported louder than an ordinary extension, because the file did say it mattered.
 *
 * THE BUFFER IS SUPPLIED, NOT FETCHED. A `.glb` carries its BIN chunk inside it, but the `.gltf`
 * files name an external `.bin`. Resolving that is the caller's job, exactly as it is for a
 * Tiled `.tsx`: a parser that reached for a file would need a filesystem and stop being testable.
 */

import { MeshPrimitive, MeshInstance } from "./MeshData";

/** Bounds on a hand-editable file. A corrupt count should fail, not allocate. */
export const GLTF_MAX_VERTICES = 4_000_000;
export const GLTF_MAX_PRIMITIVES = 8_192;
export const GLTF_MAX_NODE_DEPTH = 64;

/** The GLB container's magic and its two chunk types, as four-byte little-endian words. */
const GLB_MAGIC = 0x46546c67;    // "glTF"
const CHUNK_JSON = 0x4e4f534a;   // "JSON"
const CHUNK_BIN = 0x004e4942;    // "BIN\0"

/**
 * Required extensions this may ignore, because they cannot change the GEOMETRY.
 *
 * The spec says a client MUST NOT load an asset requiring an extension it does not implement, and
 * that rule exists so nothing is drawn confidently wrong. This module reads geometry and no
 * materials at all, so an extension that only decorates a material cannot make its output wrong —
 * and refusing on one costs 246 files, 4.7% of the tree, over a lighting hint.
 *
 * IT IS AN ALLOW-LIST, NOT A LENIENCY. Anything not named here is still refused by name.
 *
 * REVISITED WHEN MATERIALS LANDED, as the previous note demanded. The answer did not change, and
 * the reason is worth pinning down: `gltfMaterials` now reads base colour, metallic, roughness and
 * emissive, but NOTHING LIGHTS THEM — there is no 3D renderer. `KHR_materials_unlit` says "do not
 * light this material", which cannot change an unlit reading of it.
 *
 * THE EXTENSION IS NOW READ, even though it is still ignorable: `GltfMaterial.unlit` carries it,
 * so the information those 246 files insist on is no longer discarded. What stays ignorable is the
 * REQUIREMENT — refusing to open a file over a lighting hint, while nothing lights anything, would
 * cost 246 models for no benefit.
 *
 * THE EXACT TRIGGER for removing it from this list: the first time a lighting term is applied to a
 * glTF material. On that day these files must honour `unlit` — and now they can, because the flag
 * is already there — or be refused, because from then on ignoring it means shading something the
 * file said to leave flat.
 */
export const GLTF_IGNORABLE_REQUIRED = ["KHR_materials_unlit"];

/** `mode` values. Every one of the 9,190 primitives in the tree is TRIANGLES; the rest are named. */
const MODE_TRIANGLES = 4;
const MODE_NAMES: Record<number, string> = {
    0: "points", 1: "lines", 2: "line loops", 3: "line strips",
    5: "triangle strips", 6: "triangle fans"
};

/** Component types, as the file's own numbers. */
const COMPONENT_BYTES: Record<number, number> = {
    5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4
};
/** How many components each accessor type holds. */
const TYPE_COMPONENTS: Record<string, number> = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16
};

/** The raw JSON, kept loose: this reads the parts it understands and reports the rest. */
export interface GltfJson {
    asset?: { version?: string; generator?: string };
    scene?: number;
    scenes?: { nodes?: number[] }[];
    nodes?: GltfNode[];
    meshes?: { name?: string; primitives: GltfPrimitiveJson[] }[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: { byteLength?: number; uri?: string }[];
    materials?: GltfMaterialJson[];
    textures?: { source?: number; sampler?: number }[];
    images?: { uri?: string; mimeType?: string; bufferView?: number }[];
    extensionsUsed?: string[];
    extensionsRequired?: string[];
}

export interface GltfNode {
    name?: string;
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
}

interface GltfPrimitiveJson {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
    targets?: unknown[];
}

interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    sparse?: unknown;
}

interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
}

interface GltfMaterialJson {
    name?: string;
    doubleSided?: boolean;
    alphaMode?: string;
    alphaCutoff?: number;
    emissiveFactor?: number[];
    normalTexture?: { index?: number };
    /** Kept LOOSE: a file may name any extension, and this reader only asks whether a key exists. */
    extensions?: Record<string, unknown>;
    pbrMetallicRoughness?: {
        baseColorFactor?: number[];
        baseColorTexture?: { index?: number; texCoord?: number };
        metallicFactor?: number;
        roughnessFactor?: number;
    };
}

/**
 * Where an image's bytes are, without fetching them.
 *
 * A glTF image is EITHER a file beside the document or a slice of the buffer already in hand, and
 * 4,150 of the measured images are the first while 125 are the second. Naming which, rather than
 * handing back bytes, is the same rule every reader here follows: resolving a path needs a
 * filesystem, and a parser that reaches for one stops being testable.
 */
export type GltfImageSource =
    | { kind: "uri"; uri: string; mimeType: string | null }
    | { kind: "buffer"; offset: number; length: number; mimeType: string | null };

/** One material, as the PBR model states it. Colours are linear RGBA, 0..1. */
export interface GltfMaterial {
    name: string;
    /** `baseColorFactor`, defaulting to opaque white as the spec does. */
    baseColor: [number, number, number, number];
    /** The IMAGE this material paints with, or null. Resolved through `textures` to `images`. */
    baseColorImage: GltfImageSource | null;
    metallic: number;
    roughness: number;
    emissive: [number, number, number];
    /** "OPAQUE", "MASK" or "BLEND" — 3,329 of the measured materials state one. */
    alphaMode: string;
    alphaCutoff: number;
    doubleSided: boolean;
    /**
     * `KHR_materials_unlit` — the file saying "do not light this; show the base colour as it is".
     *
     * READ RATHER THAN IGNORED, which is the change. 479 materials across 246 files carry it, and
     * every one of those files declares it REQUIRED. Until now the reader dropped it on the
     * grounds that a lighting hint cannot change an unlit reading — true, and it meant the one
     * piece of information those files insist on was the one piece thrown away.
     *
     * Carrying the flag costs a boolean and means the day a lighting term arrives, the answer is
     * already in the data rather than needing a second pass over 5,464 files to recover it.
     */
    unlit: boolean;
}

/** A GLB opened: its JSON and, when present, its embedded buffer. */
export interface GlbContainer {
    json: GltfJson;
    /** The BIN chunk. Null for a `.gltf`, whose buffer a caller supplies. */
    bin: Uint8Array | null;
}

/**
 * What this reader produces, which is what EVERY 3D reader here produces.
 *
 * The shape lives in `MeshData` rather than here so OBJ and, later, FBX hand back the same thing —
 * two nearly-identical primitive types are how a consumer ends up with a branch per format, and how
 * the first field one gains becomes the field the others quietly lack.
 */
export type GltfPrimitive = MeshPrimitive;
export type GltfMeshInstance = MeshInstance;

/** A read model. */
export interface GltfResult {
    generator: string;
    instances: GltfMeshInstance[];
    /** Extensions the file uses, so a caller can see what was ignored. */
    extensions: string[];
    /** What could not be represented exactly, reported rather than left to be discovered. */
    notes: string[];
}

/**
 * An image's bytes located, following `textures[i].source` to `images[]`.
 *
 * TWO HOPS, NOT ONE. A material names a TEXTURE, which names an IMAGE — the indirection exists so
 * several materials can share one picture with different samplers, and skipping it reads the
 * texture index as an image index. That is off-by-whatever silently, and lands on a real image
 * often enough to look like a mismatched-but-plausible skin rather than a bug.
 */
export function gltfImageSource(json: GltfJson, textureIndex: number): GltfImageSource | null {
    const texture = (json.textures ?? [])[textureIndex];
    // `texture.source === undefined` is REDUNDANT with the lookup below — indexing an array with
    // undefined yields undefined, which the next line already refuses — and is kept because a
    // texture naming no image is a rule of the format rather than an accident of JS indexing.
    if (!texture || texture.source === undefined) return null;
    const image = (json.images ?? [])[texture.source];
    if (!image) return null;
    const mimeType = image.mimeType ?? null;
    if (image.uri !== undefined) {
        // A `data:` URI is bytes already, not a path — the caller must not try to open it as one.
        return { kind: "uri", uri: image.uri, mimeType };
    }
    if (image.bufferView !== undefined) {
        const view = (json.bufferViews ?? [])[image.bufferView];
        if (!view) return null;
        return { kind: "buffer", offset: view.byteOffset ?? 0, length: view.byteLength, mimeType };
    }
    return null;
}

/**
 * The document's materials, with every default the spec states filled in.
 *
 * DEFAULTS MATTER MORE THAN THEY LOOK. Only 3,798 of the 7,955 measured materials state a
 * `baseColorFactor` at all; the rest rely on the spec's opaque white. A reader defaulting to black
 * or to transparent would render half the corpus invisible or unlit, and would do it without any
 * field being missing that a check could notice.
 */
export function gltfMaterials(json: GltfJson): GltfMaterial[] {
    return (json.materials ?? []).map(m => {
        const pbr = m.pbrMetallicRoughness ?? {};
        const base = pbr.baseColorFactor;
        const emissive = m.emissiveFactor;
        const textureIndex = pbr.baseColorTexture?.index;
        return {
            name: m.name ?? "",
            baseColor: base && base.length >= 4
                ? [base[0], base[1], base[2], base[3]]
                : [1, 1, 1, 1],
            baseColorImage: textureIndex === undefined ? null : gltfImageSource(json, textureIndex),
            // 1 and 1 are the spec's defaults — fully metallic and fully rough — and 7,476 of the
            // measured materials state metallic explicitly while only 3,488 state roughness, so
            // the default is load-bearing for over half of them.
            metallic: pbr.metallicFactor ?? 1,
            roughness: pbr.roughnessFactor ?? 1,
            emissive: emissive && emissive.length >= 3
                ? [emissive[0], emissive[1], emissive[2]]
                : [0, 0, 0],
            alphaMode: m.alphaMode ?? "OPAQUE",
            alphaCutoff: m.alphaCutoff ?? 0.5,
            doubleSided: m.doubleSided === true,
            // PRESENCE IS THE WHOLE SIGNAL. The extension's object is empty in every one of the
            // 479 measured materials, so testing for a property inside it would read every one as
            // lit — the value is that the key is there at all.
            unlit: !!(m.extensions && Object.prototype.hasOwnProperty.call(m.extensions, "KHR_materials_unlit"))
        };
    });
}

/** What went wrong with a GLB container, or null. */
export function glbError(bytes: unknown): string | null {
    if (!(bytes instanceof Uint8Array)) return "a GLB must be bytes";
    if (bytes.length < 20) return "not a GLB: shorter than its header";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) return "not a GLB: wrong magic";
    const version = view.getUint32(4, true);
    if (version !== 2) return `GLB version ${version} is not supported`;
    // The header's LENGTH is checked against the real file: a truncated download parses its header
    // perfectly and then reads a chunk that runs off the end.
    const declared = view.getUint32(8, true);
    if (declared !== bytes.length) return `GLB declares ${declared} bytes but is ${bytes.length}`;
    if (view.getUint32(16, true) !== CHUNK_JSON) return "not a GLB: first chunk is not JSON";
    return null;
}

/**
 * A GLB's JSON and embedded buffer.
 *
 * Throws on anything `glbError` refuses.
 */
export function parseGlb(bytes: Uint8Array): GlbContainer {
    const bad = glbError(bytes);
    if (bad) throw new Error(`Invalid GLB: ${bad}.`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    if (20 + jsonLength > bytes.length) throw new Error("Invalid GLB: JSON chunk runs past the end.");
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;

    // CHUNKS ARE 4-BYTE ALIGNED and the padding is counted in the declared length, so walking by
    // `8 + length` is right — but only if each length is checked against what remains first.
    let bin: Uint8Array | null = null;
    let at = 20 + jsonLength;
    while (at + 8 <= bytes.length) {
        const length = view.getUint32(at, true);
        const type = view.getUint32(at + 4, true);
        if (at + 8 + length > bytes.length) break;
        if (type === CHUNK_BIN) { bin = bytes.subarray(at + 8, at + 8 + length); break; }
        at += 8 + length;
    }
    return { json, bin };
}

/** What went wrong with a glTF document, or null. */
export function gltfError(json: unknown): string | null {
    if (!json || typeof json !== "object") return "a glTF must be an object";
    const g = json as GltfJson;
    const version = g.asset?.version;
    if (version === undefined) return "not a glTF: no asset version";
    // 1.0 is a DIFFERENT format wearing the same name — its meshes, materials and shaders are laid
    // out unrecognisably — so it is refused rather than half-read into something plausible.
    if (!version.startsWith("2.")) return `glTF version ${version} is not supported`;
    // REQUIRED means the file states that ignoring it changes the picture — so anything that could
    // touch the geometry is refused BY NAME rather than read into something plausible. The
    // material-only ones are listed above, with the reason they are safe for a geometry read.
    const required = (g.extensionsRequired ?? []).filter(e => !GLTF_IGNORABLE_REQUIRED.includes(e));
    if (required.length > 0) return `requires extensions this does not implement: ${required.join(", ")}`;
    const primitives = (g.meshes ?? []).reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
    if (primitives > GLTF_MAX_PRIMITIVES) return `${primitives} primitives is more than this reads`;
    return null;
}

/**
 * One accessor's numbers, honouring the interleaving.
 *
 * THE STRIDE IS THE WHOLE POINT. When a bufferView declares one, consecutive elements sit that many
 * bytes apart with other attributes in between; when it does not, they are packed end to end. 9,596
 * bufferViews in the tree declare one, so the packed path is the exception here rather than the
 * rule, and a reader that only implemented it would be wrong about almost every file while
 * producing perfectly well-formed output.
 */
export function readAccessor(json: GltfJson, index: number, buffer: Uint8Array): Float64Array | null {
    const accessor = (json.accessors ?? [])[index];
    if (!accessor) return null;
    // A SPARSE accessor overlays substitute values on a base; ignoring that yields the unmodified
    // base, which is a shape that looks right and is not. None appear in the tree, so it is refused
    // rather than guessed at.
    if (accessor.sparse) return null;
    const components = TYPE_COMPONENTS[accessor.type];
    const componentSize = COMPONENT_BYTES[accessor.componentType];
    if (!components || !componentSize) return null;
    if (accessor.count > GLTF_MAX_VERTICES) return null;

    const view = (json.bufferViews ?? [])[accessor.bufferView ?? -1];
    if (!view) return null;
    // BOTH offsets: the accessor's into the view, and the view's into the buffer.
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const elementSize = components * componentSize;
    const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : elementSize;
    if (base + (accessor.count - 1) * stride + elementSize > buffer.length) return null;

    const data = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const out = new Float64Array(accessor.count * components);
    for (let i = 0; i < accessor.count; i++) {
        const at = base + i * stride;
        for (let c = 0; c < components; c++) {
            const o = at + c * componentSize;
            let v: number;
            switch (accessor.componentType) {
                case 5120: v = data.getInt8(o); break;
                case 5121: v = data.getUint8(o); break;
                case 5122: v = data.getInt16(o, true); break;
                case 5123: v = data.getUint16(o, true); break;
                case 5125: v = data.getUint32(o, true); break;
                default: v = data.getFloat32(o, true); break;
            }
            // NORMALIZED integers stand for a fraction, so a byte of 255 means 1 and not 255. A
            // reader that skipped this would put UVs in the thousands and light nothing correctly.
            if (accessor.normalized) {
                if (accessor.componentType === 5121) v /= 255;
                else if (accessor.componentType === 5123) v /= 65535;
                else if (accessor.componentType === 5120) v = Math.max(v / 127, -1);
                else if (accessor.componentType === 5122) v = Math.max(v / 32767, -1);
            }
            out[i * components + c] = v;
        }
    }
    return out;
}

/** Column-major 4x4 multiply, `a` then `b` — the order a child composes onto its parent. */
export function multiplyMat4(a: readonly number[], b: readonly number[]): number[] {
    const out = new Array<number>(16).fill(0);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

/**
 * A node's own transform.
 *
 * A node states EITHER a matrix or a translation/rotation/scale triple, never both, and the triple
 * composes as T*R*S in that order — 4,693 nodes in the tree use the triple and none uses a matrix,
 * but both are read because the format allows both and a file using one is not exotic.
 */
export function nodeMatrix(node: GltfNode): number[] {
    if (node.matrix && node.matrix.length === 16) return [...node.matrix];
    const [tx, ty, tz] = node.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale ?? [1, 1, 1];
    // The rotation is a QUATERNION, and its w is LAST — a reader taking it first produces a model
    // rotated by a plausible-looking wrong amount rather than an error.
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        tx, ty, tz, 1
    ];
}

/** One primitive's arrays, or null when it cannot be read exactly. */
function readPrimitive(
    json: GltfJson, prim: GltfPrimitiveJson, buffer: Uint8Array, notes: string[]
): GltfPrimitive | null {
    const mode = prim.mode ?? MODE_TRIANGLES;
    if (mode !== MODE_TRIANGLES) {
        // NAMED rather than silently skipped: a model missing a third of itself with no explanation
        // reads as a broken exporter. Every one of the 9,190 primitives in the tree is triangles.
        notes.push(`a primitive draws ${MODE_NAMES[mode] ?? `mode ${mode}`}, which this does not read`);
        return null;
    }
    if (prim.targets) notes.push("a primitive carries morph targets, which are not applied");

    const positionIndex = prim.attributes?.POSITION;
    if (positionIndex === undefined) { notes.push("a primitive has no POSITION"); return null; }
    const positions = readAccessor(json, positionIndex, buffer);
    if (!positions) { notes.push("a primitive's POSITION could not be read"); return null; }

    const normalIndex = prim.attributes.NORMAL;
    const uvIndex = prim.attributes.TEXCOORD_0;
    const normals = normalIndex === undefined ? null : readAccessor(json, normalIndex, buffer);
    const uvs = uvIndex === undefined ? null : readAccessor(json, uvIndex, buffer);

    let indices: Uint32Array;
    if (prim.indices === undefined) {
        // A NON-INDEXED primitive is every three vertices in order. Giving it the implied indices
        // means one downstream path instead of two, and the two would drift.
        const count = positions.length / 3;
        indices = new Uint32Array(count);
        for (let i = 0; i < count; i++) indices[i] = i;
    } else {
        const raw = readAccessor(json, prim.indices, buffer);
        if (!raw) { notes.push("a primitive's indices could not be read"); return null; }
        indices = Uint32Array.from(raw);
    }

    return {
        positions: Float32Array.from(positions),
        normals: normals ? Float32Array.from(normals) : null,
        uvs: uvs ? Float32Array.from(uvs) : null,
        indices,
        material: prim.material ?? null
    };
}

/**
 * The model's primitives, each with the world matrix of the node that placed it.
 *
 * Throws on anything `gltfError` refuses. `buffer` is the bytes a `.glb` carried or a caller
 * resolved for a `.gltf` — this never reaches for a file.
 */
export function parseGltf(json: GltfJson, buffer: Uint8Array): GltfResult {
    const bad = gltfError(json);
    if (bad) throw new Error(`Invalid glTF: ${bad}.`);
    const notes: string[] = [];
    const instances: GltfMeshInstance[] = [];
    const nodes = json.nodes ?? [];
    const meshes = json.meshes ?? [];

    // The named scene, or the first — a file with several states which one it opens with, and
    // drawing all of them would stack alternate versions of a model on top of each other.
    const scenes = json.scenes ?? [];
    const scene = scenes[json.scene ?? 0] ?? scenes[0];
    const roots = scene?.nodes ?? nodes.map((_, i) => i);

    const seen = new Set<number>();
    const walk = (index: number, parent: number[], depth: number): void => {
        if (depth > GLTF_MAX_NODE_DEPTH) { notes.push("node hierarchy is deeper than this walks"); return; }
        // A CYCLE would otherwise recur until the stack gives out. The format forbids one; a
        // hand-edited file does not have to obey.
        if (seen.has(index)) { notes.push("node hierarchy revisits a node"); return; }
        const node = nodes[index];
        if (!node) return;
        seen.add(index);
        const world = multiplyMat4(parent, nodeMatrix(node));
        const mesh = node.mesh === undefined ? undefined : meshes[node.mesh];
        if (mesh) {
            for (const prim of mesh.primitives ?? []) {
                const read = readPrimitive(json, prim, buffer, notes);
                if (read) instances.push({ name: node.name ?? mesh.name ?? "mesh", matrix: world, primitive: read });
            }
        }
        for (const child of node.children ?? []) walk(child, world, depth + 1);
        seen.delete(index);
    };
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const root of roots) walk(root, identity, 0);

    const used = json.extensionsUsed ?? [];
    // USED extensions change the picture too, just not so much that the file refuses to load
    // without them — 3,711 files transform their UVs and 1,565 skip lighting. Naming them is the
    // difference between a caller knowing what it got and assuming it got everything.
    for (const name of used) notes.push(`uses ${name}, which is read as its unextended equivalent`);
    // A REQUIRED extension that was ignored is said louder than a used one: the file declared that
    // ignoring it changes the picture, and this read it anyway on the grounds that it cannot change
    // the geometry. That reasoning has to be visible to whoever gets the result.
    for (const name of json.extensionsRequired ?? []) {
        notes.push(`REQUIRES ${name}, ignored because it cannot affect geometry`);
    }
    if (json.buffers && json.buffers.length > 1) notes.push("only the first buffer is read");

    return {
        generator: json.asset?.generator ?? "",
        instances,
        extensions: [...used],
        notes
    };
}
