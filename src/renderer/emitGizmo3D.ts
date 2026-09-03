/**
 * @module emitGizmo3D
 * @description Emits the fixed-size SVG overlay for the pure 3D translation-gizmo model.
 */

import { RotateGizmo3D, TranslateGizmo3D } from "./Gizmo3D";

const NS = "http://www.w3.org/2000/svg";

export function emitTranslateGizmo3D(host: HTMLElement, gizmo: TranslateGizmo3D | null): void {
    const svg = prepare(host, "translate");
    if (!gizmo) return;
    for (const handle of gizmo.handles) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", String(handle.origin.x)); line.setAttribute("y1", String(handle.origin.y));
        line.setAttribute("x2", String(handle.end.x)); line.setAttribute("y2", String(handle.end.y));
        line.setAttribute("stroke", handle.color); line.setAttribute("stroke-width", "3");
        line.setAttribute("data-axis", handle.axis);
        const tip = document.createElementNS(NS, "circle");
        tip.setAttribute("cx", String(handle.end.x)); tip.setAttribute("cy", String(handle.end.y));
        tip.setAttribute("r", "5"); tip.setAttribute("fill", handle.color);
        svg.append(line, tip);
    }
}

export function emitScaleGizmo3D(host: HTMLElement, gizmo: TranslateGizmo3D | null): void {
    const svg = prepare(host, "scale");
    if (!gizmo) return;
    for (const handle of gizmo.handles) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", String(handle.origin.x)); line.setAttribute("y1", String(handle.origin.y));
        line.setAttribute("x2", String(handle.end.x)); line.setAttribute("y2", String(handle.end.y));
        line.setAttribute("stroke", handle.color); line.setAttribute("stroke-width", "3");
        line.setAttribute("data-axis", handle.axis);
        const tip = document.createElementNS(NS, "rect");
        tip.setAttribute("x", String(handle.end.x - 5)); tip.setAttribute("y", String(handle.end.y - 5));
        tip.setAttribute("width", "10"); tip.setAttribute("height", "10"); tip.setAttribute("fill", handle.color);
        svg.append(line, tip);
    }
}

export function emitRotateGizmo3D(host: HTMLElement, gizmo: RotateGizmo3D | null): void {
    const svg = prepare(host, "rotate");
    if (!gizmo) return;
    for (const handle of gizmo.handles) {
        const ring = document.createElementNS(NS, "circle");
        ring.setAttribute("cx", String(handle.center.x)); ring.setAttribute("cy", String(handle.center.y));
        ring.setAttribute("r", String(handle.radius)); ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", handle.color); ring.setAttribute("stroke-width", "3");
        ring.setAttribute("data-axis", handle.axis);
        svg.appendChild(ring);
    }
}

function prepare(host: HTMLElement, mode: string): SVGSVGElement {
    let svg = host.querySelector<SVGSVGElement>("svg[data-vde-gizmo3d]");
    if (!svg) {
        svg = document.createElementNS(NS, "svg");
        Object.assign(svg.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
        host.appendChild(svg);
    }
    svg.dataset.vdeGizmo3d = mode;
    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${Math.max(1, host.clientWidth)} ${Math.max(1, host.clientHeight)}`);
    return svg;
}
