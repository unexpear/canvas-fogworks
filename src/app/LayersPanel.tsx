/**
 * @module LayersPanel
 * @description The layer tree extracted from the app shell. Search, collapse and
 * drag indicators stay here; document edits are reported so App keeps the write path.
 */

import React, { useRef, useState } from "react";
import { ReadonlyDocument } from "../core/document/Document";
import { ReadonlyNode } from "../core/document/SceneGraph";
import { resolveLayerDrop, DropPosition } from "../editor/layerDrop";
import { selectionForRowClick, ClickModifiers } from "../editor/layerSelection";
import { filterLayers } from "../editor/layerFilter";

const ui = {
    bg: "#0e0e18",
    line: "#262642",
    lineSoft: "#1f1f38",
    text: "#dcdce8",
    textDim: "#8a8aa5",
    accent: "#4da3ff"
};

const PANEL_HEADING: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase",
    color: ui.textDim, marginBottom: 8, paddingBottom: 6, borderBottom: `1px solid ${ui.lineSoft}`
};

/** One friendly label per node type. Unknown types fall back to the type id. */
const NODE_TYPE_LABELS: Record<string, string> = {
    "core.rectangle": "Rectangle",
    "core.text": "Text",
    "core.image": "Image",
    "core.ellipse": "Ellipse",
    "core.line": "Line",
    "core.path": "Path"
};

export function nodeTypeLabel(type: string): string {
    return NODE_TYPE_LABELS[type] || type;
}

/** The label a layer row shows — name, then type — so other panels can match it. */
export function layerNodeLabel(node: { name?: string; type: string } | undefined, id: string): string {
    return node ? (node.name || nodeTypeLabel(node.type)) : id;
}

/** Glyph per node type — a layer list you can scan by shape rather than by reading every row. */
const LAYER_ICONS: Record<string, string> = {
    "core.rectangle": "▭", "core.ellipse": "○", "core.line": "╱", "core.text": "T",
    "core.image": "▣", "core.path": "◇", "core.instance": "⧉"
};

export interface LayersPanelProps {
    getDocument: () => ReadonlyDocument;
    selectedIds: readonly string[];
    onSelect: (ids: string[]) => void;
    onFlags: (id: string, flags: { hidden?: boolean; locked?: boolean }) => void;
    onReparent: (id: string, parent: string | null, index: number) => void;
    onOpacity: (id: string, opacity: number) => void;
    onRename: (id: string, name: string) => void;
    /** A refused drop still repaints, matching the shell's previous refresh. */
    onRefresh: () => void;
}

export function LayersPanel({ getDocument, selectedIds, onSelect, onFlags, onReparent,
    onOpacity, onRename, onRefresh }: LayersPanelProps) {
    const document = getDocument();
    // Which folders are collapsed. Purely a view concern — collapsing is not undoable.
    const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
    const [layerQuery, setLayerQuery] = useState("");
    // The layer drag in flight. React state, because the hovered row has to redraw.
    const [layerDrag, setLayerDrag] = useState<{ id: string; over: string | null; position: DropPosition | null }>(
        { id: "", over: null, position: null });
    // The row a shift-click measures from. Panel-local: an affordance, not document state.
    const layerAnchorRef = useRef<string | null>(null);

    return <>
        <div style={PANEL_HEADING}>Layers</div>
        <input
            type="text"
            value={layerQuery}
            placeholder="Search layers…"
            onChange={e => setLayerQuery(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") setLayerQuery(""); }}
            style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px", marginBottom: 6,
                background: ui.bg, color: ui.text, border: `1px solid ${layerQuery ? ui.accent : ui.line}`, borderRadius: 2 }}
        />
        {(() => {
            // Walk the real tree: roots, then each node's children, depth-first.
            const doc = getDocument();
            const rows: React.ReactNode[] = [];
            const labelOf = (id: string) => layerNodeLabel(doc.nodes.get(id), id);
            // The same label the row displays, so the filter cannot disagree with what the user reads.
            const filter = filterLayers(doc, layerQuery, labelOf);
            // The order rows are actually rendered in — what a shift-click range means.
            const visibleOrder: string[] = [];
            // Both flags inherit, so the walk carries them down rather than each row climbing.
            const walk = (ids: readonly string[], depth: number, hiddenAbove = false, lockedAbove = false) => {
                for (const id of ids) {
                    const n = doc.nodes.get(id);
                    if (!n) continue;
                    if (!filter.inactive && !filter.visible.has(id)) continue;
                    const hasChildren = n.children.length > 0;
                    // While filtering, a hit inside a collapsed group must stay reachable.
                    const isCollapsed = filter.inactive ? collapsedLayers.has(id) : false;
                    visibleOrder.push(id);
                    rows.push(
                        <LayerRow
                            key={id}
                            node={n}
                            depth={depth}
                            selected={selectedIds.includes(id)}
                            collapsed={isCollapsed}
                            hasChildren={hasChildren}
                            isAutoLayout={n.layout.container !== undefined || n.layout.grid !== undefined}
                            inheritedHidden={hiddenAbove}
                            inheritedLocked={lockedAbove}
                            onFlag={flags => onFlags(id, flags)}
                            dropHint={layerDrag.over === id ? layerDrag.position : null}
                            onDragStart={() => setLayerDrag({ id, over: null, position: null })}
                            onDragOver={position => {
                                const dragged = layerDrag.id;
                                const ok = dragged && dragged !== id
                                    && resolveLayerDrop(getDocument(), dragged, id, position) !== null;
                                setLayerDrag(d => ({ ...d, over: ok ? id : null, position: ok ? position : null }));
                            }}
                            onDrop={() => {
                                const dragged = layerDrag.id;
                                const drop = dragged && layerDrag.position
                                    ? resolveLayerDrop(getDocument(), dragged, id, layerDrag.position)
                                    : null;
                                setLayerDrag({ id: "", over: null, position: null });
                                if (drop && dragged) onReparent(dragged, drop.parent, drop.index);
                                else onRefresh();
                            }}
                            onDragEnd={() => setLayerDrag({ id: "", over: null, position: null })}
                            onOpacity={opacity => onOpacity(id, opacity)}
                            onRename={name => onRename(id, name)}
                            label={n.name || nodeTypeLabel(n.type)}
                            onSelect={mods => {
                                const next = selectionForRowClick(visibleOrder, selectedIds, layerAnchorRef.current, id, mods);
                                layerAnchorRef.current = next.anchor;
                                onSelect(next.selected);
                            }}
                            onToggle={() => {
                                const next = new Set(collapsedLayers);
                                next.has(id) ? next.delete(id) : next.add(id);
                                setCollapsedLayers(next);
                            }}
                        />
                    );
                    // A collapsed folder hides its subtree; the nodes stay selected and rendered.
                    if (hasChildren && !isCollapsed) walk(n.children, depth + 1, hiddenAbove || !!n.hidden, lockedAbove || !!n.locked);
                }
            };
            walk(doc.rootNodeUuids, 0);
            return rows;
        })()}
        {document.nodes.size === 0 && (
            <div style={{ fontSize: 11, color: "#555", padding: "4px 6px" }}>No layers yet</div>
        )}
    </>;
}

/**
 * One row of the layer tree.
 *
 * A row is a folder when it has children. A group is a container with no fill, and a frame
 * is one that paints. The tree shows what a node is rather than a stored kind.
 */
function LayerRow({ node, depth, selected, collapsed, hasChildren, isAutoLayout, inheritedHidden, inheritedLocked, onSelect, onToggle, onFlag, label, dropHint, onDragStart, onDragOver, onDrop, onDragEnd, onRename, onOpacity }: {
    node: ReadonlyNode; depth: number; selected: boolean; collapsed: boolean; hasChildren: boolean;
    isAutoLayout: boolean;
    /** True when an ancestor is hidden or locked — the row shows the effect without pretending this node holds the flag. */
    inheritedHidden: boolean; inheritedLocked: boolean;
    onSelect: (mods: ClickModifiers) => void; onToggle: () => void; onFlag: (flags: { hidden?: boolean; locked?: boolean }) => void; label: string;
    /** Where the pointer currently is within this row, so the row can draw what the release will do. */
    dropHint: DropPosition | null;
    onDragStart: () => void; onDragOver: (position: DropPosition) => void; onDrop: () => void; onDragEnd: () => void;
    onRename: (name: string) => void;
    onOpacity: (opacity: number) => void;
}) {
    const [hover, setHover] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const isGroup = hasChildren && (node.style.fill === "none" || !node.style.fill);
    return (
        <div
            data-layer-node-id={node.id}
            draggable={!renaming}
            onDragStart={e => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
            onDragOver={e => {
                e.preventDefault();
                // Top and bottom eighths reorder; the middle reparents into the row.
                const r = e.currentTarget.getBoundingClientRect();
                const t = (e.clientY - r.top) / r.height;
                onDragOver(t < 0.3 ? "before" : t > 0.7 ? "after" : "inside");
            }}
            onDrop={e => { e.preventDefault(); onDrop(); }}
            onDragEnd={onDragEnd}
            onClick={e => onSelect({ shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey })}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            title={`${label} — ${node.id.slice(0, 8)}`}
            style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "3px 6px", paddingLeft: 6 + depth * 12,
                fontSize: 11, borderRadius: 3, cursor: "pointer", marginBottom: 1,
                background: selected ? "#22436b" : hover ? "#1d1d33" : "transparent",
                opacity: node.hidden || inheritedHidden ? 0.4 : 1,
                boxShadow: dropHint === "before" ? `inset 0 2px 0 ${ui.accent}`
                    : dropHint === "after" ? `inset 0 -2px 0 ${ui.accent}`
                    : dropHint === "inside" ? `inset 0 0 0 1px ${ui.accent}` : undefined,
                borderLeft: selected ? "2px solid #4da3ff" : "2px solid transparent",
                color: selected ? "#f0f6ff" : "#c8c8d8"
            }}
        >
            <span
                onClick={e => { if (hasChildren) { e.stopPropagation(); onToggle(); } }}
                style={{ width: 10, textAlign: "center", color: "#7a7a95", cursor: hasChildren ? "pointer" : "default" }}
            >
                {hasChildren ? (collapsed ? "▸" : "▾") : ""}
            </span>
            <span style={{ width: 12, textAlign: "center", color: selected ? "#9ecbff" : "#8a8aa5" }}>
                {hasChildren ? (isGroup ? "🗀" : "▤") : (LAYER_ICONS[node.type] || "◦")}
            </span>
            {renaming ? (
                <input
                    autoFocus
                    defaultValue={label}
                    onClick={e => e.stopPropagation()}
                    onBlur={e => { setRenaming(false); onRename(e.target.value); }}
                    onKeyDown={e => {
                        if (e.key === "Enter") { setRenaming(false); onRename((e.target as HTMLInputElement).value); }
                        if (e.key === "Escape") setRenaming(false);
                    }}
                    style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "0 2px", background: ui.bg, color: ui.text, border: `1px solid ${ui.accent}`, borderRadius: 2 }}
                />
            ) : (
                <span
                    onDoubleClick={e => { e.stopPropagation(); setRenaming(true); }}
                    style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >{label}</span>
            )}
            {(hover || node.style.opacity < 1) && (
                <input
                    type="number" min={0} max={100} step={5}
                    value={Math.round(node.style.opacity * 100)}
                    title="Opacity %"
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                        const pct = parseFloat(e.target.value);
                        if (!Number.isFinite(pct)) return;
                        onOpacity(Math.min(1, Math.max(0, pct / 100)));
                    }}
                    style={{ width: 34, fontSize: 9, padding: "0 2px", background: ui.bg, color: ui.textDim,
                        border: `1px solid ${ui.line}`, borderRadius: 2 }}
                />
            )}
            <span
                title={inheritedHidden ? "Hidden by a parent" : node.hidden ? "Show" : "Hide"}
                onClick={e => { e.stopPropagation(); if (!inheritedHidden) onFlag({ hidden: !node.hidden }); }}
                style={{ width: 12, textAlign: "center", fontSize: 10, cursor: inheritedHidden ? "default" : "pointer",
                    color: inheritedHidden ? "#4a4a60" : node.hidden ? "#8a8aa5" : "#5f5f7a",
                    opacity: hover || node.hidden || inheritedHidden ? 1 : 0 }}
            >{node.hidden || inheritedHidden ? "◌" : "◉"}</span>
            <span
                title={inheritedLocked ? "Locked by a parent" : node.locked ? "Unlock" : "Lock"}
                onClick={e => { e.stopPropagation(); if (!inheritedLocked) onFlag({ locked: !node.locked }); }}
                style={{ width: 12, textAlign: "center", fontSize: 10, cursor: inheritedLocked ? "default" : "pointer",
                    color: inheritedLocked ? "#4a4a60" : node.locked ? "#d8a657" : "#5f5f7a",
                    opacity: hover || node.locked || inheritedLocked ? 1 : 0 }}
            >{node.locked || inheritedLocked ? "⊘" : "◇"}</span>
            {isAutoLayout && <span title="Auto-layout" style={{ fontSize: 9, color: "#6f9", opacity: 0.8 }}>⇥</span>}
            {node.type === "core.instance" && <span title="Component instance" style={{ fontSize: 9, color: "#b98cff" }}>⧉</span>}
        </div>
    );
}
