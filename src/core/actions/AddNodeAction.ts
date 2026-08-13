/**
 * @module AddNodeAction
 * @description Creates a new node in the document.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node, NodeType, PathCommand, Style, RasterSurface, isNodeType, dimensionError, nodeIdError, pathError, rasterSurfaceError, srcError, styleError } from "../document/Node";
import { Tilemap, tilemapError, emptyTilemap } from "../document/Tilemap";
import { MutationResult, ActionPayload } from "./types";
import { generateUUID } from "../ids/UUID";

/**
 * The CONTENT a created node carries beyond its box: the text a `core.text` renders, or the
 * commands a `core.path` is drawn from. Both are optional — a node without them is the plain
 * box every caller before this created.
 *
 * `path` is why this exists: until now nothing on the EDIT path could author path commands
 * (they arrived only by loading a file), so `pathError` had exactly one call site, the loader.
 * A shared validator with only one caller is a validator waiting to drift.
 */
export interface NodeContent {
    text?: string;
    path?: readonly PathCommand[];
    /** A `core.image`'s source — a URL, or a `data:` URL for a file the user picked. */
    src?: string;
    /**
     * A `core.raster`'s pixels, as `PixelCodec` encodes them.
     *
     * A RASTER MUST BE BORN WITH ONE. Every other content field is optional decoration on a node
     * that is already visible — a path without commands is an empty box, an image without a src is
     * a blank frame. A raster without a surface is not a smaller picture, it is a node nothing can
     * paint: `PaintSurfaceAction.validate` refuses it, so the node would exist and be permanently
     * inert. Creating it and giving it pixels must therefore be one act.
     */
    surface?: RasterSurface;
    /**
     * A `core.tilemap`'s grid (schema 61).
     *
     * BORN WITH ONE, for exactly the reason a raster is born with its surface: `Integrity` refuses
     * a tilemap node without a grid, so a node created without one could be made but never saved.
     * A caller that supplies nothing gets an empty grid rather than an invalid node.
     */
    tilemap?: Tilemap;
}

export class AddNodeAction extends Action {
    private nodeType: NodeType;
    private x: number;
    private y: number;
    private width: number;
    private height: number;
    private fill: string;
    private explicitId: string | null;
    private parentId: string | null;
    private content: NodeContent | null;
    private stroke: string | undefined;
    private strokeWidth: number | string | undefined;
    private createdNodeId: string | null = null;

    constructor(
        document: ReadonlyDocument,
        nodeType: NodeType,
        x: number,
        y: number,
        width: number,
        height: number,
        fill: string = "#cccccc",
        id?: string,
        parentId?: string | null,
        content?: NodeContent,
        /** Border colour. Absent = no stroke. An OUTLINE shape is `fill: "none"` plus this. */
        stroke?: string,
        /** Border thickness in WORLD units (schema 25). Absent = the hairline default. */
        strokeWidth?: number | string
    ) {
        super(document);
        this.nodeType = nodeType;
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.fill = fill;
        this.explicitId = id ?? null;
        this.parentId = parentId ?? null;
        this.content = content ?? null;
        this.stroke = stroke;
        this.strokeWidth = strokeWidth;
    }

    /** The style the created node gets: a fill, full opacity, and a stroke when one was asked
     *  for. An OUTLINE shape is just `fill: "none"` with a stroke — no new field needed. */
    private style(): Style {
        return {
            fill: this.fill, opacity: 1,
            ...(this.stroke !== undefined ? { stroke: this.stroke } : {}),
            ...(this.strokeWidth !== undefined ? { strokeWidth: this.strokeWidth } : {})
        };
    }

    public validate(): boolean {
        // An explicit id must not collide with an existing node, or the add
        // would silently replace it (and orphan its child links).
        if (this.explicitId !== null && this.document.nodes.has(this.explicitId)) {
            return false;
        }
        // Reserved ids (shared with the load path via `nodeIdError`): the document-delta
        // sentinel would collide with doc-level deltas in the node-id-keyed map, and an id
        // containing "::" would collide with a component instance's virtual copies.
        if (this.explicitId !== null && nodeIdError(this.explicitId) !== null) {
            return false;
        }
        // A requested parent must actually exist.
        if (this.parentId !== null && !this.document.nodes.has(this.parentId)) {
            return false;
        }
        // Content obeys the rules the LOAD path applies to the same fields: `pathError` (shared)
        // rejects commands on a non-path node, a list that does not start with `M`, non-finite
        // coordinates, and an over-long one. Without this the editor could author a node the
        // loader refuses — the round-trip-closure rule this codebase is built on.
        if (this.content?.path !== undefined && pathError(this.nodeType, this.content.path) !== null) {
            return false;
        }
        // The assembled style obeys the SAME rule an edit to it would (UpdateNodeStyleAction and
        // Integrity both run `styleError`) — until now a created node's style was never checked.
        if (styleError(this.style()) !== null) return false;
        if (this.content?.text !== undefined && typeof this.content.text !== "string") {
            return false;
        }
        // Same rule the loader applies (schema 23): only an image may carry a src, and it must
        // be a bounded string with a scheme a renderer could draw.
        if (this.content?.src !== undefined && srcError(this.nodeType, this.content.src) !== null) {
            return false;
        }
        // ONLY A RASTER MAY CARRY A SURFACE, and it must be one the loader would accept — the same
        // rule `PaintSurfaceAction` enforces on every later stroke. Without this the editor could
        // author a node it cannot reopen, which is the round-trip-closure rule this codebase is
        // built on; and a surface on a rectangle would be a field no renderer looks at.
        if (this.content?.surface !== undefined) {
            if (this.nodeType !== "core.raster") return false;
            if (rasterSurfaceError(this.content.surface) !== null) return false;
        }
        if (this.content?.tilemap !== undefined) {
            if (this.nodeType !== "core.tilemap") return false;
            if (tilemapError(this.content.tilemap) !== null) return false;
        }
        return (
            // Membership, not just non-empty: TypeScript alone does not stop a cast,
            // a plugin (M15) or an AI-emitted action (M14) from supplying a bogus
            // type — and the LOAD path rejects it, so without this the engine can
            // author a document it cannot reopen.
            isNodeType(this.nodeType) &&
            Number.isFinite(this.x) && Number.isFinite(this.y) &&
            // Shared with the load path (per-type: a line may collapse one axis).
            dimensionError(this.nodeType, this.width, this.height) === null
        );
    }

    public execute(): MutationResult {
        // Self-validate like every sibling action, so a corrupt node can never be
        // produced by a caller that skips the dispatcher's validate() gate.
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid node parameters for type "${this.nodeType}".`);
        }
        this.createdNodeId = this.explicitId ?? generateUUID();

        const node: Node = {
            id: this.createdNodeId,
            type: this.nodeType,
            parent: this.parentId,
            children: [],
            geometry: { x: this.x, y: this.y, width: this.width, height: this.height },
            style: this.style(),
            layout: {}
        };
        // Copied, not aliased: the caller's array must not become the document's.
        if (this.content?.text !== undefined) node.text = this.content.text;
        if (this.content?.path !== undefined) node.path = this.content.path.map(c => ({ ...c }));
        if (this.content?.src !== undefined) node.src = this.content.src;
        // Copied field-by-field rather than aliased, for the same reason `path` is: the caller's
        // object must not become the document's.
        if (this.content?.surface !== undefined) {
            node.surface = { ...this.content.surface };
        }
        // THE GRID, deep-copied for the same reason: `tiles` is an array the caller still holds.
        // A tilemap node with none gets the empty default rather than being born unsaveable.
        if (this.nodeType === "core.tilemap") {
            const given = this.content?.tilemap;
            node.tilemap = given
                ? { ...given, tiles: [...given.tiles] }
                : emptyTilemap();
        }

        return {
            updatedNodeIds: new Set([this.createdNodeId]),
            propertyDeltas: new Map([[this.createdNodeId, { kind: "add", node } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "AddNodeAction",
            payload: {
                nodeType: this.nodeType,
                x: this.x,
                y: this.y,
                width: this.width,
                height: this.height,
                fill: this.fill,
                stroke: this.stroke,
                strokeWidth: this.strokeWidth,
                parentId: this.parentId,
                content: this.content
            },
            timestamp: Date.now()
        };
    }

    public getCreatedNodeId(): string | null {
        return this.createdNodeId;
    }
}
