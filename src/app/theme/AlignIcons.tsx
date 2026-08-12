/**
 * @module AlignIcons
 * @description Four bars, ragged or flush — what every editor draws for text alignment.
 *
 * WHY THESE EXIST, and it is not decoration. `⇤ ⇹ ⇥` were doing two unrelated jobs in one app: in
 * the object row they mean PUSH THE SELECTED NODES to an edge, and in the text row they meant SET
 * THE RAGGED SIDE of a paragraph. Same three glyphs, same inspector, two operations — and `⇥` was
 * doing a third job as the auto-layout marker in the tree. An arrow pointing left is a perfectly
 * good icon for "move it left"; it is a poor one for "ragged right", which is a statement about
 * lines of text and is universally drawn as lines of text.
 *
 * DRAWN HERE RATHER THAN IMPORTED. Stacked bars are the convention, not any one designer's work —
 * every editor from Word to Figma draws this, so there is nothing to take from a pack and nothing
 * to attribute. It is also ten lines, against a converter and a licence question for the same four
 * icons.
 *
 * THE GEOMETRY IS A PURE FUNCTION, separate from the element, because the thing worth testing is
 * not that an `<svg>` appeared: it is that the four alignments are TOLD APART — that the short
 * lines actually sit at different offsets and that justify has no short line. A component in a
 * `testEnvironment: node` suite could only be asserted on as source text.
 *
 * `currentColor` AND NO FIXED SIZE, so the button owns the colour and the row owns the scale — the
 * icon inherits the disabled grey and the active blue without knowing either exists.
 */
import React from "react";
import { TextAlign } from "../../core/document/Node";

/** The box the bars are drawn in. Wider than tall, like the lines of text it stands for. */
export const ALIGN_ICON_BOX = { width: 14, height: 12 } as const;
/** Bar widths per line: a full line, a short one, a full one, a short one. */
const LINES: readonly number[] = [14, 8, 14, 8];
const BAR = 1.6;
const GAP = 3.5;

/** One bar of the icon. */
export interface AlignBar { x: number; y: number; width: number }

/**
 * The four bars for an alignment.
 *
 * THE SHORT LINES CARRY THE MEANING. Flush left leaves the ragged edge on the right, flush right
 * leaves it on the left, centred splits the slack — and JUSTIFY HAS NO SHORT LINE AT ALL, which is
 * what justified text is. Every one of those four is a different set of `x`, so the icons are told
 * apart by the only thing a reader looks at.
 */
export function alignBars(align: TextAlign): AlignBar[] {
    return LINES.map((w, i) => {
        const width = align === "justify" ? ALIGN_ICON_BOX.width : w;
        const slack = ALIGN_ICON_BOX.width - width;
        const x = align === "right" ? slack : align === "center" ? slack / 2 : 0;
        return { x, y: i * GAP, width };
    });
}

/** The stacked-bars icon for one alignment. */
export function AlignIcon({ align, size = 13 }: { align: TextAlign; size?: number }): React.ReactElement {
    const { width, height } = ALIGN_ICON_BOX;
    return (
        <svg
            width={size} height={size * (height / width)} viewBox={`0 0 ${width} ${height}`}
            // DECORATIVE, because the button already carries the name: `title` states it for a
            // pointer and `aria-label` for a screen reader. An icon that repeats the name reads
            // it twice.
            aria-hidden="true" focusable="false"
            style={{ display: "block" }}
        >
            {alignBars(align).map((b, i) => (
                <rect key={i} x={b.x} y={b.y} width={b.width} height={BAR} rx={0.4} fill="currentColor" />
            ))}
        </svg>
    );
}
