# API Contracts

<!-- describes: src/core/actions, src/core/document, src/core/geometry, src/editor, src/renderer, src/electron/preload.js, scripts/build.js -->

> 🔒 Frozen contract · schema v34 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). The public surface each layer depends on.
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

// Variables.ts — design tokens (schema 19, M5). Validation shared by load + edit paths;
// resolution is pure and NEVER throws (broken references render the visible fallback).
type ThemeMode = "light" | "dark";
const THEME_MODES: readonly ThemeMode[];
type VariableType = "color" | "spacing" | "font";
type VariableValue = string | number;                      // concrete, or an alias "$key"
interface Variable { type: VariableType; value: VariableValue; modes?: Partial<Record<ThemeMode, VariableValue>> }
interface VariableStore { [key: string]: Variable }
const VARIABLES_MAX: number;                               // store entry cap (OOM guard)
const VARIABLE_KEY_MAX: number;                            // key length cap
const VARIABLE_FALLBACK_COLOR: string;                     // debug magenta for a broken color token
function isTokenRef(v: unknown): v is string;              // "$" + non-empty key
function tokenRefFor(key: string): string;                 // key → reference ("" → "", never a bare "$")
function tokenKeyOf(value: unknown): string;               // reference → key; "" for a concrete value
function variableError(def: unknown): string | null;       // one definition (shared with the 18→19 sanitizer)
function variableKeyError(key: string): string | null;     // one KEY (empty/long/"$"/reserved "__proto__" family) — SetVariableAction pre-checks it (the assignment would swallow a reserved key before store validation could see it)
function variableStoreError(store: unknown): string | null; // whole store, shared load + edit
function resolveVariable(store: VariableStore, key: string, theme: ThemeMode): string | number | null; // follows aliases; null = missing/cycle
function resolveColor(store: VariableStore, raw: string, theme: ThemeMode): string;   // non-token passes through; broken token → fallback
function resolveNumber(store: VariableStore, raw: number | string, theme: ThemeMode): number | null; // number tokens — consumed by radius/fontSize (schema 20); layout gap/padding later

// Components.ts — reusable components (schema 21, M6). A master is an ordinary node subtree;
// an instance is a `core.instance` node with `componentId`. Resolution is pure and never throws.
const VIRTUAL_ID_SEP: string;                              // "::" — also RESERVED in stored ids
const INSTANCE_MAX_DEPTH: number;                          // nesting cap
const INSTANCE_MAX_NODES: number;                          // total materialized-node cap (OOM guard)
function virtualId(instancePath: string, masterNodeId: string): string;
function isVirtualId(id: string): boolean;                 // true for an expansion-produced id
function splitVirtualId(id: string): { instancePath: string; masterNodeId: string } | null; // reversible
function ownerInstanceOf(id: string): string | null;       // the STORED instance a virtual node belongs to (first path segment)
function componentError(type: string, componentId: unknown): string | null; // shared load + edit; dangling is ALLOWED
// VARIANTS (schema 27). A set has no object of its own — it is the masters that name it, so
// tagging a node creates the set and untagging the last member ends it. Resolution is TOTAL:
// not a variant, no member matching, an unknown property — every failure draws `componentId`.
function variantMembers(doc: ReadonlyDocument, set: string): string[];              // sorted by id — DETERMINISTIC, not Map insertion order
function variantProperties(doc: ReadonlyDocument, set: string): Record<string, string[]>; // what a picker offers; names and values sorted
function resolveVariantMaster(doc: ReadonlyDocument, instance: { componentId?: string; variants?: Record<string, string> }): string | null;
function masterSubtreeIds(doc: ReadonlyDocument, masterId: string): string[];       // document order, cycle-safe; shared with DetachInstanceAction
// Carries overrides across a variant switch: the ROOT structurally, everything else by a name
// UNIQUE in both subtrees. An unmatched entry is KEPT (inert, live again on switch-back) —
// guessing between two same-named nodes would move an edit onto the wrong element.
function remapOverridesForVariant(doc, overrides, fromMasterId, toMasterId): Record<string, InstanceOverride> | undefined;
// An override KEY is a PATH of master node ids (schema 28): `MC` names a node of the
// instance's own master, `OI::IM` a node inside the nested instance `OI`'s expansion. This is
// what lets an outer instance reach through a nested one; the override still lives on the
// owning STORED instance, because a virtual instance node cannot hold one.
function resolveOverridePath(doc: ReadonlyDocument, instance, key: string): Node | null;  // null = inert, not invalid
function mergeOverrides(base: InstanceOverride | undefined, patch: InstanceOverride): InstanceOverride; // patch wins; nested maps merge
// SLOTS (schema 29): a master names a hole (`Node.slot`), an instance fills it
// (`Node.slotContent`: slot name → node id). The slot supplies the BOX and its own children
// are the default; a fill is a REFERENCE, so the content goes on living where it is. Unfilled
// or dangling falls back to the default. `InstanceOverride.slotContent` is how an OUTER
// instance fills a slot inside a nested one — no second addressing scheme.
function slotError(slot: unknown): string | null;                       // shared load + edit
function slotContentError(type: string, slotContent: unknown): string | null;  // instances only; shared load + edit
// STATES (Milestone 7, schema 30): what a node looks like in a named context. A state IS an
// InstanceOverride — the same shape of statement — so it shares `overrideValueError`. Which
// state shows is a DOCUMENT-level selection (`ProjectDocument.activeState`), like activeTheme.
function overrideValueError(label: string, value: unknown): string | null;  // the per-VALUE half, shared by overrides AND states
function statesError(states: unknown): string | null;                       // any node may carry states; shared load + edit
function applyActiveState(doc: ReadonlyDocument): ReadonlyDocument;         // pure; SAME reference when nothing defines the active state
// The scene as DISPLAYED — state first, then instances, so a master in its hover state makes
// hovered copies. THE seam every consumer reads; calling expandInstances directly would skip
// states, and a test asserts nothing outside Components does.
function resolveScene(doc: ReadonlyDocument): ReadonlyDocument;  // = expandInstances(applyActiveState(dropHidden(doc)))
// LAYER FLAGS (schema 31). `dropHidden` removes each hidden node WITH its subtree, so one flag
// gives all three consequences at once — not drawn, not picked, no auto-layout space — instead
// of a flag every consumer must remember to check. LOCK is different: a locked node still
// DRAWS, so it stays in the scene and `ComputedState.locked` is what both pickers skip.
function dropHidden(doc: ReadonlyDocument): ReadonlyDocument;   // SAME reference when nothing is hidden

```ts
// editor/layerDrop.ts — what a layer-panel drag resolves to, without the DOM.
type DropPosition = "before" | "after" | "inside";   // a row's top edge, bottom edge, or middle
interface LayerDrop { parent: string | null; index: number }  // index measured AFTER the node is detached
function resolveLayerDrop(doc, dragged, target, position): LayerDrop | null;   // null = refuse the drop
// editor/layerSelection.ts — what a row click selects. A shift RANGE spans the VISIBLE row
// order the panel passes in, not the document: rows the user cannot see are not between
// anything. The anchor does NOT move on shift, so a range can be grown and shrunk.
function selectionForRowClick(visible, current, anchor, clicked, mods): { selected: string[]; anchor: string | null };
// editor/layerFilter.ts — which rows a search leaves visible. A node stays when it matches OR
// anything beneath it does, so the panel shows the PATH to every hit; the caller treats a
// filtered tree as fully expanded, since a hit inside a collapsed group must be reachable.
function filterLayers(doc, query, labelOf): { visible: Set<string>; matched: Set<string>; inactive: boolean };
// geometry/PathBuilder.ts — pen points → a `core.path` node. Commands are stored LOCAL to the
// node's box while a pen draws in WORLD space, so the box is derived from the points and every
// coordinate re-based onto it. A point stores its OUT handle; the IN handle is its mirror, so a
// curve is smooth by construction. A segment is a LINE when neither end has a handle.
interface PenPoint { x: number; y: number; hx?: number; hy?: number }
function penCommands(points, closed): PathCommand[];          // WORLD space
function pathBounds(commands): Rect;                          // INCLUDES control points — never clips the ink
function translatePath(commands, dx, dy): PathCommand[];
function penNodeFrom(points, closed): { geometry: Rect; path: PathCommand[] } | null;  // null = what dimensionError would refuse
// VERTEX editing. Moving a point carries the control handles that belong to it (a cubic's
// x2/y2 is the IN handle of its own endpoint; the NEXT command's x1/y1 is that point's OUT
// handle), or the curve warps instead of translating. On a CLOSED path the M and the final
// drawing command are the same point, so the first vertex moves its twin too.
function pathVertices(commands): PathVertex[];                       // on-curve points; Z contributes none
function movePathVertex(commands, index, dx, dy): PathCommand[];
// After an edit, commands go back onto a (0,0) origin with the BOX moved to match — bounds are
// what selection, snapping, culling and hit-testing read, so ink outside the box breaks them all.
function normalizePathNode(geometry, commands): { geometry: Rect; path: PathCommand[] };
// geometry/SelectionHandles.ts — a selected `core.path` also shows one handle per vertex, in
// WORLD space, named `vertex:N` so a grab identifies the command without re-deriving it from a
// position two vertices could share.
function pathVertexHandles(doc, state, selectedNodeIds): SelectionHandle[];
function vertexIndexOf(handle: string): number | null;
```

`applyMutations` detaches before inserting, so an index measured against the list as it looks
now is one too high whenever the node moves DOWN within its own list — the adjustment lives in
`resolveLayerDrop` with tests rather than in a drag handler. It refuses a no-op, a drop into
the node's own subtree, and a drop INSIDE an instance (which has no stored children to join);
`ReparentNodeAction` refuses cycles independently, so this is about not OFFERING a drop that
would fail. The panel gates its drop indicator on the same call, so the hint and the outcome
cannot disagree.
function expandInstances(doc: ReadonlyDocument): ReadonlyDocument; // materializes instances as virtual children; SAME reference when there is nothing to expand
// Per-instance OVERRIDES (schema 22, M6 slice 2): what one instance changes about its copy,
// keyed by MASTER NODE ID. Applied during expansion at each level; a key matching no master
// node is inert. Schema 26 added `layout` and `transform`, so a copy can lay its children
// out differently and be rotated independently of its master.
interface InstanceOverride { geometry?: Partial<Geometry>; style?: Partial<Style>; text?: string; src?: string; layout?: Partial<Layout>; transform?: Partial<Transform>; slotContent?: Record<string, string> }
const INSTANCE_MAX_OVERRIDES: number;                      // per-instance cap (OOM guard)
function overridesError(type: string, overrides: unknown): string | null; // shared load + edit; each field obeys its stored rule (styleError, finite geometry)
// Node.ts — an image SOURCE (schema 23). Only a core.image may carry one; bounded, and the
// scheme must be something a renderer can draw (http/https/blob/relative, or data:image/*).
function srcError(type: NodeType, src: unknown): string | null;   // shared load + edit
function srcValueError(src: unknown): string | null;              // the TYPE-FREE half, reused by the override seam (schema 24)
const IMAGE_SRC_MAX: number;                                      // cap on an inlined data: URL
function overrideAgainstMasterError(doc: ReadonlyDocument, instance: ReadonlyNode): string | null; // the TYPE-aware half of override validation (needs the doc to resolve each key's master): per-type sizes AND "only a core.image may take a src override". BOTH paths run it
// ONE node of a master subtree as an instance renders it (override applied; the ROOT re-origined
// to (0,0) and stripped of constraints). Shared by expandInstances (VIRTUAL) and
// DetachInstanceAction (STORED), so a detach bakes exactly what was drawn.
function materializeNode(master: Node, override: InstanceOverride | undefined, isRoot: boolean, id: string, parent: string | null): Node;

// actions/nodeEdit.ts — routes an edit to the right Action for the node it targets. A STORED
// node edits directly; an instance COPY (virtual id) becomes a per-instance override. Null =
// the edit cannot be expressed (vanished node, or a copy nested inside another instance).
function geometryActionFor(doc: ReadonlyDocument, nodeId: string, patch: Partial<Geometry>): Action | null;
function styleActionFor(doc: ReadonlyDocument, nodeId: string, patch: Partial<Style>): Action | null;
function layoutActionFor(doc: ReadonlyDocument, nodeId: string, patch: Partial<Layout>): Action | null;      // schema 26
function transformActionFor(doc: ReadonlyDocument, nodeId: string, patch: Partial<Transform>): Action | null; // schema 26 — what lets a COPY rotate
function overrideTargetFor(doc: ReadonlyDocument, nodeId: string): { instanceId: string; masterNodeId: string } | null;
function contentActionFor(doc: ReadonlyDocument, nodeId: string, patch: ContentPatch): Action | null; // text/src route to an override on a copy; NAME has no override slot, so a mixed patch is refused WHOLE
function isEditableNode(doc: ReadonlyDocument, nodeId: string): boolean; // gate an affordance rather than offer a dead control
function isHandleOffered(doc: ReadonlyDocument, nodeId: string, handle: string): boolean; // the ONE rule read by the renderer, the picker AND the hover cursor (every copy now offers all of them, nested included)
function isMasterRootCopy(doc: ReadonlyDocument, nodeId: string): boolean; // the copy whose POSITION is the instance's (its x/y override is refused)

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
interface ComputedNode { world: Mat2D; local: Rect; bounds: Rect; shape: HitShape }

// ShapeHit.ts — what a node's INK covers in its LOCAL box, so picking follows the drawing.
// Derived once per node by the engine (like `locked`), read by the pickers.
type HitShape =
    | { kind: "box"; radius: number }              // rectangle/text/image/instance; radius resolved like the renderer's
    | { kind: "ellipse" }                          // fills its box
    | { kind: "line" }                             // the box DIAGONAL, top-left → bottom-right
    | { kind: "path"; commands: readonly PathCommand[]; filled: boolean };
function hitsShape(shape: HitShape, width: number, height: number, x: number, y: number, tolerance: number): boolean;
function flattenPath(commands: readonly PathCommand[]): { points: {x: number; y: number}[]; closed: boolean }[]; // 16 segments per curve, FIXED so a pick cannot depend on zoom
function isPaintBearing(fill: string): boolean;   // "", "none", "transparent" = no paint
// A path's INTERIOR is its FILL: both backends close an open subpath implicitly when filling,
// so `filled` (not an explicit `Z`) decides whether the inside is pickable. Nonzero winding is
// summed ACROSS subpaths, which is what gives a donut its hole. The outline always hits within
// `tolerance`, which is how a bare stroke is picked at all.
interface ComputedState { order: string[]; nodes: Map<string, ComputedNode>; locked: ReadonlySet<string> }
// `locked` is INHERITED (a locked group locks its contents) and computed during the same
// parents-first walk, so `hitTest` and `nodesInRect` read one answer rather than each deriving
// it. A locked node still draws — the renderer ignores it — it just cannot be selected, and a
// click passes THROUGH to whatever is behind.
function computeGeometry(
  doc: ReadonlyDocument,
  pending?: Map<string, Partial<Geometry>> | null,  // drag previews are an INPUT
  previous?: ComputedState,                          // dirty-tracking reuse
  dirty?: ReadonlySet<string>
): ComputedState;
// Runs `expandInstances` FIRST (M6), so every consumer sees one consistent scene with
// instance content materialized. A dirty set names STORED ids, so it is TRANSLATED into the
// expanded id space: a copy is dirty when any node on its `::` path is — its master node,
// the instance whose overrides / variant / slot fills shape it, or any master between.
// `incremental === full` is property-tested over instanced documents too.
function hitTest(computed: ComputedState, x: number, y: number, tolerance?: number, includeVirtual?: boolean): string | null; // local-space, DOM-free; tests the node's INK (`hitsShape`), not its box — a triangle's empty corner passes the click THROUGH to whatever is drawn behind; `tolerance` (world units, default 0) is a pick halo so thin/zero-extent targets (an axis-aligned line) stay selectable; `includeVirtual` is the DEEP pick (alt-click) that selects an instance COPY instead of the instance. By default a virtual hit RESOLVES to its owning instance rather than being skipped, so content drawn OUTSIDE the instance's own box is still clickable; `nodesInRect` resolves the same way and dedupes
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
function selectionFrame(s: ComputedState, nodeId: string, pad?: number): Quad | null;  // the node's OWN box in world (nw·ne·se·sw), turned with it; `pad` is a WORLD distance, converted per axis so the gap is even on all four edges under any scale
function selectionHandles(s: ComputedState, selectedNodeIds: readonly string[], zoom: number): SelectionHandle[]; // 4 corners + rotate per selected node — on the TURNED box, not the world AABB; each cursor comes from the direction its corner points on screen, and the knob rides the turned top edge

// TYPOGRAPHY (schema 34). Five optional Style fields; absent means what was drawn before.
const TEXT_ALIGNS: readonly ["left", "center", "right", "justify"];
const FONT_FAMILY_MAX: number;                             // cap on the font STACK string
interface Style {
    fontFamily?: string;        // a CSS font STACK, not a resolved face (there is no font loading)
    fontWeight?: number | string;   // 100-900, or a number token; absent = 400
    textAlign?: TextAlign;          // absent = "left"
    lineHeight?: number | string;   // a MULTIPLE of the font size (CSS unitless); absent = 1.2
    letterSpacing?: number | string; // world units, MAY be negative; absent = 0
}
// All five are resolved in the RENDER MODEL (token looked up, range checked, default applied), so
// the backends transcribe and decide nothing. An out-of-range resolved token falls back like
// radius/fontSize. An explicit NEWLINE is a hard line break in both backends (SVG sets
// `white-space: pre-wrap`); `justify` has no canvas equivalent and falls back to left there.

// PathBoolean.ts — union / subtract / intersect / exclude on closed shapes, by edge classification:
// split every edge where it crosses the other shape, classify each piece by its MIDPOINT, keep what
// the op asks for (reversing B's when subtracting, so the removed part reads as a hole under the
// nonzero rule), then chain the pieces back into closed rings.
type BooleanOp = "union" | "subtract" | "intersect" | "exclude";
type Ring = Point[];                                                  // closed; the closing edge is implied
function booleanRings(a: readonly Ring[], b: readonly Ring[], op: BooleanOp): Ring[];
function booleanPaths(a: readonly PathCommand[], b: readonly PathCommand[], op: BooleanOp): PathCommand[];
function commandsToRings(commands: readonly PathCommand[]): Ring[];   // every subpath treated as CLOSED, like the fill
function ringsToCommands(rings: readonly Ring[]): PathCommand[];
function insideRings(rings: readonly Ring[], x: number, y: number): boolean;
// CURVES ARE FLATTENED (16 segments each) — a boolean of curved shapes returns polylines, not
// curves. KNOWN LIMIT: exactly collinear overlapping edges are not special-cased.

// ShapeToPath.ts — any node's outline as commands ("convert to path"), the input side of a boolean.
function ellipseCommands(width: number, height: number): PathCommand[];          // 4 cubics, KAPPA control points
function rectCommands(width: number, height: number, radius?: number): PathCommand[]; // 4 lines, or lines + corner arcs; radius clamped like picking/drawing
function shapeToCommands(shape: HitShape, width: number, height: number): PathCommand[] | null;  // null for a `core.line` (a stroke has no interior) and for an empty path
function transformCommands(m: Mat2D, commands: readonly PathCommand[]): PathCommand[];  // control points included

// booleanActions.ts — the editor-facing combine (a TransactionAction factory, like alignAction).
function worldCommandsOf(computed: ComputedState, nodeId: string): PathCommand[] | null;
function booleanAction(doc, computed: ComputedState, selectedNodeIds: readonly string[], op: BooleanOp, newId: string): Action | null;
// Combines in DRAW order (bottom-most first, so `subtract` cuts the shapes above out of the one
// below whatever order they were clicked), in WORLD space, and replaces the operands with ONE
// `core.path` re-based onto its own tight box, inheriting the bottom-most operand's paint. Null —
// changing nothing — for fewer than two operands with an outline, or an empty result. DESTRUCTIVE;
// the non-destructive `core.boolean` node is a later slice. `newId` is minted by the CALLER,
// because both halves of the transaction (create the node, then set its commands) must name it.

// OrientedBox.ts — the node's box as DRAWN, and resizing along its own axes.
type Quad = [Point, Point, Point, Point];                                   // nw · ne · se · sw
function boxQuad(world: Mat2D, width: number, height: number, pad?: number): Quad;
function axisLengths(world: Mat2D): { ux: number; uy: number };             // world length of one local unit per axis (the matrix COLUMNS)
function quadCenter(q: Quad): Point;
function cursorForDirection(dx: number, dy: number): string;                // nearest of the 4 CSS resize cursors
function worldDeltaToLocal(world: Mat2D, dx: number, dy: number): Point;    // {0,0} for a singular matrix, never Infinity
function localLinear(parentWorld: Mat2D, world: Mat2D): Mat2D;              // the node's own rotate∘scale, recovered from the engine's matrices
function resizeBox(handle: string, box: Box, dLocal: Point, m: Mat2D, origin?: Point, minSize?: number): Box;
// resizeBox holds the OPPOSITE corner where it is drawn: x' = x + Δo + M(Δf − Δo), where Δo is the
// transform-origin's shift (it is a FRACTION of the size, so resizing moves it) and Δf the fixed
// corner's. With no transform M = I and it collapses to the plain `x' = x + Δf`. Dragging past the
// opposite corner CLAMPS to `minSize` — it does not flip the box.
function handleAtPoint(s: ComputedState, selectedNodeIds: readonly string[], x: number, y: number, zoom: number): SelectionHandle | null; // handle under a world point; back-to-front (rotate beats a grazed corner)
// GROUP handles (multi-select): the editor shows ONE rotate knob above the union box (selectionBounds), not per-node handles.
function groupRotateHandle(s: ComputedState, rootIds: readonly string[], zoom: number): SelectionHandle | null;  // the group's single rotate knob (nodeId ""), or null if no finite union box
function groupCornerHandles(s: ComputedState, rootIds: readonly string[], zoom: number): SelectionHandle[];      // the group box's 4 resize corners (nodeId ""); drawn/picked only for a RESIZABLE group
function groupHandleAtPoint(s: ComputedState, rootIds: readonly string[], x: number, y: number, zoom: number, includeCorners?: boolean): SelectionHandle | null; // knob first (wins overlaps), then — when includeCorners — the corners

// geometry/GroupTransform.ts — pure math for transforming a MULTI-SELECTION as one object.
interface GroupRotateInput { id: string; startX: number; startY: number; startRotation: number; centerX: number; centerY: number } // a root's start pose (captured at grab)
interface GroupRotateOutput { id: string; x: number; y: number; rotation: number } // orbited stored x/y + new absolute rotation
function rotateGroup(pivotX: number, pivotY: number, delta: number, inputs: readonly GroupRotateInput[]): GroupRotateOutput[]; // each root: rotation += delta AND centre orbits the pivot (rigid). ABSOLUTE in delta (no compounding)
function isGroupRotatable(doc: ReadonlyDocument, rootIds: readonly string[]): boolean; // every root centre-origin + translation-only PARENT chain (else no knob is shown)
interface GroupScaleInput { id: string; startX: number; startY: number; worldX: number; worldY: number; startWidth: number; startHeight: number } // stored + world start geometry
interface GroupScaleOutput { id: string; x: number; y: number; width: number; height: number }
function scaleGroup(fixedX: number, fixedY: number, sx: number, sy: number, inputs: readonly GroupScaleInput[]): GroupScaleOutput[]; // proportional scale about the FIXED corner (world), world delta mapped 1:1 to stored; absolute in sx/sy
function isGroupResizable(doc: ReadonlyDocument, rootIds: readonly string[]): boolean; // STRICTER than rotatable: every root transform-free INCLUDING itself (a rotated member scaled non-uniformly is a shear) + not laid-out

// geometry/Snapping.ts — DOM-free alignment snapping (M4 smart guides), pure like the above.
const SNAP_THRESHOLD_PX: number;                       // default snap budget, SCREEN px (tools ÷ zoom)
interface SnapGuide { axis: "x" | "y"; pos: number; start: number; end: number } // "x"=vertical line at world x=pos; span on the perpendicular axis
interface SnapResult { dx: number; dy: number; guides: SnapGuide[] }
function computeSnap(moving: Rect, targets: readonly Rect[], threshold: number): SnapResult; // MOVE: snap a whole box's edges/centre onto a target's; guides at each alignment
function snapPoint(px: number, py: number, targets: readonly Rect[], threshold: number): { dx: number; dy: number }; // RESIZE: snap the dragged corner to target lines, each axis independently
function guidesForRect(rect: Rect, targets: readonly Rect[]): SnapGuide[]; // guides for a rect's existing alignments (merged spans)
function snapTargetsExcludingSubtree(doc: ReadonlyDocument, computed: ComputedState, rootId: string): Rect[]; // other nodes' world bounds, minus rootId's own subtree
function snapTargetsExcludingSubtrees(doc: ReadonlyDocument, computed: ComputedState, rootIds: readonly string[]): Rect[]; // …minus EVERY root's subtree (group move)
function isTranslationOnlyChain(doc: ReadonlyDocument, nodeId: string): boolean; // node + all ancestors unrotated/unscaled → world snap delta == stored delta (snapping is enabled only then)

// scan/CapabilityScan.ts — find capabilities a codebase has but nothing reaches. PURE: takes
// file contents, returns findings, so the heuristic is node-tested. The RULE is a fact about
// the text (exported here, referenced in no other file); the verb/directory hints only RANK.
interface SourceFile { path: string; content: string }
interface Capability { name; path; line; kind; confidence: "high"|"medium"|"low"; reason }
function scanCapabilities(files: readonly SourceFile[]): Capability[];

// export/ExportSVG.ts — the document as standalone SVG text. PURE (no DOM), and built from the
// SAME DisplayList the editor draws, so an export cannot drift from the canvas. Framed to the
// content, not the viewport; grid and selection chrome excluded.
const EXPORT_MARGIN: number;
function exportSVG(doc: ReadonlyDocument): string;

// editor/shortcuts.ts — maps a key chord to an editor command. PURE, so "what does Shift+Left
// do?" is a unit test. Ctrl and Cmd are interchangeable; a MODIFIED arrow is left to the
// platform; a press from a text field is never a shortcut.
const NUDGE_STEP: number;         // 1
const NUDGE_STEP_LARGE: number;   // 10, with Shift
type Shortcut = { kind: "nudge"; dx; dy } | { kind: "duplicate" | "delete" | "group" | "select-all" | "deselect" | "undo" | "redo" };
function resolveShortcut(e: KeyChord): Shortcut | null;
function isTypingTarget(target): boolean;

// geometry/Alignment.ts — pure align/distribute maths over WORLD rects; returns the new origin
// for each box that MOVES (an unchanged box is omitted, so a no-op click commits nothing).
type AlignEdge = "left" | "center-h" | "right" | "top" | "center-v" | "bottom";
type DistributeAxis = "horizontal" | "vertical";
function alignBoxes(boxes: readonly Rect[], edge: AlignEdge): Map<number, {x,y}>;      // >= 2 boxes
function distributeBoxes(boxes: readonly Rect[], axis: DistributeAxis): Map<number, {x,y}>; // >= 3, equal GAPS

// geometry/Polygon.ts — regular N-gon vertices (pentagon, hexagon, octagon, …), normalized so
// the polygon's own bbox fills the drawn box. Pure; ShapeTool turns them into core.path commands.
const POLYGON_MIN_SIDES: number;   // 3 — a 2-gon is a line
const POLYGON_MAX_SIDES: number;   // 64 — past that an N-gon IS an ellipse, which we draw cheaper
const POLYGON_DEFAULT_SIDES: number;
function clampSides(sides: number): number;                    // shared by the tool, the toolbar and the generator
function polygonPoints(sides: number, width: number, height: number): Point[];

// geometry/Ruler.ts — pure ruler tick computation (the app draws the bars).
interface RulerTick { world: number; label: string; major: boolean } // major = every 5th tick
function niceStep(worldPerTarget: number): number;                     // 1/2/5 × 10ᵏ step
function rulerTicks(worldStart: number, worldEnd: number, zoom: number, targetPx?: number): RulerTick[]; // ticks across the visible world range, ~targetPx apart

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
schema-18 effects (`Shadow` = dx/dy/blur/color; `blur` ≥ 0). `trackError(t)` validates ONE grid
track (exactly one of px/fr/auto; `px ≥ 0`, `fr > 0`, `auto === true`) and is exported so the
track-list parser can defer to it rather than restate it. `layoutExclusivity(patch)` is the ONE
statement of grid ⊕ container exclusivity — it takes and returns a PATCH (the action's delta must
stay partial so a transaction merge is last-wins), and `mergeLayout(base, patch)` is
`{ ...base, ...layoutExclusivity({ ...patch }) }`; the override merge and
`UpdateNodeLayoutAction`'s delta both call it. `newGridPatch()` returns the layout
patch that turns a node into a grid — a COMPLETE grid, since `columns` and `rowHeight` are
mandatory; it does not clear `container`, because `UpdateNodeLayoutAction` carries grid ⊕
container exclusivity in the delta itself. See [DOCUMENT-SCHEMA.md](DOCUMENT-SCHEMA.md).

```ts
// TrackList.ts — the TEXT form of a grid track list ("1fr 1fr 200px"), the authoring side of
// the structured `TrackSize[]`. Pure, and the exact inverse of each other for any valid list.
interface TrackListParse { tracks: readonly TrackSize[] | null; error: string | null }  // exactly one is set
function parseTrackList(text: string): TrackListParse;   // ws/comma separated; bare number = px; empty is an ERROR
function formatTrackList(tracks: readonly TrackSize[]): string;
```

The parser builds a candidate track and hands it to `trackError`, so a field cannot author a
track the document would refuse. Structured storage is kept for the same reason `core.path`
stores commands rather than a `d` string (one validator, no backend re-parses); the text form
exists because a row-per-track widget is a poor way to author six columns.

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
// Two patches for the SAME node merge later-wins. Object fields (geometry/transform/style/layout)
// merge FIELD BY FIELD — their actions emit partials, and a move + a resize must both land.
// Everything else is a whole-value spread, which also preserves KEY PRESENCE (the `in`-read
// contract of variant/variants/slot/slotContent/states/hidden/locked: carrying the key with
// `undefined` is how a clear is expressed).

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
      text?: string; src?: string; name?: string }
  | { kind: "variables"; variables: VariableStore; activeTheme: ThemeMode }; // DOC-level (M5): whole store + theme, under DOCUMENT_DELTA_KEY
const DOCUMENT_DELTA_KEY: string;    // = RESERVED_NODE_ID ("__document__") — the delta-map key for kind "variables"; the node id itself is REJECTED by AddNodeAction + Integrity so a real node can never collide, and TransactionAction excludes it from updatedNodeIds

// VariableActions.ts — the design-token write path (M5). All emit the "variables" delta;
// validation delegates to the shared variableStoreError (load/edit round-trip closure).
class SetVariableAction extends Action { constructor(doc: ReadonlyDocument, key: string, variable: Variable) }   // upsert
class DeleteVariableAction extends Action { constructor(doc: ReadonlyDocument, key: string) }                     // dangling refs stay valid
class SetActiveThemeAction extends Action { constructor(doc: ReadonlyDocument, theme: ThemeMode) }                // undoable + persisted
```

## Dispatcher & History (`core/actions/`)

```ts
class ActionDispatcher {
  constructor(initialDoc: ProjectDocument);
  dispatchAction(action: Action, options?: { coalesce?: boolean }): MutationResult; // never throws; coalesce collapses a run of same-target edits (a node action by `actionId:nodeId`, a TransactionAction by its name) into one undo
  onChange(listener: (r: MutationResult) => void): () => void;  // returns unsubscribe
  undo(): ProjectDocument | null;
  redo(): ProjectDocument | null;
  canUndo(): boolean;
  canRedo(): boolean;
  getHistoryCheckpoint(): string;                      // current revision id; capture BEFORE a live-committed gesture
  rollbackToCheckpoint(revisionId: string): boolean;   // hard-cancel: discard revisions since the checkpoint (no undo/redo trace); false if trimmed
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
  getCurrentRevisionId(): string;                      // a checkpoint id for rollbackTo
  rollbackTo(revisionId: string): ProjectDocument | null; // DISCARD every revision after the id (undo leaves them redoable; this erases them); null if trimmed
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
  // = one undo per continuous drag; Escape cancels an in-flight resize/rotate — a rotate cancel rolls
  // history back to a checkpoint captured at grab, erasing the gesture's revisions with no undo/redo
  // trace regardless of the coalesce window, and a grab+Escape with no drag is a true no-op), Delete/Backspace, and on an
  // IDLE hover sets `EditorState.hoverCursor` from `handleAtPoint` so the Canvas backend shows handle cursors —
  // each a mode that intercepts before the active tool. For a MULTI-root selection the per-node handles are
  // replaced by ONE group rotate knob (`groupHandleAtPoint`): grabbing it rotates every root rigidly about the
  // group-box centre (`rotateGroup`), live-committed as one coalesced `TransactionAction` per frame (one undo);
  // Escape reverts (shown only when `isGroupRotatable`). Dragging a GROUP CORNER scales every root
  // proportionally about the opposite corner (`scaleGroup`) — previewed via pendingGeometry, committed as
  // one transaction on mouse-up, Escape drops the preview; shown only when `isGroupResizable` (every root
  // transform-free — resizing a ROTATED set is a shear and stays impossible by design).
}
```

Tools: `SelectTool`, `MoveTool`, `ShapeTool` (all implement `Tool`). Tools construct
Actions and dispatch them; they mutate only `EditorState`, never the document.
`ShapeTool` is ONE tool parameterised by `ShapeKind` (`SHAPE_KINDS` = rectangle | ellipse |
line | text | triangle | polygon | image), since the corner-to-corner gesture, preview, Escape and zoom-independent
minimum size are identical for all of them — only the node type, the paint and the content
differ. Its minimum-size rule is per-type on purpose, to agree with the shared `dimensionError`
the action validates against (a `core.line` may collapse ONE axis; everything else needs a box),
so the tool can never commit what validation would reject. FILLED vs OUTLINE is a toolbar mode,
not a document concept: an outline is `fill: "none"` plus a `stroke`, both long-standing `Style`
fields. `supportsPaintMode(kind)` reads the same table the tool commits from, so the control is
never offered for a kind that would ignore it (a line is already only a stroke). An outline's
BORDER WIDTH is `Style.strokeWidth` (schema 25) in WORLD units — absent means the historic
1-SCREEN-pixel hairline, so an older document renders unchanged; `clampStrokeWidth` is shared
by the tool and the toolbar control.
`SelectTool` also owns box-select: a drag begun on empty space draws a marquee
(`EditorState.marqueeRect`) and, on release, selects `nodesInRect` (shift = additive); a
plain click with no drag deselects. Picking is world-space (`hitTest`/`nodesInRect`), never
the DOM, so selection works under any renderer backend.
Alignment snapping applies to a SINGLE node whose transform chain is translation-only
(`isTranslationOnlyChain` — so a WORLD snap delta maps 1:1 to stored; top-level OR nested under
purely-translated parents): `MoveTool` folds `computeSnap` into a drag (whole box) and
`ToolController` resize folds `snapPoint` into a corner drag — both run in WORLD space (via the
node's world origin/offset) and write `EditorState.snapGuides`. A multi-node, or rotated/scaled-
chain, gesture is unsnapped (deferred).

## Renderer (`renderer/`)

The renderer is a pure display-list builder plus a thin backend. `buildRenderModel`
turns `(size, doc, state)` into a plain-data `DisplayList`; a backend transcribes it to
the screen. Every draw decision lives in the model (unit-tested in the `node` env like
the layout engine); the backend does no arithmetic. Every COLOR slot (fill, stroke,
shadow.color, the line's stroke||fill fallback) resolves `$token` references via
`resolveColor(doc.variables, raw, doc.activeTheme)` IN the model (M5), so both backends
agree, the deduped filter defs key on resolved colors, and a theme switch repaints
through the normal dispatch path.

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
function setImageReadyCallback(cb: (() => void) | null): void;       // fired when a lazily-loaded Canvas image decodes (→ repaint)
function renderSVG(container: HTMLElement, doc: ReadonlyDocument, state: RendererState): void;    // buildRenderModel ∘ emitSVG
function renderCanvas(container: HTMLElement, doc: ReadonlyDocument, state: RendererState, onAsyncReady?: () => void): void; // ∘ emitCanvas (sizes a <canvas> for the DPR; onAsyncReady repaints on image load)
function clearRenderState(container: HTMLElement): void;             // drop the container's cached prev frame (call when its DOM is cleared)
type RenderBackend = "svg" | "canvas";
function renderScene(container: HTMLElement, doc: ReadonlyDocument, state: RendererState, backend: RenderBackend, onAsyncReady?: () => void): void; // the live backend selector
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
  smoke-verified). Canvas IMAGES now render (lazily loaded + cached; `setImageReadyCallback` repaints on
  decode). Canvas TEXT now word-WRAPS (greedy measureText breaking with CSS-normal whitespace
  collapse — all whitespace runs are single-space break points, matching the HTML backend —
  1.2×fontSize lines, clip-cropped); exact `<foreignObject>` metric parity stays the inherent gap.
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
