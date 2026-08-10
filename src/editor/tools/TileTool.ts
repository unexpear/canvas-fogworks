/**
 * @module TileTool
 * @description The drag that paints a tile grid — a stroke, a bucket, or a pick.
 *
 * A map could be imported and drawn and not painted, and `TilemapEdit` closed the arithmetic half of
 * that. This is the gesture: press picks a cell, drag paints the run between samples, and every dab
 * commits through `SetTilemapAction` so the map updates under the cursor and undo takes the whole
 * stroke. The same bargain `RasterTool` and `WeightTool` make, for the same reason — an ephemeral
 * overlay of pending cells would be a second answer to what the map is.
 *
 * THE GAPS BETWEEN SAMPLES ARE FILLED, unlike the weight brush's dabs, and the difference is the
 * size of the thing being painted. A mesh has a few dozen points under a brush far wider than the
 * gap between two mouse events; a CELL is one tile wide, so a pointer at 60Hz crossing a map at
 * speed skips several — a stroke would come out as beads. It walks `PixelBuffer.linePoints`, the
 * same Bresenham the pixel brush interpolates with, because a tile grid is an integer grid and a
 * second implementation would disagree with the first by a cell at some angles.
 *
 * WHICH CELL is asked of `Tilemap.cellAt` after `toLocal`, which is how the RENDERER finds cells
 * too — the pair of them is why a tool cannot paint the cell beside the one under the cursor. The
 * node's own matrix is what `toLocal` applies, so a rotated or scaled tilemap paints correctly with
 * nothing here knowing that it is.
 *
 * IT ALSO PAINTS TERRAIN (schema 63), which is the same gesture over a different question: which
 * cells are grass, rather than which tile is drawn. The cell is found in the STORED node's box,
 * which is what makes a click land squarely in one terrain cell — the DISPLAY grid is half a cell
 * off and one larger, so a click on a drawn tile is ambiguous between the four terrain cells that
 * tile covers. Painting the question and letting `resolveTilemaps` answer it is the whole point.
 *
 * ALT PICKS instead of painting, which is the one gesture every tile editor has: the tile under the
 * cursor becomes the brush, orientation included. It writes to the BRUSH, not the document, so it
 * leaves no history entry — the same shape as the eyedropper writing to the swatch.
 *
 * A RECTANGLE IS THE THIRD GESTURE, and it is the one that could not be a stroke: `rectCells` had
 * done the arithmetic since the grid landed and had no caller outside its own tests, which is to say
 * it was not a feature. Filling a room by dragging its two corners is the commonest thing an author
 * does to a tile map, and doing it by stroke means painting every row.
 *
 * ITS PREVIEW IS THE DOCUMENT, like every other gesture here — but it recomputes from the map AS IT
 * WAS AT THE PRESS rather than layering onto the last frame. That is the whole difference between a
 * rectangle and a stroke: a stroke only ever adds, so painting onto what is there is right, while a
 * rectangle that is dragged out and then pulled back in must UNPAINT what the larger one covered.
 * Applying each frame to the live map would leave the high-water mark behind, and the author would
 * see a rectangle that can only grow.
 *
 * A GESTURE THAT ENDS UP CHANGING NOTHING LEAVES NO HISTORY, which needs saying because this one can
 * reach that state after having committed: drag a rectangle out over cells that already hold the
 * brush, pull it back to the anchor, release. Every other tool here simply never dispatches in that
 * case. This one rolls back to the checkpoint it took at the press, which is also what Escape does.
 *
 * NO DOM. Events and a rect in, actions out, so the whole gesture is drivable from a test.
 */

import { Tool } from "./ToolController";
import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { EditorState, screenToWorld } from "../EditorState";
import { SetTilemapAction } from "../../core/actions/SetTilemapAction";
import { withTiles, withTerrain, fillRegion, rectCells, copyTilemap, TileEdit, TerrainEdit } from "../../core/document/TilemapEdit";
import { cellAt, cellCoordAt, tileAt, flipAt, ReadonlyTilemap, Tilemap, TILE_EMPTY } from "../../core/document/Tilemap";
import { terrainCellAt, terrainCoordAt } from "../../core/document/Autotile";
import { computeGeometry, toLocal } from "../../core/geometry/GeometryEngine";
import { linePoints } from "../../core/paint/PixelBuffer";

/** What the tool needs from the panel: which tile, which way up, and what the gesture means. */
export interface TileBrush {
    /** The index to paint. `TILE_EMPTY` is a legitimate choice and is how a panel offers an eraser. */
    index: number;
    /** 0..7 — the three flip bits, as `Tilemap` stores them. */
    flip: number;
    /**
     * `paint` strokes cell by cell; `fill` replaces the connected run of whatever was clicked;
     * `rect` fills the rectangle between the press and the release.
     */
    mode: "paint" | "fill" | "rect";
    /** Whether a stroke clears cells instead of writing `index`. */
    erasing: boolean;
    /**
     * Paint TERRAIN rather than tiles (schema 63) — which cells are grass, not which tile is drawn.
     *
     * THE SAME GESTURE OVER DIFFERENT MATERIAL, which is why it is a flag here rather than a second
     * tool: the target rule, the cell lookup, the gap-filling between samples and the one-undo-step
     * bargain are all identical, and only the value written differs. A second class would be a
     * second copy of the part that is easy to get wrong.
     */
    terrain: boolean;
    /** Which material a terrain stroke writes. 0 is the eraser, as `terrainError` states. */
    material: number;
}

/** A rectangle gesture in flight: what it started from, and what it has committed so far. */
interface RectDrag {
    /** The cell the press landed in. The other corner follows the pointer. */
    anchor: { col: number; row: number };
    /**
     * THE MAP AS IT WAS AT THE PRESS. Every frame is computed from this, not from the last one, so
     * pulling the rectangle back in unpaints what the larger one covered.
     */
    base: Tilemap;
    /** The history head before the first preview, so Escape — or a net-zero release — leaves no trace. */
    checkpoint: string;
    /** Whether any preview has been committed, which is what decides `coalesce`. */
    dispatched: boolean;
    /** Whether the last preview came out identical to `base`. */
    netZero: boolean;
}

export class TileTool implements Tool {
    private painting = false;
    /** The last cell this stroke reached, so the next sample can fill the gap to it. */
    private last: { col: number; row: number } | null = null;
    /** The rectangle gesture in flight, or null. */
    private rect: RectDrag | null = null;

    constructor(
        private dispatcher: ActionDispatcher,
        private editorState: EditorState,
        private refresh: () => void,
        private brush: () => TileBrush,
        /** Where an alt-click sends the tile it sampled. */
        private onPick: (index: number, flip: number) => void
    ) { }

    /** The one tilemap node this gesture may touch, or null. */
    private target(): string | null {
        const selected = this.editorState.selectedNodeIds;
        if (selected.length !== 1) return null;
        const node = this.dispatcher.getDocument().nodes.get(selected[0]);
        return node?.type === "core.tilemap" && node.tilemap ? selected[0] : null;
    }

    /**
     * Which cell a screen point is over, in the target's own grid.
     *
     * `loose` keeps the answer when the point is off the grid, which only the rectangle gesture
     * wants — see `cellCoordAt`. Every other caller wants "no cell", because painting a clamped one
     * would smear the map's edge with whatever the pointer did outside it.
     */
    private cellUnder(
        e: MouseEvent, canvasRect: DOMRect, nodeId: string, loose = false
    ): { col: number; row: number } | null {
        const doc = this.dispatcher.getDocument();
        const map = doc.nodes.get(nodeId)?.tilemap;
        if (!map) return null;
        const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
        // THE NODE'S OWN SPACE, asked of the geometry engine rather than composed here: a tilemap
        // inside a rotated frame is still a grid, and the only thing that knows the chain of
        // matrices above it is the computed state.
        //
        // AND THAT SPACE IS THE RESOLVED ONE. `computeGeometry` resolves the scene internally — that
        // is what keeps every consumer reading one scene — so for an autotiled layer this point is
        // in the DISPLAY grid, which is one larger each way and offset half a cell. Terrain is
        // painted in the other grid, and `terrainCellAt` is the inverse. Getting this wrong does not
        // look like an off-by-one: the brush paints a neighbouring cell everywhere and nothing at
        // all along the last row and column.
        const local = toLocal(computeGeometry(doc), nodeId, w.x, w.y);
        if (!local) return null;
        if (map.terrain) {
            return loose ? terrainCoordAt(map, local.x, local.y) : terrainCellAt(map, local.x, local.y);
        }
        return loose ? cellCoordAt(map, local.x, local.y) : cellAt(map, local.x, local.y);
    }

    onMouseDown(e: MouseEvent, canvasRect?: DOMRect): void {
        if (e.button !== 0 || !canvasRect) return;
        const nodeId = this.target();
        if (!nodeId) return;
        const cell = this.cellUnder(e, canvasRect, nodeId);
        if (!cell) return;                    // a press off the grid starts nothing at all
        e.preventDefault();

        const map = this.dispatcher.getDocument().nodes.get(nodeId)!.tilemap!;
        // ALT SAMPLES. Checked before the mode, because picking is what an author wants whichever
        // mode the panel is in — a bucket that had to be switched off first would be a trap.
        if (e.altKey) {
            this.onPick(tileAt(map, cell.col, cell.row), flipAt(map, cell.col, cell.row));
            this.refresh();
            return;
        }
        const mode = this.brush().mode;
        if (mode === "fill") {
            this.bucket(nodeId, cell);
            return;
        }
        if (mode === "rect") {
            // THE PRESS ITSELF PAINTS ONE CELL, so a click with no drag is a single-cell fill rather
            // than a gesture that appears to do nothing until the pointer moves.
            this.rect = {
                anchor: cell, base: copyTilemap(map), checkpoint: this.dispatcher.getHistoryCheckpoint(),
                dispatched: false, netZero: true
            };
            this.previewRect(nodeId, cell);
            return;
        }
        this.painting = true;
        this.last = cell;
        this.write(nodeId, [cell], false);
    }

    onMouseMove(e: MouseEvent, canvasRect?: DOMRect): void {
        if (!canvasRect) return;
        if (this.rect) {
            const nodeId = this.target();
            if (!nodeId) { this.rect = null; return; }
            // LOOSE, so a drag past the map's edge keeps following the pointer in the axis that is
            // still on it; `rectCells` clamps. A null here means the point could not be placed at
            // all, and the rectangle simply holds its last corner.
            const corner = this.cellUnder(e, canvasRect, nodeId, true);
            if (corner) this.previewRect(nodeId, corner);
            return;
        }
        if (!this.painting) return;
        const nodeId = this.target();
        if (!nodeId) { this.painting = false; return; }
        const cell = this.cellUnder(e, canvasRect, nodeId);
        // OFF THE GRID KEEPS THE STROKE ALIVE but paints nothing, and drops the anchor so coming
        // back does not draw a line across the map from wherever the pointer left it.
        if (!cell) { this.last = null; return; }
        const from = this.last;
        this.last = cell;
        if (!from) { this.write(nodeId, [cell], true); return; }
        // THE RUN BETWEEN THE TWO SAMPLES, ends inclusive. `linePoints` returns the start again,
        // which is harmless: writing a cell the value it already holds is not a change, and
        // `withTiles` answers null for an edit that changes nothing.
        this.write(nodeId, linePoints(from.col, from.row, cell.col, cell.row)
            .map(([col, row]) => ({ col, row })), true);
    }

    onMouseUp(): void {
        this.painting = false;
        this.last = null;
        const rect = this.rect;
        this.rect = null;
        // A RECTANGLE THAT COMMITTED AND THEN CAME BACK TO WHERE IT STARTED leaves the checkpoint
        // behind it, because the alternative is an undo step that undoes nothing — the same thing
        // `SetTilemapAction.validate` refuses when a single edit changes nothing, reached here by a
        // path that goes through several edits to arrive at no change.
        if (rect && rect.dispatched && rect.netZero) {
            this.dispatcher.rollbackToCheckpoint(rect.checkpoint);
            this.refresh();
        }
    }

    /** Escape abandons the rectangle, leaving neither paint nor history — as the rotate handle does. */
    onKeyDown(e: KeyboardEvent): void {
        if (e.key !== "Escape" || !this.rect) return;
        const rect = this.rect;
        this.rect = null;
        e.preventDefault();
        if (rect.dispatched) this.dispatcher.rollbackToCheckpoint(rect.checkpoint);
        this.refresh();
    }

    /**
     * Commit the rectangle between the anchor and `corner`, computed from the map at the press.
     *
     * Dispatch decides for itself whether this is a change: an invalid action (which is what a
     * no-op is) returns `success: false` rather than throwing, so the frame where the pointer moves
     * within one cell costs a validate and nothing else.
     */
    private previewRect(nodeId: string, corner: { col: number; row: number }): void {
        const rect = this.rect;
        if (!rect) return;
        const doc = this.dispatcher.getDocument();
        const cells = rectCells(rect.base, rect.anchor, corner);
        // NULL MEANS "THE SAME AS BASE", so this reads as: the rectangle covers nothing the base did
        // not already have. Falling back to `base` is what UNPAINTS a larger rectangle dragged out
        // a moment ago — dispatching the base map is a real change when the preview is on screen,
        // and a refused no-op when it is not.
        const next = this.edited(rect.base, cells) ?? rect.base;
        rect.netZero = next === rect.base;
        const result = this.dispatcher.dispatchAction(
            new SetTilemapAction(doc, nodeId, next), { coalesce: rect.dispatched }
        );
        // ONLY A COMMITTED FRAME OPENS THE STEP. Counting a refused one would coalesce the first
        // real edit into whatever the author did before the gesture.
        if (!result.success) return;
        rect.dispatched = true;
        this.refresh();
    }

    /** Replace the connected run of whatever was clicked — one click, one history entry. */
    private bucket(nodeId: string, cell: { col: number; row: number }): void {
        const doc = this.dispatcher.getDocument();
        const map = doc.nodes.get(nodeId)?.tilemap;
        if (!map) return;
        // A BUCKET ON A CELL THAT ALREADY HOLDS THE BRUSH would find the whole region and change
        // nothing, so `withTiles` answers null and nothing is dispatched. That is the check, not a
        // separate test here.
        this.write(nodeId, fillRegion(map, cell.col, cell.row), false);
    }

    /**
     * `base` with `cells` painted by the current brush, or null when nothing changes.
     *
     * THE ONE PLACE THAT DECIDES WHAT A BRUSH WRITES, so the stroke and the rectangle cannot come to
     * different conclusions about what erasing means or which question terrain asks. It takes the
     * map to paint ONTO rather than reading the document, which is what lets the rectangle compute
     * every frame from the map as it was at the press.
     */
    private edited(base: ReadonlyTilemap, cells: readonly { col: number; row: number }[]): Tilemap | null {
        const brush = this.brush();
        // TERRAIN IS A DIFFERENT QUESTION, so it takes a different edit — and the tiles are left
        // exactly alone, because on an autotiled layer they are derived and `withTiles` refuses to
        // touch them at all.
        if (brush.terrain) {
            const edits: TerrainEdit[] = cells.map(c => ({
                col: c.col, row: c.row, material: brush.erasing ? 0 : brush.material
            }));
            return withTerrain(base, edits);
        }
        const index = brush.erasing ? TILE_EMPTY : brush.index;
        // AN ERASED CELL IS ALSO STRAIGHTENED. An empty cell that kept an orientation is a stored
        // value nothing can see, and it would hold the whole `flips` array alive — the invariant is
        // that the array is absent when nothing is turned, and erasing a map's last turned tile has
        // to be able to reach that state.
        const flip = brush.erasing ? 0 : brush.flip;
        const edits: TileEdit[] = cells.map(c => ({ col: c.col, row: c.row, index, flip }));
        return withTiles(base, edits);
    }

    /**
     * Write cells onto the LIVE map, and dispatch only if something changed.
     *
     * `coalesce` is false for the first commit of a gesture and true after, so a stroke is ONE undo
     * step — the bargain the rotate handle, the raster brush and the weight brush all make. Opening
     * with a coalescing commit would merge the stroke into whatever the author did before it.
     */
    private write(nodeId: string, cells: readonly { col: number; row: number }[], coalesce: boolean): void {
        const doc = this.dispatcher.getDocument();
        const map = doc.nodes.get(nodeId)?.tilemap;
        if (!map || cells.length === 0) return;
        const next = this.edited(map, cells);
        // NULL MEANS NOTHING CHANGED, and nothing is dispatched: a stroke over cells that already
        // hold the brush must not fill the undo stack with steps that undo nothing.
        if (!next) return;
        this.dispatcher.dispatchAction(new SetTilemapAction(doc, nodeId, next), { coalesce });
        this.refresh();
    }
}
