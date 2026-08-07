/**
 * @module Palette
 * @description A set of colours with the layout the artist chose.
 *
 * VDE already stores colours — `VariableStore` holds design tokens — but as a flat keyed set,
 * because a token is looked up by NAME. A pixel-art palette is looked at by EYE, and its grid is
 * part of the artist's meaning: DawnBringer's 32 colours laid out 8x4 group ramps into rows, and a
 * picker that reflowed them to fit its panel would destroy the grouping while keeping every colour.
 *
 * MEASURED FROM REAL PALETTES rather than assumed — Pixelorama ships `Default.json` as 32 colours
 * in 8x4 and `Pixelorama.json` as 56 in 12x5, each carrying an attribution comment. The layout and
 * the credit are both fields, because both are things a palette carries that a colour list does not.
 *
 * A GRID MAY BE INCOMPLETE. 56 colours do not fill 12x5, and the last row is short — so a slot is
 * addressed rather than assumed occupied, and a picker draws holes instead of shifting colours up.
 */

import { Rgba } from "./PixelBuffer";

/** Bounds on a hand-editable file. */
export const PALETTE_MAX_COLOURS = 4096;
export const PALETTE_MAX_SIDE = 256;

/** A palette: colours, the grid they sit in, and who made it. */
export interface Palette {
    name: string;
    /** In slot order, row-major. May be SHORTER than `width * height`. */
    colours: Rgba[];
    width: number;
    height: number;
    /** Attribution as the file gives it — a palette is somebody's work. */
    comment: string;
}

/** What went wrong, or null. */
export function paletteError(palette: unknown): string | null {
    if (palette === null || typeof palette !== "object") return "a palette must be an object";
    const p = palette as Partial<Palette>;
    if (typeof p.name !== "string") return "a palette must have a name";
    if (!Array.isArray(p.colours)) return "a palette must have a list of colours";
    if (p.colours.length > PALETTE_MAX_COLOURS) return `a palette may not exceed ${PALETTE_MAX_COLOURS} colours`;
    if (!Number.isInteger(p.width) || !Number.isInteger(p.height)) {
        return "a palette's grid must have whole dimensions";
    }
    const w = p.width as number, h = p.height as number;
    if (w < 1 || h < 1) return "a palette's grid must be at least one slot";
    if (w > PALETTE_MAX_SIDE || h > PALETTE_MAX_SIDE) return `a palette's grid may not exceed ${PALETTE_MAX_SIDE}`;
    // THE GRID MUST HOLD THE COLOURS. A palette with more colours than slots would silently hide
    // the tail — which is worse than refusing, because the colours are there and unreachable.
    if (p.colours.length > w * h) return "a palette has more colours than its grid has slots";
    for (const c of p.colours) {
        if (!Array.isArray(c) || c.length !== 4) return "every colour must be four components";
        for (const v of c) {
            if (!Number.isFinite(v) || v < 0 || v > 255) return "colour components must be 0..255";
        }
    }
    return null;
}

/**
 * The colour in a slot, or null when the slot is empty or off the grid.
 *
 * NULL IS A REAL ANSWER. A grid is often not full — 56 colours in 12x5 leaves four empty — and a
 * picker must draw a hole there rather than shifting the next colour up, which would silently
 * rearrange the artist's rows.
 */
export function paletteAt(palette: Palette, column: number, row: number): Rgba | null {
    if (column < 0 || row < 0 || column >= palette.width || row >= palette.height) return null;
    const index = row * palette.width + column;
    return index < palette.colours.length ? palette.colours[index] : null;
}

/**
 * A colour as Pixelorama writes it: `"(r, g, b, a)"` with components 0..1.
 *
 * FLOATS, NOT BYTES. Reading `(1, 0.5, 0, 1)` as 0..255 gives near-black for every colour in the
 * file — a palette that loads, displays, and is uniformly wrong, which is the kind of wrong that
 * looks like a broken screen rather than a broken parser.
 */
export function parseFloatColour(text: unknown): Rgba | null {
    if (typeof text !== "string") return null;
    const m = /^\s*\(([^)]*)\)\s*$/.exec(text);
    if (!m) return null;
    const parts = m[1].split(",").map(v => Number(v.trim()));
    if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null;
    // CLAMPED rather than trusted: the format states 0..1 and nothing enforces it, and a component
    // above 1 would otherwise land past 255 and wrap when it reached a byte.
    return parts.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)) as unknown as Rgba;
}
