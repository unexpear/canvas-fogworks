# API Contracts

> 🔒 Frozen for Milestone 0 · v0.0.5. The public surface each layer depends on.
> Signatures here are the contract; changing one is a versioned, documented change.

## Document (`core/document/`)

```ts
const CURRENT_VERSION: string;               // app/display version, from package.json
const SCHEMA_VERSION: string;                // "1" — persisted document schema (decoupled)
function createEmptyDocument(): ProjectDocument;

// SceneGraph.ts — the ONLY correct node ordering (z-order / layer order)
function traverseSceneGraph(doc: ProjectDocument): Node[]; // depth-first, cycle-safe, keeps orphans

// Integrity.ts — structural + range validation (runs inside deserializeDocument)
function validateDocumentIntegrity(doc: ProjectDocument): void;  // throws on the first problem

// geometry/ComputedGeometry.ts — the Milestone 1 seam
interface WorldRect { x: number; y: number; width: number; height: number }
interface ComputedGeometry { order: string[]; rects: Map<string, WorldRect> }
function computeWorldGeometry(
  doc: ProjectDocument,
  pending?: Map<string, Partial<Geometry>> | null   // drag previews are an INPUT
): ComputedGeometry;
function hitTest(computed: ComputedGeometry, x: number, y: number): string | null; // DOM-free

// Serializer.ts
function serializeDocument(doc: ProjectDocument): string;
function deserializeDocument(json: string): ProjectDocument;   // throws on invalid JSON / bad envelope / foreign version
function compareDocuments(a: ProjectDocument, b: ProjectDocument): boolean;

const Serializer: {
  loadResult(): LoadResult;                  // "empty" | "loaded" | "corrupt"
  load(): ProjectDocument | null;            // back-compat convenience
  save(doc: ProjectDocument): SaveResult;   // { status: "saved" } | { status: "failed", error }
};
```

Types: `ProjectDocument`, `DocumentMetadata`, `SerializedMetadata`, `VariableStore`,
`Node`, `NodeType`, `Geometry`, `Style`, `Layout`, `StateDefinition`, `SerializedDocument`,
`DeepReadonly`, `ReadonlyDocument`, `ReadonlyNode`,
`LoadResult`, `SaveResult`, `NODE_TYPES`/`isNodeType`. See [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md).

## Actions (`core/actions/`)

```ts
abstract class Action {
  constructor(document: ProjectDocument);
  rebind(document: ProjectDocument): void;
  abstract validate(): boolean;
  abstract execute(): MutationResult;
  abstract serialize(): ActionPayload;
}

// Command constructors
new AddNodeAction(doc, type: NodeType, x, y, width, height,
                  fill?: string /* "#cccccc" */, id?: string, parentId?: string | null);
new ReparentNodeAction(doc, nodeId: string, newParentId: string | null, index?: number);
new DeleteNodeAction(doc, nodeId: string);
new MoveNodeAction(doc, nodeId: string, newX: number, newY: number);
new ResizeNodeAction(doc, nodeId: string, newWidth: number, newHeight: number);
new UpdateNodeGeometryAction(doc, nodeId: string, geometry: Partial<Geometry>);
new UpdateNodeStyleAction(doc, nodeId: string, style: Partial<Style>);
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
      geometry?: Partial<Geometry>; style?: Partial<Style>; layout?: Partial<Layout>;
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
  commitRevision(payload: ActionPayload, documentState: ProjectDocument, allowCoalesce?: boolean): void;
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
  pendingGeometry: Map<string, Partial<Geometry>> | null; // move/resize preview, fed INTO computeWorldGeometry
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
  computed: ComputedGeometry;   // resolved world rects + draw order (required)
  viewport: { x: number; y: number; zoom: number };
}
function renderSVG(container: HTMLElement, doc: ProjectDocument, state: RendererState): void;
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
