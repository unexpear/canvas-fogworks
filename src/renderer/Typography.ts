/**
 * @module Typography
 * @description Shared text defaults and hard line breaks, with no render-model or action dependency.
 */
import { TextAlign } from "../core/document/Node";
import { resolveNumber, VariableStore } from "../core/document/Variables";

/** Every typography value a text shape needs, resolved — the shape of what `resolveTypography` answers. */
export interface ResolvedType {
    fontSize: number;
    fontFamily: string;
    fontWeight: number;
    textAlign: TextAlign;
    lineHeight: number;
    letterSpacing: number;
}

/**
 * A style's typography with `$token`s looked up, ranges checked and defaults applied (schema 34).
 *
 * EXPORTED because the render model is no longer the only thing that needs it: the on-canvas text
 * editor puts a real text field over the node, and a field whose metrics disagree with the render
 * puts the caret in the wrong place and makes the text jump the moment editing ends. Re-deriving
 * the defaults there would be five numbers written twice — and the ONE that drifted would be
 * invisible until somebody typed into a node that used it.
 *
 * A broken or out-of-range token falls back to the documented default rather than throwing: a
 * negative `spacing` variable is a legal variable and an illegal line height, and the answer to
 * that is the value the renderer already drew.
 */
export function resolveTypography(
    style: {
        fontSize?: number | string; fontFamily?: string; fontWeight?: number | string;
        textAlign?: TextAlign; lineHeight?: number | string; letterSpacing?: number | string;
    },
    store: VariableStore,
    theme: string
): ResolvedType {
    const slot = (raw: number | string | undefined, fallback: number, min: number, max: number): number => {
        if (raw === undefined) return fallback;
        const n = typeof raw === "number" ? raw : resolveNumber(store, raw, theme as never);
        return n !== null && n >= min && n <= max ? n : fallback;
    };
    return {
        // `fontSize` has no upper bound of its own — only "positive" — which is why it is not just
        // another `slot` call.
        fontSize: (() => {
            if (style.fontSize === undefined) return 14;
            const r = typeof style.fontSize === "number" ? style.fontSize : resolveNumber(store, style.fontSize, theme as never);
            return r !== null && r > 0 ? r : 14;
        })(),
        fontFamily: style.fontFamily && style.fontFamily.trim() !== "" ? style.fontFamily : "sans-serif",
        fontWeight: slot(style.fontWeight, 400, 1, 1000),
        textAlign: style.textAlign ?? "left",
        // `normal` in a browser is ~1.2, which is what the Canvas backend already used to break
        // lines — so an absent line height keeps every backend where it was.
        lineHeight: slot(style.lineHeight, 1.2, 0.01, 100),
        letterSpacing: slot(style.letterSpacing, 0, -1e6, 1e6)
    };
}

/**
 * Text split into PARAGRAPHS on explicit newlines — the hard breaks, shared by everything that
 * lays text out.
 *
 * A newline is a line in both backends (schema 34), and the exporter has to agree or a document
 * exports as one run of text it does not look like. Wrapping on the box width is a separate,
 * MEASURED step that only the canvas backend can do; this is the part that needs no measurement
 * and therefore must not be re-implemented three times.
 *
 * Whitespace WITHIN a paragraph is collapsed to single separators, matching `white-space:
 * pre-wrap`'s treatment of runs of spaces and tabs.
 */
export function textParagraphs(text: string): string[] {
    return text.split("\n").map(paragraph => paragraph.split(/[^\S\n]+/).filter(word => word.length > 0).join(" "));
}
