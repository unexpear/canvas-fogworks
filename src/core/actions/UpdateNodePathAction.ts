/**
 * @module UpdateNodePathAction
 * @description Sets a `core.path` node's drawing commands — the write path `Node.path` never had.
 *
 * `core.path` arrived at schema 17 with validation, both render backends and round-tripping, but
 * no action could ever set the field: a path could only enter a document by hand-editing a file.
 * `pathError`'s own doc comment recorded that gap, waiting for "a future pen/import action". This
 * is it, and an SVG importer will use the same one — normalizing foreign `d` data into
 * `PathCommand[]` is a translation problem, not a second write path.
 *
 * The commands are LOCAL to the node's box, so a pen (which draws in world space) re-bases them
 * with `PathBuilder.penNodeFrom` before dispatching. Validation is the shared `pathError`, the
 * same rule the loader runs, so this cannot author a path a reload would refuse.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { PathCommand, pathError } from "../document/Node";
import { MutationResult, ActionPayload } from "./types";

export class UpdateNodePathAction extends Action {
    private nodeId: string;
    private path: PathCommand[];

    constructor(document: ReadonlyDocument, nodeId: string, path: PathCommand[]) {
        super(document);
        this.nodeId = nodeId;
        this.path = path;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.nodeId);
        if (!node) return false;
        // `pathError` is type-aware — it refuses path data on anything but a `core.path` — so
        // this needs no separate type check, and cannot drift from the loader's rule.
        return pathError(node.type, this.path) === null;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: invalid path for node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            // A whole-array replace: a path is edited as a shape, not field by field, and a
            // partial merge of two command lists has no meaning.
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", path: this.path } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return { actionId: "UpdateNodePathAction", payload: { nodeId: this.nodeId, path: this.path }, timestamp: Date.now() };
    }
}
