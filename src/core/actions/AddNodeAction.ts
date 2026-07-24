/**
 * @module AddNodeAction
 * @description Creates a new node in the document.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node, NodeType, isNodeType } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";
import { generateUUID } from "../ids/UUID";

export class AddNodeAction extends Action {
    private nodeType: NodeType;
    private x: number;
    private y: number;
    private width: number;
    private height: number;
    private fill: string;
    private explicitId: string | null;
    private parentId: string | null;
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
        parentId?: string | null
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
    }

    public validate(): boolean {
        // An explicit id must not collide with an existing node, or the add
        // would silently replace it (and orphan its child links).
        if (this.explicitId !== null && this.document.nodes.has(this.explicitId)) {
            return false;
        }
        // A requested parent must actually exist.
        if (this.parentId !== null && !this.document.nodes.has(this.parentId)) {
            return false;
        }
        return (
            // Membership, not just non-empty: TypeScript alone does not stop a cast,
            // a plugin (M15) or an AI-emitted action (M14) from supplying a bogus
            // type — and the LOAD path rejects it, so without this the engine can
            // author a document it cannot reopen.
            isNodeType(this.nodeType) &&
            Number.isFinite(this.x) && Number.isFinite(this.y) &&
            this.width > 0 && this.height > 0 &&
            Number.isFinite(this.width) && Number.isFinite(this.height)
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
                parentId: this.parentId
            },
            timestamp: Date.now()
        };
    }

    public getCreatedNodeId(): string | null {
        return this.createdNodeId;
    }
}
