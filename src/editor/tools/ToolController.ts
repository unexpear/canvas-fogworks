/**
 * @module ToolController
 * @description Routes pointer events to the active tool. Handles pan, resize, and rotate modes.
 */

import { ActionDispatcher } from "../../core/actions/ActionDispatcher";
import { Action } from "../../core/actions/Action";
import { UpdateNodeGeometryAction } from "../../core/actions/UpdateNodeGeometryAction";
import { UpdateNodeTransformAction } from "../../core/actions/UpdateNodeTransformAction";
import { DeleteNodeAction } from "../../core/actions/DeleteNodeAction";
import { TransactionAction } from "../../core/actions/TransactionAction";
import { EditorState, panBy, screenToWorld, viewportToFit } from "../EditorState";
import { computeGeometry, ComputedState, hitTest, selectionBounds } from "../../core/geometry/GeometryEngine";
import { interactionFor, Trigger } from "../../core/document/Prototype";
import { PICK_RADIUS_PX } from "./SelectTool";
import { handleAtPoint, groupHandleAtPoint, vertexIndexOf, vertexHandleAtPoint, meshIndexOf, meshHandleAtPoint, gradientHandleAtPoint, gradientPointOf, isGradientHandle, GradientHandle } from "../../core/geometry/SelectionHandles";
import { withHandleAt } from "../../core/document/GradientEdit";
import { SetMeshAction } from "../../core/actions/SetMeshAction";
import { movePathVertex, normalizePathNode } from "../../core/geometry/PathBuilder";
import { UpdateNodePathAction } from "../../core/actions/UpdateNodePathAction";
import { rotateGroup, isGroupRotatable, scaleGroup, isGroupResizable, GroupRotateInput, GroupScaleInput } from "../../core/geometry/GroupTransform";
import { resolveScene } from "../../core/document/Components";
import { geometryActionFor, styleActionFor, isHandleOffered, isEditableNode, transformActionFor } from "../../core/actions/nodeEdit";
import { snapPoint, guidesForRect, snapTargetsExcludingSubtree, isTranslationOnlyChain, SNAP_THRESHOLD_PX } from "../../core/geometry/Snapping";
import { Rect, Mat2D, IDENTITY } from "../../core/geometry/Matrix";
import { localLinear, resizeBox, worldDeltaToLocal } from "../../core/geometry/OrientedBox";
import { ReadonlyDocument } from "../../core/document/Document";
import { selectionRoots } from "../../core/document/SceneGraph";

export interface Tool {
    // `computed` is the geometry the controller already resolved for its handle hit-test;
    // a tool that needs geometry should reuse it rather than recompute (see SelectTool.pick).
    onMouseDown?(e: MouseEvent, canvasRect?: DOMRect, computed?: ComputedState): void;
    onMouseMove?(e: MouseEvent, canvasRect?: DOMRect): void;
    onMouseUp?(e: MouseEvent): void;
    onKeyDown?(e: KeyboardEvent): void;
    onKeyUp?(e: KeyboardEvent): void;
    onWheel?(e: WheelEvent, canvasRect?: DOMRect): void;
}

/** Middle mouse button (per the MouseEvent.button spec). */
const MIDDLE_BUTTON = 1;

/** Margin left around a navigated-to frame, in SCREEN px — a prototype screen that touches
 *  every edge reads as clipped rather than framed. */
const NAVIGATE_PADDING_PX = 24;

export class ToolController {
    private activeTool: Tool | null = null;
    private resizeMode = false;
    private resizeNodeId: string | null = null;
    private resizeHandle: string | null = null;
    private resizeOrigin: { x: number; y: number; width: number; height: number } | null = null;
    private resizePreview: { x: number; y: number; width: number; height: number } | null = null;
    private resizeStartX = 0;
    private resizeStartY = 0;
    // Alignment snap targets for the resize, captured at mouse-down when the resizing node's chain
    // is translation-only (world snap delta == stored delta); null disables resize snapping.
    private resizeSnapTargets: Rect[] | null = null;
    // The node's WORLD-minus-STORED origin offset (constant for a translation chain), so the snap
    // (which runs in world) maps to the stored-geometry resize: {0,0} for a top-level node.
    private resizeSnapOffset: { x: number; y: number } = { x: 0, y: 0 };
    // The node's frame AT THE PRESS: its world matrix (world delta → the box's own units), the
    // local rotate∘scale that maps a box vector into PARENT space, and its transform-origin
    // fraction. Captured once rather than re-read per frame, because the live preview changes the
    // very matrix the gesture is measured against — re-reading it would make the box chase itself.
    private resizeWorld: Mat2D = IDENTITY;
    private resizeLinear: Mat2D = IDENTITY;
    private resizeOriginFraction: { x: number; y: number } = { x: 0.5, y: 0.5 };

    // Rotate mode — grabbing the rotate knob spins the node about its world-AABB centre.
    // Each move live-commits a coalesced UpdateNodeTransformAction, so a CONTINUOUS drag is one
    // undo step (subject to the history coalesce window, exactly like a slider drag).
    // Vertex drag — moving one on-curve point of a `core.path`. Live-committed and coalesced
    // like rotate, so a continuous drag is one undo step.
    private vertexNodeId: string | null = null;
    /** The gradient handle being dragged (schema 56), or null. */
    private gradNodeId: string | null = null;
    private gradHandle: GradientHandle | null = null;
    private meshNodeId: string | null = null;
    private meshIndex = 0;
    private meshStartX = 0;
    private meshStartY = 0;
    private vertexIndex = -1;
    private vertexStartX = 0;
    private vertexStartY = 0;
    private rotateMode = false;
    private rotateNodeId: string | null = null;
    private rotateCenterX = 0;
    private rotateCenterY = 0;
    private rotateStartAngle = 0;   // pointer angle about the centre at grab
    private rotateInitial = 0;      // the node's rotation at grab
    // History checkpoint captured at grab (single OR group rotate). Both gestures live-commit per
    // frame, so Escape cancels by rolling history back to here — erasing the gesture's revisions
    // entirely (no undo/redo trace), which is reliable regardless of the coalesce window. null = no
    // gesture / no checkpoint (fall back to a manual revert).
    private rotateCheckpointId: string | null = null;

    // Group rotate — grabbing the GROUP knob spins EVERY selected root rigidly about the group
    // box's centre (each root's rotation gains the same delta AND its centre orbits the pivot; see
    // GroupTransform.rotateGroup). Live-committed as one coalesced TransactionAction per frame, so a
    // continuous drag is one undo step; `groupRotateKey` (the sorted root ids) keys the coalescing.
    private groupRotateMode = false;
    private groupRotateInputs: GroupRotateInput[] = []; // each root's start pose, captured at grab
    private groupPivotX = 0;
    private groupPivotY = 0;
    private groupRotateStartAngle = 0; // pointer angle about the pivot at grab
    private groupRotateKey = "";       // coalesce key = "rotate-group:<sorted root ids>"

    // Group resize — dragging a GROUP corner scales every root proportionally about the
    // opposite (fixed) corner (scaleGroup). Previewed via pendingGeometry (nothing commits
    // until mouse-up → one transaction → one undo; Escape just drops the preview).
    private groupResizeMode = false;
    private groupResizeInputs: GroupScaleInput[] = []; // each root's start geometry, at grab
    private groupResizeHandle = "";                     // the dragged corner ("nw"|"ne"|"sw"|"se")
    private groupResizeBox: Rect = { x: 0, y: 0, width: 0, height: 0 }; // the group box at grab (world)
    private groupResizeStartX = 0;                      // pointer (client px) at grab
    private groupResizeStartY = 0;
    private groupResizePending: Map<string, { x: number; y: number; width: number; height: number }> | null = null;

    // Viewport pan (space+drag or middle-mouse) — a mode that intercepts before the tool,
    // like resize. The gesture is screen-space, so it applies at any zoom and any tool.
    private spaceHeld = false;
    private panMode = false;
    private panLastX = 0;
    private panLastY = 0;

    private dispatcher: ActionDispatcher;
    private editorState: EditorState;
    private refresh: () => void;

    constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void) {
        this.dispatcher = dispatcher;
        this.editorState = editorState;
        this.refresh = refresh;
    }

    setTool(tool: Tool): void {
        this.activeTool = tool;
    }

    onMouseDown(e: MouseEvent, canvasRect: DOMRect): void {
        // Pan takes precedence over everything (any tool, node, or handle): hold Space and drag,
        // or drag with the middle mouse button.
        if (this.spaceHeld || e.button === MIDDLE_BUTTON) {
            this.panMode = true;
            this.panLastX = e.clientX;
            this.panLastY = e.clientY;
            this.editorState.isDragging = true;
            e.preventDefault();
            return;
        }

        // PLAY MODE (M7): the canvas is the prototype, not the editor. A press fires whatever the
        // node under it says to do and nothing else happens — no selection, no handles, no tool.
        // Panning above still works, because navigating a prototype is not editing it.
        if (this.editorState.playing) {
            this.firePlayTrigger(e, canvasRect, "click");
            e.preventDefault();
            return;
        }

        // Handle picking in WORLD space — no DOM read, so it works under any backend (the Canvas
        // surface has no `data-resize-handle` element). Geometry is resolved once here and handed to
        // the active tool on fall-through, so a plain click that misses the handles doesn't recompute
        // it in `SelectTool.pick`. A SINGLE root shows per-node resize+rotate handles; a MULTI-root
        // selection shows only the GROUP rotate knob (group resize is deferred).
        const sel = this.editorState.selectedNodeIds;
        let computed: ComputedState | undefined;
        if (sel.length > 0) {
            const doc = this.dispatcher.getDocument();
            const vp = this.editorState.viewport;
            const w = screenToWorld(vp, canvasRect, e.clientX, e.clientY);
            computed = computeGeometry(doc, this.editorState.pendingGeometry);
            // Roots resolved on the EXPANDED tree so a selected instance COPY survives (a virtual
            // id isn't in the stored map, and `selectionRoots` drops what it can't resolve).
            const roots = selectionRoots(resolveScene(doc), sel);

            if (roots.length >= 2) {
                // Group: the rotate knob (a rotatable group) and the corner handles (a
                // resizable group) — each affordance gated on ITS eligibility, matching what
                // the renderer draws. A hit that isn't acted on falls through to the tool.
                const rotatable = isGroupRotatable(doc, roots);
                const resizable = isGroupResizable(doc, roots);
                const hit = (rotatable || resizable)
                    ? groupHandleAtPoint(computed, roots, w.x, w.y, vp.zoom, resizable)
                    : null;
                if (hit?.handle === "rotate" && rotatable) {
                    this.beginGroupRotate(doc, computed, roots, w.x, w.y);
                    e.preventDefault();
                    return;
                }
                if (hit && hit.handle !== "rotate" && resizable) {
                    this.beginGroupResize(doc, computed, roots, hit.handle, e.clientX, e.clientY);
                    e.preventDefault();
                    return;
                }
                // else fall through: a body click/drag on the multi-selection goes to the tool.
            } else {
                // 0/1 root: per-node handles, hit-tested over `roots` so picking matches drawing.
                // VERTEX handles are checked FIRST: they sit inside the box, so a corner
                // handle would otherwise swallow a vertex that happens to land near it.
                // MESH points are checked FIRST. A warped node resolves to a `core.path`, so it
                // also grows vertex handles for the BENT outline — and dragging one of those
                // would edit the result instead of the cause. The control points are the cause.
                // GRADIENT handles are checked FIRST, above the vertices, for the same reason
                // the vertices sit above the corners: they are drawn on top and they are inside
                // the box, so anything checked before them would swallow the grab.
                const hit = gradientHandleAtPoint(doc, computed, roots, w.x, w.y, vp.zoom)
                    ?? meshHandleAtPoint(doc, computed, roots, w.x, w.y, vp.zoom)
                    ?? vertexHandleAtPoint(doc, computed, roots, w.x, w.y, vp.zoom)
                    ?? handleAtPoint(computed, roots, w.x, w.y, vp.zoom);
                const c = hit ? computed.nodes.get(hit.nodeId) : undefined;
                // Resolved against the EXPANDED document so an instance COPY's handles work: its
                // geometry (master + any existing override) is only visible there. The resize
                // COMMIT routes through `geometryActionFor`, which writes an override for it.
                const node = hit ? resolveScene(doc).nodes.get(hit.nodeId) : undefined;
                if (hit && c && node) {
                    if (!isHandleOffered(doc, hit.nodeId, hit.handle)) {
                        // An instance COPY offers only the handles whose edit it can record: no
                        // rotate knob (a TRANSFORM override is a later slice), and nothing at all
                        // for a copy nested inside another instance's expansion. The renderer
                        // draws exactly this set, so falling through to the tool is what the user
                        // sees — better than a control that silently does nothing.
                        this.activeTool?.onMouseDown?.(e, canvasRect, computed);
                        return;
                    }
                    if (isGradientHandle(hit.handle)) {
                        this.gradNodeId = hit.nodeId;
                        this.gradHandle = hit.handle;
                        this.editorState.isDragging = true;
                        e.preventDefault();
                        return;
                    }
                    const mi = meshIndexOf(hit.handle);
                    if (mi !== null) {
                        this.meshNodeId = hit.nodeId;
                        this.meshIndex = mi;
                        this.meshStartX = w.x;
                        this.meshStartY = w.y;
                        this.editorState.isDragging = true;
                        e.preventDefault();
                        return;
                    }
                    const vi = vertexIndexOf(hit.handle);
                    if (vi !== null) {
                        this.vertexNodeId = hit.nodeId;
                        this.vertexIndex = vi;
                        this.vertexStartX = w.x;
                        this.vertexStartY = w.y;
                        this.editorState.isDragging = true;
                        e.preventDefault();
                        return;
                    }
                    if (hit.handle === "rotate") {
                        // Spin about the world-AABB centre (= the default centre transform-origin).
                        this.rotateMode = true;
                        this.rotateNodeId = hit.nodeId;
                        this.rotateCenterX = c.bounds.x + c.bounds.width / 2;
                        this.rotateCenterY = c.bounds.y + c.bounds.height / 2;
                        this.rotateInitial = node.transform?.rotation ?? 0;
                        this.rotateStartAngle = Math.atan2(w.y - this.rotateCenterY, w.x - this.rotateCenterX);
                        this.rotateCheckpointId = this.dispatcher.getHistoryCheckpoint(); // pre-gesture head, for Escape
                        this.editorState.isDragging = true;
                        e.preventDefault();
                        return;
                    }
                    this.resizeMode = true;
                    this.resizeNodeId = hit.nodeId;
                    this.resizeHandle = hit.handle;
                    this.resizeStartX = e.clientX;
                    this.resizeStartY = e.clientY;
                    this.resizeOrigin = {
                        x: node.geometry.x,
                        y: node.geometry.y,
                        width: node.geometry.width,
                        height: node.geometry.height
                    };
                    // The gesture's reference frame. `resizeLinear` = parentWorld⁻¹ · world,
                    // linear part only: the box→parent map, which is what the stored x/y are in.
                    // Derived from the matrices the ENGINE published rather than re-deriving
                    // rotate∘scale from the node's fields, so the two conventions cannot drift.
                    this.resizeWorld = c.world;
                    const parentWorld = node.parent ? computed.nodes.get(node.parent)?.world ?? IDENTITY : IDENTITY;
                    this.resizeLinear = localLinear(parentWorld, c.world);
                    this.resizeOriginFraction = {
                        x: node.transform?.origin?.x ?? 0.5,
                        y: node.transform?.origin?.y ?? 0.5
                    };
                    // Enable snapping for a translation-only chain (world snap delta == stored delta),
                    // capturing the constant world↔stored origin offset so the world snap maps to stored.
                    if (isTranslationOnlyChain(doc, hit.nodeId)) {
                        this.resizeSnapTargets = snapTargetsExcludingSubtree(doc, computed, hit.nodeId);
                        this.resizeSnapOffset = { x: c.bounds.x - node.geometry.x, y: c.bounds.y - node.geometry.y };
                    } else {
                        this.resizeSnapTargets = null;
                    }
                    e.preventDefault();
                    return;
                }
            }
        }

        this.activeTool?.onMouseDown?.(e, canvasRect, computed);
    }

    /**
     * Fire the interaction under the pointer, if any (play mode).
     *
     * Picking is the ORDINARY `hitTest`, so a prototype responds to the shape you can see — the
     * empty corner of a triangle passes the click through to whatever is behind it, exactly as it
     * does while editing. A node with no matching interaction is not a miss to report; a
     * prototype is mostly non-interactive surface.
     *
     * The transition is recorded with the CURRENT active state as its origin, so a run of clicks
     * always animates from where the screen actually is rather than from where the last one
     * started. Duration 0 means no transition at all — the app applies the state and is done.
     */
    private firePlayTrigger(e: MouseEvent, canvasRect: DOMRect, trigger: Trigger): boolean {
        const doc = this.dispatcher.getDocument();
        const computed = computeGeometry(doc);
        const vp = this.editorState.viewport;
        const w = screenToWorld(vp, canvasRect, e.clientX, e.clientY);
        const hit = hitTest(computed, w.x, w.y, PICK_RADIUS_PX / Math.max(0.01, vp.zoom));
        if (!hit) return false;
        // The scene is the RESOLVED one (an instance's copy is what a prototype user clicks), so
        // the interaction is read from the resolved node — a copy inherits its master's.
        const node = resolveScene(doc).nodes.get(hit);
        const interaction = node ? interactionFor(node, trigger) : null;
        if (!interaction) return false;

        const from = this.editorState.playState;
        this.editorState.playState = interaction.state;
        const duration = interaction.duration ?? 0;
        const easing = interaction.easing ?? "linear";
        this.editorState.transition = duration > 0
            ? { from, to: interaction.state, startedAt: Date.now(), duration, easing }
            : null;

        // NAVIGATION (schema 36): move the viewport to fit the target. A dangling target simply
        // does not navigate — the same inert-reference rule the state name follows — so deleting
        // a frame degrades the prototype rather than breaking the document.
        const targetBounds = interaction.target ? computed.nodes.get(interaction.target)?.bounds : undefined;
        if (targetBounds) {
            const to = viewportToFit(targetBounds, { width: canvasRect.width, height: canvasRect.height }, NAVIGATE_PADDING_PX, vp.zoom);
            if (duration > 0) {
                this.editorState.viewportTransition = { from: { ...vp }, to, startedAt: Date.now(), duration, easing };
            } else {
                this.editorState.viewportTransition = null;
                Object.assign(this.editorState.viewport, to);
            }
        }
        this.refresh();
        return true;
    }

    onMouseMove(e: MouseEvent, canvasRect: DOMRect): void {
        // Play mode: a move is a HOVER trigger and nothing else — no drag, no marquee, no handles.
        if (this.editorState.playing) {
            this.firePlayTrigger(e, canvasRect, "hover");
            return;
        }

        if (this.panMode) {
            panBy(this.editorState.viewport, e.clientX - this.panLastX, e.clientY - this.panLastY);
            this.panLastX = e.clientX;
            this.panLastY = e.clientY;
            this.refresh();
            return;
        }

        if (this.meshNodeId !== null) {
            const doc = this.dispatcher.getDocument();
            // The node's OWN mesh, from the stored document rather than the resolved scene: the
            // resolved one has had its mesh removed, the bend being in its commands by then.
            const node = doc.nodes.get(this.meshNodeId);
            if (!node?.mesh) { this.meshNodeId = null; this.refresh(); return; }
            const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
            const dx = w.x - this.meshStartX;
            const dy = w.y - this.meshStartY;
            this.meshStartX = w.x;
            this.meshStartY = w.y;
            // The delta is world-space and the points are FRACTIONS of the box (schema 43), so it
            // is divided by the box as well as being local-only. Correct exactly while the node is
            // translation-only — the same limit the vertex drag states, and refused the same way
            // rather than silently skewed.
            const bw = node.geometry.width, bh = node.geometry.height;
            // A zero-sized box has no fraction to express a drag in. Refusing the drag leaves the
            // mesh alone, which is better than dividing by zero and writing NaN into the document
            // — `meshError` would then reject it on the next load.
            if (bw === 0 || bh === 0) { this.refresh(); return; }
            const points = node.mesh.points.map((p, i) =>
                i === this.meshIndex
                    ? { ...p, x: p.x + dx / bw, y: p.y + dy / bh }
                    : { ...p });
            this.dispatcher.dispatchAction(
                new SetMeshAction(doc, this.meshNodeId, { cols: node.mesh.cols, rows: node.mesh.rows, points }),
                { coalesce: true });
            this.refresh();
            return;
        }

        if (this.gradNodeId !== null && this.gradHandle !== null) {
            const doc = this.dispatcher.getDocument();
            const node = resolveScene(doc).nodes.get(this.gradNodeId);
            // RE-DERIVED each move rather than captured at pointer-down: the ramp lives in the
            // node's own space, so a node that moves under the drag (a nudge, an undo) must move
            // the mapping with it. `computeGeometry` is what every other gesture here re-runs too.
            const c = computeGeometry(doc).nodes.get(this.gradNodeId);
            const fill = node?.style.fill;
            // The fill stopped being a gradient mid-drag (an undo, the inspector) — end the
            // gesture rather than writing a ramp onto a colour.
            if (!node || !c || fill === undefined || typeof fill === "string") {
                this.resetGradient(); this.refresh(); return;
            }
            const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
            // ABSOLUTE, not a delta. The pointer is mapped back through the SAME matrix the handle
            // was drawn with, so the handle stays under the cursor however the node is rotated or
            // scaled — a world-space delta would need that matrix anyway and would drift.
            const p = gradientPointOf(fill, c.world, c.local, w.x, w.y);
            if (!p) return;
            const next = withHandleAt(fill, this.gradHandle, p.x, p.y);
            if (!next) return;
            const action = styleActionFor(doc, this.gradNodeId, { fill: next });
            if (action) this.dispatcher.dispatchAction(action, { coalesce: true });
            this.refresh();
            return;
        }

        if (this.vertexNodeId !== null) {
            const doc = this.dispatcher.getDocument();
            const node = resolveScene(doc).nodes.get(this.vertexNodeId);
            if (!node?.path) { this.resetVertex(); this.refresh(); return; }
            const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
            // The delta is measured in WORLD space but applied to LOCAL commands, so it is only
            // correct while the node is translation-only — a rotated or scaled path would need
            // the inverse of its world matrix. Refused rather than silently skewed.
            const dx = w.x - this.vertexStartX;
            const dy = w.y - this.vertexStartY;
            this.vertexStartX = w.x;
            this.vertexStartY = w.y;
            const moved = movePathVertex(node.path, this.vertexIndex, dx, dy);
            // Re-normalize: dragging outward otherwise leaves ink outside the node's box, and
            // bounds are what selection, snapping, culling and hit-testing all read.
            const norm = normalizePathNode(node.geometry, moved);
            const geo = geometryActionFor(doc, this.vertexNodeId, { x: norm.geometry.x, y: norm.geometry.y, width: norm.geometry.width, height: norm.geometry.height });
            const actions: Action[] = [];
            if (geo) actions.push(geo);
            actions.push(new UpdateNodePathAction(doc, this.vertexNodeId, norm.path));
            this.dispatcher.dispatchAction(new TransactionAction(doc, `vertex:${this.vertexNodeId}`, actions), { coalesce: true });
            this.refresh();
            return;
        }

        if (this.rotateMode && this.rotateNodeId) {
            const doc = this.dispatcher.getDocument();
            // The node vanished mid-drag (e.g. deleted by a keyboard shortcut): end the gesture
            // AND clear the drag-cursor flag, or it stays stuck on "grabbing".
            if (!isEditableNode(doc, this.rotateNodeId)) { this.resetRotate(); this.editorState.isDragging = false; this.refresh(); return; }
            const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
            const angle = Math.atan2(w.y - this.rotateCenterY, w.x - this.rotateCenterX);
            const rotation = this.rotateInitial + (angle - this.rotateStartAngle);
            // Live-commit, coalesced → a continuous drag is one undo step; onChange repaints.
            const rotateAction = transformActionFor(doc, this.rotateNodeId, { rotation });
            if (rotateAction) this.dispatcher.dispatchAction(rotateAction, { coalesce: true });
            return;
        }

        if (this.groupRotateMode) {
            const doc = this.dispatcher.getDocument();
            // Every root vanished mid-drag → end the gesture AND clear the drag-cursor flag.
            if (!this.groupRotateInputs.some(n => doc.nodes.has(n.id))) {
                this.resetGroupRotate(); this.editorState.isDragging = false; this.refresh(); return;
            }
            const w = screenToWorld(this.editorState.viewport, canvasRect, e.clientX, e.clientY);
            const angle = Math.atan2(w.y - this.groupPivotY, w.x - this.groupPivotX);
            // Absolute delta from the start angle → each frame recomputes from the captured poses, so
            // nothing compounds; live-committed coalesced (one undo for the drag). onChange repaints.
            this.commitGroupRotate(angle - this.groupRotateStartAngle);
            return;
        }

        if (this.groupResizeMode) {
            const doc = this.dispatcher.getDocument();
            const live = this.groupResizeInputs.filter(n => doc.nodes.has(n.id));
            if (live.length === 0) { // every root vanished mid-drag → abort cleanly
                this.resetGroupResize(); this.refresh(); return;
            }
            const zoom = Math.max(0.01, this.editorState.viewport.zoom);
            const dx = (e.clientX - this.groupResizeStartX) / zoom;
            const dy = (e.clientY - this.groupResizeStartY) / zoom;
            const { fixedX, fixedY, sx, sy } = this.groupScaleFactors(dx, dy);
            // Preview via pendingGeometry — absolute from the captured poses, nothing commits.
            const pending = new Map<string, { x: number; y: number; width: number; height: number }>();
            for (const p of scaleGroup(fixedX, fixedY, sx, sy, live)) {
                pending.set(p.id, { x: p.x, y: p.y, width: p.width, height: p.height });
            }
            this.groupResizePending = pending;
            this.editorState.pendingGeometry = pending;
            this.refresh();
            return;
        }

        if (this.resizeMode && this.resizeNodeId && this.resizeHandle && this.resizeOrigin) {
            const zoom = Math.max(0.01, this.editorState.viewport.zoom);
            let dx = (e.clientX - this.resizeStartX) / zoom;
            let dy = (e.clientY - this.resizeStartY) / zoom;

            const doc = this.dispatcher.getDocument();
            // Liveness against the EXPANDED tree: an instance COPY is legitimately absent from the
            // stored map, and reading that as "deleted mid-drag" aborts the resize on its very
            // first frame — the same trap MoveTool's preview loop had.
            if (!resolveScene(doc).nodes.has(this.resizeNodeId)) { this.resetResize(); this.refresh(); return; }

            // Alignment snapping: pull the DRAGGED corner (the fixed corner stays put) onto a
            // nearby target edge/centre, then recompute the box from the adjusted delta. The corner
            // and guides run in WORLD (stored + offset); the snap delta applies 1:1 to stored.
            const off = this.resizeSnapOffset;
            if (this.resizeSnapTargets) {
                const corner = this.movingCorner(this.resizeHandle, this.resizeOrigin);
                const snap = snapPoint(corner.x + off.x + dx, corner.y + off.y + dy, this.resizeSnapTargets, SNAP_THRESHOLD_PX / zoom);
                dx += snap.dx;
                dy += snap.dy;
            }

            // Into the node's OWN units. A rotated node's handles sit on its turned corners, so a
            // drag has to be read along those axes — applying the world delta straight to
            // width/height made a turned node grow sideways relative to the direction dragged.
            const d = worldDeltaToLocal(this.resizeWorld, dx, dy);
            // Preview via geometry override — no document mutation until commit.
            const g = resizeBox(this.resizeHandle, this.resizeOrigin, d, this.resizeLinear, this.resizeOriginFraction);
            this.resizePreview = g;
            this.editorState.pendingGeometry = new Map([[this.resizeNodeId, g]]);
            if (this.resizeSnapTargets) {
                const worldBox = { x: g.x + off.x, y: g.y + off.y, width: g.width, height: g.height };
                const guides = guidesForRect(worldBox, this.resizeSnapTargets);
                this.editorState.snapGuides = guides.length > 0 ? guides : null;
            }

            this.refresh();
            return;
        }

        // Idle hover (no button held, no active gesture): reflect the handle under the pointer as a
        // cursor. The Canvas backend can't set a per-region cursor the way SVG's per-element `cursor`
        // does, so the app reads this. Only recompute when a selection has handles to hover.
        if ((e.buttons & 1) === 0) this.updateHoverCursor(e, canvasRect);

        this.activeTool?.onMouseMove?.(e, canvasRect);
    }

    /** Set `editorState.hoverCursor` to the cursor of the handle under an idle pointer (or null). */
    private updateHoverCursor(e: MouseEvent, canvasRect: DOMRect): void {
        const sel = this.editorState.selectedNodeIds;
        let cursor: string | null = null;
        if (sel.length > 0) {
            const doc = this.dispatcher.getDocument();
            const vp = this.editorState.viewport;
            const w = screenToWorld(vp, canvasRect, e.clientX, e.clientY);
            const computed = computeGeometry(doc, this.editorState.pendingGeometry);
            // Expanded, exactly like onMouseDown: on the stored document `selectionRoots` drops a
            // selected instance COPY, so the pointer would stay an arrow over handles that ARE
            // drawn and ARE grabbable — and a MIXED selection would take the single-root branch
            // here while the press takes the group branch, promising a grab that doesn't exist.
            const roots = selectionRoots(resolveScene(doc), sel);
            // Match onMouseDown's picking exactly: each group affordance is gated on its own
            // eligibility — so the hover cursor reflects what a press would actually grab.
            if (roots.length >= 2) {
                const rotatable = isGroupRotatable(doc, roots);
                const resizable = isGroupResizable(doc, roots);
                const hit = (rotatable || resizable)
                    ? groupHandleAtPoint(computed, roots, w.x, w.y, vp.zoom, resizable)
                    : null;
                const actionable = hit && (hit.handle === "rotate" ? rotatable : resizable);
                cursor = actionable ? hit.cursor : null;
            } else {
                const hit = handleAtPoint(computed, roots, w.x, w.y, vp.zoom);
                // Same `isHandleOffered` gate the press and the renderer use — a copy's rotate
                // knob is neither drawn nor grabbable, so it must not show a cursor either.
                cursor = hit && isHandleOffered(doc, hit.nodeId, hit.handle) ? hit.cursor : null;
            }
        }
        if (cursor !== this.editorState.hoverCursor) {
            this.editorState.hoverCursor = cursor;
            this.refresh(); // only repaint on a change, not on every idle pixel
        }
    }

    /** Capture each root's start pose + the group pivot (box centre) for a group-rotate gesture. */
    private beginGroupRotate(doc: ReadonlyDocument, computed: ComputedState, roots: string[], wx: number, wy: number): void {
        const box = selectionBounds(computed, roots);
        if (!box) return; // no finite group box — nothing to rotate (the knob hit implies one exists)
        const inputs: GroupRotateInput[] = [];
        for (const id of roots) {
            const c = computed.nodes.get(id);
            const node = doc.nodes.get(id);
            if (!c || !node) continue;
            inputs.push({
                id,
                startX: node.geometry.x,
                startY: node.geometry.y,
                startRotation: node.transform?.rotation ?? 0,
                centerX: c.bounds.x + c.bounds.width / 2,   // == the box centre for a centre-origin node
                centerY: c.bounds.y + c.bounds.height / 2
            });
        }
        if (inputs.length === 0) return;
        this.groupPivotX = box.x + box.width / 2;
        this.groupPivotY = box.y + box.height / 2;
        this.groupRotateStartAngle = Math.atan2(wy - this.groupPivotY, wx - this.groupPivotX);
        this.groupRotateInputs = inputs;
        this.rotateCheckpointId = this.dispatcher.getHistoryCheckpoint(); // pre-gesture head, for Escape
        // Gesture-specific coalesce key (sorted so it's stable), so a continuous drag collapses to one
        // undo but two DIFFERENT group selections don't merge (see HistoryManager.coalesceKey).
        this.groupRotateKey = `rotate-group:${[...roots].sort().join(",")}`;
        this.groupRotateMode = true;
        this.editorState.isDragging = true;
    }

    /**
     * Live-commit the group rotation at `delta` radians: one atomic, coalesced transaction of a
     * geometry (orbit) + transform (rotation) update per surviving root. Absolute in `delta`, so the
     * caller passes the total delta from the start angle and frames don't compound. A no-op when
     * every root has vanished (the move/up handlers detect that and end the gesture).
     */
    private commitGroupRotate(delta: number): void {
        const doc = this.dispatcher.getDocument();
        const live = this.groupRotateInputs.filter(n => doc.nodes.has(n.id));
        if (live.length === 0) return;
        const poses = rotateGroup(this.groupPivotX, this.groupPivotY, delta, live);
        const actions: Action[] = [];
        for (const p of poses) {
            actions.push(new UpdateNodeGeometryAction(doc, p.id, { x: p.x, y: p.y }));
            actions.push(new UpdateNodeTransformAction(doc, p.id, { rotation: p.rotation }));
        }
        this.dispatcher.dispatchAction(new TransactionAction(doc, this.groupRotateKey, actions), { coalesce: true });
    }

    private resetGroupRotate(): void {
        this.groupRotateMode = false;
        this.groupRotateInputs = [];
        this.rotateCheckpointId = null;
    }

    /** Capture the group box + each root's start geometry for a group-resize gesture. */
    private beginGroupResize(doc: ReadonlyDocument, computed: ComputedState, roots: string[], handle: string, clientX: number, clientY: number): void {
        const box = selectionBounds(computed, roots);
        if (!box) return;
        const inputs: GroupScaleInput[] = [];
        for (const id of roots) {
            const node = doc.nodes.get(id);
            const c = computed.nodes.get(id);
            if (!node || !c) continue;
            inputs.push({
                id,
                startX: node.geometry.x,
                startY: node.geometry.y,
                worldX: c.bounds.x,
                worldY: c.bounds.y,
                startWidth: node.geometry.width,
                startHeight: node.geometry.height
            });
        }
        if (inputs.length === 0) return;
        this.groupResizeMode = true;
        this.groupResizeInputs = inputs;
        this.groupResizeHandle = handle;
        this.groupResizeBox = box;
        this.groupResizeStartX = clientX;
        this.groupResizeStartY = clientY;
        this.editorState.isDragging = true;
    }

    /**
     * Scale factors + the FIXED corner for the current drag: the dragged corner follows the
     * pointer, the opposite corner stays put, and the group extent clamps at `min(1 world unit,
     * the STARTING extent)` per axis — no flip (mirroring member positions while their content
     * stays unmirrored would misrepresent the gesture; the single-node resize CAN flip because
     * one box has no layout). The floor is capped at the starting extent so a SUB-unit group
     * (two lines 0.5 apart) isn't force-grown to 1 by a drag on the other axis; a ZERO-extent
     * axis (a group of collinear zero-height lines) locks at s=1 — dividing by it would make
     * Infinity, NaN out the whole preview, and silently void the commit (review-confirmed).
     */
    private groupScaleFactors(dx: number, dy: number): { fixedX: number; fixedY: number; sx: number; sy: number } {
        const b = this.groupResizeBox;
        const h = this.groupResizeHandle;
        const west = h === "nw" || h === "sw";   // dragging a LEFT corner → the RIGHT edge is fixed
        const north = h === "nw" || h === "ne";  // dragging a TOP corner → the BOTTOM edge is fixed
        const fixedX = west ? b.x + b.width : b.x;
        const fixedY = north ? b.y + b.height : b.y;
        const movingX = (west ? b.x : b.x + b.width) + dx;
        const movingY = (north ? b.y : b.y + b.height) + dy;
        const newW = Math.max(Math.min(1, b.width), west ? fixedX - movingX : movingX - fixedX);
        const newH = Math.max(Math.min(1, b.height), north ? fixedY - movingY : movingY - fixedY);
        return {
            fixedX, fixedY,
            sx: b.width > 0 ? newW / b.width : 1,   // degenerate axis → locked, the other still scales
            sy: b.height > 0 ? newH / b.height : 1
        };
    }

    private resetGroupResize(): void {
        this.groupResizeMode = false;
        this.groupResizeInputs = [];
        this.groupResizePending = null;
        this.editorState.pendingGeometry = null;
        this.editorState.isDragging = false;
    }

    private resetGradient(): void {
        this.gradNodeId = null;
        this.gradHandle = null;
        this.editorState.isDragging = false;
    }

    private resetVertex(): void {
        this.vertexNodeId = null;
        this.meshNodeId = null;
        this.vertexIndex = -1;
    }

    onMouseUp(e: MouseEvent): void {
        if (this.gradNodeId !== null) this.resetGradient();
        if (this.meshNodeId !== null) { this.meshNodeId = null; this.editorState.isDragging = false; }
        if (this.vertexNodeId !== null) { this.resetVertex(); this.editorState.isDragging = false; }
        if (this.panMode) {
            this.panMode = false;
            this.editorState.isDragging = false;
            this.refresh();
            return;
        }


        if (this.rotateMode) {
            // The rotation was already live-committed (coalesced) during the drag; just end.
            this.resetRotate();
            this.editorState.isDragging = false;
            this.refresh();
            return;
        }

        if (this.groupRotateMode) {
            // The group rotation was already live-committed (coalesced) during the drag; just end.
            this.resetGroupRotate();
            this.editorState.isDragging = false;
            this.refresh();
            return;
        }

        if (this.groupResizeMode) {
            // Commit the previewed scale as ONE transaction (one undo restores the whole group).
            const doc = this.dispatcher.getDocument();
            const pending = this.groupResizePending;
            if (pending) {
                const actions: Action[] = [];
                pending.forEach((g, id) => {
                    if (doc.nodes.has(id)) actions.push(new UpdateNodeGeometryAction(doc, id, g));
                });
                if (actions.length === 1) this.dispatcher.dispatchAction(actions[0]);
                else if (actions.length > 1) this.dispatcher.dispatchAction(new TransactionAction(doc, "resize-group", actions));
            }
            this.resetGroupResize();
            this.refresh();
            return;
        }

        if (this.resizeMode && this.resizeNodeId) {
            const doc = this.dispatcher.getDocument();
            // Routed: a stored node commits a geometry edit, an instance COPY commits a
            // per-instance override. Null means the target vanished — commit nothing.
            const action = this.resizePreview ? geometryActionFor(doc, this.resizeNodeId, this.resizePreview) : null;
            if (action) {
                this.dispatcher.dispatchAction(action);
            }
            this.resetResize();
            this.refresh();
            return;
        }

        this.activeTool?.onMouseUp?.(e);
    }

    onKeyDown(e: KeyboardEvent): void {
        const target = e.target as HTMLElement;
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;

        // Hold Space to pan on the next drag; swallow it so the page doesn't scroll.
        if (e.key === " ") {
            this.spaceHeld = true;
            e.preventDefault();
            return;
        }

        if (e.key === "Escape") {
            if (this.resizeMode) {
                this.resetResize();
                this.refresh();
                return;
            }
            if (this.rotateMode && this.rotateNodeId) {
                // Cancel = roll history back to the checkpoint captured at grab, which erases the
                // gesture's live-committed revisions entirely (no undo AND no redo trace), reliably
                // and independent of the coalesce window. Fallback (checkpoint trimmed, ~never):
                // revert the angle the old way.
                if (!this.cancelGesture()) {
                    const doc = this.dispatcher.getDocument();
                    const revert = transformActionFor(doc, this.rotateNodeId, { rotation: this.rotateInitial });
                    if (revert) this.dispatcher.dispatchAction(revert, { coalesce: true });
                }
                this.resetRotate();
                this.editorState.isDragging = false;
                this.refresh();
                return;
            }
            if (this.groupRotateMode) {
                // Same as single rotate: roll history back to the grab checkpoint (erases the
                // gesture's revisions). Fallback: revert every root's pose via rotateGroup(delta 0).
                if (!this.cancelGesture()) this.commitGroupRotate(0);
                this.resetGroupRotate();
                this.editorState.isDragging = false;
                this.refresh();
                return;
            }
            if (this.groupResizeMode) {
                // Preview-only gesture (like single resize): nothing committed — drop the preview.
                this.resetGroupResize();
                this.refresh();
                return;
            }
        }

        if (e.key === "Delete" || e.key === "Backspace") {
            this.deleteSelectedNodes();
            return;
        }

        this.activeTool?.onKeyDown?.(e);
    }

    onKeyUp(e: KeyboardEvent): void {
        // Releasing Space stops the NEXT drag from panning; a pan already in progress
        // keeps going until mouse-up (the usual behaviour).
        if (e.key === " ") this.spaceHeld = false;
        this.activeTool?.onKeyUp?.(e);
    }

    /**
     * New geometry for a corner drag, computed from the fixed opposite corner
     * and the moving corner so the rect flips (rather than pinning at 1px) when
     * the pointer crosses an edge.
     */
    private computeResizedGeometry(
        handle: string,
        o: { x: number; y: number; width: number; height: number },
        dx: number,
        dy: number
    ): { x: number; y: number; width: number; height: number } {
        let fixedX: number, fixedY: number, movingX: number, movingY: number;
        if (handle === "se") {
            fixedX = o.x; fixedY = o.y;
            movingX = o.x + o.width + dx; movingY = o.y + o.height + dy;
        } else if (handle === "nw") {
            fixedX = o.x + o.width; fixedY = o.y + o.height;
            movingX = o.x + dx; movingY = o.y + dy;
        } else if (handle === "ne") {
            fixedX = o.x; fixedY = o.y + o.height;
            movingX = o.x + o.width + dx; movingY = o.y + dy;
        } else { // sw
            fixedX = o.x + o.width; fixedY = o.y;
            movingX = o.x + dx; movingY = o.y + o.height + dy;
        }
        return {
            x: Math.min(fixedX, movingX),
            y: Math.min(fixedY, movingY),
            width: Math.max(1, Math.abs(movingX - fixedX)),
            height: Math.max(1, Math.abs(movingY - fixedY))
        };
    }

    /** The corner a resize handle DRAGS (the fixed corner is the opposite), in stored coords. */
    private movingCorner(handle: string, o: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
        const right = o.x + o.width, bottom = o.y + o.height;
        if (handle === "se") return { x: right, y: bottom };
        if (handle === "ne") return { x: right, y: o.y };
        if (handle === "sw") return { x: o.x, y: bottom };
        return { x: o.x, y: o.y }; // nw
    }

    private resetResize(): void {
        this.resizeMode = false;
        this.resizeNodeId = null;
        this.resizeHandle = null;
        this.resizeOrigin = null;
        this.resizePreview = null;
        this.resizeSnapTargets = null;
        this.editorState.pendingGeometry = null;
        this.editorState.snapGuides = null;
    }

    /**
     * Cancel a live-committed rotate by rolling history back to the checkpoint captured at grab —
     * erasing the gesture's revisions entirely (undoable AND redoable). Returns false when there is no
     * checkpoint or it was trimmed, so the caller can fall back to a manual revert. A grab with no
     * committed frame rolls back to the same head → a true no-op (no spurious revision).
     */
    private cancelGesture(): boolean {
        return this.rotateCheckpointId !== null && this.dispatcher.rollbackToCheckpoint(this.rotateCheckpointId);
    }

    private resetRotate(): void {
        this.rotateMode = false;
        this.rotateNodeId = null;
        this.rotateCheckpointId = null;
    }

    private deleteSelectedNodes(): void {
        const ids = [...this.editorState.selectedNodeIds];
        if (ids.length === 0) return;
        const doc = this.dispatcher.getDocument();

        // Delete only the roots of the selection: a selected node whose ancestor
        // is also selected would be cascade-deleted by that ancestor, and asking
        // to delete it again would fail the atomic transaction.
        const roots = selectionRoots(doc, ids);

        this.editorState.selectedNodeIds = [];
        if (roots.length === 1) {
            this.dispatcher.dispatchAction(new DeleteNodeAction(doc, roots[0]));
        } else if (roots.length > 1) {
            // One transaction → one undo restores the whole deleted selection.
            this.dispatcher.dispatchAction(new TransactionAction(
                doc,
                "delete-nodes",
                roots.map(id => new DeleteNodeAction(doc, id))
            ));
        }
        this.refresh();
    }

    onWheel(e: WheelEvent, canvasRect: DOMRect): void {
        this.activeTool?.onWheel?.(e, canvasRect);
    }
}
