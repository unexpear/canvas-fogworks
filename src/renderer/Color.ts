/**
 * @module Color
 * @description Parses the bounded hexadecimal colour vocabulary shared by renderer backends.
 */

/**
 * A CSS colour as normalized RGBA components. The document may carry broader CSS colour strings,
 * but GPU lighting has always accepted only these deterministic hexadecimal forms; parity means
 * the software backends skip the same unreadable light instead of inventing another parser.
 */
export function parseColor(css: string): [number, number, number, number] | null {
    const s = css.trim();
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (!m) return null;
    const h = m[1];
    const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
    const n = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return [n(0), n(1), n(2), full.length === 8 ? n(3) : 1];
}
