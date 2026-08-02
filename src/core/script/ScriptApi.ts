/**
 * @module ScriptApi
 * @description The scripting boundary (Milestone 15) — the one place a script's intentions become
 * document changes.
 *
 * The architectural commitment `ACTION-SYSTEM.md` has carried since M1 is that a plugin "can only
 * ever emit Actions — it cannot corrupt the document or bypass history". This module is that
 * sentence made mechanical, and its shape is chosen so the guarantee does not rest on the
 * sandbox being perfect:
 *
 *   1. A script never receives the document. It receives a SNAPSHOT: plain, frozen data with no
 *      functions, no prototypes worth reaching through, and no reference back to anything live.
 *   2. A script never receives an Action, a dispatcher, or a node. It returns REQUESTS: plain
 *      data naming an operation and its arguments.
 *   3. The host compiles requests into real Actions here, validating each against the SAME shared
 *      validators the loader and the inspector use. A request naming a node that does not exist,
 *      a geometry the schema refuses, or an operation that is not on the list, is dropped.
 *
 * So the worst a compromised script can do is ask for edits a person could have made by hand —
 * and every one of them lands as one undoable transaction. Everything crossing the boundary is
 * JSON, which is also what makes the boundary testable without a sandbox at all.
 */

import { Action } from "../actions/Action";
import { AddNodeAction } from "../actions/AddNodeAction";
import { DeleteNodeAction } from "../actions/DeleteNodeAction";
import { TransactionAction } from "../actions/TransactionAction";
import { UpdateNodeContentAction } from "../actions/UpdateNodeContentAction";
import { UpdateNodeGeometryAction } from "../actions/UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "../actions/UpdateNodeStyleAction";
import { ReadonlyDocument } from "../document/Document";
import { isNodeType, NodeType, Style } from "../document/Node";
import { resolveScene } from "../document/Components";

/** How many requests one run may produce — a script is a program, so it needs a bound. */
export const SCRIPT_MAX_REQUESTS = 10_000;

/** One node as a script sees it: plain data, no methods, no live reference. */
export interface ScriptNode {
    id: string;
    type: string;
    name: string | null;
    parent: string | null;
    children: string[];
    x: number;
    y: number;
    width: number;
    height: number;
    fill: string;
    opacity: number;
    text: string | null;
}

/** What a script is given. Frozen, so a script cannot even mutate its own copy misleadingly. */
export interface ScriptSnapshot {
    nodes: ScriptNode[];
}

/**
 * The document as plain data, taken from the RESOLVED scene — a script sees what is on screen,
 * including an instance's materialized copies, which is what "the nodes" means to someone
 * looking at the canvas. Requests naming a virtual id are refused later by the compiler, because
 * a copy has no stored identity to edit; that refusal belongs there, not here.
 */
export function snapshotFor(doc: ReadonlyDocument): ScriptSnapshot {
    const scene = resolveScene(doc);
    const nodes: ScriptNode[] = [];
    scene.nodes.forEach((n, id) => {
        nodes.push(Object.freeze({
            id,
            type: n.type,
            name: n.name ?? null,
            parent: n.parent ?? null,
            children: Object.freeze([...n.children]) as string[],
            x: n.geometry.x, y: n.geometry.y, width: n.geometry.width, height: n.geometry.height,
            fill: n.style.fill, opacity: n.style.opacity,
            text: n.text ?? null
        }));
    });
    return Object.freeze({ nodes: Object.freeze(nodes) as ScriptNode[] });
}

/** Everything a script may ask for. Adding a case here is the ONLY way to widen the surface. */
export type ActionRequest =
    | { op: "move"; id: string; x: number; y: number }
    | { op: "resize"; id: string; width: number; height: number }
    | { op: "style"; id: string; style: Partial<Style> }
    | { op: "text"; id: string; text: string }
    | { op: "create"; nodeType: string; x: number; y: number; width: number; height: number; fill?: string }
    | { op: "delete"; id: string };

/**
 * Shape check for one request — the gate BEFORE anything touches the document.
 *
 * Only the shape is checked here; whether the values are legal is the shared validators' job,
 * inside each Action. Splitting it that way is deliberate: this function cannot drift from the
 * schema because it does not restate it.
 */
export function actionRequestError(req: unknown): string | null {
    if (typeof req !== "object" || req === null || Array.isArray(req)) return "each request must be an object";
    const r = req as Record<string, unknown>;
    // No separate membership check against a list of operations: the switch below already ends
    // in a `default` that refuses anything it does not name, and a second list would be a copy
    // to keep in step — provably equivalent to nothing, which a mutation of it demonstrated.
    const num = (k: string): boolean => typeof r[k] === "number" && Number.isFinite(r[k] as number);
    const id = (): boolean => typeof r.id === "string" && r.id.length > 0;
    switch (r.op) {
        case "move": return id() && num("x") && num("y") ? null : "move needs id, x, y";
        case "resize": return id() && num("width") && num("height") ? null : "resize needs id, width, height";
        case "style": return id() && typeof r.style === "object" && r.style !== null && !Array.isArray(r.style)
            ? null : "style needs id and a style object";
        case "text": return id() && typeof r.text === "string" ? null : "text needs id and a string";
        case "create": return isNodeType(r.nodeType) && num("x") && num("y") && num("width") && num("height")
            ? null : "create needs a known nodeType, x, y, width, height";
        case "delete": return id() ? null : "delete needs id";
        default: return `unknown operation "${String(r.op)}"`;
    }
}

/** The result of compiling a script's requests: what will run, and what was refused and why. */
export interface CompiledScript {
    action: Action | null;
    /** One line per dropped request — surfaced to the author, never silently swallowed. */
    refusals: string[];
}

/**
 * Compile requests into ONE transaction — the whole run is one undo, because a script that half
 * ran is worse than one that did not.
 *
 * Every refusal is REPORTED rather than thrown: a script is written by a person who needs to know
 * which line did nothing, and a single bad request must not discard the good ones. The one thing
 * that is never negotiable is that a request cannot reach the document except as an Action the
 * host constructed.
 */
export function compileScript(
    doc: ReadonlyDocument,
    requests: readonly unknown[],
    newId: () => string
): CompiledScript {
    const refusals: string[] = [];
    if (requests.length > SCRIPT_MAX_REQUESTS) {
        return { action: null, refusals: [`a script may make at most ${SCRIPT_MAX_REQUESTS} requests`] };
    }

    const actions: Action[] = [];
    requests.forEach((raw, i) => {
        const shapeError = actionRequestError(raw);
        if (shapeError) { refusals.push(`#${i}: ${shapeError}`); return; }
        const req = raw as ActionRequest;

        // A STORED node is the only editable target. An instance's copy has no stored identity —
        // editing one means writing an override, which is a different operation with different
        // rules, and inventing it here would let a script reach through a component silently.
        if (req.op !== "create" && !doc.nodes.has(req.id)) {
            refusals.push(`#${i}: no editable node "${req.id}"`);
            return;
        }

        const action = buildOne(doc, req, newId);
        if (!action) { refusals.push(`#${i}: ${req.op} refused (invalid for that node)`); return; }
        actions.push(action);
    });

    return { action: actions.length > 0 ? new TransactionAction(doc, "script", actions) : null, refusals };
}

/** One request as an Action, or null when the Action's own validator refuses it. */
function buildOne(doc: ReadonlyDocument, req: ActionRequest, newId: () => string): Action | null {
    let action: Action;
    switch (req.op) {
        case "move":
            action = new UpdateNodeGeometryAction(doc, req.id, { x: req.x, y: req.y });
            break;
        case "resize":
            action = new UpdateNodeGeometryAction(doc, req.id, { width: req.width, height: req.height });
            break;
        case "style":
            action = new UpdateNodeStyleAction(doc, req.id, req.style);
            break;
        case "text":
            action = new UpdateNodeContentAction(doc, req.id, { text: req.text });
            break;
        case "create":
            action = new AddNodeAction(doc, req.nodeType as NodeType, req.x, req.y, req.width, req.height,
                req.fill ?? "#cccccc", newId());
            break;
        case "delete":
            action = new DeleteNodeAction(doc, req.id);
            break;
    }
    // The Action's OWN validator has the last word — the same one the inspector and the loader
    // run. A script therefore cannot author anything a person could not, and this file needs no
    // copy of the schema's rules to enforce that.
    return action.validate() ? action : null;
}
