/**
 * @module SpriteSheet
 * @description A character's clips as a strip of cells, plus the descriptor an engine reads.
 *
 * The first piece aimed squarely at the game direction, and deliberately core-shaped rather than
 * engine-shaped: a plan and a JSON atlas, not a packaging pipeline. What a 2D engine wants from an
 * animation tool is a texture and a description of which rectangles are which frames of which
 * animation — nothing more, and every one of those facts already exists in the document.
 *
 * THE PLAN IS PURE AND HOLDS EVERY DECISION: how many columns, which frames, where each cell sits,
 * how large the sheet ends up. `drawSheet` is a separate function taking a 2D context. That is the
 * same split `TextRaster` uses and for the same reason — a layout can be asserted in the `node`
 * environment, while pixels can only be looked at, so everything worth getting wrong lives in the
 * half a test can reach.
 *
 * FRAMES COME FROM CLIPS, in clip order. A sheet laid out as an undifferentiated run of the
 * timeline throws away the structure the author put in; an engine reading it back needs to know
 * that frames 12 to 27 are the walk, which is exactly what a clip already says. A document with no
 * clips exports its whole timeline as one unnamed run, the honest reading of "one animation".
 *
 * THE CELL IS SIZED FROM THE UNION OF EVERY FRAME'S INK, not from a node's box. A character
 * squashes and travels, so it leaves its own box constantly, and a cell cut to the box would clip
 * exactly the extremes an animator spent the effort on — the impact frame, the full stretch. The
 * union comes from the same `MotionTrace` that measures everything else, so the framing is a
 * measurement rather than a guess with padding bolted on.
 */

import { ReadonlyDocument } from "../document/Document";
import { Clip } from "../document/Clips";
import { traceMotion } from "../diagnostics/MotionTrace";
import { applyFrame } from "../document/Timeline";
import { computeGeometry } from "../geometry/GeometryEngine";
import { buildRenderModel } from "../../renderer/RenderModel";
import { emitCanvas } from "../../renderer/emitCanvas";

/**
 * Largest sheet this will plan, in pixels.
 *
 * A long clip at a large cell size is how an export becomes a request for a texture no GPU will
 * accept — 16384 squared is the common ceiling and plenty of hardware stops lower. Being told at
 * plan time is much better than discovering it at upload.
 */
export const SHEET_MAX_PIXELS = 8192 * 8192;

/** One frame's place on the sheet. */
export interface Cell {
    /** The timeline frame drawn here. */
    frame: number;
    /** Which clip it belongs to, or null when the document has none. */
    clip: string | null;
    col: number;
    row: number;
    /** Pixel rect within the sheet, padding included in the position but not the size. */
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Everything needed to draw the sheet and to describe it. */
export interface SheetPlan {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    width: number;
    height: number;
    padding: number;
    /** World-space rect the cells are framed on — the union of every frame's ink. */
    frame: { x: number; y: number; width: number; height: number };
    cells: Cell[];
}

/** The descriptor an engine reads back. */
export interface SheetAtlas {
    image: string;
    fps: number;
    cellWidth: number;
    cellHeight: number;
    clips: { name: string; from: number; to: number; loop: boolean; frames: number[] }[];
    frames: Cell[];
}

/** The frames a document exports, in clip order — or its whole timeline when it has no clips. */
function framesOf(doc: ReadonlyDocument): { frame: number; clip: string | null }[] {
    const out: { frame: number; clip: string | null }[] = [];
    const clips = doc.clips;
    if (clips && clips.length > 0) {
        for (const c of clips) {
            for (let f = c.from; f <= c.to; f++) out.push({ frame: f, clip: c.name });
        }
        return out;
    }
    // NO CLIPS is not an error and not an empty sheet: the document has one animation, which is
    // its whole timeline. A document with no timeline either has exactly one frame.
    const last = doc.timeline ? doc.timeline.frames - 1 : 0;
    for (let f = 0; f <= last; f++) out.push({ frame: f, clip: null });
    return out;
}

/**
 * The world rect every frame's ink fits inside.
 *
 * Measured rather than assumed, from the same trace that measures everything else. A character
 * that squashes at contact and stretches at launch occupies a box larger than any single frame's,
 * and larger than the node's own — framing on either would clip the poses the animation is about.
 */
function inkBounds(doc: ReadonlyDocument, frames: readonly number[]): { x: number; y: number; width: number; height: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of frames) {
        for (const s of traceMotion(doc, { from: f, to: f })) {
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x + s.width);
            maxY = Math.max(maxY, s.y + s.height);
        }
    }
    // An empty document has no ink, so it has no extent — one pixel rather than an infinite or
    // negative rect, because every consumer below divides by these.
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return { x: 0, y: 0, width: 1, height: 1 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Where every exported frame sits on the sheet.
 *
 * `columns` defaults to something close to square, which is what keeps a long clip from becoming a
 * strip thousands of pixels wide and a few tall — the shape that wastes the most texture memory
 * once a GPU rounds it up.
 */
export function planSheet(
    doc: ReadonlyDocument,
    opts?: { columns?: number; cellWidth?: number; cellHeight?: number; padding?: number }
): SheetPlan {
    const wanted = framesOf(doc);
    const frame = inkBounds(doc, wanted.map(w => w.frame));
    const padding = Math.max(0, Math.round(opts?.padding ?? 0));
    const cellWidth = Math.max(1, Math.round(opts?.cellWidth ?? Math.ceil(frame.width)));
    const cellHeight = Math.max(1, Math.round(opts?.cellHeight ?? Math.ceil(frame.height)));
    const columns = Math.max(1, Math.round(opts?.columns ?? Math.ceil(Math.sqrt(Math.max(1, wanted.length)))));
    const rows = Math.max(1, Math.ceil(wanted.length / columns));

    const cells: Cell[] = wanted.map((w, i) => {
        const col = i % columns, row = Math.floor(i / columns);
        return {
            frame: w.frame, clip: w.clip, col, row,
            // PADDING sits between cells rather than inside them, so a cell's rect is exactly the
            // area an engine samples. Padding inside would make every frame's usable region
            // smaller than the number in the descriptor, which is a bug nobody finds until a
            // sprite shows a sliver of its neighbour.
            x: padding + col * (cellWidth + padding),
            y: padding + row * (cellHeight + padding),
            width: cellWidth,
            height: cellHeight
        };
    });

    return {
        columns, rows, cellWidth, cellHeight, padding, frame, cells,
        width: padding + columns * (cellWidth + padding),
        height: padding + rows * (cellHeight + padding)
    };
}

/** Is this plan larger than anything sensible will accept? Asked rather than discovered later. */
export function sheetTooLarge(plan: SheetPlan): boolean {
    return plan.width * plan.height > SHEET_MAX_PIXELS;
}

/**
 * The descriptor an engine reads back.
 *
 * Clip ranges are carried through as authored, and each clip's frame list is exactly the cells that
 * belong to it — so a reader can either walk the range or use the list without the two disagreeing.
 */
export function sheetAtlas(doc: ReadonlyDocument, plan: SheetPlan, image: string): SheetAtlas {
    const clips = (doc.clips ?? []).map((c: Clip) => ({
        name: c.name,
        from: c.from,
        to: c.to,
        loop: c.loop !== false,
        frames: plan.cells.filter(cell => cell.clip === c.name).map(cell => cell.frame)
    }));
    return {
        image,
        fps: doc.timeline?.fps ?? 0,
        cellWidth: plan.cellWidth,
        cellHeight: plan.cellHeight,
        clips,
        frames: plan.cells
    };
}

/** How many frames a clip contributes to a sheet — the cross-check against `clipLength`. */
export function sheetClipFrames(plan: SheetPlan, name: string): number {
    return plan.cells.filter(c => c.clip === name).length;
}

/**
 * Draw every cell of a plan into a 2D context.
 *
 * The impure half, kept apart from `planSheet` so the decisions stay testable — see the module
 * note. It draws through `buildRenderModel` and `emitCanvas`, the SAME path the editor's canvas
 * backend uses, rather than a second renderer written for export: a sheet that did not match what
 * the editor showed would be the worst kind of bug, because you only find it in the game.
 *
 * The GRID and the OVERLAY are blanked before emitting. They are editor furniture — selection
 * frames, handles, the background grid — and baking them into a character's texture is the most
 * obvious way an export can be wrong. The display list is plain data, so this is a substitution
 * rather than a flag threaded through the renderer.
 */
export function drawSheet(ctx: CanvasRenderingContext2D, doc: ReadonlyDocument, plan: SheetPlan): void {
    for (const cell of plan.cells) {
        const timed = applyFrame(doc, cell.frame);
        const computed = computeGeometry(timed);
        // The VIEWPORT places the ink's own origin at this cell. `buildRenderModel` translates by
        // `-viewport`, so asking for the frame rect's corner puts the union of every pose exactly
        // at 0,0 — which is what makes every cell share one registration point. Cells that framed
        // themselves individually would make a character jitter as it played.
        const model = buildRenderModel(
            { width: plan.cellWidth, height: plan.cellHeight },
            timed,
            { selectedNodeIds: [], hoveredNodeId: null, computed, viewport: { x: plan.frame.x, y: plan.frame.y, zoom: 1 } }
        );
        // The GRID is genuinely removed here and a test proves it: the same document drawn the
        // editor's way does stroke grid lines, and this one strokes nothing.
        // The OVERLAY blanking is BELT-AND-BRACES, and saying so is more useful than implying it
        // is tested. Every overlay item is gated on a selection, a hover, or a preview rect, and
        // the state above supplies none — so `model.overlay` is already empty and a mutation
        // replacing `[]` with it changes no output. It stays because "no editor furniture in a
        // texture" should not silently become false the day an overlay appears that is not driven
        // by selection.
        const bare = { ...model, grid: { ...model.grid, lines: [] }, overlay: [] };
        ctx.save();
        // CLIPPED to the cell, so a frame whose ink exceeds the measured union — possible only if
        // the caller supplied a smaller cell size than the plan measured — cannot bleed into its
        // neighbours and quietly corrupt two sprites instead of one. It is also what keeps
        // `emitCanvas`'s full-canvas clear from erasing the cells already drawn.
        ctx.beginPath();
        ctx.rect(cell.x, cell.y, cell.width, cell.height);
        ctx.clip();
        // The cell offset is passed IN rather than applied as a `ctx.translate` first: `emitCanvas`
        // sets the CTM absolutely, so a translate here is discarded and every cell lands on top of
        // the first — which is precisely what the first version of this did, and what a sheet with
        // one ball on it and forty-seven empty cells looks like.
        // TRANSPARENT, because the editor's backdrop is furniture in exactly the way the grid and
        // the overlay are. Baked into a texture it makes every sprite a solid rectangle.
        emitCanvas(ctx, bare, 1, { x: cell.x, y: cell.y, background: null });
        ctx.restore();
    }
}
