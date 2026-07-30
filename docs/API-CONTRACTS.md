# API Contracts

<!-- describes: src/core/actions, src/core/document, src/core/geometry, src/editor, src/renderer, src/electron/preload.js, scripts/build.js -->

> 🔒 Frozen contract · schema v18 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). The public surface each layer depends on.
> Signatures here are the contract; changing one is a versioned, documented change.

## Document (`core/document/`)

```ts
const CURRENT_VERSION: string;               // app/display version, from package.json
const SCHEMA_VERSION: string;                // persisted document schema (decoupled from app version)
function createEmptyDocument(): ProjectDocument;

// SceneGraph.ts — the ONLY correct node ordering (z-order / layer order)
function traverseSceneGraph(doc: ReadonlyDocument): ReadonlyNode[]; // depth-first, cycle-safe, keeps orphans

// Integrity.ts — structural + range validation (runs inside deserializeDocument)
function validateDocumentIntegrity(doc: ReadonlyDocument): void;  // throws on the first problem

// geometry/Matrix.ts — 2D affine primitive
interface Mat2D { a: number; b: number; c: number; d: number; e: number; f: number }
interface Rect { x: number; y: number; width: number; height: number }
const IDENTITY: Mat2D;
function multiply(outer: Mat2D, inner: Mat2D): Mat2D;      // outer ∘ inner
function translation(tx: number, ty: number): Mat2D;
function compose(x, y, rotation, scaleX, scaleY, pivotX, pivotY): Mat2D;
function invert(m: Mat2D): Mat2D | null;                   // null when singular
function applyToPoint(m: Mat2D, x: number, y: number): { x: number; y: number };
function transformRectToAABB(m: Mat2D, rect: Rect): Rect;  // all four corners
function unionRect(a: Rect, b: Rect): Rect;
function toMatrixString(m: Mat2D): string;                 // SVG/Canvas ready
function isTranslationOnly(m: Mat2D): boolean;

// geometry/GeometryEngine.ts — Milestone 1: intent → computed results
interface ComputedNode { world: Mat2D; local: Rect; bounds: Rect }
interface ComputedState { order: string[]; nodes: Map<string, ComputedNode> }
function computeGeometry(
  doc: ReadonlyDocument,
  pending?: Map<string, Partial<Geometry>> | null,  // drag previews are an INPUT
  previous?: ComputedState,                          // dirty-tracking reuse
  dirty?: ReadonlySet<string>
): ComputedState;
function hitTest(computed: ComputedState, x: number, y: number, tolerance?: number): string | null; // local-space, DOM-free; `tolerance` (world units, default 0) is a pick halo so thin/zero-extent targets (an axis-aligned line) stay selectable
function nodesInRect(computed: ComputedState, rect: Rect): string[]; // marquee (box) select: ids whose WORLD bounds OVERLAP rect (touch, not containment), in draw order; DOM-free
function toLocal(s: ComputedState, nodeId: string, x: number, y: number): { x: number; y: number } | null;
function toWorld(s: ComputedState, nodeId: string, x: number, y: number): { x: number; y: number } | null;
function subtreeBounds(doc: ReadonlyDocument, s: ComputedState, rootId: string): Rect | null;
function selectionBounds(s: ComputedState, ids: readonly string[]): Rect | null;

// geometry/SelectionHandles.ts — DOM-free resize-handle geometry, SHARED by the renderer
// (draws) and the editor (hit-tests) so they cannot drift.
const HANDLE_SIZE_PX: number;                          // handle square edge, SCREEN px
const ROTATE_OFFSET_PX: number;                        // rotate knob's height above the box top, SCREEN px
type HandleId = "nw" | "ne" | "sw" | "se" | "rotate";
interface SelectionHandle { nodeId: string; handle: HandleId; cx: number; cy: number; cursor: string } // center in WORLD
// `zoom` places the rotate knob (fixed screen px above the box) and, for handleAtPoint, sizes the grab square
// (HANDLE_SIZE_PX/floored-zoom) — the SAME square the renderer draws, so grab==draw at every zoom.
function selectionHandles(s: ComputedState, selectedNodeIds: readonly string[], zoom: number): SelectionHandle[]; // 4 corners + rotate per selected node
function handleAtPoint(s: ComputedState, selectedNodeIds: readonly string[], x: number, y: number, zoom: number): SelectionHandle | null; // handle under a world point; back-to-front (rotate beats a grazed corner)

// geometry/Snapping.ts — DOM-free alignment snapping (M4 smart guides), pure like the above.
const SNAP_THRESHOLD_PX: number;                       // default snap budget, SCREEN px (tools ÷ zoom)
interface SnapGuide { axis: "x" | "y"; pos: number; start: number; end: number } // "x"=vertical line at world x=pos; span on the perpendicular axis
interface SnapResult { dx: number; dy: number; guides: SnapGuide[] }
function computeSnap(moving: Rect, targets: readonly Rect[], threshold: number): SnapResult; // MOVE: snap a whole box's edges/centre onto a target's; guides at each alignment
function snapPoint(px: number, py: number, targets: readonly Rect[], threshold: number): { dx: number; dy: number }; // RESIZE: snap the dragged corner to target lines, each axis independently
function guidesForRect(rect: Rect, targets: readonly Rect[]): SnapGuide[]; // guides for a rect's existing alignments (merged spans)
function snapTargetsExcludingSubtree(doc: ReadonlyDocument, computed: ComputedState, rootId: string): Rect[]; // other nodes' world bounds, minus rootId's own subtree

// geometry/LayoutEngine.ts — Milestone 2 core: auto-layout containers.
// Runs INSIDE computeGeometry; a container's children get a computed local rect.
function layoutChildren(                          // pure flex-stack math (multi-line when wrap)
  container: LayoutContainer,
  parentSize: { width: number; height: number },
  children: readonly { id: string; width: number; height: number }[]
): Map<string, Rect>;                             // childId → parent-relative rect
interface FlexLine { items: number[]; cross: number }  // indices into the input + the line's cross size
function breakFlexLines(                           // shared by the position pass + the measure cross-hug fold
  items: readonly { main: number; cross: number; marginMain: number; marginCross: number }[],
  innerMain: number, gap: number, wrap: boolean    // marginMain/Cross = before+after totals (mapped by direction)
): FlexLine[];
function resolveMargin(m: number | Margins | undefined):  // uniform number or per-side object -> physical sides
  { top: number; right: number; bottom: number; left: number };
function isLayoutContainer(node: { layout: { container?: unknown } } | undefined): boolean;
function expandDirtyForLayout(doc: ReadonlyDocument, dirty: ReadonlySet<string>): Set<string>;
                                                  // climbs a change up the hug chain to the first fixed container
function measureIntrinsicSizes(                    // bottom-up: resolved own-size per node, hug folded from children
  scene: readonly ReadonlyNode[],
  pending: ReadonlyMap<string, Partial<Geometry>> | null | undefined
): Map<string, { width: number; height: number }>;
type GridChild = { id: string; width: number; height: number; colSpan?: number; rowSpan?: number;
                   margin?: number | Margins; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] };
function layoutGridChildren(                       // grid: children flow (spans/pins) into px/fr/auto cells and fill them
  grid: LayoutGrid,                                // grid.autoFlow: "row" | "row dense" | "column" | "column dense"
  parentSize: { width: number; height: number },
  children: readonly GridChild[]
): Map<string, Rect>;                             // childId → cell rect (a span sums tracks + gaps; margins inset the child)
interface GridCell { col: number; row: number; colSpan: number; rowSpan: number }
function placeGridItems(                            // sparse/dense/column auto-placement + explicit pins — the SOLE authority
  items: readonly { colSpan?: number; rowSpan?: number; gridColumn?: readonly [number, number]; gridRow?: readonly [number, number] }[],
  primaryCount: number,                            // FIXED-axis track count (cols for row-flow, rows for column-flow)
  opts?: { columnFlow?: boolean; dense?: boolean }
): { cells: GridCell[]; rows: number; cols: number }; // both axes; one is primaryCount, the other derived
function resolveGridTracks(                         // shared by the measure fold (hug) and the position pass (cells)
  grid: LayoutGrid,
  children: readonly Omit<GridChild, "id">[],
  parentSize: { width: number; height: number }
): { colWidths: number[]; rowHeights: number[]; cols: number; rows: number; cells: GridCell[] };
function resolveConstraints(                       // anchors: reposition a plain parent's child on resize
  stored: Rect,
  constraints: Constraints | undefined,
  ref: { width: number; height: number } | undefined,   // the FROZEN reference size
  parentSize: { width: number; height: number }
): Rect;                                          // offset = parentSize - ref; static if either absent
function isAbsolute(node: { layout: { position?: unknown } } | undefined): boolean; // out-of-flow escape

// LayoutContainer also carries `alignContent` (cross-axis line distribution) and `wrapReverse`.
// Layout (per child) also carries `margin` (uniform number OR per-side `Margins`), `position:
// "absolute"`, `colSpan`/`rowSpan` (grid spans), and `gridColumn`/`gridRow` (explicit line pins).

// Serializer.ts
function serializeDocument(doc: ReadonlyDocument): string;
function deserializeDocument(json: string): ProjectDocument;   // throws on invalid JSON / bad envelope / foreign version
function compareDocuments(a: ReadonlyDocument, b: ReadonlyDocument): boolean;

const Serializer: {
  loadResult(): LoadResult;                  // "empty" | "loaded" | "corrupt"
  load(): ProjectDocument | null;            // back-compat convenience
  save(doc: ReadonlyDocument): SaveResult;   // { status: "saved" } | { status: "failed", error }
};
```

Types: `ProjectDocument`, `DocumentMetadata`, `SerializedMetadata`, `VariableStore`,
`Node`, `NodeType`, `Geometry`, `Style`, `Layout`, `LayoutContainer`, `LayoutGrid`,
`TrackSize`, `Constraints`, `HConstraint`, `VConstraint`, `Margins`, `Transform`,
`StateDefinition`, `SerializedDocument`, `DeepReadonly`, `ReadonlyDocument`, `ReadonlyNode`,
`LoadResult`, `SaveResult`, `NODE_TYPES`/`isNodeType`. Shared validators
`transformError(t)` / `layoutError(l)` / `dimensionError(type, w, h)` / `pathError(type, path)` /
`styleError(style)` return an error string or `null`, and are used by BOTH the edit path and the
load path. `dimensionError` is per-type (rect/ellipse/text/image need a positive box; `core.line`/
`core.path` may collapse one axis, not both). `pathError` (+ `PathCommand`, `PATH_MAX_COMMANDS`)
validates a `core.path`'s commands (present ⇒ non-empty, opens with `M`, finite coords, ≤ cap) and
rejects path data on any other type. `styleError` validates every `Style` field including the
schema-18 effects (`Shadow` = dx/dy/blur/color; `blur` ≥ 0). See [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md).

## Actions (`core/actions/`)

```ts
abstract class Action {
  constructor(document: ReadonlyDocument);   // an Action only READS
  rebind(document: ReadonlyDocument): void;
  abstract validate(): boolean;
  abstract execute(): MutationResult;
  abstract serialize(): ActionPayload;
}

// Command constructors
new AddNodeAction(doc, type: NodeType, x, y, width, height,
                  fill?: string /* "#cccccc" */, id?: string, parentId?: string | null);
new ReparentNodeAction(doc, nodeId: string, newParentId: string | null, index?: number); // reports old+new parent dirty (layout)
new DeleteNodeAction(doc, nodeId: string);                                               // reports removed child's parent dirty (layout)
new MoveNodeAction(doc, nodeId: string, newX: number, newY: number);
new ResizeNodeAction(doc, nodeId: string, newWidth: number, newHeight: number);
new UpdateNodeGeometryAction(doc, nodeId: string, geometry: Partial<Geometry>);
new UpdateNodeStyleAction(doc, nodeId: string, style: Partial<Style>);
new UpdateNodeTransformAction(doc, nodeId: string, transform: Partial<Transform>); // rotation/scale/origin
new UpdateNodeLayoutAction(doc, nodeId: string, layout: Partial<Layout>);          // M2 layout (container/grid/grow/constraints/position/margin)
new TransactionAction(doc, label: string, actions: Action[]);

// applyMutations.ts — the single mutation site
function applyMutationsToDocument(doc: ProjectDocument, propertyDeltas: Map<string, NodeDelta>): void;
```

Types: `MutationResult`, `NodeDelta`, `ActionPayload`, `Revision`, `DocumentSnapshot`.

```ts
// The delta protocol is a discriminated union — terminal vs composable is enforced
// by the type, not by prose. See ACTION-SYSTEM.md.
type NodeDelta =
  | { kind: "add"; node: Node }
  | { kind: "delete" }
  | { kind: "patch"; reparent?: { parent: string | null; index?: number };
      geometry?: Partial<Geometry>; transform?: Partial<Transform>;
      style?: Partial<Style>; layout?: Partial<Layout>;
      text?: string; src?: string; name?: string };
```

## Dispatcher & History (`core/actions/`)

```ts
class ActionDispatcher {
  constructor(initialDoc: ProjectDocument);
  dispatchAction(action: Action, options?: { coalesce?: boolean }): MutationResult; // never throws
  onChange(listener: (r: MutationResult) => void): () => void;  // returns unsubscribe
  undo(): ProjectDocument | null;
  redo(): ProjectDocument | null;
  canUndo(): boolean;
  canRedo(): boolean;
  getDocument(): ReadonlyDocument;   // deep-readonly; mutation requires an Action
  loadDocument(doc: ProjectDocument): void;            // New/Open: replace + reset history
  hasTruncatedHistory(): boolean;                      // undo can no longer reach the start
  revertToOriginal(): ProjectDocument;                 // explicit way back; itself undoable
}

class HistoryManager {
  constructor(initialDoc: ProjectDocument);
  commitRevision(payload: ActionPayload, documentState: ReadonlyDocument, allowCoalesce?: boolean): void;
  current(): ProjectDocument | null;   // cursor position, used to roll back a failed apply
  undo(): ProjectDocument | null;   // deep-cloned snapshot
  redo(): ProjectDocument | null;   // deep-cloned snapshot
  canUndo(): boolean;
  canRedo(): boolean;
  getRevisionCount(): number;
  hasTruncatedHistory(): boolean;
  getOriginal(): ProjectDocument;      // pinned outside the trimmable list
  getCurrentIndex(): number;
  getCurrentActionId(): string;
}
// Retention is memory-bounded: DEFAULT_HISTORY_LIMITS = { maxBytes: 128MB, minEntries: 50, maxEntries: 10_000 }
// Injectable via `new ActionDispatcher(doc, limits)` / `new HistoryManager(doc, limits)`.
```

## Editor (`editor/`)

```ts
interface EditorState {
  selectedNodeIds: string[];
  hoveredNodeId: string | null;
  activeTool: string;
  isDragging: boolean;
  previewRect: Rect | null;                 // rectangle-tool draw preview
  marqueeRect: Rect | null;                 // box-select marquee (WORLD coords), drawn as an overlay
  pendingGeometry: Map<string, Partial<Geometry>> | null; // move/resize preview, fed INTO computeGeometry
  viewport: { x: number; y: number; zoom: number };
}
function createEditorState(): EditorState;
function clampViewport(vp): void;            // zoom ∈ [0.05, 20]; pan ±10000 WORLD units (scaled by zoom)
// Pure viewport math (node-tested); each mutates vp then re-clamps.
function panBy(vp, dx: number, dy: number): void;                 // SCREEN-px pan (zoom-independent)
function zoomAt(vp, factor: number, cursorX: number, cursorY: number): void; // cursor-anchored zoom
function screenToWorld(vp, canvasRect: { left: number; top: number }, clientX: number, clientY: number): { x: number; y: number }; // the one sanctioned screen→world inverse, shared by all tools

interface Tool {                             // all methods optional
  onMouseDown?(e: MouseEvent, canvasRect?: DOMRect): void;
  onMouseMove?(e: MouseEvent, canvasRect?: DOMRect): void;
  onMouseUp?(e: MouseEvent): void;
  onKeyDown?(e: KeyboardEvent): void;
  onKeyUp?(e: KeyboardEvent): void;
  onWheel?(e: WheelEvent, canvasRect?: DOMRect): void;
}

class ToolController {
  constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void);
  setTool(tool: Tool): void;
  // routes pointer/key events; owns viewport PAN (space+drag / middle-mouse), corner-RESIZE and
  // ROTATE (both via DOM-free `handleAtPoint` over the selection, NOT `data-resize-handle`; rotate
  // spins about the node's world-AABB centre and live-commits a coalesced `UpdateNodeTransformAction`
  // = one undo per continuous drag), Delete/Backspace, Escape — each a mode that intercepts before the active tool
}
```

Tools: `SelectTool`, `MoveTool`, `RectangleTool` (all implement `Tool`). Tools construct
Actions and dispatch them; they mutate only `EditorState`, never the document.
`SelectTool` also owns box-select: a drag begun on empty space draws a marquee
(`EditorState.marqueeRect`) and, on release, selects `nodesInRect` (shift = additive); a
plain click with no drag deselects. Picking is world-space (`hitTest`/`nodesInRect`), never
the DOM, so selection works under any renderer backend.
Alignment snapping applies to a SINGLE top-level, unrotated node (stored == world): `MoveTool`
folds `computeSnap` into a drag (whole box), and `ToolController` resize folds `snapPoint` into a
corner drag — both write `EditorState.snapGuides` for the renderer. A multi-node/nested/rotated
gesture is unsnapped (deferred).

## Renderer (`renderer/`)

The renderer is a pure display-list builder plus a thin backend. `buildRenderModel`
turns `(size, doc, state)` into a plain-data `DisplayList`; a backend transcribes it to
the screen. Every draw decision lives in the model (unit-tested in the `node` env like
the layout engine); the backend does no arithmetic.

```ts
interface RendererState {
  selectedNodeIds: string[];
  hoveredNodeId: string | null;
  previewRect?: Rect | null;
  marqueeRect?: Rect | null;    // box-select marquee (world coords), drawn as an overlay
  computed: ComputedState;      // world matrices + bounds + draw order (required)
  viewport: { x: number; y: number; zoom: number };
}

// Pure model (renderer/RenderModel.ts) — no DOM; imports only the Mat2D *type*.
type Shape =
  | { kind: "rect"; x; y; width; height }
  | { kind: "ellipse"; cx; cy; rx; ry }
  | { kind: "line"; x1; y1; x2; y2 }
  | { kind: "path"; commands: readonly PathCommand[] }  // structured (canvas-ready), NOT a `d` string
  | { kind: "text"; x; y; width; height; text: string; fontSize: number }
  | { kind: "image"; x; y; width; height; href: string | null };
// A null Paint field = absent attribute; pointerEvents:false = pointer-events:none.
interface Paint {
  fill: string | null; opacity: number | null;
  stroke: string | null; strokeWidth: number | null; strokeDash: string | null;
  radius: number | null; cursor: string | null; pointerEvents: boolean;
  shadow: Shadow | null; blur: number | null;   // schema-18 effects (world units), resolved from Style
}
type DrawRole = "grid-line" | "content" | "outline" | "handle" | "preview" | "marquee";
interface DrawItem {
  shape: Shape; paint: Paint;
  world: Mat2D | null;          // null → the backend emits no transform
  nodeId: string | null;        // data-node-id; handle? → data-resize-handle
  handle?: string; role: DrawRole;
}
interface GridModel { sig: string; lines: DrawItem[]; unchanged: boolean }
interface FilterDef { id: string; shadow: Shadow | null; blur: number | null }  // one <filter> per entry
interface DisplayList {
  viewport: { x: number; y: number; zoom: number };
  grid: GridModel; content: DrawItem[]; overlay: DrawItem[];
  defs: FilterDef[];            // deduped effect filters (by id); emitSVG builds <defs> from these
}
// Pure, deterministic, INJECTIVE, SVG-id-safe filter id (the twin of commandsToPathData); null = no effect.
function effectFilterId(shadow: Shadow | null, blur: number | null): string | null;

function buildRenderModel(
  size: { width: number; height: number },
  doc: ReadonlyDocument, state: RendererState, prev?: DisplayList | null
): DisplayList;                                          // pure, deterministic
function emitSVG(container: HTMLElement, model: DisplayList): void;   // SVG DOM transcription
function emitCanvas(ctx: CanvasRenderingContext2D, model: DisplayList, dpr?: number): void; // Canvas 2D transcription
function renderSVG(container: HTMLElement, doc: ReadonlyDocument, state: RendererState): void;    // buildRenderModel ∘ emitSVG
function renderCanvas(container: HTMLElement, doc: ReadonlyDocument, state: RendererState): void; // buildRenderModel ∘ emitCanvas (sizes a <canvas> for the DPR)
function clearRenderState(container: HTMLElement): void;             // drop the container's cached prev frame (call when its DOM is cleared)
type RenderBackend = "svg" | "canvas";
function renderScene(container: HTMLElement, doc: ReadonlyDocument, state: RendererState, backend: RenderBackend): void; // the live backend selector
```

- Pure read of `(doc, state)`; no dispatcher reference, cannot write.
- `buildRenderModel` reads **all positions from `state.computed`** (world/local/bounds)
  and never composes coordinates — enforced by importing only the `Mat2D` *type*. `doc`
  supplies only type/style/text/src.
- `renderScene(container, doc, state, backend)` is the app entry point: it dispatches to
  `renderSVG` or `renderCanvas`, and on a backend switch clears the container (removing the
  other backend's element) + drops the SVG grid cache (`clearRenderState`). `renderSVG`
  measures the container and threads the previous `DisplayList` (so an unchanged grid reuses
  its lines by reference); `renderCanvas` sizes a `<canvas>` for the device pixel ratio (model
  in CSS px, backing store in device px, DPR passed to `emitCanvas`).
- `DisplayList` is plain, serializable data — asserted directly in unit tests. `emitSVG`
  and `emitCanvas` are backend transcribers over the SAME list; each does zero coordinate
  arithmetic (canvas folds DPR into the base CTM then post-multiplies `world` via
  `ctx.transform`). `emitCanvas` is verified by a recording-mock ctx (its call sequence is
  its output); pixel-level SVG↔canvas parity stays a browser smoke test. **Both backends are
  now live** (M4 — a toolbar toggle), since all picking is DOM-free. The shims themselves
  (`renderSVG`/`renderCanvas`/`renderScene`) are DOM plumbing (the untested boundary, browser-
  smoke-verified). First-pass canvas gaps: single-line text, image deferred.
- **Viewport culling:** `content` holds only nodes whose world bounds intersect the visible
  world rect `{x: vp.x/z, y: vp.y/z, w: (size.w||800)/z, h: (size.h||600)/z}` (the same
  screen→world region the viewport transform maps, inclusive edges). So `content` depends
  on `viewport`/`size`, not just draw order — the "one item per in-flow node" shape holds
  only for the on-screen subset. Content-only: `overlay` and `grid` are never culled.
- DOM structure `svg > g#viewport-transform > { g#grid, g#content, g#overlay }`, reused
  across calls (not torn down). Grid is capped at 300 lines/axis and skipped when its
  `sig` is unchanged.

## Electron bridge

Preload (`electron/preload.js`) exposes on `window.electronAPI`:

```ts
interface ElectronAPI {
  onMenuNew(cb: () => void): () => void;            // returns disposer
  onMenuSave(cb: () => void): () => void;
  onFileOpened(cb: (p: { filePath: string; content: string }) => void): () => void;
  onRequestSave(cb: (filePath: string) => void): () => void;
  saveFile(filePath: string, content: string): Promise<boolean>;
  requestSaveAs(): Promise<boolean>;   // prompts Save As for an unsaved document
}
```

`App` subscribes with cleanup disposers and is a no-op when `window.electronAPI` is
undefined (browser build). Main process (`electron/main.js`) owns the window, menu,
Open/Save dialogs, and the `"save-file"` IPC handler.

## Build (`scripts/build.js`)

Three esbuild builds → `dist/`:
| Entry | Output | Format/platform |
|-------|--------|-----------------|
| `app/index.tsx` | `dist/app/bundle.js` | iife / browser (minified) |
| `electron/main.js` | `dist/electron/main.js` | cjs / node, `external: electron` |
| `electron/preload.js` | `dist/electron/preload.js` | cjs / node, `external: electron` |

Plus `index.html` copied to `dist/app/` with the bundle injected. `--watch` supported.
