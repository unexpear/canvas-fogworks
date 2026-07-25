/**
 * @module apiSurface
 * @description Compile-time pin for the public API surface documented in
 * `docs/API-CONTRACTS.md`.
 *
 * This file is never executed — it exists so that `tsc` fails if a documented
 * symbol is renamed, removed, or changes shape. It is the same move the engine
 * already uses elsewhere: turn a convention into something the compiler checks.
 *
 * WHY: `docs/API-CONTRACTS.md` drifted three times in one pass while the freeze
 * rule was nominally in force, and the drift was found by accident. An identifier
 * checker was measured against that drift and caught 0 of 4 cases, because the
 * drift was semantic — `ProjectDocument` still existed, it was just no longer the
 * right type. A type-level assertion catches exactly that class.
 *
 * SCOPE — be honest about what this does and does not cover:
 *   ✓ a documented export disappearing or being renamed
 *   ✓ a documented signature changing shape (params, return, readonly-ness)
 *   ✗ prose that describes behaviour which has since changed
 * Prose drift is still caught only by review.
 */

import {
    ProjectDocument, ReadonlyDocument, createEmptyDocument,
    CURRENT_VERSION, SCHEMA_VERSION
} from "../document/Document";
import { Node, NodeType, NODE_TYPES, isNodeType, LayoutContainer, LayoutGrid, TrackSize, Constraints, HConstraint, VConstraint, Margins, layoutError, dimensionError, pathError, PathCommand, PATH_MAX_COMMANDS, Layout } from "../document/Node";
import {
    serializeDocument, deserializeDocument, compareDocuments, Serializer,
    LoadResult, SaveResult
} from "../document/Serializer";
import { traverseSceneGraph, selectionRoots, ReadonlyNode } from "../document/SceneGraph";
import { validateDocumentIntegrity } from "../document/Integrity";
import { computeGeometry, hitTest, toLocal, toWorld, subtreeBounds, selectionBounds, ComputedState, ComputedNode } from "../geometry/GeometryEngine";
import { layoutChildren, layoutGridChildren, resolveGridTracks, placeGridItems, GridCell, breakFlexLines, FlexLine, resolveMargin, expandDirtyForLayout, isLayoutContainer, isAbsolute, measureIntrinsicSizes, resolveConstraints } from "../geometry/LayoutEngine";
import { Mat2D, Rect, IDENTITY, multiply, translation, invert, compose, applyToPoint, transformRectToAABB, unionRect, toMatrixString, isTranslationOnly } from "../geometry/Matrix";
import { Action } from "../actions/Action";
import { MutationResult, NodeDelta, ActionPayload, Revision, DocumentSnapshot } from "../actions/types";
import { applyMutationsToDocument } from "../actions/applyMutations";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { HistoryManager, HistoryLimits, DEFAULT_HISTORY_LIMITS } from "../actions/HistoryManager";
import { AddNodeAction } from "../actions/AddNodeAction";
import { DeleteNodeAction } from "../actions/DeleteNodeAction";
import { MoveNodeAction } from "../actions/MoveNodeAction";
import { ResizeNodeAction } from "../actions/ResizeNodeAction";
import { ReparentNodeAction } from "../actions/ReparentNodeAction";
import { UpdateNodeGeometryAction } from "../actions/UpdateNodeGeometryAction";
import { UpdateNodeStyleAction } from "../actions/UpdateNodeStyleAction";
import { UpdateNodeTransformAction } from "../actions/UpdateNodeTransformAction";
import { UpdateNodeLayoutAction } from "../actions/UpdateNodeLayoutAction";
import { TransactionAction } from "../actions/TransactionAction";
import { createEditorState, clampViewport, EditorState } from "../../editor/EditorState";
import { renderSVG, RendererState } from "../../renderer/SVGRenderer";
import { buildRenderModel, DisplayList, DrawItem, Shape, Paint, commandsToPathData } from "../../renderer/RenderModel";
import { emitSVG } from "../../renderer/emitSVG";

/**
 * Assert an expression is ASSIGNABLE to the documented type.
 *
 * Note the limit: assignability is one-directional. `expectType<ReadonlyDocument>(x)`
 * passes even if `x` is the *mutable* `ProjectDocument`, because mutable widens to
 * readonly. Verified empirically — reverting `getDocument()` to `ProjectDocument`
 * did NOT fail this check. Guarantees that must not weaken use `expectNotMutable`.
 */
function expectType<T>(_value: T): void { /* compile-time only */ }

/**
 * Assert the ARGUMENT'S OWN static type is not assignable to the mutable document.
 *
 * The conditional is load-bearing and must stay generic: a first attempt declared
 * the parameter as `ReadonlyDocument`, which made the check tautological — it
 * asserted a fact about the two types rather than about the value being passed, and
 * silently passed when `getDocument()` was reverted to mutable. Here `T` is inferred
 * from the call site, so a mutable argument collapses the parameter to `never`.
 */
function expectNotMutable<T>(_value: T extends ProjectDocument ? never : T): void { }

export function __apiSurfacePin(): void {
    const doc: ProjectDocument = createEmptyDocument();
    const dispatcher = new ActionDispatcher(doc);

    // --- Document -----------------------------------------------------------
    expectType<string>(CURRENT_VERSION);
    expectType<string>(SCHEMA_VERSION);
    expectType<readonly NodeType[]>(NODE_TYPES);
    expectType<boolean>(isNodeType("core.rectangle"));
    expectType<string | null>(dimensionError("core.line", 1, 0));
    expectType<string | null>(pathError("core.path", []));
    expectType<number>(PATH_MAX_COMMANDS);
    const pathCmd: PathCommand = { c: "M", x: 0, y: 0 };
    expectType<PathCommand>(pathCmd);
    expectType<string>(commandsToPathData([{ c: "M", x: 0, y: 0 }, { c: "Z" }]));

    // getDocument() is READ-ONLY — asserted in BOTH directions, so the guarantee
    // cannot be silently weakened back to a mutable document.
    expectType<ReadonlyDocument>(dispatcher.getDocument());
    expectNotMutable(dispatcher.getDocument());

    // --- Serializer ---------------------------------------------------------
    expectType<string>(serializeDocument(dispatcher.getDocument()));
    expectType<ProjectDocument>(deserializeDocument("{}"));
    expectType<boolean>(compareDocuments(doc, doc));
    expectType<LoadResult>(Serializer.loadResult());
    expectType<ProjectDocument | null>(Serializer.load());
    expectType<SaveResult>(Serializer.save(doc));

    // --- Scene graph / integrity / geometry ---------------------------------
    expectType<ReadonlyNode[]>(traverseSceneGraph(doc));
    expectType<string[]>(selectionRoots(doc, []));
    expectType<void>(validateDocumentIntegrity(doc));
    const computed: ComputedState = computeGeometry(doc, null);
    expectType<string[]>(computed.order);
    expectType<Map<string, ComputedNode>>(computed.nodes);
    expectType<string | null>(hitTest(computed, 0, 0));
    expectType<string | null>(hitTest(computed, 0, 0, 4)); // optional world-space pick tolerance
    expectType<{ x: number; y: number } | null>(toLocal(computed, "id", 0, 0));
    expectType<{ x: number; y: number } | null>(toWorld(computed, "id", 0, 0));
    expectType<Rect | null>(subtreeBounds(doc, computed, "id"));
    expectType<Rect | null>(selectionBounds(computed, ["id"]));

    // --- M2 layout engine ---------------------------------------------------
    const container: LayoutContainer = { direction: "row", gap: 0, padding: 0, alignItems: "start", wrap: true, alignContent: "space-between", wrapReverse: true };
    expectType<LayoutContainer>(container);
    expectType<string | null>(layoutError({ container } as Partial<Layout>));
    expectType<Map<string, Rect>>(layoutChildren(container, { width: 1, height: 1 }, [{ id: "a", width: 1, height: 1 }]));
    expectType<FlexLine[]>(breakFlexLines([{ main: 1, cross: 1, marginMain: 0, marginCross: 0 }], 1, 0, true));
    const margins: Margins = { top: 1, left: 2 };
    expectType<{ top: number; right: number; bottom: number; left: number }>(resolveMargin(margins));
    expectType<{ top: number; right: number; bottom: number; left: number }>(resolveMargin(5));
    expectType<Set<string>>(expandDirtyForLayout(doc, new Set<string>()));
    expectType<boolean>(isLayoutContainer(doc.nodes.get("id")));
    expectType<boolean>(isAbsolute(doc.nodes.get("id")));
    expectType<Map<string, { width: number; height: number }>>(measureIntrinsicSizes(traverseSceneGraph(doc), null));
    const track: TrackSize = { fr: 1 };
    const autoTrack: TrackSize = { auto: true };
    const grid: LayoutGrid = { columns: [{ px: 1 }, track, autoTrack], rowHeight: { px: 1 }, rows: [autoTrack], hugWidth: true, hugHeight: false, autoFlow: "column dense", columnGap: 0, rowGap: 0, padding: 0 };
    expectType<LayoutGrid>(grid);
    expectType<Map<string, Rect>>(layoutGridChildren(grid, { width: 1, height: 1 }, [{ id: "a", width: 1, height: 1, colSpan: 2, rowSpan: 1 }]));
    expectType<{ colWidths: number[]; rowHeights: number[]; cols: number; rows: number; cells: GridCell[] }>(resolveGridTracks(grid, [{ width: 1, height: 1, colSpan: 1 }], { width: 1, height: 1 }));
    expectType<{ cells: GridCell[]; rows: number; cols: number }>(placeGridItems([{ colSpan: 2, rowSpan: 1, gridColumn: [1, 3], gridRow: [1, 2] }], 3, { columnFlow: true, dense: true }));
    const constraints: Constraints = { horizontal: "right" as HConstraint, vertical: "center" as VConstraint };
    expectType<Constraints>(constraints);
    expectType<Rect>(resolveConstraints({ x: 0, y: 0, width: 1, height: 1 }, constraints, { width: 1, height: 1 }, { width: 2, height: 2 }));

    // Matrix primitive
    expectType<Mat2D>(IDENTITY);
    expectType<Mat2D>(multiply(IDENTITY, IDENTITY));
    expectType<Mat2D>(translation(0, 0));
    expectType<Mat2D | null>(invert(IDENTITY));
    expectType<Mat2D>(compose(0, 0, 0, 1, 1, 0, 0));
    expectType<{ x: number; y: number }>(applyToPoint(IDENTITY, 0, 0));
    expectType<Rect>(transformRectToAABB(IDENTITY, { x: 0, y: 0, width: 1, height: 1 }));
    expectType<Rect>(unionRect({ x: 0, y: 0, width: 1, height: 1 }, { x: 1, y: 1, width: 1, height: 1 }));
    expectType<string>(toMatrixString(IDENTITY));
    expectType<boolean>(isTranslationOnly(IDENTITY));

    // --- Actions ------------------------------------------------------------
    // The delta channel is a discriminated union, NOT Record<string, any>.
    expectType<Map<string, NodeDelta>>(({} as MutationResult).propertyDeltas);
    expectType<void>(applyMutationsToDocument(doc, new Map<string, NodeDelta>()));

    const actions: Action[] = [
        new AddNodeAction(doc, "core.rectangle", 0, 0, 1, 1, "#fff", "id", null),
        new DeleteNodeAction(doc, "id"),
        new MoveNodeAction(doc, "id", 0, 0),
        new ResizeNodeAction(doc, "id", 1, 1),
        new ReparentNodeAction(doc, "id", null, 0),
        new UpdateNodeGeometryAction(doc, "id", { x: 0 }),
        new UpdateNodeStyleAction(doc, "id", { opacity: 1 }),
        new UpdateNodeTransformAction(doc, "id", { rotation: 0 }),
        new UpdateNodeLayoutAction(doc, "id", { container: { direction: "row" } })
    ];
    expectType<TransactionAction>(new TransactionAction(doc, "label", actions));
    expectType<MutationResult>(actions[0].execute());
    expectType<ActionPayload>(actions[0].serialize());

    // --- Dispatcher & history ----------------------------------------------
    expectType<MutationResult>(dispatcher.dispatchAction(actions[0], { coalesce: true }));
    expectType<() => void>(dispatcher.onChange(() => { }));
    expectType<ProjectDocument | null>(dispatcher.undo());
    expectType<ProjectDocument | null>(dispatcher.redo());
    expectType<boolean>(dispatcher.canUndo());
    expectType<boolean>(dispatcher.canRedo());
    expectType<void>(dispatcher.loadDocument(doc));
    expectType<boolean>(dispatcher.hasTruncatedHistory());
    expectType<ProjectDocument>(dispatcher.revertToOriginal());

    const history = new HistoryManager(doc, DEFAULT_HISTORY_LIMITS);
    expectType<HistoryLimits>(DEFAULT_HISTORY_LIMITS);
    expectType<void>(history.commitRevision({ actionId: "x", payload: null, timestamp: 0 }, doc, false));
    expectType<ProjectDocument>(history.getOriginal());
    expectType<boolean>(history.hasTruncatedHistory());
    expectType<number>(history.getRevisionCount());
    expectType<Revision["sizeBytes"]>(0);
    expectType<DocumentSnapshot["version"]>("1");

    // --- Editor & renderer --------------------------------------------------
    const es: EditorState = createEditorState();
    expectType<Map<string, Partial<Node["geometry"]>> | null>(es.pendingGeometry);
    expectType<void>(clampViewport(es.viewport));
    const rendererState: RendererState = {
        selectedNodeIds: [], hoveredNodeId: null, computed, viewport: es.viewport
    };
    expectType<RendererState>(rendererState);
    expectType<(c: HTMLElement, d: ReadonlyDocument, s: RendererState) => void>(renderSVG);

    // M3 render model: pure display list + backend seam.
    const model: DisplayList = buildRenderModel({ width: 800, height: 600 }, doc, rendererState);
    expectType<DrawItem[]>(model.content);
    expectType<DrawItem[]>(model.overlay);
    expectType<DrawItem[]>(model.grid.lines);
    expectType<string>(model.grid.sig);
    expectType<boolean>(model.grid.unchanged);
    expectType<Shape>(model.content[0].shape);
    expectType<Paint>(model.content[0].paint);
    expectType<Mat2D | null>(model.content[0].world);
    expectType<(c: HTMLElement, m: DisplayList) => void>(emitSVG);
}
