/**
 * @module SetTilemapAction
 * @description A tile edit, through the dispatcher — a stroke, a fill, or a resize.
 *
 * This is what makes painting tiles part of the document rather than beside it, exactly as
 * `PaintSurfaceAction` does for pixels: validated, undoable, transactable, serializable.
 *
 * THE WHOLE GRID TRAVELS, unlike a stroke's pixel patch — and the difference is arithmetic, not
 * taste. A 4096-square RGBA surface is 67MB, so a per-stroke copy of one would make twenty pencil
 * dots cost gigabytes; the corpus's largest grid is 10,000 small integers, and the cap is a million.
 * Carrying the whole array keeps the delta protocol's existing rule — a patch field is a whole value
 * — and means the stored document always describes its own map with nothing to replay.
 *
 * THE CALLER COMPUTES THE NEXT MAP, which is the opposite of `PaintSurfaceAction`'s arrangement, and
 * for a reason: there the payload is an ENCODING of the patch, so computing it twice could disagree,
 * while here the next map IS the value. `TilemapEdit` is where the rules live, this checks that what
 * arrived can be stored, and neither duplicates the other.
 */

import { Action } from "./Action";
import { ReadonlyDocument } from "../document/Document";
import { ReadonlyTilemap, Tilemap, tilemapError } from "../document/Tilemap";
import { MutationResult, ActionPayload } from "./types";

export class SetTilemapAction extends Action {
    private nodeId: string;
    private next: Tilemap;

    constructor(document: ReadonlyDocument, nodeId: string, next: Tilemap) {
        super(document);
        this.nodeId = nodeId;
        this.next = next;
    }

    public validate(): boolean {
        const node = this.document.nodes.get(this.nodeId);
        if (!node) return false;
        // A tilemap node is the only thing that HAS a grid. Redundant with the check below, and kept
        // for the reason `PaintSurfaceAction` keeps its type test: "only a tilemap node is paintable"
        // is a rule, while "nothing else happens to carry that field" is a fact that could change.
        if (node.type !== "core.tilemap") return false;
        if (!node.tilemap) return false;
        // THE DOCUMENT'S OWN VALIDATOR, so an edit cannot author a grid the loader would refuse —
        // the same rule the importer submits to. A tool computing `cols * rows` cells and writing
        // one fewer would otherwise produce a file that opens as corrupt art.
        if (tilemapError(this.next) !== null) return false;
        // A NO-OP IS INVALID, not harmless: it would put an undo step on the stack that undoes
        // nothing, so a person pressing undo once appears to have been ignored. `TilemapEdit`
        // returns null rather than an unchanged map for the same reason, so a caller using it
        // cannot reach this; a caller assembling a grid by hand can.
        if (sameMap(node.tilemap, this.next)) return false;
        return true;
    }

    public execute(): MutationResult {
        if (!this.validate()) {
            throw new Error(`Validation failed: cannot set the tilemap of node "${this.nodeId}".`);
        }
        return {
            updatedNodeIds: new Set([this.nodeId]),
            propertyDeltas: new Map([[this.nodeId, { kind: "patch", tilemap: this.next } as const]]),
            success: true
        };
    }

    public serialize(): ActionPayload {
        return {
            actionId: "SetTilemapAction",
            payload: {
                nodeId: this.nodeId,
                // THE CELLS ARE DELIBERATELY ABSENT, as a stroke's pixels are: an action log is for
                // replay and diagnosis, and ten thousand indices per edit would drown it. The size
                // and how many cells are filled is what identifies the edit; the grid is in the
                // document.
                tilemap: {
                    cols: this.next.cols, rows: this.next.rows,
                    filled: this.next.tiles.reduce((n, t) => (t >= 0 ? n + 1 : n), 0),
                    turned: this.next.flips ? this.next.flips.reduce((n, f) => (f !== 0 ? n + 1 : n), 0) : 0
                }
            },
            timestamp: Date.now()
        };
    }
}

/** Whether two grids are the same in every respect a document stores. */
function sameMap(a: ReadonlyTilemap, b: ReadonlyTilemap): boolean {
    if (a.cols !== b.cols || a.rows !== b.rows) return false;
    if (a.tileWidth !== b.tileWidth || a.tileHeight !== b.tileHeight) return false;
    const as = a.sheet, bs = b.sheet;
    if (as.columns !== bs.columns || as.tileWidth !== bs.tileWidth || as.tileHeight !== bs.tileHeight
        || as.spacing !== bs.spacing || as.margin !== bs.margin) return false;
    if (a.tiles.length !== b.tiles.length) return false;
    for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) return false;
    // ABSENT AND ALL-ZERO ARE THE SAME MAP, which is what makes the invariant on `Tilemap.flips`
    // enforceable: an edit that straightens the last turned cell drops the array, and that must not
    // read as a change from a map that never had one.
    const af = a.flips, bf = b.flips;
    const turned = (f: readonly number[] | undefined, i: number) => (f ? f[i] ?? 0 : 0);
    for (let i = 0; i < a.tiles.length; i++) if (turned(af, i) !== turned(bf, i)) return false;
    return true;
}
