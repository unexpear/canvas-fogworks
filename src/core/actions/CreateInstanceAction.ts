/**
 * @module CreateInstanceAction
 * @description Creates a `core.instance` node pointing at a MASTER node (Milestone 6).
 *
 * The write-path primitive for components: an instance is an ordinary node carrying
 * `componentId`, so it inherits every existing mechanism (undo, transactions, geometry,
 * serialization). Resolution — materializing the master's subtree beneath it — happens in the
 * pure `expandInstances` pass at compute time; nothing is copied into the document, so a
 * master edit is reflected by every instance on the next frame.
 *
 * The instance's own size DEFAULTS to the master's box, so a fresh instance looks exactly like
 * its master; callers may supply a different initial size, and child geometry overrides remain
 * available after creation.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { Node, dimensionError, nodeIdError } from "../document/Node";
import { componentError } from "../document/Components";
import { MutationResult, ActionPayload } from "./types";
import { generateUUID } from "../ids/UUID";

export class CreateInstanceAction extends Action {
    private masterId: string;
    private x: number;
    private y: number;
    private explicitId: string | null;
    private parentId: string | null;
    private createdNodeId: string | null = null;

    constructor(
        document: ReadonlyDocument,
        masterId: string,
        x: number,
        y: number,
        id?: string,
        parentId?: string | null
    ) {
        super(document);
        this.masterId = masterId;
        this.x = x;
        this.y = y;
        this.explicitId = id ?? null;
        this.parentId = parentId ?? null;
    }

    public validate(): boolean {
        // The MASTER must exist at creation time (unlike a dangling reference at rest, which
        // stays valid): authoring an instance of nothing is a caller bug, not a document state.
        const master = this.document.nodes.get(this.masterId);
        if (!master) return false;
        // Instancing a node that is itself an instance would nest a reference rather than the
        // content — allowed by the resolver (it recurses, capped) but confusing to author, so
        // the edit path requires a concrete master.
        if (master.type === "core.instance") return false;
        if (this.explicitId !== null && this.document.nodes.has(this.explicitId)) return false;
        if (this.explicitId !== null && nodeIdError(this.explicitId) !== null) return false;
        if (this.parentId !== null && !this.document.nodes.has(this.parentId)) return false;
        if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) return false;
        // The instance's box is the master's, so it must satisfy the same per-type rule the
        // load path enforces — shared `dimensionError`, checked for the INSTANCE type.
        if (dimensionError("core.instance", master.geometry.width, master.geometry.height) !== null) return false;
        return componentError("core.instance", this.masterId) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: cannot instance master "${this.masterId}".`);
        }
        const master = this.document.nodes.get(this.masterId)!;
        // Reuse the id across re-executions (a redo must not mint a new node).
        const nodeId = this.createdNodeId ?? this.explicitId ?? generateUUID();
        this.createdNodeId = nodeId;

        const node: Node = {
            id: nodeId,
            type: "core.instance",
            parent: this.parentId,
            children: [],
            geometry: { x: this.x, y: this.y, width: master.geometry.width, height: master.geometry.height },
            // The instance draws nothing itself; a style is required by the schema, so carry a
            // neutral one (the materialized copies keep their own).
            style: { fill: "none", opacity: 1 },
            layout: {},
            componentId: this.masterId,
            name: master.name ? `${master.name} instance` : undefined
        };

        return {
            updatedNodeIds: new Set([nodeId]),
            propertyDeltas: new Map([[nodeId, { kind: "add", node } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "CreateInstanceAction",
            payload: { nodeId: this.createdNodeId, masterId: this.masterId, x: this.x, y: this.y, parentId: this.parentId },
            timestamp: Date.now()
        };
    }

    /** The id of the node this action created (null before `execute`). */
    public getCreatedNodeId(): string | null {
        return this.createdNodeId;
    }
}
