/**
 * @module MeshData
 * @description What every 3D reader produces, so there is one shape downstream rather than several.
 *
 * glTF and OBJ describe geometry very differently — one is a binary buffer with strides, the other
 * is text with three independent index streams — but what a renderer needs from either is the same
 * four arrays. Naming that once means a mesh node, a picker and a GPU path are each written once.
 *
 * TWO NEARLY-IDENTICAL TYPES ARE HOW THE DRIFT STARTS. If each reader declared its own primitive,
 * the first field one of them gained would be the field the other quietly lacked, and every
 * consumer would grow a branch per format. FBX is still to come and will produce this too.
 */

/** One drawable run of triangles, in its own local space. */
export interface MeshPrimitive {
    /** Flat xyz triples. */
    positions: Float32Array;
    /**
     * Flat xyz triples, or null when the source states none.
     *
     * UNIT LENGTH is guaranteed here, and is not guaranteed by every source. glTF's spec requires
     * it and its files honour it; OBJ's does not, and 206 measured files carry normals of length
     * exactly 0.1 — correct directions at a tenth scale. A renderer that trusts the invariant would
     * light those surfaces a tenth as brightly, so the reader that knows its format is loose is the
     * one that fixes it. A ZERO normal stays zero: it has no direction to preserve.
     */
    normals: Float32Array | null;
    /** Flat uv pairs, or null. */
    uvs: Float32Array | null;
    /**
     * Triangle indices, three per face. ALWAYS present: a source with no indices of its own is
     * given the implied `0..n-1`, so consumers have one path rather than two that can drift.
     */
    indices: Uint32Array;
    /**
     * Which material this run uses, as the source names it — an index for glTF, a name for OBJ, and
     * null for neither. REPORTED rather than resolved, because resolving needs a filesystem.
     */
    material: number | string | null;
}

/** A primitive placed in a scene. */
export interface MeshInstance {
    /** Whatever the source called it, for naming a layer something meaningful. */
    name: string;
    /**
     * Column-major 4x4, the product of every transform from the scene root down.
     *
     * OBJ has no hierarchy and always supplies the identity; keeping the field rather than making
     * it optional is what lets one consumer place both formats.
     */
    matrix: number[];
    primitive: MeshPrimitive;
}

/** The identity, which a reader with no transforms of its own hands back. */
export const MESH_IDENTITY: readonly number[] =
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
