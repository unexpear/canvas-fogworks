/**
 * @module AddNodeAction
 * @description Creates a new node in the document.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node, NodeType, PathCommand, isNodeType, dimensionError, nodeIdError, pathError, srcError } from "../document/Node";
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
        content?: NodeContent
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
        if (this.content?.text !== undefined && typeof this.content.text !== "string") {
            return false;
        }
        // Same rule the loader applies (schema 23): only an image may carry a src, and it must
        // be a bounded string with a scheme a renderer could draw.
        if (this.content?.src !== undefined && srcError(this.nodeType, this.content.src) !== null) {
            return false;
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
            style: { fill: this.fill, opacity: 1 },
            layout: {}
        };
        // Copied, not aliased: the caller's array must not become the document's.
        if (this.content?.text !== undefined) node.text = this.content.text;
        if (this.content?.path !== undefined) node.path = this.content.path.map(c => ({ ...c }));
        if (this.content?.src !== undefined) node.src = this.content.src;

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
