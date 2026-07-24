# API Contracts

<!-- describes: src/core/actions, src/core/document, src/core/geometry, src/editor, src/renderer/SVGRenderer.ts, src/electron/preload.js, scripts/build.js -->

> 🔒 Frozen contract · schema v13 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap, grid (+rows/auto/hug/spans), constraints, absolute + margins). The public surface each layer depends on.
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
function hitTest(computed: ComputedState, x: number, y: number): string | null; // local-space, DOM-free
function toLocal(s: ComputedState, nodeId: string, x: number, y: number): { x: number; y: number } | null;
function toWorld(s: ComputedState, nodeId: string, x: number, y: number): { x: number; y: number } | null;
function subtreeBounds(doc: ReadonlyDocument, s: ComputedState, rootId: string): Rect | null;
function selectionBounds(s: ComputedState, ids: readonly string[]): Rect | null;

// geometry/LayoutEngine.ts — Milestone 2 core: auto-layout containers.
// Runs INSIDE computeGeometry; a container's children get a computed local rect.
function layoutChildren(                          // pure flex-stack math (multi-line when wrap)
  container: LayoutContainer,
  parentSize: { width: number; height: number },
  children: readonly { id: string; width: number; height: number }[]
): Map<string, Rect>;                             // childId → parent-relative rect
interface FlexLine { items: number[]; cross: number }  // indices into the input + the line's cross size
function breakFlexLines(                           // shared by the position pass + the measure cross-hug fold
  items: readonly { main: number; cross: number; margin: number }[],
  innerMain: number, gap: number, wrap: boolean
): FlexLine[];
function isLayoutContainer(node: { layout: { container?: unknown } } | undefined): boolean;
function expandDirtyForLayout(doc: ReadonlyDocument, dirty: ReadonlySet<string>): Set<string>;
                                                  // climbs a change up the hug chain to the first fixed container
function measureIntrinsicSizes(                    // bottom-up: resolved own-size per node, hug folded from children
  scene: readonly ReadonlyNode[],
  pending: ReadonlyMap<string, Partial<Geometry>> | null | undefined
): Map<string, { width: number; height: number }>;
function layoutGridChildren(                       // grid: children auto-flow (with spans) into px/fr/auto cells and fill them
  grid: LayoutGrid,
  parentSize: { width: number; height: number },
  children: readonly { id: string; width: number; height: number; colSpan?: number; rowSpan?: number }[]
): Map<string, Rect>;                             // childId → cell rect (a span sums its tracks + internal gaps)
interface GridCell { col: number; row: number; colSpan: number; rowSpan: number }
function placeGridItems(                            // sparse auto-placement — the SINGLE placement authority
  items: readonly { colSpan?: number; rowSpan?: number }[],
  cols: number
): { cells: GridCell[]; rows: number };           // cells index-aligned with items; rows derived (may exceed ceil(n/cols))
function resolveGridTracks(                         // shared by the measure fold (hug) and the position pass (cells)
  grid: LayoutGrid,
  children: readonly { width: number; height: number; colSpan?: number; rowSpan?: number }[],
  parentSize: { width: number; height: number }
): { colWidths: number[]; rowHeights: number[]; cols: number; rows: number; cells: GridCell[] };
function resolveConstraints(                       // anchors: reposition a plain parent's child on resize
  stored: Rect,
  constraints: Constraints | undefined,
  ref: { width: number; height: number } | undefined,   // the FROZEN reference size
  parentSize: { width: number; height: number }
): Rect;                                          // offset = parentSize - ref; static if either absent
function isAbsolute(node: { layout: { position?: unknown } } | undefined): boolean; // out-of-flow escape

// Layout also carries per-child `margin` (uniform flex-flow spacing),
// `position: "absolute"` (out of flow), and `colSpan`/`rowSpan` (grid item spans).

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
`TrackSize`, `Constraints`, `HConstraint`, `VConstraint`, `Transform`,
`StateDefinition`, `SerializedDocument`, `DeepReadonly`, `ReadonlyDocument`, `ReadonlyNode`,
`LoadResult`, `SaveResult`, `NODE_TYPES`/`isNodeType`. Shared validators
`transformError(t)` / `layoutError(l)` return an error string or `null`, and are used by
BOTH the edit path and the load path. See [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md).

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
  pendingGeometry: Map<string, Partial<Geometry>> | null; // move/resize preview, fed INTO computeGeometry
  viewport: { x: number; y: number; zoom: number };
}
function createEditorState(): EditorState;
function clampViewport(vp): void;            // zoom ∈ [0.05, 20]; pan ±10000 WORLD units (scaled by zoom)

interface Tool {                             // all methods optional
  onMouseDown?(e: MouseEvent, canvasRect?: DOMRect): void;
  onMouseMove?(e: MouseEvent, canvasRect?: DOMRect): void;
  onMouseUp?(e: MouseEvent): void;
  onKeyDown?(e: KeyboardEvent): void;
  onWheel?(e: WheelEvent, canvasRect?: DOMRect): void;
}

class ToolController {
  constructor(dispatcher: ActionDispatcher, editorState: EditorState, refresh: () => void);
  setTool(tool: Tool): void;
  // routes pointer/key events; owns corner-resize, Delete/Backspace, Escape
}
```

Tools: `SelectTool`, `MoveTool`, `RectangleTool` (all implement `Tool`). Tools construct
Actions and dispatch them; they mutate only `EditorState`, never the document.

## Renderer (`renderer/SVGRenderer.ts`)

```ts
interface RendererState {
  selectedNodeIds: string[];
  hoveredNodeId: string | null;
  previewRect?: Rect | null;
  computed: ComputedState;      // world matrices + bounds + draw order (required)
  viewport: { x: number; y: number; zoom: number };
}
function renderSVG(container: HTMLElement, doc: ReadonlyDocument, state: RendererState): void;
```

- Pure read of `(doc, state)`; no dispatcher reference, cannot write.
- Reads **all positions from `state.computed`**; `doc` supplies only type/style/text/src.
  M1 narrows this to ComputedState alone.
- DOM structure `svg > g#viewport-transform > { g#grid, g#content, g#overlay }`, reused
  across calls (not torn down). Grid is capped at 300 lines/axis.

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
