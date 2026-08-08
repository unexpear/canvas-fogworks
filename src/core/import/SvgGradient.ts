/**
 * @module SvgGradient
 * @description Reading `<linearGradient>` and `<radialGradient>` out of an SVG file.
 *
 * `SvgDocument` already notices gradients and flattens each to its first stop, saying so in its
 * notes. That is honest and it is still 2,491 fills across 516 files arriving as flat colour. This
 * reads the real thing.
 *
 * SEPARATE FROM `SvgDocument` ON PURPOSE. That module is tested against the whole corpus and its
 * internals are load-bearing; a gradient parser is a self-contained pass over the same text, and
 * bolting it into the shape walk would put two jobs in one loop for no gain.
 *
 * `Style.fill` CAN NOW HOLD ONE (schema 56), so what these gradients need is a caller:
 * `SvgDocument` still flattens each to its first stop on the way into a node. Wiring the two
 * together is the next step and is a change to the shape walk, not to this file.
 *
 * `href` INHERITANCE IS REAL AND SMALL: 150 of 3,127 gradients state no stops and point at another
 * gradient for them. Ignoring it leaves those 150 with no stops at all — which `gradientError`
 * refuses, so they would not merely look wrong, they would be rejected.
 */

import { Gradient, GradientStop, defaultGradient, normalizeStops, GRADIENT_MAX_STOPS } from "../document/Gradient";
import { parseSvgTransform } from "../geometry/Matrix";

/** Attributes of one tag, single or double quoted — the same loose reading the Tiled reader uses. */
function attributes(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)) out[m[1]] = m[3];
    return out;
}

function num(value: string | undefined, fallback: number): number {
    if (value === undefined) return fallback;
    // A PERCENTAGE is a real spelling for every one of these — `offset="50%"`, `r="50%"` — and
    // reading it as the number 50 puts a stop fifty times past the end of the ramp.
    const percent = value.trim().endsWith("%");
    const n = parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    return percent ? n / 100 : n;
}

/**
 * The stops inside one gradient element's body.
 *
 * `stop-color` and `stop-opacity` may arrive as ATTRIBUTES or inside a `style=` — both spellings
 * occur, and a reader that knows only the attribute silently gives every such stop the default
 * black at full opacity, which looks like a colour bug rather than a parsing one.
 */
function parseStops(body: string): GradientStop[] {
    const stops: GradientStop[] = [];
    for (const m of body.matchAll(/<stop\b([^>]*)\/?>/g)) {
        if (stops.length >= GRADIENT_MAX_STOPS) break;
        const a = attributes("<stop" + m[1] + ">");
        const style = a.style ?? "";
        const styled = (name: string): string | undefined => {
            const hit = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
            return hit ? hit[1].trim() : undefined;
        };
        const color = a["stop-color"] ?? styled("stop-color") ?? "#000000";
        const opacity = a["stop-opacity"] ?? styled("stop-opacity");
        stops.push({
            offset: Math.min(1, Math.max(0, num(a.offset, 0))),
            color: color.trim(),
            opacity: opacity === undefined ? 1 : Math.min(1, Math.max(0, num(opacity, 1)))
        });
    }
    return stops;
}

/** The `id` another gradient is inherited from, from `href` or the older `xlink:href`. */
function inheritsFrom(attrs: Record<string, string>): string | null {
    const ref = attrs.href ?? attrs["xlink:href"];
    if (!ref) return null;
    const hit = /^#(.+)$/.exec(ref.trim());
    return hit ? hit[1] : null;
}

/**
 * Every gradient in the file, by id.
 *
 * Gradients that inherit stops are resolved AFTER all are read, because a file may reference one
 * declared later — SVG has no ordering rule, and the corpus contains both directions.
 */
export function parseSvgGradients(xml: string): Map<string, Gradient> {
    const out = new Map<string, Gradient>();
    const inherit = new Map<string, string>();

    // THE OPEN TAG IS MATCHED, AND THE BODY FOUND FROM IT — not both in one pattern. A single
    // regex reaching for the closing tag swallows everything up to the NEXT gradient's close
    // whenever the current one is SELF-CLOSING, eating it whole. There are exactly 150
    // self-closing gradients here, and the first version of this lost 151 of 3,127 to them.
    // Comparing the parser's count against an independent scan is what caught it: on its own it
    // reported 2,976 gradients, every one well-formed, and looked entirely healthy.
    for (const m of xml.matchAll(/<(linear|radial)Gradient\b([^>]*?)(\/?)>/g)) {
        const kind = m[1] === "linear" ? "linear" as const : "radial" as const;
        const a = attributes("<g" + m[2] + ">");
        if (!a.id) continue;
        // DUPLICATE IDS ARE INVALID SVG and 37 occur across 6 files. A browser takes the FIRST,
        // so this does too — the same reasoning as repairing out-of-order stops.
        if (out.has(a.id)) continue;
        // A SELF-CLOSING gradient has no body: its stops come from its href, which is the whole
        // reason the tag is written that way.
        let body = "";
        if (m[3] !== "/") {
            const from = (m.index ?? 0) + m[0].length;
            const end = xml.indexOf(`</${m[1]}Gradient>`, from);
            body = end < 0 ? xml.slice(from) : xml.slice(from, end);
        }
        const g: Gradient = {
            ...defaultGradient(kind),
            // ONLY WHEN STATED: SVG's default is objectBoundingBox and 150 files rely on it, so a
            // reader defaulting to the common `userSpaceOnUse` gets those wrong by a whole
            // coordinate system.
            units: a.gradientUnits === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox",
            transform: a.gradientTransform ? parseSvgTransform(a.gradientTransform) : defaultGradient(kind).transform,
            stops: parseStops(body)
        };
        if (kind === "linear") {
            g.x1 = num(a.x1, 0); g.y1 = num(a.y1, 0);
            g.x2 = num(a.x2, 1); g.y2 = num(a.y2, 0);
        } else {
            g.cx = num(a.cx, 0.5); g.cy = num(a.cy, 0.5); g.r = num(a.r, 0.5);
            // THE FOCUS DEFAULTS TO THE CENTRE — which means cx/cy, not 0.5, once cx/cy are
            // stated. Defaulting it to a literal 0.5 would drag the highlight to the middle of the
            // box on every gradient that moves its circle.
            g.fx = num(a.fx, g.cx); g.fy = num(a.fy, g.cy);
        }
        out.set(a.id, g);
        const from = inheritsFrom(a);
        if (from) inherit.set(a.id, from);
    }

    // RESOLVED AFTERWARDS, because a file may point at a gradient declared later — SVG imposes no
    // order and the corpus has both directions. Chains are followed, and a CYCLE stops rather than
    // spinning: a file that points two gradients at each other is malformed, not a hang.
    for (const [id, first] of inherit) {
        const target = out.get(id)!;
        if (target.stops.length > 0) continue;
        const seen = new Set<string>([id]);
        let from: string | null = first;
        while (from && !seen.has(from)) {
            seen.add(from);
            const source = out.get(from);
            if (!source) break;
            if (source.stops.length > 0) { target.stops = source.stops.map(s => ({ ...s })); break; }
            from = inherit.get(from) ?? null;
        }
    }

    // Normalised last, so an inherited list is repaired the same way a stated one is.
    for (const g of out.values()) g.stops = normalizeStops(g.stops);
    return out;
}
