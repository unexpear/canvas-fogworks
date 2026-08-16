# API Contracts

<!-- describes: src/core/actions, src/core/document, src/core/geometry, src/editor, src/renderer, src/electron/preload.js, scripts/build.js -->
<!-- re-read 2026-08-14 after the runtime's first slice: accurate, and it gained a surface —
     `core/runtime/World`, below. Nothing existing changed shape; the runtime stamps a document the
     way `applyFrame` does and every signature here reads it unchanged. -->
<!-- re-read 2026-08-13 after the collection draw path: `collectionTileBox` added; the tilemap
     DisplayItem now carries `pictures` beside `sheet`, and the two are never both non-null. -->
<!-- re-read 2026-08-13 after schema 67 and the multi-tileset exporter: THREE signatures here had
     drifted. `tilemapForLayer` gained its identity FUNCTION; `AutotileTable` holds a LIST per mask
     and `rotatedTable` takes an array, not a Map; and autotiling was still described as having "no
     schema field yet", four schemas after `Tilemap.terrain` shipped. The `document/Tileset` surface
     was missing entirely. -->
<!-- re-read 2026-08-10 after the object-layer slices and the OP7 fix: accurate. The wrong
     sentence about a grid inheriting an object layer's opacity lived in the code comment, the
     mutant note and ACTION-SYSTEM.md — not here; `TilePlacement` is not part of this surface. -->

> 🔒 Frozen contract · schema v71 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). The public surface each layer depends on.
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
const FLATTEN_TOLERANCE: number;   // 0.05 — how far a polyline may stray from its curve, in the PATH's own units
const FLATTEN_MAX_DEPTH: number;   // 10 halvings — the bound that keeps a pathological curve from hanging a hot path
function flattenPath(commands: readonly PathCommand[], tolerance?: number): { points: {x: number; y: number}[]; closed: boolean }[];
const DISPLAY_DEVIATION_PX: number;   // 0.2 — silhouette error a DRAWN curve may show, in device px
const DISPLAY_TOLERANCE_MIN: number;  // 1e-4        bounds, because `scale` comes from a document matrix
const DISPLAY_TOLERANCE_MAX: number;  // 8
function displayTolerance(scale: number): number;   // device-px-per-world-unit → a flattening tolerance
function localScaleOf(m: {a,b,c,d}, viewScale: number): number;   // larger row norm x view scale
// TWO tolerances, and they are different KINDS of number. `FLATTEN_TOLERANCE` is in the path's own
// units and never moves, because PICKING must answer the same at every magnification. The display
// one is measured on the SCREEN, because the only drawing error that matters is one a person can
// see — a fixed world tolerance facets a curve at 20x and wastes a hundred segments on it at
// 0.05x. QUANTISED to powers of two: a tolerance tracking the zoom continuously would change the
// vertex count every frame of a pinch and make silhouettes shimmer. Bounded at both ends, and a
// non-finite or non-positive scale falls back to `FLATTEN_TOLERANCE`.
// ADAPTIVE de Casteljau subdivision: split at the midpoint until the control hull is flat, so the
// work follows the curve rather than a fixed count. Still DETERMINISTIC and viewport-independent
// — the input is the curve's own numbers — which is the property a fixed count was defending.
function isPaintBearing(fill: string): boolean;   // "", "none", "transparent" = no paint

// Light.ts — what the scene is lit by (schema 42).
const LIGHTS_MAX: number;                                  // 4 — each costs a shader uniform
interface Light { x, y, z: number; color: string; intensity: number }   // DIRECTIONAL, un-normalised
function lightsError(lights: unknown): string | null;      // shared by the edit and load paths
function ambientError(ambient: unknown): string | null;    // 0..1
function normalize(v): {x,y,z} | null;                     // null when it has no length
function lambert(normal, light): number;                   // CLAMPED at 0 — a light must never subtract
function heightAbovePage(depth: number): number;           // -depth, floored at 0 — `depth` counts AWAY from the viewer
function shadowOffset(light, depth, ontoDepth?): {x, y};   // the GAP between them, not the caster's height; onto the page by default

// MotionTrace.ts — where everything ACTUALLY is, at every frame (diagnostics, not document data).
interface Sample {                          // one node at one frame, from the COMPUTED world
  frame: number; nodeId: string;
  x; y; width; height;                      // world-space BOUNDS — where the ink lands
  anchorX; anchorY;                         // world position of the transform ORIGIN — where the node IS
  rotation; scaleX; scaleY;                 // the deformation that produced them
  opacity;
}
interface Velocity { nodeId; frame; dx; dy; speed; dRotation }
interface Timing { frames: number; fps: number; seconds: number }
const TRACE_MAX_SAMPLES: number;            // bound: frames x nodes is quadratic in a way a document is not
function traceMotion(doc, opts?: { from?; to?; nodeIds? }): Sample[];
function traceVelocity(samples: readonly Sample[]): Velocity[];
function traceTiming(doc, from?, to?): Timing;
function traceDigest(samples: readonly Sample[]): string;    // stable, for diffing two runs
// PURE and DETERMINISTIC — same document, same frames, same trace, so two traces of an animation
// before and after a change are a regression test needing no screenshots. Samples the COMPUTED
// world (`applyFrame` then `computeGeometry`), never the stored geometry: a node's ink lands where
// layout, instance expansion, the parent chain and the transform put it, and a trace of stored
// values would agree with the document while disagreeing with the screen.
// NO wall-clock: elapsed milliseconds are a property of the machine, not of the animation. Timing
// is in FRAMES, converted to seconds by the timeline's own fps.
// Velocity is DERIVED from the samples rather than recorded alongside them, so speed and position
// cannot drift apart — and it differences the ANCHOR, not the bounds. A squashing ball widens
// about its feet, so its box's left edge moves while the ball travels at a steady speed;
// differencing the box reports the squash as sideways motion.

// ActionJournal.ts — what was DISPATCHED, in order (the other half; see ARCHITECTURE 4b).
interface JournalEntry { seq: number; at: number; type: string; nodeIds: readonly string[]; ok: boolean }
const JOURNAL_MAX: number;
function recordAction(entry): void; function journal(): readonly JournalEntry[];
function journalDropped(): number; function clearJournal(): void;
// Carries wall-clock timestamps ON PURPOSE — when something was done is what an edit history is
// for — which is exactly why it is kept apart from the trace, whose value is being diffable.

// Demos.ts — the classic animation exercises, as real documents.
const DEMOS: readonly { name: string; build: () => ProjectDocument }[];
function bouncingBall(): ProjectDocument;   // timing, spacing, arcs, squash+stretch
function jumpingSquare(): ProjectDocument;  // anticipation, follow-through, weight
function pendulum(): ProjectDocument;       // arcs and overlap, via ROTATION
function celSequence(): ProjectDocument;    // frame-by-frame with HELD keyframes
function wavingLimb(): ProjectDocument;     // rotation about a JOINT, with an overlapping forearm
// BUILDERS rather than saved fixtures, so they migrate with the schema and the tests can assert
// what the motion DOES. They exist to find holes: the bouncing ball is what proved a keyframe
// needed per-property easing, because one curve made the ball decelerate sideways as it rose.

// SpriteSheet.ts — a character's clips as a strip of cells, plus the descriptor an engine reads.
interface Cell { frame: number; clip: string | null; col: number; row: number; x; y; width; height }
interface SheetPlan { columns: number; rows: number; cellWidth; cellHeight; width; height; cells: Cell[] }
interface SheetAtlas { image: string; fps: number; cellWidth; cellHeight;
                       clips: { name; from; to; loop; frames: number[] }[]; frames: Cell[] }
const SHEET_MAX_PIXELS: number;
function planSheet(doc, opts?: { clips?; columns?; cellWidth?; cellHeight?; padding? }): SheetPlan;
function sheetAtlas(doc, plan, imageName): SheetAtlas;
function drawSheet(ctx, doc, plan): void;      // impure: needs a 2D context, like TextRaster
// The PLAN is pure and is where every decision lives: how many columns, which frames, where each
// cell sits. The RASTERISER is a separate function that takes a context, the same split
// `TextRaster` uses — a layout can be asserted, pixels can only be looked at.
// FRAMES COME FROM CLIPS, in clip order, so a sheet is laid out the way a character is authored
// rather than as an undifferentiated run of the timeline; a document with no clips exports its
// whole timeline as one unnamed run. Every clip's frame list is asserted against `clipLength`, so
// the sheet and the timeline cannot disagree about what a range means.
// The CELL is sized from the union of every frame's ink, not from a node's box: a squashing or
// travelling character leaves its box, and a cell cut to the box clips exactly the extremes an
// animator cares about. Padding is added around it, not inside it.
// SHEET_MAX_PIXELS bounds the output — a long clip at a large cell size is how an export becomes
// a request for a texture no GPU will take.

// Clips.ts — named frame ranges over the one timeline (schema 46).
interface Clip { name: string; from: number; to: number; loop?: boolean }   // both ends INCLUSIVE
const CLIPS_MAX: number; const CLIP_NAME_MAX: number;
function clipsError(clips: unknown, timeline): string | null;   // shared edit+load
function findClip(doc, name): Clip | null;
function clipFrameAt(clip, elapsedFrames): number;              // where the playhead sits, honouring `loop`
// A character is a dozen animations, not one. A clip is a NAMED RANGE rather than a timeline of its
// own — one clock, cut into runs, which is how sprite sheets and every 2D engine express it, and
// which is why nothing below this had to learn a new idea. `loop` defaults TRUE because most
// character clips cycle; the one-shots are what an author thinks about. Names are UNIQUE (a clip is
// selected by name) and the list is ORDERED (that is the order somebody arranged them in). Every
// range must lie inside the timeline, and clips without a timeline are refused rather than passed
// on to whoever tries to play them.

// Bezier.ts — arbitrary easing as a cubic Bézier (schema 44).
interface CubicBezier { x1; y1; x2; y2 }                    // (0,0) and (1,1) are fixed
function cubicBezierError(v: unknown): string | null;       // x within [0,1]; y DELIBERATELY unbounded
function solveForX(curve, x): number;                       // Newton + a bisection fallback
function cubicBezierAt(curve, t): number;                   // exact at both ends; result NOT clamped
const BEZIER_PRESETS: readonly { name; curve }[];
// y as a function of x has NO closed form — both are cubics in a parameter s — so x is inverted
// numerically and y evaluated there. Newton stalls where the derivative approaches zero, which is
// a flat start or end: the most ordinary curve an animator draws, not a pathological input.
// x is TIME and is bounded, or one moment maps to several progress values. y is FREE, because y
// outside [0,1] is overshoot — anticipation and follow-through are made of it.
// `Prototype.easingError` is the shared edit+load validator for `Easing = EasingName | CubicBezier`.
//
// `document/Timeline` now has its own section below. It was the INVERSE of the usual rot: the
// compile-time pin had imported it for schemas, while this file never described it — so the pin
// was holding a shape no document claimed, and a reader had nothing to check the code against.
// `document/Prototype` is still undescribed here. Stated rather than left to be discovered.

// Mesh.ts — a grid of control points that BENDS a shape (schema 41).
const MESH_MAX_DIVISIONS: number;                         // 64 — the point count is the product
interface Mesh { cols: number; rows: number; points: {x: number; y: number}[] }   // row-major, DEFORMED positions
function meshError(mesh: unknown): string | null;         // shared by the edit and load paths
function restPoint(mesh, col, row): {x, y};               // col/cols, row/rows — FRACTIONS (schema 43)
function restMesh(cols, rows): Mesh;                      // the grid a user starts from; identity at ANY size
function isIdentityMesh(mesh): boolean;                   // untouched = skipped entirely, at every size
function warpPoint(mesh, box, x, y): {x, y};              // BILINEAR; clamped outside the box
function warpCommands(commands, box, mesh, flatten): PathCommand[];
function heightOf(p): number;                              // a control point's z; absent = 0
function warpHeight(mesh, box, x, y): number;              // the same bilinear blend, on z
function surfaceNormal(mesh, box, x, y): {x, y, z};        // RAW — un-normalised, zero where the cell collapsed
function normalAt(mesh, box, x, y): {x, y, z};             // the same, as a UNIT vector
function isFlatMesh(mesh): boolean;                        // no height anywhere = nothing to light
function heightRange(mesh): {min, max};                    // from the CONTROL POINTS — exact, and what bounds the ray
// Both use CENTRED differences because a one-sided step lands outside the box at a CORNER, gets
// clamped back, and collapses the tangent — which reported every corner of a shape flat. The
// tangents are DIVIDED BY THEIR STEP, so a sample on the rim (where the span is halved by that
// clamp) has the same scale as one inland.
// `surfaceNormal` is the one the GPU is given, and its length is the point. Inside one cell the
// patch is `A + Bu + Cv + Duv`, so the cross product of its tangents is `B×C + u(B×D) + v(D×C)`
// — AFFINE, which is exactly what linear interpolation between vertices reproduces. Normalising
// first is a nonlinear step: what interpolates afterwards agrees with the surface only at the
// corners, and the gap is the faceting visible along triangle edges. The fragment shader
// normalises what arrives, so the normal is per-FRAGMENT rather than per-vertex.
// Segments are SUBDIVIDED at the grid's resolution before warping — a warp bends the space
// BETWEEN two points, so an edge that kept only its ends would chord across every bend.

// Depth.ts — how far BACK a node sits (schema 40). One number, three consumers.
const DEPTH_MIN: number; const DEPTH_MAX: number;            // -1000 .. 1000
function depthError(depth: unknown): string | null;          // shared by the edit and load paths
function depthOf(node: {depth?: number}): number;            // absent = 0, the plane of the page
function parallaxRate(depth: number): number;                // 1/(1+d) behind, 1-d in front
function parallaxOffset(depth: number, vp: {x,y,zoom}): {x: number; y: number};   // WORLD units
function depthToClipZ(depth: number): number;                // DECREASING in depth, clamped inside the volume
function applyParallax<T>(doc: T, vp: {x,y,zoom}): T;        // same reference when nothing is layered
function parallaxIds<T>(doc: T): Set<string>;                // which nodes the above would MOVE —
    // the DIRTY SET's half of the same question, and it must be asked whenever the viewport moves.
    // The geometry engine decides reuse by SET MEMBERSHIP and never compares geometry, so a layered
    // node shifted by a pan (which dispatches no action and moves no body) kept the position it had
    // when the camera was elsewhere: 300px on one depth-1 layer after a 600px pan, in the editor as
    // well as during a run. Depth 0 is EXCLUDED because its offset is exactly zero — including it
    // would dirty every node of every document on every frame of every pan.
// ORDER is sorted in the render MODEL (far first, tree order breaking ties) so all three backends
// agree; the GPU additionally writes the clip z and runs a real DEPTH_TEST, so nearer wins whatever
// order a draw call arrived in. PARALLAX is applied at the DISPLAY SEAM, before geometry, so a
// layer is CLICKABLE where it is drawn — picking, marquee and snapping read that same geometry.

// Resolve.ts — arbitrary contours made SIMPLE under a FILL RULE. The primitive the others assumed.
// Splits every edge against every edge (its own contour included), keeps a piece only where the
// fill differs on its two sides, directs it with the filled side on the LEFT, and re-chains.
// What comes out never crosses itself and means the same region under NONZERO that the input meant
// under the rule asked for — so nothing downstream has to carry the rule any further.
type FillRule = "nonzero" | "evenodd";                    // = document/Node's, not a second spelling
function crossingCount(rings: readonly Ring[], x: number, y: number): number;   // the even-odd raw material
function insideRule(rings: readonly Ring[], x: number, y: number, rule: FillRule): boolean;
function resolveRings(rings: readonly Ring[], rule?: FillRule): Ring[];
function resolveWith(rings, filled: (x, y) => boolean): Ring[];        // the general form: bound wherever `filled` says
function resolveBoolean(a: Ring[], b: Ring[], op: BooleanOp): Ring[];  // THE boolean — robust at coincident edges
function resolveBooleanPaths(a, b, op): PathCommand[];                 // the same, on commands
// `resolveBoolean` replaces `PathBoolean.booleanRings` at every call site. The older one
// classifies an edge piece by whether its MIDPOINT lies inside the other shape, which has no
// answer when the shapes share an edge — the union AND intersection of two axis-aligned
// rectangles at the same `y` came back EMPTY, as did two rectangles merely touching, as did a
// shape unioned with itself. Asking where membership CHANGES across an edge removes the
// question instead of answering it more carefully: the probe samples the two faces either
// side, never the edge. Coincident survivors are de-duplicated, or a union with a shared edge
// emits that edge twice.

// RayMarch.ts — can a point SEE the light? (no schema field; derived).
const RAY_STEPS: number;                                   // 16 — this is per FRAGMENT-equivalent work; a real cost decision
function marchOccluded(height, x, y, toLight, maxHeight, steps?): boolean;
// The question a NORMAL cannot answer: a crease beside a raised edge faces the light squarely
// and is still dark, because the edge is in the way. `height` is INJECTED, so this is pure
// geometry a mesh, an imported heightmap or a closed-form test surface can all drive.
// BINARY, like `CastShadow` and for the same reason — a directional light has no penumbra.
// `maxHeight` bounds the march: once the ray is above everything, nothing further can occlude.
// Answers false for a light at or below the horizon, whose faces `lambert` has already darkened.
// SAMPLED: a spike thinner than the step spacing is missed, which is finer relief than a mesh
// can represent. `Draw.shadow` carries the result per VERTEX; per FRAGMENT needs the heightfield
// in the shader, which needs the texture path this renderer still does not have.

// CastShadow.ts — one shape darkening another, as GEOMETRY (no schema field; derived).
const SHADOW_ALPHA: string; const CAST_SHADOW_MAX_PAIRS: number;   // #00000059; 400 — this is quadratic in RAISED shapes
interface ShadowShape { id: string; rings: readonly Ring[]; depth: number }   // rings in WORLD space
interface CastShadowPatch { receiverId: string; casterId: string; rings: Ring[] }
function shadowPatch(caster, receiver, offset): Ring[];            // the caster's outline, moved, intersected with the receiver
function castShadows(shapes, offsetOf, maxPairs?): CastShadowPatch[];   // [] when nothing is raised — the common case, per frame
// A shape casts onto another only when STRICTLY nearer the viewer; equal depth is the same
// plane and neither is above the other, which is also what stops a shape shadowing itself.
// Patches for one receiver are MERGED by the model before drawing (union, nonzero): occlusion is
// binary, so two casters over one card must not paint the overlap twice. `castShadows` itself
// returns them per PAIR, and TRUNCATES SILENTLY at `maxPairs`.
// `offsetOf` is injected so this module needs to know nothing about lights, and takes BOTH
// depths: a card 40 above the page throws 40 onto the page and only 20 onto a card at 20.         // idempotent on simple input
// IDEMPOTENT by design: callers resolve indiscriminately rather than detecting whether they need
// to, because detecting self-intersection costs the same O(n^2) as fixing it. Returns [] when the
// region is empty — two identical contours wound oppositely cancel exactly, and that is an answer.

// ConvexDecompose.ts — a shape as CONVEX pieces, so an area query is ONE test.
// HERTEL-MEHLHORN over `triangulate`: merge neighbouring pieces wherever the merge stays convex.
// Guarantees at most 4x the fewest possible pieces, invents no vertices, and inherits holes and
// islands for free (a triangle list has no memory of which ring a triangle came from).
const DECOMPOSE_MAX_PIECES: number;                       // 20_000 — the merge loop's budget
function isConvexRing(ring: Ring): boolean;               // collinear corners allowed; < 3 points is not a ring
function convexPieces(rings: readonly Ring[]): Ring[];    // [] for degenerate input, like `triangulate`
// Takes SIMPLE rings — resolve first if the input might cross itself (it inherits `triangulate`'s
// precondition, having started from the triangles).
function convexOverlaps(a: Ring, b: Ring): boolean;       // SAT. Convexity is a PRECONDITION, not checked
function piecesOverlap(pieces: readonly Ring[], region: Ring): boolean;
function edgesOverlap(subpaths: readonly {points: readonly Point[]; closed: boolean}[], region: Ring): boolean;
function rectRing(x: number, y: number, width: number, height: number): Ring;
function piecesArea(pieces: readonly Ring[]): number;
// SAT settles overlap, TOUCHING and CONTAINMENT in one answer — a region inside a shape admits no
// separating axis, so containment is not a case anyone has to remember. A two-point operand is
// legal: a segment is convex with no area, which is how ink that has no interior (a `core.line`,
// an unfilled path) goes through the same routine as ink that does.

// StrokeOutline.ts — a BORDER as fillable rings, so a stroke can be geometry and not a parameter.
// POLYLINE OFFSETTING over the same `flattenPath` picking and tessellation use. The two sides of
// a corner are not symmetric: the OUTER side gets the join, the INNER side is TRIMMED to where
// the offsets cross (untrimmed it would self-intersect, which nonzero hides on SVG/Canvas and the
// triangulator cannot). The join/cap vocabularies live in `document/Node` — this re-exports them.
type StrokeJoin = "miter" | "round" | "bevel";   // = document/Node's, not a second spelling
type StrokeCap = "butt" | "round" | "square";
const STROKE_ALIGNS: readonly ["center", "inner", "outer"];
type StrokeAlign = typeof STROKE_ALIGNS[number];
interface StrokeStyle { width: number; join?: StrokeJoin; cap?: StrokeCap; miterLimit?: number; align?: StrokeAlign }
function strokeOutline(commands: readonly PathCommand[], style: StrokeStyle, tolerance?: number): Ring[];
// The result is RESOLVED before it is returned, so a stroke wide enough to overlap itself still
// comes back as simple, non-overlapping rings that the tessellator and the decomposition can take.
// A CLOSED subpath yields two rings (outer edge + hole, wound opposite); an OPEN one yields a
// single ring, up one side and back the other through the caps. ALIGNMENT is measured against the
// shape's own winding, not the drawing direction, so a rectangle drawn either way gets the same
// inside border — and on an open subpath there is no inside, so align is treated as "center".
// Width <= 0 or a path with no length returns [] rather than throwing.

// DashPath.ts — a dashed line as GEOMETRY (the GPU is handed pieces, not a pattern).
function parseDashArray(spec: string): number[] | null;   // null = SOLID (empty/negative/all-zero), as SVG does
function dashSubpaths(commands, pattern, offset?, tolerance?): PathCommand[][];   // open `M`/`L` runs
// SVG's semantics, because agreeing with the other two backends is the point: an ODD pattern
// REPEATS to become even (or a cycle ends on a gap and the next starts on a dash); the offset is
// taken modulo the cycle and made positive; the pattern runs continuously along a subpath and
// RESTARTS at the next. Runs are OPEN even from a closed contour — a dash has two ends and they
// take the stroke's CAP, where a closed ring would be joined back to itself.

// Tessellate.ts — filled outlines as TRIANGLES, the only form a GPU accepts.
// EAR CLIPPING over the same `Ring`s picking and booleans use, so the GPU fills exactly the
// outline the other consumers test against. Holes are BRIDGED into the outline by a doubled edge.
const TESSELLATE_MAX_VERTICES: number;   // 100_000 — the OOM guard, the twin of PATH_MAX_COMMANDS
function signedArea2(ring: readonly {x: number; y: number}[]): number;   // sign = winding
function triangulate(rings: readonly Ring[]): number[];   // flat [x0,y0, x1,y1, x2,y2, ...]
const SUBDIVIDE_MAX_DEPTH: number;                        // 4 — a bound, not a target
function subdivideTriangles(flat: readonly number[], maxEdge: number, maxDepth?: number): number[];
// Ear clipping puts vertices only where the OUTLINE has them, which is right for a flat fill and
// wrong for SHADING: a value sampled per vertex can only vary where there ARE vertices. Split at
// the MIDPOINTS, four ways (the middle piece is what stops it leaving a hole), bounded by both the
// edge length and the depth cap. Used only when an item carries a lighting surface.
// Rings are classified by SIGNED AREA, not array order: the largest is the outline, opposite
// winding is a hole, same winding is a separate island. That is the nonzero rule picking and both
// other backends already obey. Degenerate input returns [] rather than throwing — a shape with no
// area is legitimate mid-edit and a renderer must not fall over on one.
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
function nodesInRect(computed: ComputedState, rect: Rect): string[]; // marquee (box) select: ids whose INK overlaps rect (touch, not containment), in draw order; DOM-free. Bounds are the cheap reject, then the exact test — the node's ink decomposed into CONVEX pieces (`ConvexDecompose`) with the marquee carried into LOCAL space, so a rotated square is not selected through the empty corner of its box. Ink with no AREA (a `core.line`, an unfilled path) tests its SEGMENTS instead, the same split `hitsShape` makes for a click
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
type TextLines = (shape: TextShape) => string[];                    // how text breaks into lines
interface ExportImages {                                            // what a PURE function cannot know
    naturalSize?(href: string): { width: number; height: number } | null;
    surfaceUrl?(href: string, surface: { data: string; width: number; height: number }): string | null;
}
function exportSVG(doc: ReadonlyDocument, linesOf?: TextLines, images?: ExportImages): string;
// FOUR SILENT LOSSES, now fixed. The exporter read the same DisplayList as the live backends and
// then dropped: a sourceRect (one cell of a tileset exported as the WHOLE sheet), `pixelated`
// (exported pixel art came out smoothed), opacity GROUPS (it read model.content and never
// model.groups, so a translucent group exported at full strength with its children individually
// opaque), and a core.raster (whose href is a cache key, not a URL — an <image> loading nowhere).
// Two of those need an image MEASURED or a surface ENCODED, which a pure function cannot do, so
// they are injected like the text wrapper. ABSENT, THE EXPORTER OMITS what it cannot express:
// a whole sheet in place of one cell is a different picture, and it looks like a success.
// WRAPPING is injected because this module is pure and wrapping has to MEASURE. The default
// honours explicit newlines and nothing else — which is all it ever did, and it meant a long
// paragraph ran past its box in the exported file while the editor wrapped it on screen. The
// app passes `TextRaster.textLinesFor`, so the artefact breaks lines where the Canvas and GPU
// backends do rather than having an opinion of its own.
// Built from the SAME DisplayList the editor draws, so shapes, booleans and effects come along
// without a second description. TEXT carries the schema-34 typography (family, weight, anchor,
// letter-spacing) and breaks explicit newlines into <tspan>s stepped by the line height, via the
// shared `textParagraphs`. KNOWN GAP: it does not WRAP — wrapping needs measurement, which a pure
// exporter has none of, so a long unbroken paragraph runs past the box where the editor wrapped it.
function textParagraphs(text: string): string[];   // RenderModel — hard breaks only; shared by the exporter and the canvas backend

// editor/shortcuts.ts — maps a key chord to an editor command. PURE, so "what does Shift+Left
// do?" is a unit test. Ctrl and Cmd are interchangeable; a MODIFIED arrow is left to the
// platform; a press from a text field is never a shortcut.
const NUDGE_STEP: number;         // 1
const NUDGE_STEP_LARGE: number;   // 10, with Shift
type Shortcut = { kind: "nudge"; dx; dy } | { kind: "tool"; name: string }
             | { kind: "duplicate" | "delete" | "group" | "select-all" | "deselect" | "undo" | "redo" };
function resolveShortcut(e: KeyChord): Shortcut | null;
const SHORTCUT_HELP: { keys: string; does: string; kind: Shortcut["kind"] }[];
// TOOL KEYS — V select · M move · R/E/T rectangle/ellipse/text · P pen · B paint. Matched to the
// apps people arrive from (Figma, Illustrator, Photoshop, Aseprite) so muscle memory transfers.
// UNMODIFIED ONLY: Ctrl+V is paste everywhere, and reading it as "move tool" would break the most
// reflexive chord on the keyboard. `isTypingTarget` already keeps every letter out of text fields.
// A tool key also switches WORKSPACE when the current one does not show that tool — a live tool
// with no button is a gesture whose state is invisible.
// SHORTCUT_HELP lives beside the bindings because a sheet assembled elsewhere drifts, and a
// shortcut sheet that lies teaches a key that does nothing. A test pins every kind into it.
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
schema-18 effects (`Shadow` = dx/dy/blur/color; `blur` ≥ 0). `style.fill` is `string | Gradient`
(schema 56); the ramp’s own rules live in `gradientError` and are reached through `styleError`, so
the edit path, the load path and the importer cannot disagree about what a legal ramp is.
`flatFill(fill)` is the one-colour answer for the places that cannot hold a ramp — hit testing,
the script sandbox, and the backends that flatten.

`core/document/GradientEdit` is what an EDITOR does to a ramp, kept apart from `Gradient` (which
says what one is) because it needs `blendColor` — and that lives with the transition code, which
imports `Node`, which imports `Gradient`:

```ts
GRADIENT_MIN_STOPS: number                                   // below this it is a flat colour
gradientFromColor(color, kind?): Gradient                    // same colour both ends, opaque → clear
colorAt(g, t): { color; opacity } | null                     // what the ramp already shows there
withStop(g, t): { gradient; index } | null                   // takes the colour already at t
withStopOffset(g, i, offset): { gradient; index } | null
withoutStop(g, i): Gradient | null                           // null below GRADIENT_MIN_STOPS
withStopColor(g, i, color, opacity?): Gradient | null
withKind(g, kind): Gradient                                  // derived from the existing geometry
withHandleAt(g, handle, x, y): Gradient | null               // an on-canvas drag, in GRADIENT space
```

Every one returns a NEW gradient — the document is written through actions, and a mutating helper
would edit behind the dispatcher and leave undo nothing to restore. The two that can REORDER return
the moved stop's new index with it: stops are kept sorted, so a caller tracking "the selected stop"
as its own number edits a different stop the moment a drag crosses a neighbour. Refusal is `null`
and never a silent no-op, since a quiet decline is indistinguishable from a helper that worked.

`core/geometry/SelectionHandles` places that ramp on the canvas:

```ts
GRADIENT_HANDLES: readonly ["grad:start","grad:end","grad:center","grad:radius","grad:focus"]
type GradientHandle = typeof GRADIENT_HANDLES[number]        // part of HandleId — a typo will not compile
gradientPaintMatrix(g, world, local): Mat2D                  // gradient space → world, box fold included
gradientHandles(doc, state, selectedNodeIds): SelectionHandle[]
gradientHandleAtPoint(doc, state, ids, x, y, zoom): SelectionHandle | null
gradientPointOf(g, world, local, worldX, worldY): { x; y } | null   // the inverse; null if singular
isGradientHandle(handle): handle is GradientHandle
```

The picker is built from the producer the renderer draws from — handles drawn from one list and
picked from another appear on screen and do nothing when grabbed. Both directions go through
`gradientPaintMatrix`, which is what keeps a dragged handle under the cursor. `objectBoundingBox`
is applied HERE and not stored in `transform`: an authored ramp keeps its 0..1 coordinates exactly
as SVG does, and the SVG backend gets the box for free from `gradientUnits`. `trackError(t)` validates ONE grid
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

### `core/import/SheetSlice` — reading a sheet nobody wrote an atlas for

```ts
interface SliceGrid { columns: number; rows: number; cellWidth: number; cellHeight: number; count: number }
interface SliceOptions { cellWidth: number; cellHeight: number; margin?: number; spacing?: number; limit?: number }
const SLICE_MAX_CELLS: number;                       // bound on a hand-editable grid

function sliceGrid(imageWidth: number, imageHeight: number, opts: SliceOptions): SliceGrid | null;   // null = does not divide
function sliceCells(grid: SliceGrid, opts?: SliceOptions): SourceRect[];                             // reading order
function sliceTrack(cells: readonly SourceRect[], opts?: { start?: number; step?: number }): Keyframe[];
```

- THE GRID, NEVER THE INK. Measured on real packs: ink runs are ragged and adjacent frames' ink
  merges, so boundary detection finds 19 frames in a sheet holding 80. See ARCHITECTURE.
- `margin` is the border around the whole sheet, `spacing` the gutter BETWEEN cells — the two
  numbers every tileset editor uses, and they are different: a sheet can have one without the other.
- Slicing yields plain rects; `sliceTrack` turns them into keyframes as a SEPARATE step, because
  which rectangles and how fast are different decisions.

### `core/import/Aseprite` — the file the sheet was exported from

```ts
interface AseLayer { name: string; childLevel: number; type: number; visible: boolean; opacity: number; blendMode: number }
interface AseCel { frame: number; layer: number; x: number; y: number; width: number; height: number;
                   opacity: number; pixels: Uint8Array | null; compressed: Uint8Array | null; linkedFrom: number | null }
interface AseTag { name: string; from: number; to: number; direction: number }
interface AseFile { width: number; height: number; colorDepth: number; frames: { duration: number }[];
                    layers: AseLayer[]; cels: AseCel[]; tags: AseTag[]; palette: {r,g,b,a}[] }

function asepriteError(bytes: Uint8Array): string | null;
function parseAseprite(bytes: Uint8Array, opts?: { inflate?: (d: Uint8Array) => Uint8Array }): AseFile;
function asepriteClips(file: AseFile): { name: string; from: number; to: number; loop: boolean }[];
function asepriteTimeline(file: AseFile): { frames: number; fps: number };

interface AseFrame { width: number; height: number; rgba: Uint8Array; notes: string[] }
const ASE_BLEND_NORMAL: number;
function composeFrame(file: AseFile, frame: number): AseFrame | null;   // null past the end
```

- THE TAGS ARE CLIPS. `{ name, from, to }` is `Clip` field for field (schema 46), so the import is a
  rename. A cel's `x`/`y`/size is the TRIM — the padding never existed in the file.
- PARSING IS PURE, INFLATING IS INJECTED: without a decompressor the structure still parses and cels
  keep their compressed bytes, which is enough for clips, timing and layout.
- The SHORTEST frame duration sets the rate — the only choice that expresses every frame as a whole
  number of ticks, where an average rounds the quick ones away.
- Indexed/greyscale depths, tilemap cels and truncation are NAMED in the error, never half-read.
- `composeFrame` IS THE HALF THAT MAKES AN IMAGE. `celRgba` converts one cel; a frame is every
  visible layer's cel stacked, and without this the reader could describe a file in perfect detail
  and produce nothing — which is why nothing called it for months. It returns STRAIGHT (non-premultiplied)
  RGBA and composites source-over with the division by composited alpha, not the `src*a + dst*(1-a)`
  shortcut, which is right only over an opaque destination and elsewhere darkens every anti-aliased
  edge toward black.
- Layer order is FILE order, bottom first. A hidden GROUP hides its children — the tree is a flat
  list plus a `childLevel`, so skipping only the group still draws what the artist switched off.
  Layer and cel opacity MULTIPLY. Linked cels are resolved, or every held frame composites to
  nothing. A cel may hang off the canvas and is clipped, never wrapped.
- Blend modes other than NORMAL are drawn as normal and NAMED in `notes`: refusing outright would
  reject most real pixel art, and drawing one silently is the plausible-wrong-picture this module's
  header argues against.

### `core/import/SvgDocument` — a whole SVG file as flat, transformed shapes

```ts
interface SvgShape { commands: PathCommand[]; fill: string | null; stroke: string | null;
                     strokeWidth: number | null; opacity: number }
interface SvgDocumentResult { width: number | null; height: number | null; shapes: SvgShape[]; notes: string[] }
const SVG_MAX_SHAPES: number; const SVG_MAX_USE_DEPTH: number;

function svgDocumentError(xml: unknown): string | null;
function parseSvgDocument(xml: string): SvgDocumentResult;
function parseSvgTransform(text: string): Mat2D;        // matrix/translate/scale/rotate/skew
```

- A `<g transform>` CANNOT be a node transform — `Transform` is rotation, scale and an origin, while
  `matrix()` is 23,276 of the 24,861 transforms measured. It is BAKED into the coordinates instead,
  which is exact: a Bézier is affine-invariant. The group structure is lost; the shape is not.
- Coordinates go through `ShapeToPath.transformCommands`, the function the shape layer already uses.
- `<use>` is EXPANDED (19,194 elements in the measured art) with a depth bound, since a symbol
  referencing its own ancestor is a loop.
- A gradient FILL arrives whole (schema 56): `SvgShape.fill` is `string | Gradient | null`, read
  through `SvgGradient` and moved into the shape's space by `placeGradient` (the baked group
  transform) and again by `svgNodeSpecs` (the path normalisation). Only STROKES flatten to a first
  stop, and that lands in `notes` like every other approximation.
- Verified against all 5,279 real files: 109,036 shapes, none empty, none rejected by `pathError`.

### `core/import/MeshData` — what every 3D reader produces

```ts
interface MeshPrimitive {
    positions: Float32Array;
    normals: Float32Array | null;     // UNIT LENGTH guaranteed here
    uvs: Float32Array | null;
    indices: Uint32Array;             // always present
    material: number | string | null; // an index for glTF, a name for OBJ
}
interface MeshInstance { name: string; matrix: number[]; primitive: MeshPrimitive }
const MESH_IDENTITY: readonly number[];
```

glTF and OBJ describe geometry very differently — a binary buffer with strides against text with
three independent index streams — but what a renderer needs from either is the same four arrays.
**Two nearly-identical types are how the drift starts**: the first field one reader gained would be
the field the other quietly lacked, and every consumer would grow a branch per format. FBX will
produce this too.

**UNIT NORMALS ARE AN INVARIANT OF THIS TYPE, not of every source.** glTF's spec requires them and
its files honour it; OBJ's does not, and 206 measured files carry normals of length exactly 0.1 —
correct directions at a tenth scale. A renderer trusting the invariant would light those surfaces a
tenth as brightly, so the reader that knows its format is loose is the one that fixes it. A zero
normal stays zero, having no direction to preserve.

### `core/import/Obj` — three index streams a GPU cannot use as three

```ts
interface ObjMaterial {
    name: string;
    diffuse: [number, number, number] | null;   // Kd
    ambient: [number, number, number] | null;   // Ka
    specular: [number, number, number] | null;  // Ks
    shininess: number | null;                   // Ns
    opacity: number;                            // d, or 1 - Tr
    diffuseMap: string | null;                  // map_Kd — a path, never read
    alphaMap: string | null;
    bumpMap: string | null;
}
interface ObjResult { instances: MeshInstance[]; materialLibraries: string[]; notes: string[] }

function objError(text: unknown): string | null;
function parseObj(text: string): ObjResult;
function mtlError(text: unknown): string | null;
function parseMtl(text: string): Map<string, ObjMaterial>;
function resolveObjIndex(raw: number, count: number): number;
```

**`v`, `vt` AND `vn` ARE INDEPENDENT.** A face names a position, a texcoord and a normal by separate
indices and nothing requires them to agree. A GPU wants one index per vertex, so the obvious
implementation — build the buffer from the `v` lines, index it by the position index — is wrong the
moment a position is shared by faces with different normals. **It is wrong in 598 of 600 measured
files.** A cube's corner takes whichever normal was written last and a hard-edged model shades like
a soft one: well-formed geometry, quietly wrong lighting, no error anywhere. So `v/vt/vn` triples
are de-duplicated into unique vertices, at a measured cost of 3.7 vertices per position.

**FACES ARE NOT ALWAYS TRIANGLES.** 81,712 of the 2,605,375 faces in the tree have more than three
corners — mostly quads, up to a 13-gon. Taking the first three drops 3% of every model's surface.
They are fan-triangulated, exact for the convex faces an exporter emits.

**Indices are 1-BASED and may be NEGATIVE**, counted back from what has been read *so far* — which
is why `resolveObjIndex` takes a count rather than an array. No measured file uses a negative one,
which is exactly why it is tested rather than assumed absent.

**The index streams are FILE-WIDE, not per group.** A face after the second `usemtl` still indexes
the file's list, so a reader that reset them per group misindexes every multi-material model — and
every measured file has several.

**`usemtl` splits a file into runs**, 13,852 across the tree, each its own primitive so a model with
a painted and a metal part is two draws rather than one with an arbitrary material.

**`Tr` is the INVERSE of `d`.** Reading it as opacity makes every solid material invisible and every
invisible one solid, and both spellings appear in the wild for the same intent.

**A `map_*` line may carry options before its path** — `map_Kd -s 1 1 1 tex.png` — so the file is
the last token, not the first.

**The material library is a sidecar**, reported and never fetched, exactly as Tiled and glTF do.

**Not read yet:** smoothing groups (`s`), `usemap`, free-form surfaces, and `illum` models.

### `core/import/Gltf` — a `.glb` as triangles

3D arrives as a READER first. Nothing draws these yet — that needs a schema, a node type and a
pipeline — but reading them correctly is a self-contained problem with a right answer, and doing it
first is what makes the rest small. Every 2D format went in this order.

```ts
interface GlbContainer { json: GltfJson; bin: Uint8Array | null }
interface GltfPrimitive {
    positions: Float32Array;          // always present
    normals: Float32Array | null;     // null when the file states none
    uvs: Float32Array | null;
    indices: Uint32Array;             // a non-indexed primitive gets the implied 0..n-1
    material: number | null;          // reported, not resolved
}
interface GltfMeshInstance { name: string; matrix: number[]; primitive: GltfPrimitive }
interface GltfResult { generator: string; instances: GltfMeshInstance[]; extensions: string[]; notes: string[] }

function glbError(bytes: unknown): string | null;
function parseGlb(bytes: Uint8Array): GlbContainer;
function gltfError(json: unknown): string | null;
function parseGltf(json: GltfJson, buffer: Uint8Array): GltfResult;
function readAccessor(json: GltfJson, index: number, buffer: Uint8Array): Float64Array | null;
function nodeMatrix(node: GltfNode): number[];
function multiplyMat4(a: readonly number[], b: readonly number[]): number[];
const GLTF_IGNORABLE_REQUIRED: string[];
```

**THE VERTEX DATA IS INTERLEAVED.** 9,596 bufferViews in the tree declare a `byteStride`, so a
primitive's positions, normals and UVs are woven together rather than stored one array after
another. A reader that walks an accessor tightly-packed returns the first position, then its
NORMAL, then its UV — all finite, all well-formed, all wrong. This is glTF's flip-flag: the common
case rather than the exotic one, and there is no error to notice.

**AN ACCESSOR IS TWO OFFSETS** — its own into a bufferView, and the view's into the buffer. Adding
one and not the other looks like a model built slightly wrong rather than one read wrongly.

**Indices arrive in three widths** (unsigned byte, short and int all appear), and a `normalized`
integer stands for a FRACTION — a byte of 255 means 1, not 255.

**The BIN chunk is found by TYPE, not by position.** The spec allows unknown chunks between JSON
and BIN, and taking "the second chunk" hands back an extension's private bytes as vertex data.

**A required extension is refused BY NAME**, except one that provably cannot touch geometry.
`KHR_materials_unlit` is required by 246 files and is a lighting hint; this module reads no
materials, so refusing on it would cost 4.7% of the corpus over something that cannot change a
vertex. `GLTF_IGNORABLE_REQUIRED` is an explicit allow-list, using it is reported louder than an
ordinary extension, and **it must be revisited when materials land**.

**The buffer is supplied, not fetched.** A `.glb` carries its BIN chunk; the `.gltf` files name an
external `.bin` and most images are sidecars. The caller resolves those, exactly as it does a
Tiled `.tsx`.

**MATERIALS AND TEXTURES ARE READ.** `gltfMaterials(json)` returns base colour, its image,
metallic, roughness, emissive, alpha mode and cutoff, double-sidedness, and **`unlit`** — with every
default the spec states. **The defaults carry the corpus**: 4,489 of 7,955 measured materials state no
`baseColorFactor` at all, so a reader defaulting to black renders 56% of the tree wrong with no
field missing for a check to notice.

**`KHR_materials_unlit` IS READ, AND ITS SIGNAL IS THE KEY.** 479 materials across 246 files carry
it, every one of those files declares it REQUIRED, and the extension's object is EMPTY in all 479 —
`{"KHR_materials_unlit": {}}`. A reader testing that object for truthiness marks every one of them
as lit. The requirement stays on `GLTF_IGNORABLE_REQUIRED` deliberately: refusing to open 246 models
over a lighting hint, while nothing lights anything, costs the models and buys nothing. Carrying the
flag means the day a lighting term arrives the answer is already in the data.

**An image is LOCATED, not fetched.** `gltfImageSource(json, textureIndex)` follows TWO hops — a
material names a texture, which names an image — and returns either `{kind:"uri"}` for a file the
caller opens or `{kind:"buffer", offset, length}` for a slice of the bytes already in hand. Both
occur (4,130 and 125). Skipping the indirection reads a texture index as an image index, which
lands on a real picture often enough to look like a mismatched skin rather than a bug.

**Not read yet:** animations (154 files), skins (31), normal/metallic-roughness texture maps, sparse
accessors, and cameras.

### The Electron bridge — reading what a MAP FILE names

```ts
readTiledFolder(folder): Promise<{ path, name, relative }[]>
readTiledMap(folder, mapPath): Promise<string>
readTiledTileset(folder, mapPath, relative): Promise<string>
readTiledImage(folder, mapPath, relative): Promise<string>   // data: URL
inflateSync(base64): { ok: boolean; data?: string; error?: string }
```

**This is the one place a path arrives from FILE CONTENT** rather than from a dialog or the
renderer's own state, and a `.tmx` is plain text anyone can write —
`<image source="../../../../.ssh/id_rsa"/>` is a well-formed Tiled document. Every one of these is
confined to the folder the USER PICKED, not to the map's own directory: the real maps legitimately
reference `../Spritesheet/sheet.png`, one level up from themselves and still well inside the pack,
so a check against the map's directory would refuse every real file while a check against nothing
would hand back whatever the file asked for.

**`inflateSync` is the ONE synchronous channel.** `parseTiledMap` and `parseAseprite` both call
their injected `inflate` DURING the parse — which is what keeps them pure and testable with no
decompressor present — and an async bridge cannot satisfy that signature. Both readers shipped with
the injection point and neither had anything to inject; this is it. Output is bounded, since a
hostile stream is a few hundred bytes that expand to gigabytes, and a failure is RETURNED rather
than thrown, because a throw inside a `sendSync` handler leaves the renderer blocked forever.

### `core/import/TiledMap` — a `.tmx` as tiles this engine can already draw

A Tiled map is a grid of references into a sheet, which is exactly what a `sourceRect` is. Resolving
a GID to a tileset and a cell is the whole job; the drawing is machinery that already exists.

```ts
const FLIP_H = 0x80000000, FLIP_V = 0x40000000, FLIP_D = 0x20000000, GID_MASK = 0x1fffffff;
interface TiledCell { gid: number; flipH: boolean; flipV: boolean; flipD: boolean }
interface TiledTileset {
    firstGid: number; source: string | null; name: string;
    tileWidth: number; tileHeight: number; columns: number; tileCount: number;
    spacing: number; margin: number;
    image: string | null; imageWidth: number | null; imageHeight: number | null;
    tiles: TiledTileImage[];            // a COLLECTION set's own files; empty for a sheet
    offsetX: number; offsetY: number;   // <tileoffset>, applied to every tile the set draws
}
interface TiledTileImage { id: number; image: string; width: number; height: number }
interface TiledLayer { name: string; width: number; height: number; cells: TiledCell[] }
interface TiledMapResult {
    width: number; height: number; tileWidth: number; tileHeight: number;
    orientation: string; tilesets: TiledTileset[]; layers: TiledLayer[]; notes: string[];
}

function tiledMapError(xml: unknown): string | null;
function parseTiledMap(xml: string, opts?: { inflate?: (d: Uint8Array) => Uint8Array }): TiledMapResult;
function parseTiledTileset(xml: string, into: TiledTileset): TiledTileset;
function decodeGid(raw: number): TiledCell;
function tilesetFor(tilesets: readonly TiledTileset[], gid: number): TiledTileset | null;
function tileSourceRect(set: TiledTileset, gid: number): SourceRect | null;
function tilePosition(map: { orientation: string; tileWidth: number; tileHeight: number },
                      col: number, row: number): { x: number; y: number };
function tileTransform(cell: TiledCell): { rotation: number; scaleX: number; scaleY: number };
function tileImageFor(set: TiledTileset, gid: number): TiledTileImage | null;
function tilesetOverflow(set: TiledTileset): string | null;

interface TiledTilemapLayer {
    image: string;                                  // the sheet as NAMED; the caller resolves it
    x: number; y: number; width: number; height: number;
    tilemap: Tilemap; opacity: number; hidden: boolean;
    dropped: number;                                // cells the set has no tile for — holes, counted
}
interface TiledTilemapFit { layer: TiledTilemapLayer | null; why: string | null }
// OBJECT LAYERS (2026-08-10) — the half of Tiled a game needs first: a tile layer says what is at
// every position, an object layer says where a few THINGS are. `parseTiledMap` now returns these.
interface TiledProperty { name: string; type: string; value: string }   // value kept AS WRITTEN
interface TiledObject {
  id: number; name: string; className: string;   // `class` (1.9) and `type` (1.8) are ONE field
  kind: "tile" | "rectangle" | "ellipse" | "point" | "polygon" | "polyline" | "text" | "template";
  x: number; y: number; width: number; height: number;   // NOT a top-left corner for a tile — see objectBox
  rotation: number;                                       // DEGREES, clockwise, about (x, y)
  visible: boolean; cell: TiledCell | null; template: string | null;
  properties: TiledProperty[]; points: { x: number; y: number }[];      // points are RELATIVE to (x, y)
}
interface TiledObjectGroup { id; name; opacity; visible; offsetX; offsetY; objects: TiledObject[] }
// A TILE OBJECT'S (x, y) IS ITS BOTTOM-LEFT and every other object's is its top-left — the most
// common Tiled importing bug there is, and invisible: everything lands one object-height too low.
function objectBox(obj: TiledObject): { x: number; y: number; width: number; height: number };
// Radians (the sign is NOT flipped: both conventions are clockwise on a y-down screen) plus the
// fraction of the box Tiled turns about — {0,1} for a tile object, {0,0} for the rest.
function objectTransform(obj: TiledObject): { rotation: number; origin: { x: number; y: number } };
// What an object BECOMES, or why it cannot — the twin of `tilemapForLayer`, down to naming the sheet
// as a PATH the caller resolves. A polygon's box is derived from its POINTS (Tiled states 0x0 for
// one) and its commands are made relative to that box, which differ whenever a point is negative.
// Three kinds never place: a point (no size), a text object (its string is unread) and a template
// (its file is unopened).
interface TiledObjectPlacement {
  shape: "image" | "rectangle" | "ellipse" | "path";
  x; y; width; height: number;          // top-left anchored, objectBox already applied
  image: string | null; sourceRect: SourceRect | null;
  rotation: number; origin: { x: number; y: number };   // radians + the corner it turns about
  scaleX: number; scaleY: number;       // the gid's flips, via the same tileTransform a cell uses
  path: PathCommand[] | null; name: string;
}
function objectPlacement(obj: TiledObject, tilesets: readonly TiledTileset[]): { placement: TiledObjectPlacement | null; why: string | null };
// THE SAME SET, TOLD HOW BIG ITS IMAGE REALLY IS — and re-derived. `columns` and `tilecount` are
// recovered from a DECLARED `<image width height>` at parse time (25 of the tree's 26 such sets);
// this is for the one that declares neither, where only a decoded bitmap can say. NEVER overrides
// what the file stated, so it is safe to call on every set: the file is the authority.
function withImageSize(set: TiledTileset, width: number, height: number): TiledTileset;
// WHERE ONE CELL'S PICTURE GOES, box and all — `tilePosition` answers where the CELL is, this
// answers where the ART goes in it. A tile is anchored at the BOTTOM of its cell, so art taller
// than the grid stands UP from it (nine maps in the tree have such art). Both of Tiled's own
// oversized-tile examples declare SMALL `<tileoffset>`s, which is only possible if that is the
// default. Cell-sized art is unmoved, which is 45 of the corpus's 53 layers.
function tileImageBox(map: { orientation; tileWidth; tileHeight },
                      layer: { offsetX; offsetY }, set: { offsetX; offsetY },
                      image: { width; height }, col: number, row: number):
    { x: number; y: number; width: number; height: number };
// The 4th argument is an identity FUNCTION, not an id (schema 67): deduplication is the CALLER's,
// because only the caller sees every layer at once and can tell that six of them name one set.
// It also means no `Tilemap` ever exists carrying an empty id awaiting a fix-up.
function tilemapForLayer(map: { orientation: string; tileWidth: number; tileHeight: number },
                         layer: TiledLayer, tilesets: readonly TiledTileset[],
                         tilesetIdFor: (set: TiledTileset) => string): TiledTilemapFit;
```

**`tilemapForLayer` is why `core.tilemap` exists.** A whole tile layer becomes ONE node holding
indices. Measured on `Roguelike Base Pack/Map/sample_map.tmx` (100x100, five layers, 10,618 non-empty
cells), importing both ways and then deriving the frame over the whole map:

| | nodes | saved JSON | first frame | warm frame | to place |
|---|---|---|---|---|---|
| one `core.image` per cell | 10,618 | 7.80 MB | 32.3 ms | 12.1 ms | 1,244 ms |
| one `core.tilemap` per layer | 5 | 0.77 MB | 0.8 ms | 0.1 ms | 4 ms |

**A grid cannot express every layer, so it is decided PER LAYER and the reason is reported.** 45 of
the 53 tile layers in `freeassets` fit, carrying 22,440 of the 22,808 non-empty cells (98.4%). What
stops the other eight: **five layers whose tiles are bigger than their cells** (64x64 art on a 60x60
grid, 24x24 on 18x18 — Tiled overhangs, a cell would squash), and **three layers with no tiles at
all** (no sheet to name). Those keep the node-per-cell path, which is therefore not legacy code.
Two conditions that would have needed handling were checked and do not arise: no layer draws from two
tilesets, and no layer's data length disagrees with its own width and height.

**`tilemapError` has the last word.** Whatever grid is built is offered to the document's own
validator before being returned, so the importer cannot mint a node that fails to reopen. The
reachable case is a file declaring zero-sized tiles, which passes every earlier check because the
cell and the art agree at 0x0.

**A layer's `opacity` and `visible` survive only on this path.** The node-per-cell import dropped
both in silence — fading ten thousand nodes one at a time composites differently from fading the
layer — and one node per layer makes each a field. No `freeassets` map uses either; Tiled's own
automapping examples hide three layers of six.

**`tileTransform` is DERIVED, not tabulated.** The three bits are three reflections — transpose,
then negate x, then negate y — which together generate all eight symmetries of a square, exactly
what a quarter turn plus one axis flip also generates. `Matrix.compose` builds the linear part as
`R(t)·S(sx,sy)`; fixing `scaleY` at 1 and matching entries gives `sx = det(M)`, `cos t = M11`,
`sin t = -M01`. Rotation is in RADIANS, the unit `transform.rotation` is defined in. An unflipped
cell returns the exact identity, so the 123,872 unflipped cells in the tree carry no transform.

**THE TOP THREE BITS OF A GID ARE FLIP FLAGS.** A raw id of 2,684,354,697 in the measured tree is
tile 137 turned twice, and a reader taking it at face value indexes a billion tiles past the end of
every set it meets. 820 of the 124,692 measured cells carry a flag; each is a wrong picture rather
than a missing one if it is dropped.

**GID 0 IS EMPTY** — reserved by the format, not merely below a `firstGid` of 1 — so it stays empty
even for a malformed set that starts at 0.

**Layer data arrives three ways**: CSV, base64, and zlib-compressed base64. **Inflating is INJECTED**
exactly as `Aseprite` injects it. With no inflater a compressed layer is skipped with a NOTE rather
than failing the map, so its tilesets and other layers still arrive.

**An external `.tsx` is resolved by the CALLER.** `source` names it and `image` stays null; a parser
that reached for a file would need a filesystem and stop being pure. `parseTiledTileset` merges the
file onto the stub and **carries the map's `firstGid` over**, because that number belongs to the
reference rather than to the set and is not in the external file at all.

**`columns` is DERIVED when the file omits it.** An older Tiled wrote neither `columns` nor
`tilecount`; two measured maps are affected, which is 10,954 cells — 8.8% of the tree — that a
reader trusting `columns="0"` drops silently as empty. The arithmetic is the gutter arithmetic
inverted, and it comes out at exactly 57x31 for both.

**Orientation changes placement, not parsing.** `tilePosition` lays orthogonal on a grid and
isometric on a diamond; the cells read identically either way. **No isometric cell in the corpus has
ever been placed**: all three isometric maps carry one 60x60 tile layer whose every cell is empty, so
the diamond is covered by unit tests and the spec, not by a file.

**A TILESET IS NOT ALWAYS A SHEET.** Tiled allows a set whose tiles are separate files, and three
in the measured tree are built that way — 244, 348 and 236 tiles. Such a set has no sheet to cut:
`image` is null, `tileSourceRect` returns null, and the whole file IS the tile at its own size. A
caller asks `tileImageFor` FIRST and falls back to the rect. Checking `image` would be the wrong
test, since both kinds have images — one has a sheet and the other has many. The first `<image>` in
a collection belongs to its first `<tile>`, so taking it as the sheet gives a set whose every cell
is cut out of tile zero's picture.

**`<tileoffset>` moves every tile the set draws.** Four files carry one, all `-12,6`. It exists so a
tall tile can hang ABOVE the cell it occupies — a building rooted in one square standing over the
three behind it — so dropping it lays every such tile flat, which reads as a map drawn in the wrong
order rather than as a lost attribute.

**Either quote.** Two files write `<tile id='0'><image source='../Tiles/x.png'/>`, and a reader
that knew only double quotes saw a tag with NO attributes rather than an error. The quote is
back-referenced, so an apostrophe inside a double-quoted value does not end it early.

**`tilesetOverflow` exists because "it parsed" is not a check.** Before collection sets were
understood, one real `.tsx` had its first TILE's image taken as the whole sheet: the set then
declared 348 tiles in a 256x352 picture and placed its last one at y=122,144. Every function
returned a plausible value and every field was populated, so a sweep whose only question was
whether parsing threw passed it. This asks something that CAN fail — does the last tile a set
claims still land inside its own image. A note rather than an error, since a set may legitimately
over-declare and leave the tail unused; what it must not do is go unmentioned. `parseTiledMap`
reports it for embedded sets; an external one has no image until a caller resolves it, so the
caller checks it then.

**Not read:** infinite maps (chunked storage), object and image layers.

### `core/import/FontFile` — the facts needed to register a face

```ts
type FontFlavour = "truetype" | "cff";
interface FontInfo { family: string; subfamily: string; fullName: string; postScriptName: string;
                     flavour: FontFlavour; unitsPerEm: number; weight: number; italic: boolean }
function fontFileError(bytes: unknown): string | null;
function parseFontFile(bytes: Uint8Array): FontInfo;
```

`renderer/FontCache` is the impure half, beside `ImageCache` because it needs a DOM:

```ts
function registerFont(info: FontInfo, bytes: Uint8Array): Promise<string | null>;   // null = registered
function registeredFonts(): FontInfo[];
```

- THE FAMILY COMES OUT OF THE FILE. 36 of the 56 fonts measured have a filename that differs from
  the name the platform matches on, so a picker built from filenames offers families no document
  can use.
- Parsing stops at the `name`, `head` and `OS/2` tables: the platform rasterises text itself once a
  face is registered, so glyph outlines are not this engine's business.
- `usWeightClass` lands in `style.fontWeight` unchanged — both are the 1–1000 scale — clamped into
  range, since the field is a raw uint16.
- Collections (`.ttc`) and WOFF are NAMED, not half-read: each needs an unpacking step this omits.

### `core/import/SvgNodes` — read shapes as `core.path` nodes

```ts
interface SvgNodeSpec { geometry: Rect; path: PathCommand[]; style: Style }
const SVG_TRANSPARENT: string;                       // "#00000000" — every backend reads 8-digit hex
function svgNodeSpecs(shapes: readonly SvgShape[]): SvgNodeSpec[];
```

- The commands arrive ABSOLUTE (baking the transforms leaves them so); a node wants a box and
  commands relative to its corner. That conversion is `PathBuilder.normalizePathNode`, the one the
  pen tool already uses — not a second copy.
- A node's `fill` is required, so `fill="none"` becomes fully transparent black. Opacity is clamped
  into what `styleError` accepts, since nested opacities multiply.
- A shape with no extent in EITHER axis is dropped; a single-axis collapse is kept, because a
  horizontal stroke is a real path.

### `core/import/SvgPath` — SVG path data into this engine's commands

```ts
const SVG_PATH_MAX_COMMANDS: number;
function svgPathError(d: unknown): string | null;      // null = readable
function parseSvgPath(d: string): PathCommand[];        // absolute M/L/C/Q/Z only; throws on refusal
```

- A CONVERSION, not a reading: `H`/`V` become `L`, relative letters resolve against the current
  point, `S`/`T` reflect the previous control point (and degrade to it when the previous command was
  not the matching curve type), and elliptical arcs become cubics split at quarter turns.
- Verified against 95,160 real `<path>` elements: all parse, producing 2,658,530 commands, none
  rejected by `pathError` and no non-finite number among them.
- An arc's two FLAGS are single digits, so the scanner is driven by the parser rather than run ahead
  of it — `a10 10 0 015 5` is seven arguments, not five.

### `core/import/Trim` — cutting padding without moving the picture

```ts
interface TrimBox { x: number; y: number; width: number; height: number }
interface Trim { source: SourceRect; box: TrimBox }

function trimmedPlacement(box: TrimBox, source: SourceRect, ink: SourceRect): Trim | null;   // null = nothing to draw
function inkUnion(rects: readonly SourceRect[]): SourceRect | null;
```

`renderer/ImageCache` supplies the measurement, because it needs pixels:

```ts
function imageInkBounds(href: string, within?: TrimBox, alphaThreshold?: number): TrimBox | null;
```

- A TRIM IS A RECTANGLE AND A PLACEMENT. Trimming each frame to its own ink and dropping them in
  one box makes a character JITTER — measured ink origins across four run frames are (223,210),
  (209,204), (222,208), (225,215). Narrowing the source is paid for by moving and scaling the
  destination identically, so every pixel of ink stays exactly where it was.
- `inkUnion` is the safer trade: one box for every frame, so nothing can jitter by construction.
  On the measured run cycle it is 8% of the file where a per-frame trim reaches 4%.
- The threshold is a parameter because the packs disagree — pixel art is hard-alpha (0.0000
  soft-edge) while the stick figure is antialiased (0.0686).

### `core/import/Sequence` — a folder of numbered images

```ts
interface SequenceFrame { file: string; index: number }
interface Sequence { name: string; frames: SequenceFrame[] }
const SEQUENCE_MAX: number;

function parseFrameName(file: string): { stem: string; index: number } | null;   // null = carries no number
function groupSequences(files: readonly string[]): Sequence[];                   // first-seen order; frames sorted by NUMBER
function sequenceTrack(seq: Sequence, opts?: { start?: number; step?: number; hrefFor?: (f: string) => string }): Keyframe[];
```

- The number is the LAST digit run before the extension, separator OPTIONAL — the measured pack
  contains `fighter_wallslide0084.png` beside 83 files that use an underscore.
- Numbering does NOT restart per animation (`fighter_run` begins at 0017), so an index is
  meaningful only within its stem; case is kept, since `fighter_Idle` and `fighter_run` coexist.
- Sorted by NUMBER, never by name: one unpadded file makes a lexicographic sort play 10 before 9.
- The emitted keyframes are UNHELD, which is only safe because a keyframed `src` STEPS (schema 53).
  `hold` would freeze the whole node, so a running character could not both cycle and move.

### `actions/sequenceImport` — the actions a numbered run becomes

```ts
interface SequencePlacement { name: string; first: string; track: readonly Keyframe[];
                              x: number; y: number; width: number; height: number }
const SEQUENCE_DEFAULT_FPS: number;                                     // 24, for a document with no timeline
function sequenceImportActions(doc, p: SequencePlacement): { actions: Action[]; id: string };
```

- **ONE TRANSACTION or nothing.** Every action after the first names the node the first creates, so
  the list only works inside a `TransactionAction` — and that is the point: one undo removes the
  node, its name, its track and its timeline together.
- **The id comes back** because it cannot be looked up: the node exists in no document until the
  transaction commits. Minting it afterwards is what makes a track land on the wrong node.
- **`first` is written TWICE** — as the node's `src` and as the track's head — so the node draws
  before the playhead has moved, and in a document that never gets a timeline.
- **The timeline is GROWN, never shrunk**, to `lastFrame + 1`, and an existing one keeps its own
  `fps`. Shrinking would truncate whatever else the document animates; resetting the fps would
  re-time it.
- **An empty track yields NO actions.** "Import an animation" that quietly produced a still frame
  is a half-success with nothing to undo.
- It exists as a module for the reason `tileImportActions` does, plus one that was measured: a
  panel's `onClick` cannot be exercised at all, since `window.electronAPI` is frozen and the native
  folder dialog cannot be stubbed. See ACTION-SYSTEM.md § 5.

### `document/Timeline` — animation over frames (schema 39; CHANNELS schema 47)

```ts
interface Keyframe {
    frame: number;                        // whole, >= 0; a track is in ASCENDING order
    hold?: boolean;                       // stay put until the next keyframe — frame-by-frame
    easing?: Easing;                      // shapes the tween LEAVING this keyframe; ignored when held
    easings?: Record<string, Easing>;     // PER-PROPERTY curves (schema 45), keyed by path
    values: StateDefinition;              // the same statement a state and an override make
}
interface TimelineSettings { frames: number; fps: number }

const TIMELINE_MAX_FRAMES: number;        // 100_000
const TRACK_MAX_KEYFRAMES: number;        // 10_000
const FPS_MIN: number, FPS_MAX: number;   // 1, 240
const CHANNELS_MAX: number;               // channels one node may carry
const EASABLE_PATHS: ReadonlySet<string>; // the paths `easings` and `channels` may name

function timelineError(t: unknown): string | null;
function trackError(track: unknown, valuesError: (v: unknown) => string | null): string | null;
function channelsError(channels: unknown, valuesError: (v: unknown) => string | null): string | null;
function keyframesAt(track: readonly Keyframe[], frame: number):
    { from: Keyframe; to: Keyframe | null; t: number; raw: number } | null;   // null outside/empty; `raw` is the un-eased progress
function applyFrame(doc: ReadonlyDocument, frame: number | undefined): ReadonlyDocument;
function onionFrames(frame: number, before: number, after: number, frames: number): number[];
```

- `applyFrame` returns an ORDINARY document and is run inside `resolveScene`, so nothing below the
  display seam knows time exists. A document with no animated node is returned BY REFERENCE.
- The derived document's own `frame` is cleared. Naming it would re-apply the track to a document
  already placed in time — the trap `blendStates` fell into with `activeState`.
- Outside a track's range the nearest keyframe is HELD, never extrapolated.
- A CHANNEL IS A TRACK for one property path (schema 47) — same `Keyframe`, same rules, same
  validators. The one added rule: its keyframes may name only its own path. Channels are applied
  AFTER the track, so a property named by both takes the channel's value, and a document with no
  channels behaves exactly as it did before they existed.

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

## Scripting (`core/script/`, `editor/ScriptRunner.ts`) — Milestone 15

```ts
const SCRIPT_MAX_REQUESTS: number;   // 10_000 per run
const SCRIPT_TIMEOUT_MS: number;     // 2_000 — after which the WORKER IS TERMINATED
interface ScriptNode { id; type; name; parent; children; x; y; width; height; fill; opacity; text }
interface ScriptSnapshot { nodes: ScriptNode[] }        // FROZEN, plain, JSON-round-trippable
type ActionRequest =
    | { op: "move"; id; x; y } | { op: "resize"; id; width; height }
    | { op: "style"; id; style } | { op: "text"; id; text }
    | { op: "create"; nodeType; x; y; width; height; fill? } | { op: "delete"; id };
function snapshotFor(doc: ReadonlyDocument): ScriptSnapshot;       // from the RESOLVED scene
function actionRequestError(req: unknown): string | null;          // SHAPE only; values are each Action's job
function compileScript(doc, requests: readonly unknown[], newId: () => string): { action: Action | null; refusals: string[] };
function runScript(source: string, snapshot: ScriptSnapshot, timeoutMs?): Promise<ScriptResult>;  // NEVER rejects
```

The guarantee does not rest on the sandbox. A script is handed plain data and returns plain data;
`compileScript` builds the Actions and lets **each Action's own validator** decide — the same one
the inspector and the loader run — so a script can only ask for edits a person could make by hand.
The run is ONE transaction (one undo) and refusals are reported per request rather than thrown.
The worker adds depth: no DOM, no preload bridge, and the bootstrap deletes the network globals.

## Editor (`editor/`)

```ts
interface EditorState {
  selectedNodeIds: string[];
  hoveredNodeId: string | null;
  activeTool: string;
  isDragging: boolean;
  previewRect: Rect | null;                 // rectangle-tool draw preview
  marqueeRect: Rect | null;                 // box-select marquee (WORLD coords), drawn as an overlay
  // The PIXEL selection (2026-08-09): which pixels of which raster an edit may touch. A different
  // thing from `marqueeRect`, which picks NODES. Editor state, never the schema — a selection is
  // what the author is pointing at, not content, so it does not survive a save.
  pixelSelection?: { nodeId: string; mask: SelectionMask } | null;
  pendingGeometry: Map<string, Partial<Geometry>> | null; // move/resize preview, fed INTO computeGeometry
  viewport: { x: number; y: number; zoom: number };
}
function createEditorState(): EditorState;
// The playhead a loaded document should start on. `doc.frame` was written on every save and read
// back nowhere, so opening an animation put the scrubber at 0 while the canvas drew the stored
// frame — both halves self-consistent, disagreeing with each other. Clamped, because a timeline
// can be shortened under a saved frame; undefined without a timeline, which means "the document
// decides" rather than "frame 0".
function frameOnLoad(doc): number | undefined;
function clampViewport(vp): void;            // zoom ∈ [0.05, 20]; pan ±10000 WORLD units (scaled by zoom)
// Pure viewport math (node-tested); each mutates vp then re-clamps.
function panBy(vp, dx: number, dy: number): void;                 // SCREEN-px pan (zoom-independent)
function zoomAt(vp, factor: number, cursorX: number, cursorY: number): void; // cursor-anchored zoom
// PROTOTYPE NAVIGATION (schema 36) — pure, and RETURNING a viewport rather than mutating one,
// because a navigation needs both ends to interpolate between.
function viewportToFit(bounds: Rect, size: Size, padding: number, fallbackZoom: number): EditorState["viewport"]; // "zoom to this frame": the tighter axis wins, the rect is centred, the result is CLAMPED; a degenerate rect keeps the current zoom rather than dividing by zero
const FIT_PADDING_PX = 24;
function overlayTransform(world: Mat2D, vp): string;   // a node's world matrix as the CSS transform
                             // that puts a DOM overlay exactly on it — the on-canvas text field.
                             // Same relationship `screenToWorld` inverts, so the caret lands in
                             // the letters under any rotation, scale or zoom   // shared by the editor's Zoom to Fit and a prototype NAVIGATE — one
                             // gesture with two triggers, so one number for the breathing room
function lerpViewport(a, b, t: number): EditorState["viewport"];  // offsets LINEARLY, zoom GEOMETRICALLY (a linear zoom over a wide range barely moves, then lurches); t clamped to [0,1]
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
  // ESCAPE REACHES THE ACTIVE TOOL BEFORE IT MEANS DESELECT, and until 2026-08-10 it did not — so
  // every cancel below, and every tool's own, was unreachable in the running app while its unit
  // tests passed. `App` resolves the DESELECT shortcut from a key press, and `deselect` stands
  // aside only when NOTHING is selected; a gesture that can be cancelled always has a selection,
  // because it needed one to start. `App` now offers Escape to `toolController.onKeyDown` FIRST and
  // falls back to deselect only if the press was not claimed. A TOOL CLAIMS IT by calling
  // `preventDefault` in the branch that acted — which is why each of those branches is guarded by
  // "is there a gesture": a cancel that claimed the key whenever its tool happened to be active
  // would stop Escape ever deselecting.
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

Tools: `SelectTool`, `MoveTool`, `ShapeTool`, `PenTool`, `RasterTool`, `WeightTool`,
`EyedropperTool`, `TileTool` (all implement `Tool`).
Tools construct Actions and dispatch them; they mutate only `EditorState`, never the document.

```ts
class TileTool implements Tool {
    constructor(dispatcher, editorState, refresh,
        brush: () => TileBrush, onPick: (index: number, flip: number) => void);
}
interface TileBrush { index: number; flip: number; mode: "paint" | "fill"; erasing: boolean }
```

`TileTool` is the only caller of `SetTilemapAction`. **THE DOCUMENT IS THE PREVIEW**, as for the
raster and weight brushes: every move commits, coalesced, so the map updates under the cursor and
one Ctrl+Z takes the stroke.

**IT FILLS THE GAPS BETWEEN SAMPLES**, unlike the weight brush, and the difference is the size of
the thing painted: a mesh has a few dozen points under a brush wider than the gap between two mouse
events, while a CELL is one tile wide, so a pointer at 60Hz crossing a map skips several and a
stroke would come out as beads. It walks `PixelBuffer.linePoints` — the same Bresenham the pixel
brush interpolates with — because a tile grid is an integer grid and a second implementation would
disagree with the first by a cell at some angles.

**Which cell** is `toLocal` then `Tilemap.cellAt`, which is how the RENDERER finds cells too; that
pair is why a rotated, scaled or nested tilemap paints the cell under the cursor with nothing in the
tool knowing it is transformed. **ALT SAMPLES** the tile under the cursor into the brush, orientation
included, and writes to the BRUSH rather than the document — the same shape as the eyedropper
writing to the swatch, so it leaves no history entry. It is checked BEFORE the mode, so picking works
in fill mode rather than being a trap. **ERASING also straightens the cell**, or an emptied cell
would keep an orientation nothing can see and hold the whole `flips` array alive.

**A RECTANGLE is the third gesture** (`mode: "rect"`), and the one that could not be a stroke:
press one corner, drag the other, release. `rectCells` had done its arithmetic since the grid landed
with no caller outside its own tests — which is to say it was not a feature.

Its preview is the document, like every gesture here, but each frame is computed from the map **as
it was at the press** rather than layered onto the last one. That is the whole difference between a
rectangle and a stroke: a stroke only ever adds, so painting onto what is there is right, while a
rectangle pulled back in must UNPAINT what the larger one covered — applied to the live map it
leaves the high-water mark behind and can only grow. The far corner is asked for LOOSELY
(`cellCoordAt`) so a drag off the map keeps following the pointer, and **a gesture that ends up
changing nothing rolls back to the checkpoint it took at the press** — this is the one tool here
that can reach "no change" AFTER having committed, and an undo step that undoes nothing reads as a
press of undo being ignored. Escape does the same thing mid-drag.

**Leaving the grid mid-stroke drops the anchor**, so coming back paints where the pointer is rather
than striping a line across the map from where it left. **A press off the grid starts nothing.**

```ts
class BucketTool implements Tool { constructor(dispatcher, editorState, refresh, colour: () => Rgba) }
function surfaceEditAction(doc, nodeId, edit: (b: PixelBuffer) => number, mask?: SelectionMask | null): Action | null;
function quantizeAction(doc, nodeId, palette: Palette, mask?: SelectionMask | null): Action | null;

// The four marquees. ONE tool, four modes: every mode resolves the same target, reads the same base
// mask and combines the same way — only the shape function differs, and the target rule is where a
// paint tool actually goes wrong. Dispatches NOTHING: a selection is not content, so it writes editor
// state and leaves no history entry, the same bargain the eyedropper makes with the swatch.
type PixelSelectMode = "rect" | "ellipse" | "lasso" | "wand";
interface PixelSelectConfig { mode: PixelSelectMode; contiguous: boolean; tolerance: number }
class PixelSelectTool implements Tool { constructor(dispatcher, editorState, refresh, config: () => PixelSelectConfig) }
function wandMatcher(tolerance: number): (a, b) => boolean;   // exact at 0; sums all four channels
const WAND_TOLERANCE_MAX = 1020;                              // 255 across four channels
```

**The OPERATOR comes from the modifiers, not from a panel** — plain replaces, Shift adds, Alt
subtracts, both intersect — because it is a property of the gesture: a toggle would let an author
leave "subtract" on and then wonder why the next marquee ate their selection. **A press that never
moves DESELECTS**, which is the only way out with a mouse; **Escape mid-drag restores the base mask**
rather than clearing, so cancelling costs the gesture and not the selection. The lasso unions the
polygon with the TRAIL: vertices sit at pixel centres (a corner leaves which pixel was meant
ambiguous), which puts the traced line exactly on the boundary where half of it would fall out by
parity.

**`BucketTool` is the seam that makes `floodFill` reachable** — it had no caller outside the tests for
as long as the paint layer has existed. The WHOLE SURFACE is the captured region, unlike a stroke's:
a stroke's future is bounded by the brush, a fill's only by the canvas. One click is one history
entry, with no coalescing, because a drag is one gesture and two clicks are two decisions.

**A palette is loaded through its own two IPC channels** (`readPaletteFolder` / `readPaletteFile`),
mirroring the Tiled pair rather than widening it, and confined to the folder the user picked. There is
no palette extension to scan for, so the scan is `.json` and the panel reports how many of the files
found actually described a palette — `parsePaletteFile` answering null is what makes that honest.

`tileIndexAt` is the picker's half of the same arithmetic — the exact inverse of `tileSourceRect`,
answering **null in the gutter and the margin** rather than the neighbouring tile.

```ts
class RasterTool implements Tool {
    constructor(dispatcher, editorState, refresh,
        colour: () => Rgba, brush: () => Brush, symmetry: () => SymmetryMode);
    isPainting(): boolean;
    cancel(): void;
}
const STROKE_REACH: number;   // captured region beyond the first dab, in SURFACE pixels
```

`RasterTool` is the only caller of `PaintSurfaceAction`, and the seam that makes the whole
`core/paint` layer reachable. **THE DOCUMENT IS THE PREVIEW**: a stroke commits on every move,
coalesced, exactly like the rotate and vertex-drag gestures — so every backend draws it with no
preview surface and no new plumbing. **The patch is CUMULATIVE from the stroke's start**, which
is what lets the same action be re-sent each frame: its `after` bytes are absolute, so re-applying
lands on the same result. **Release dispatches NOTHING** — a final identical patch would land as a
second history entry, making the first Ctrl+Z appear to do nothing. **The target is the SELECTION**,
captured at press with its `SurfaceSpace`, not re-picked per event.

Known and shared with every live-committed gesture here: the coalesce window is timed, so two
quick separate strokes on the same node merge into one undo step. The picture is right either way;
only the granularity is coarse.
`ShapeTool` is ONE tool parameterised by `ShapeKind` (`SHAPE_KINDS` = rectangle | ellipse |
line | text | triangle | polygon | image | **raster**), since the corner-to-corner gesture, preview, Escape and zoom-independent
minimum size are identical for all of them — only the node type, the paint and the content
differ. Its minimum-size rule is per-type on purpose, to agree with the shared `dimensionError`
the action validates against (a `core.line` may collapse ONE axis; everything else needs a box),
so the tool can never commit what validation would reject.
**`raster` draws a CANVAS**: a `core.raster` born with a blank surface sized to the drag at one
pixel per world unit, clamped to `RASTER_MAX_SIDE` and to at least one pixel. It must be born with
one — a raster without a surface is a node `PaintSurfaceAction` refuses, so it would validate,
serialize and be permanently unpaintable.
**Every kind now SELECTS what it created.** Conventional, and load-bearing since `RasterTool`
paints the selection: without it, drawing a canvas and painting on it silently did nothing, which
is exactly what driving the real app found. FILLED vs OUTLINE is a toolbar mode,
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

## Paint (`core/paint/`)

```ts
// PixelBuffer — a surface VDE authored, straight RGBA, not premultiplied
interface PixelBuffer { width: number; height: number; data: Uint8ClampedArray }
function createPixelBuffer(w, h): PixelBuffer;      function setPixel(b, x, y, colour): void;
function getPixel(b, x, y): Rgba | null;            function inBounds(b, x, y): boolean;
function linePoints(x0, y0, x1, y1): [number, number][];
function drawLine(b, x0, y0, x1, y1, colour): void;
// A CLIP is a selection expressed as a predicate, so nothing down here knows what a selection IS.
// Absent means unconstrained. For a FILL it is a WALL, not a filter: tested where neighbours are
// QUEUED, or the fill tunnels under the boundary and surfaces on the far side.
type PixelClip = (x: number, y: number) => boolean;
function floodFill(b, x, y, colour, clip?: PixelClip): number;

// PixelPatch — what a stroke costs to remember
interface PixelPatch { x; y; width; height; before: Uint8ClampedArray; after: Uint8ClampedArray }
function capturePatch(b, before, x, y, w, h): PixelPatch;   function applyPatch(b, p): void;
function revertPatch(b, p): void;   function invertPatch(p): PixelPatch;   function patchCost(p): number;

// Brush — a set of dabs, each optionally carrying its own colour
interface BrushDab { dx: number; dy: number; colour: Rgba | null }
interface Brush { width; height; round: boolean; dabs: BrushDab[]; variants: Brush[] }
function makeBrush(size, round): Brush;             function brushFromImage(b: PixelBuffer): Brush;
function brushWithVariants(faces): Brush | null;    function pickFace(brush, roll: number): Brush;
// The clip is tested PER DAB. At the stamp's centre instead, a wide brush lands whole or not at all
// and the boundary becomes brush-sized and ragged rather than the line the author drew.
function stampBrush(b, brush, x, y, colour, clip?: PixelClip): void;  function brushBounds(brush, x, y): Box;
function strokePath(b, brush, points, colour, line, clip?: PixelClip): void;  function strokeBounds(brush, points): Box | null;

// PixelCodec — a surface as text a document can hold
function encodeSurface(b): { data: string; rawBytes: number; packedBytes: number };
function decodeSurface(data, width, height): PixelBuffer | null;

// Stroke — a drag, from first press to the patch it becomes
// The clip lives ON the session, captured at the press with everything else: a stroke paints from
// three places (the press's dot, each move's segment, the mirrors) and one handed to some of them is
// a selection the brush half-obeys.
function beginStroke(b, brush, x, y, colour, reach, clip?: PixelClip): StrokeSession | null;
function extendStroke(b, session, x, y, line): void;
function endStroke(b, session, line): PixelPatch;   function strokeEscaped(session): boolean;

// SurfaceSpace — where a pointer is, in pixels
interface SurfaceSpace { world: Mat2D; localWidth: number; localHeight: number;
                         surfaceWidth: number; surfaceHeight: number; }
function surfaceSpaceError(space): string | null;
function worldToSurface(space, worldX, worldY): [number, number] | null;
function surfaceToWorld(space, sx, sy): { x: number; y: number } | null;   // a pixel's CENTRE
// A GRID coordinate — the corner between pixels, which is where a selection's edge runs. `surfaceToWorld`
// is derived from this, so "where is pixel (3,4)" and "where is grid line 3" cannot drift apart.
function surfaceCornerToWorld(space, gx, gy): { x: number; y: number } | null;
function surfacePixelSize(space): { x: number; y: number } | null;

// Selection — which pixels an edit may touch. A binary MASK, not a rectangle: a rectangle cannot
// express a lasso, a wand, or a rectangle minus a bite, and a system that starts with rectangles
// grows a special case per shape until something has to unify them anyway. 16MB at PIXEL_MAX_SIDE
// against 67MB of RGBA. EDITOR state, never the schema — see `pixelMaskFor`.
interface SelectionMask { width: number; height: number; data: Uint8Array }   // 0 or SELECTED (255)
type SelectionOp = "replace" | "add" | "subtract" | "intersect";
function selectionMaskError(mask): string | null;   // the length-vs-dimensions check that matters most
function emptyMask(w, h): SelectionMask;            function fullMask(w, h): SelectionMask;
function isSelected(mask, x, y): boolean;           // false OFF the mask, so an edit clips at the border
function isEmptySelection(mask): boolean;           function selectedCount(mask): number;
function maskBounds(mask): Rect | null;             // INCLUSIVE: one pixel is a 1x1 box
function combineSelection(into, shape, op): SelectionMask | null;   // null on a size mismatch
function rectSelection(w, h, a, b): SelectionMask;
function ellipseSelection(w, h, a, b): SelectionMask;    // tests pixel CENTRES, so 1x1 is one pixel
function lassoSelection(w, h, points): SelectionMask;    // even-odd, half-open in Y
function wandSelection(buffer, x, y, same, contiguous): SelectionMask;   // `same` is INJECTED
function growSelection(mask, by): SelectionMask;    // negative shrinks; the surface edge counts as inside
function borderSelection(mask, by): SelectionMask;  // derived from grow — so a FULL mask's border is empty
function invertSelection(mask): SelectionMask;
// The mask as the predicate the primitives take, and the ONE place "empty means no constraint" lives.
function selectionClip(mask): PixelClip | undefined;
// Put back what a whole-surface edit changed OUTSIDE the mask; returns how many PIXELS it undid. The
// only way to honour a mask through a stranger's callback — see docs/ACTION-SYSTEM.md.
function restoreUnselected(buffer, before, mask): number;

// Adjust — destructive colour edits. EVERY ONE IS `(buffer, ...args) => number`, which is exactly
// what `surfaceEditAction` takes, so a new adjustment becomes a panel button by being written: no
// action, no plumbing. The number is pixels CHANGED, which is what decides whether there is an undo
// step at all. ALPHA IS NEVER TOUCHED and fully transparent pixels are skipped entirely — their RGB
// is invisible, and mapping it would only enlarge every patch.
const MID = 127.5;                        // the true centre of 0..255; 128 drifts an image darker
const POSTERIZE_MIN = 2, POSTERIZE_MAX = 256;
function mapColours(buffer, map: (r, g, b) => [number, number, number]): number;   // memoised per COLOUR
function adjustBrightness(buffer, amount): number;   // ADDITIVE, so it moves black (unlike value)
function adjustContrast(buffer, amount): number;     // percentage, pivoting on MID
function rgbToHsv(r, g, b): [number, number, number];    // h 0..360, s and v 0..1; a grey has NO hue
function hsvToRgb(h, s, v): [number, number, number];    // hue wraps; the round trip is exact on bytes
function adjustHsv(buffer, hueShift, saturationScale, valueScale): number;  // ONE pass: three round trips would each round
function desaturate(buffer): number;                 // Rec.601 luma — NOT Quantize's 2:4:3, which weights SQUARED differences
function invertColours(buffer): number;
function posterize(buffer, levels): number;          // the RANGE into levels-1 intervals, so the endpoints survive
function replaceColour(buffer, from: Rgba, to: Rgba, same): number;   // `same` injected, as wandSelection takes it

// SelectionOutline — the marching ants, as merged runs of GRID line (not the bounding box, which
// would draw a lasso, a wand result and a rectangle-minus-a-bite as the same rectangle). A HOLE is
// an edge too. Only the mask's own bounds are scanned, because this runs per frame during a drag.
interface MaskSegment { x1: number; y1: number; x2: number; y2: number }
function maskOutline(mask): MaskSegment[];
```

**`SurfaceSpace` TAKES THE BOX'S SIZE, NEVER ITS ORIGIN.** `ComputedNode.local` is a Rect carrying
the node's stored x/y, but the renderer does not place with them — `buildRenderModel` emits every
shape at `x = 0, y = 0` and `world` carries the whole placement. A mapping that subtracted
`local.x` as well would count the node's position TWICE; taking only `width`/`height` makes that
unrepresentable. **This was a real bug**, and it passed six mutants and a full unit test because the
fixture paired an identity `world` with a non-zero local origin — a pairing `computeGeometry` never
emits. It surfaced only against a real document.

The map FLOORS (a pixel is a cell, and rounding halves the reachable width of the two edge columns);
the reverse map answers a pixel's CENTRE, not its corner. Results OUTSIDE the surface are returned
rather than dropped — `setPixel` already bounds every dab, and a second bounds rule is a second
thing that can disagree with it. What is refused is a conversion with no answer: a collapsed box, a
singular matrix, a NaN point.

**PAINTING REPLACES RATHER THAN BLENDS**, because an eraser is a pencil holding a transparent
colour. A blending plot cannot erase, and editors that blend by default grow a separate eraser path
that disagrees with the pencil about edges.

**A plot's x bound is not implied by its index.** `(y * width + x) * 4` is valid for `x = -1` — it
lands on the previous ROW — so bounding only the total index draws a stray column down the opposite
edge whenever a stroke leaves the side.

**Fill is FOUR-connected and queue-driven.** A diagonal seam is a wall in pixel art; eight-connected
leaks through the corner and floods the sprite. The obvious recursive fill is 16.7M deep on a full
surface.

**A brush is a set of DABS, not offsets.** A dab's own colour wins over the stroke's, which is what
makes an image brush a picture rather than a silhouette; `null` means "use the stroke's". Brushes
are not square, and `variants` are faces of ONE brush chosen per stamp — `pickFace` takes an
INJECTED roll, because a stroke must replay identically or undo and redo disagree about what was
painted.

**The order in `Stroke` is the whole difficulty**: capture the region BEFORE any paint, draw, then
diff. Getting it wrong leaves the picture correct and only the undo broken.

## Renderer (`renderer/`)

### `renderer/emitWebGL` — the effects pass (blur + composite)

```ts
interface BlurTarget { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number }
interface BlurState {
    program: WebGLProgram; quad: WebGLBuffer; composite: WebGLProgram;
    targets: [BlurTarget | null, BlurTarget | null, BlurTarget | null];
    /* attribute/uniform locations */
}
function initBlur(gl): BlurState | null;
function ensureTarget(gl, held: BlurTarget | null, w: number, h: number): BlurTarget | null;
function blurPass(gl, blur, from, into, sigma: number, horizontal: boolean): boolean;
function compositeTarget(gl, blur, from, offsetX, offsetY, tint: [number,number,number,number] | null): void;
```

**`GLState.blur` is nullable and that is a real answer** — a context that cannot link the second
program still draws every shape, losing only what this backend never had. It is built EAGERLY:
`initGL` runs on the first frame, so the programs are compiled for every context even though
nothing spends them until the loop wrap lands.

**THE LOOP BOUND MUST BE A COMPILE-TIME CONSTANT.** GLSL ES 1.00 refuses `for (i < u_radius)`
outright, so the blur loops to `BLUR_MAX_TAPS` and breaks on the uniform, with weights as a
dynamically-indexed uniform array. Measured in this renderer, not assumed.

**THREE targets, not two.** Two suffice for a blur alone (a separable pass ping-pongs between a
pair). A SHADOW needs a third, because it is a blurred copy drawn UNDER an item that is still
needed sharp — blurring in place consumes the thing being shadowed.

**PREMULTIPLIED throughout.** Targets are drawn into a transparent-cleared framebuffer with
ordinary src-alpha blending, which leaves RGB already scaled by alpha, so compositing uses
`ONE, ONE_MINUS_SRC_ALPHA`. Blurring straight RGBA would mix the colour of transparent texels —
usually black — into every soft edge, giving a dark fringe that reads as a bad shadow.

**`compositeTarget`'s offsets are in the DOCUMENT's axes — y grows DOWNWARD**, like `Shadow.dy`.
The y is negated inside, because a GL framebuffer's y grows upward; measured with a probe texel,
not reasoned about.

**`blurPass` returns false for an identity kernel**, so a caller skips the pass rather than
spending a full-screen draw copying an image to itself.

**NOT YET CALLED.** `ensureTarget`, `blurPass` and `compositeTarget` are absent from
`dist/app/bundle.js` entirely — esbuild tree-shakes what nothing calls. The loop wrap in
`emitWebGL` is what will bring them in.

### `renderer/RenderModel` — naming a raster surface

```ts
function rasterHref(nodeId: string, surface: { data: string; width: number; height: number }): string;
```

A `core.raster` node becomes an image item whose `href` **identifies** its surface. The model names
a picture and the renderer resolves it — the same seam `core.image` uses with `ImageCache`, chosen
because it needs no new pattern and keeps the model pure, which is the property the run-length codec
decision was made to protect.

**THE KEY CARRIES THE PAYLOAD'S IDENTITY, NOT THE NODE'S.** A cache keyed on the node id would show
the picture from before every stroke, since the id is exactly what does not change when a surface is
painted. The href folds in the dimensions, the payload length and a **position-weighted** checksum —
weighted because a plain character sum collides on any reordering, and a reordered payload is a
different picture. Collisions cost a stale frame, not a wrong picture, because the length and
dimensions travel alongside.

**A raster with no surface names `null`**, so a backend skips it exactly as it skips an image whose
source has not decoded.

**Nearest-neighbour by DEFAULT**, unlike `core.image`: a painted surface zoomed in is meant to show
its pixels, while a photograph is not. Two node types, two opposite correct defaults.

**Resolved by `ImageCache.resolveSurface(href, surface)`**, because the SHAPE CARRIES THE PAYLOAD
along the display list — a reference to a string the document already holds, not a copy, so the
model stays pure and the href stays identity-only. `resolveImage` could never do it: it sets
`img.src = href`, which for a `raster:` key fails to load.

```ts
function resolveSurface(href: string, surface: { data: string; width: number; height: number }):
    HTMLCanvasElement | null;      // ready THIS frame — no load to wait for
function surfaceUrl(href: string, surface: { data: string; width: number; height: number }):
    string | null;                 // the same entry, encoded — for the one backend that needs a URL
```

**Decoded SYNCHRONOUSLY into an offscreen canvas**, so the frame that asks gets the pixels. The
`HTMLImageElement` this replaced needed `toDataURL` then `onload`, which costs a frame — nothing for
a picture that arrives once, but a brush changes the cache key on EVERY MOVE and paid it every time.
All three backends take a canvas; SVG alone needs a URL and gets it from `surfaceUrl`, which encodes
lazily and caches per entry.

**KEYED BY NODE, NOT BY HREF.** The href folds in a pixel checksum, so an href-keyed cache kept one
full-size canvas per stroke for the life of the session. One entry per node, replaced when the
payload changes. A payload that will not decode is remembered as a failure for THAT key — so it is
not retried every frame, while a later, different payload for the same node still decodes.

**Canvas draws rasters; the GPU backend does not yet** — its `Draw` structure has no payload field,
so threading one through `itemDraws` is a real change. It skips them, alongside the effects
regression recorded against it in ARCHITECTURE.md.

### `renderer/Gaussian` — the blur kernel, as plain numbers

```ts
interface GaussianKernel {
    radius: number;      // taps per side; 0 means no blur
    weights: number[];   // 2*radius+1, symmetric, summing to 1
    clamped: boolean;    // true when the curve was cut at GAUSSIAN_MAX_RADIUS
}
function gaussianKernel(sigma: number): GaussianKernel;   // sigma in DEVICE pixels
function gaussianOuterProduct(kernel: GaussianKernel): number[][];
function blurPlan(sigma: number): { levels: number; sigma: number; clamped: boolean };
const GAUSSIAN_MAX_RADIUS: number;      // 64 taps per side
const GAUSSIAN_MAX_SIGMA: number;       // 21.33 — the widest one full-res pass expresses
const GAUSSIAN_MAX_DOWNSAMPLE: number;  // 4 halvings
const GAUSSIAN_SIGMA_CUTOFF: number;    // 3 sigma, keeping 99.73% of the curve
```

`shadow` and `blur` are the last thing the WebGL backend cannot draw, and both are a gaussian over
a rendered image. **The GL plumbing cannot be unit-tested without a context; the arithmetic can,
and it is where a blur that still looks like a blur hides being wrong** — so the weights live here
and the backend spends them.

**SIGMA IS IN DEVICE PIXELS.** `Shadow.blur` and `Style.blur` are world units; the backend that
owns the CTM multiplies by `z·dpr` before asking — the same one arithmetic exception `emitCanvas`
already makes for `shadow*`/`ctx.filter`.

**Separability is why this is affordable**: blurring per axis costs `2r+1` taps rather than
`(2r+1)^2`, which at sigma 20 is 121 against 14,641. `gaussianOuterProduct` exists only so that
identity can be asserted against a directly-computed 2D gaussian.

**Normalised AFTER truncation.** Spending 0.9973 of the light is a blur that darkens what it
touches, more the wider it gets. **The radius is clamped and says so** — zoom multiplies sigma, so
a 500-tap kernel is reachable by zooming in rather than by an odd document.

**A sigma of zero or less is the IDENTITY kernel, not an error**, so a caller has one code path.

**A WIDE BLUR IS COMPUTED SMALL, NOT CLAMPED FLAT.** `gaussianKernel` alone pins the effective
sigma at 21.33, so a blur of 40 and a blur of 160 come out identical and both far sharper than the
other backends draw them — and a 20px blur at 1:1 on a Retina display already reaches that, since
device sigma is `blur * zoom * dpr`. `blurPlan` moves the work instead: halving the resolution
halves the sigma needed, and a gaussian is scale-covariant, so blurring a half-size image by
sigma/2 and stretching it back is the same picture. Both correct and cheaper — the expensive pass
runs over a quarter of the pixels per level. Bounded at 4 halvings, which expresses sigma 341.

**The invariant a caller can rely on: `plan.sigma * 2^plan.levels` reconstructs the sigma asked
for.** That is what the tests assert, rather than the level counts themselves.



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
  // The PIXEL selection to outline (2026-08-09): a mask over one raster's pixels, drawn as the
  // boundary between selected and unselected — NOT its bounding box, which would draw a lasso as
  // a rectangle. The caller validates it through `pixelMaskFor`; the model does not re-check.
  pixelSelection?: { nodeId: string; mask: SelectionMask } | null;
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
  fill: string | PaintGradient | null;          // schema 56 — a colour, a resolved ramp, or absent
  opacity: number | null;
  stroke: string | null; strokeWidth: number | null; strokeDash: string | null;
  radius: number | null; cursor: string | null; pointerEvents: boolean;
  shadow: Shadow | null; blur: number | null;   // schema-18 effects (world units), resolved from Style
  strokeJoin?; strokeCap?; strokeMiterLimit?;   // schema 37 — OPTIONAL, absent = "what you already drew"
  fillRule?: FillRule;                          // schema 38 — absent = "nonzero", what all three already drew
}
type DrawRole = "grid-line" | "content" | "outline" | "handle" | "preview" | "marquee" | "guide" | "shadow";
interface DrawItem {
  shape: Shape; paint: Paint;
  world: Mat2D | null;          // null → the backend emits no transform
  nodeId: string | null;        // data-node-id; handle? → data-resize-handle
  handle?: string; role: DrawRole;
  depth?: number;               // schema 40 — absent = 0; the GPU needs it per vertex
  localBox?: { width; height }; // schema 56 — the node's own box, ONLY for an objectBoundingBox ramp
  surface?: { mesh: ReadonlyMesh; box: {width, height} };   // schema 42 — the mesh that CAUSED the bend
  groups?: string[];            // schema 32 — opacity groups this item is inside, outermost first
}
// `surface` is carried separately from the shape because `resolveMeshes` has already turned a
// meshed node into a path and dropped its mesh: the bend is in the commands by then, and what a
// light needs is the surface that caused it. Only the unresolved document still has it.
// A node's drop SHADOW is derived from `lights[0]` and its own depth when `style.shadow` is
// absent (`shadowOffset`), so moving the scene light moves every shadow together. An explicit
// `style.shadow` still wins — somebody who set one meant it.
interface GridModel { sig: string; lines: DrawItem[]; unchanged: boolean }
interface FilterDef { id: string; shadow: Shadow | null; blur: number | null }  // one <filter> per entry
// A gradient with its $token stop colours RESOLVED (schema 56). Coordinates are carried AS
// AUTHORED with `units` beside them, NOT folded into the shape's local space: this model composes
// no coordinates, and SVG has `gradientUnits`/`gradientTransform` natively — folding here would
// only mean unfolding in the backend. `flat` is the single colour a backend that cannot ramp
// paints, decided once so all three agree instead of each choosing.
interface PaintGradient {
  kind: "linear" | "radial"; id: string;        // id is content-derived → one <defs> entry per ramp
  units: GradientUnits; stops: readonly GradientStop[]; transform: Mat2D;
  x1; y1; x2; y2; cx; cy; r; fx; fy: number;
  flat: string;
}
// The GPU carries a ramp as uniforms; `gpuGradient` is the CPU half, and null is its refusal —
// more stops than the arrays hold, a stop colour `parseColor` cannot take apart, or a mapping with
// no inverse. The caller then paints `flat`. `inv` maps a fragment's LOCAL position into gradient
// space (objectBoundingBox folded in), which is the direction a shader needs.
//   GPU_MAX_STOPS: 16   — the shader's cap, not the schema's: WebGL 1 guarantees 16 fragment
//                         uniform vectors and the document allows 64 (the corpus's worst case: 11)
//   gpuGradient(g: PaintGradient, box): Draw["gradient"]
// `Draw.image.surface` carries a `core.raster`'s run-length payload (schema 55) — the href is an
// identity key, not a URL, so without it this backend has nothing to fetch and draws nothing.
function gradientDefId(g: Omit<PaintGradient, "id">): string;
function resolvePaintGradient(g: Gradient, color: (raw: string) => string): PaintGradient;
// `localBox` carries the box an objectBoundingBox ramp is a fraction of. It is NOT on
// `PaintGradient`: that is deduped by content into one <defs> entry per ramp, and a size on it
// would split one ramp used on two differently-sized shapes into two. It is not derived in a
// backend either — a `path` item carries commands, not an extent. Only the Canvas backend reads
// it; SVG has `gradientUnits` and the GPU flattens.
interface DisplayList {
  viewport: { x: number; y: number; zoom: number };
  grid: GridModel; content: DrawItem[]; overlay: DrawItem[];
  defs: FilterDef[];            // deduped effect filters (by id); emitSVG builds <defs> from these
  gradients: PaintGradient[];   // schema 56 — deduped gradient defs, in content order
  groups: OpacityGroup[];       // schema 32 — the groups `content` items refer to, outermost first
  lights?: readonly Light[]; ambient?: number;   // schema 42 — the DOCUMENT's, not a shape's
}
// `content` is sorted FAR-to-NEAR by `depth` before the tree's own order; equal depths compare
// zero, so a document that never mentions depth draws exactly as it always did.
// Pure, deterministic, INJECTIVE, SVG-id-safe filter id (the twin of commandsToPathData); null = no effect.
function effectFilterId(shadow: Shadow | null, blur: number | null): string | null;
// Which layers just ended and which just began, between two consecutive items (schema 32). An
// opacity group composites as ONE and is then faded, and every backend expresses that as a layer:
// a `<g opacity>`, an offscreen canvas, a render target. Only the SEQUENCING is shared, so it is
// stated once. A RUN, not a lookup by id — creating a layer on first mention and reusing it would
// pull a group's items back together in draw order and change what is in front of what.
// Typography with $tokens looked up, ranges checked and defaults applied (schema 34). Shared with
// the on-canvas text editor's field: a field whose metrics disagree with the render puts the caret
// in the wrong place and makes the text jump when editing ends.
interface ResolvedType { fontSize; fontFamily; fontWeight; textAlign; lineHeight; letterSpacing }
function resolveTypography(style, store: VariableStore, theme: string): ResolvedType;
function layerTransition(prev: readonly string[], next: readonly string[]): { close: number; open: string[] };
// A bitmap whose corners keep their size (schema 57), in `core/geometry/NineSlice`. ONE arithmetic,
// called by all three backends and the exporter — which is exactly why a cross-backend pixel sweep
// cannot check it: they would agree on a wrong answer. Its expected rectangles are hand-computed.
interface NineSliceInsets { left; top; right; bottom }        // SOURCE pixels, relative to sourceRect
interface Slice { src: Rect; dst: Rect }
function nineSliceRects(source: Rect, dest: Rect, insets: NineSliceInsets): Slice[];
// Linear blend skinning — the join between `Rig` (which poses a skeleton) and `Mesh` (which bends
// a shape). One bone's answer is `posed · rest⁻¹` applied to the point: where it moved TO, undoing
// where it started FROM. Space-agnostic, so the caller decides the frame.
const SKIN_MAX_BONES = 4;   // measured — all 52 skins in 5,037 glTF models use JOINTS_0 only
interface BoneWeight { node: string; weight: number }
interface BonePose { rest: Mat2D; posed: Mat2D; weight: number }
function boneWeightsError(weights: unknown): string | null;
function skinnedPoint(point: { x; y }, bones: readonly BonePose[]): { x; y };
// A control point names its bones (schema 58). SKINNING PRODUCES A MESH, so the warp, the path
// conversion, hit testing and all three backends need no knowledge that a skeleton exists — which
// is also why a skinned limb is clickable where it is drawn. Out through the node's REST matrix and
// back through its POSED one, so a point bound to a bone that moved exactly as its node did stays
// put. A bone must SHARE the mesh node's parent — enforced in `resolveMeshes` and NOWHERE else,
// so a binding that stops being a sibling goes INERT rather than making the file unopenable.
Mesh.points[i].bones?: BoneWeight[];                          // absent = not skinned
interface BoneMatrices { rest: Mat2D; posed: Mat2D }
function skinMesh(mesh, rest: { box; matrix }, posed: { box; matrix },
                  bone: (id: string) => BoneMatrices | null): ReadonlyMesh;   // by reference if unbound
function copyMeshPoint(p): Mesh["points"][number];            // a mutable copy, BINDINGS INCLUDED
// What an editor does to a binding, in `document/MeshEdit`. Every one returns a WHOLE MESH, which
// `SetMeshAction` already takes — binding a point needed no new action. `boneChoices` is the
// sibling rule walked from the parent's own children, not a restatement of it, so a panel built on
// it cannot offer an illegal bone: an invalid binding is unreachable rather than merely refused.
function boneChoices(doc: ReadonlyDocument, nodeId: string): string[];
function bonesAt(mesh, index): readonly BoneWeight[];        // never undefined — callers just map it
function withBone(mesh, index, node): ReadonlyMesh;          // no-op (BY REFERENCE) if duplicate or full
function withoutBone(mesh, index, node): ReadonlyMesh;       // the LAST one drops the field, not just its contents
function withBoneWeight(mesh, index, node, w): ReadonlyMesh; // clamped at 0; zero mutes, it does not unbind
// Bind EVERY point to the siblings nearest it, weighted by inverse distance to the bone’s JOINT
// (`Rig.jointOffset`, the point IK rotates about). At most two influences and normalised weights
// are MEASURED from 91,290 skinned vertices in the corpus; the falloff is a choice. Replaces.
function autoBindMesh(doc: ReadonlyDocument, nodeId: string): ReadonlyMesh | null;
// ONE DAB of a weight brush. `at[i]` is where point i is DRAWN (posed, from `meshHandles`), so
// the brush covers the handles the author can see. A lerp toward the target, not an addition:
// strokes converge. Others rescaled to keep the point at 1; a full point sheds its smallest.
// BY REFERENCE when nothing was covered — this runs on every pointer move of a drag.
function paintWeights(mesh, at, brush: { x; y; radius }, bone, strength): ReadonlyMesh;
const PAINT_STRENGTH = 0.35;   // the tool’s default, applied by the CALLER, not inside
// The control point the inspector is editing. VALIDATED ON READ rather than cleared on write — a
// pick goes stale four ways (another node selected, the node deleted, the warp turned off, a
// coarser grid), and asking here means no site can forget.
function pickedMeshPoint(es, doc): { nodeId: string; index: number } | null;
// The mask an edit to `nodeId` must respect, or null when it may touch every pixel — the ONE door
// every consumer reads a pixel selection through, validated on read for the same four reasons
// `pickedMeshPoint` is: another node selected, the node deleted, the surface gone, or RESIZED. The
// size check is the one that matters: a mask from before a resize would clip to a sheared ghost. An
// empty mask answers null, because "nothing selected" has to mean "no constraint" in exactly one
// place — see `selectionClip`.
function pixelMaskFor(es, doc, nodeId: string): SelectionMask | null;
// Handles for a mesh a rig has MOVED. `posed` is the resolved scene; without it the handles are
// drawn at the rest pose while the ink is elsewhere. The picker takes it for the same reason —
// this module exists so picking cannot drift from drawing.
function meshHandles(doc, state, selectedNodeIds, posed?): SelectionHandle[];
function meshHandleAtPoint(doc, state, selected, x, y, zoom, posed?): SelectionHandle | null;
// The stored fraction that puts a control point UNDER a world point — the INVERSE of the map the
// overlay draws with, probed three times because it is exactly affine. Null when degenerate.
function meshPointFromWorld(doc, state, nodeId, mesh, index, worldX, worldY, posed?): { x, y } | null;
// CLIPPING (schema 59). A container cuts its children to its own box, radius included — measured:
// of 5,279 SVGs in the corpus, ZERO use <mask> and every one of the 72 clip paths is a plain rect.
// BLENDING (schema 60). Three modes, measured: 65 of 5,279 corpus SVGs blend and name only these.
// Absent IS normal. The names match CSS and Canvas exactly, so nothing translates anywhere.
const BLEND_MODES = ["multiply", "screen", "overlay"];
// THE EYEDROPPER, in `core/geometry/Eyedropper` — asks the DOCUMENT, not the framebuffer: the
// SVG backend has no pixels, and the other two would answer with whatever the zoom resampled.
// Exact for a fill, a token, a gradient (sampled at the point) and a painted texel. Null for a
// miss, `fill: "none"`, a transparent pixel and a `core.image`. Reports the SHAPE’S colour, not
// the composited pixel — over a blended or faded shape those differ, and that is a decision.
function pickColorAt(doc, state, x, y): string | null;
function rampT(gradient, gx, gy): number;   // the same rule the GPU states in GLSL
Style.blendMode?: BlendMode;      Paint.blendMode: BlendMode | null;   // null on all chrome
function blendModeError(mode: unknown): string | null;
// All three backends. The GPU renders a blended frame into a TARGET so the backdrop is readable,
// then `blendTargets` combines scratch over backdrop — fixed-function cannot branch on the
// destination, which overlay needs. Verified pixel-identical across the three.
function blendTargets(gl, blur, backdrop, source, mode): void;
// A TILEMAP (schema 61), in `document/Tilemap` — a grid of indices into one sheet, because the
// alternative measured 10,618 nodes and 22ms a frame for one 100x100 map. Only a `core.tilemap`
// may carry one, and it MUST: `AddNodeAction` gives it the empty default so it can be saved.
Node.tilemap?: Tilemap;
interface Tilemap { cols; rows; tileWidth; tileHeight; sheet: TileSheet; tiles: number[];
                   flips?: number[] }                       // 3 bits a cell (schema 62), or absent
interface TileSheet { columns; tileWidth; tileHeight; spacing; margin }   // sheet PIXELS
function tilemapError(map): string | null;      function tileAt(map, col, row): number;
function flipAt(map, col, row): number;         function flipMatrix(flip, w, h): [a,b,c,d,e,f];
function tileSourceRect(sheet, index): Rect | null;   // the ONE slicing rule; TiledMap delegates
function visibleCells(map, localRect): { col0; row0; col1; row1 } | null;   // inclusive, clamped
// The SINGLE-POINT twin of `visibleCells`, beside it so the two cannot round differently — a
// renderer culling by one rule while a tool picks by another paints the neighbouring cell along
// every boundary. FLOOR, so a cell owns [n*size, (n+1)*size).
function cellAt(map, localX, localY): { col; row } | null;
// The SAME floor WITHOUT the bounds test, so `col` may be negative or past the last column; null
// only when the tile size is unusable. `cellAt` is DERIVED from it, which is the bargain
// `surfaceToWorld` makes with its corner — two copies of one floor disagree by a cell somewhere,
// and these two are asked the same question one call apart. Wanted only by a RECTANGLE drag, which
// must keep following the pointer past the map's edge and let `rectCells` clamp; told "no cell" it
// would freeze in BOTH axes, so the last column could only be filled by stopping exactly inside it.
// AUTHORED METADATA (schema 64) — carried, never read. Any node may hold both.
interface UserProperty { type: string; propertyType?: string; value: string }   // value is TEXT
type UserData = Record<string, UserProperty>;                                   // by NAME, not a list
function userDataError(data: unknown): string | null;      // <= 64 entries, names not reserved, values text
function classNameError(className: unknown): string | null;
// The reader's side: a DEPTH-AWARE scan, because the flat one matched a CLASS property's nested
// members as siblings of the object's own — a member named `friction` overwrote the real one and
// was written back out as a property nobody wrote. A file silently restructured, not a word lost.
function parseProperties(body: string): { props: TiledProperty[]; unread: string[] };
// The GATE. Import runs inside a TransactionAction, which THROWS on a failed component action — so
// a map that trips `userDataError` does not drop one property, it aborts the whole file. This can
// only emit what the validator accepts, and reports every skip. Last wins on a duplicate name.
function userDataFor(props: readonly TiledProperty[]): { data: UserData; unread: string[] };

// THE VIEWPORT PAIR. `screen = z*world - vp`, and both directions are written down so the
// relationship can be CHECKED — a round trip over a zoom sweep is the oracle neither had alone.
function screenToWorld(vp, canvasRect, clientX, clientY): { x; y };
function worldToScreen(vp, canvasRect, worldX, worldY): { x; y };   // same 0.01 zoom floor
// A navigation holds the world point under the screen CENTRE on a straight line, which is why the
// SIZE is required: you cannot interpolate two viewports without saying which point stays still.
// Interpolating the offsets linearly under a geometric zoom (what this did until 2026-08-10) swings
// that point out and back by the arithmetic-over-geometric mean — 430px at world x=5000 on an 800px
// canvas, 1,721px at x=20,000, 12,098px for a 1->10 zoom, and exactly 0 at the origin, which is
// where the fixture sat. A zero size degrades to holding the screen ORIGIN: bounded, not exact.
function lerpViewport(a, b, t, size: { width; height }): viewport;

// A `.unitypackage` (`core/import/UnityPackage`) — gzip + tar, one GUID folder per asset holding
// `asset`, `asset.meta` and `pathname`. DECOMPRESSION IS INJECTED, as TiledMap and Aseprite inject
// theirs. The tar header's CHECKSUM is verified, because a bad size field is read as an entry of
// arbitrary length and everything after it lands at the wrong offset — a corrupt archive becomes a
// very strange package rather than a reported one.
interface UnityAsset { path: string; guid: string; bytes: Uint8Array }
function unityPackageError(bytes: Uint8Array): string | null;   // gzip magic, BEFORE expanding
function parseUnityPackage(bytes, opts?: { gunzip? }): { assets: UnityAsset[]; folders: string[]; notes: string[] };
// REACHED FROM THE FOLDERS DRAWER via `read-unity-folder` + `read-unity-package` (confined to
// the picked folder) and a `gunzip-sync` channel — a SIBLING of `inflate-sync`, not a widening:
// a package is gzip, whose header `zlib.inflateSync` will not accept, and widening the inflate
// channel would make its name a lie about what came through it.
// Verified on all 7 packages here: 523 files, 27.7 MB, zero notes. It does NOT read `.meta` sprite
// rects (every sprite in this tree is spriteMode 0 with none) or prefabs (binary type-trees).

// REPRODUCIBLE RANDOMNESS (`core/random/Rng`). `Math.random` appears in this repo ONLY inside
// comments forbidding it: a generated map that changes when reopened is not a document.
interface Rng { next(): number; int(bound: number): number }   // next() is [0,1), never 1
function rngFrom(seed: number): Rng;      // mulberry32; seed 0 is a real seed
function seedFrom(text: string): number;  // FNV-1a, so an author's SEED can be a word
// The port is checked against the same arithmetic in BigInt with every 32-bit wrap done by hand —
// a reference sharing no operator with it. `^` yields a SIGNED 32-bit number, so a port missing one
// `>>> 0` gives negative draws half the time and every consumer keeps working.

// A CAVE, as the question a grid answers (`core/document/CaveTerrain`). Writes terrain, not tiles.
interface CaveOptions { fill?: number; passes?: number; margin?: number; connect?: boolean }
function caveCells(cols, rows, material, rng: Rng, options?): { cells: number[]; floor: number; regions: number };
// fill 0.45 sits between two COMPUTABLE thresholds: ~0.407 (site percolation — below it the raw
// noise already percolates and you get one room) and ~0.50 (where the rule is self-dual and the
// floor shatters). passes is a COUNT and never a convergence test: the rule is a symmetric
// threshold network, so orbits have period 1 or 2, and 11 of 400 seeds cycle forever. margin is 2
// because of the DUAL GRID, not because of caves — the outermost display ring has three of its four
// corners off the terrain and can never read as full rock.

function cellCoordAt(map, x, y): { col; row } | null;

// MULTI-MATERIAL TERRAIN (schema 65). A layer holds a LIST of materials IN PAINT ORDER, not one.
interface TerrainMaterial { id: number; name?: string; color?: string; art: {mask;index}[] }  // id >= 1
// `name` and `color` are LABELS (schema 66) — nothing derives from them, which is why they are easy
// to drop. `copyTerrainMaterial` is the one place a material is copied — and every path that rebuilds
// the list is now INSIDE this module, which is the part that had to change: the copier cannot protect
// a list a stranger assembled, and for two commits the panel assembled one.
// `color` is #rgb or #rrggbb (every wangcolor measured is #rrggbb). TERRAIN_NAME_MAX = 60.
// The order IS the rule: a display cell sits on four terrain corners and they can belong to two
// different materials — a shore is exactly that cell — and one cell shows ONE tile, so something has
// to win. Later draws over earlier: no extra field, already understood from layers, and reorderable
// without touching a painted cell. `sameTerrain` therefore compares the list POSITION BY POSITION,
// or the one edit that redraws every shore would be refused as a no-op.
function autotileLayers(terrain, materials): AutotileResult;   // composites; a material draws only
                                                               // where its mask is non-zero
function withTerrainMaterials(map, materials): Tilemap | null;  // the whole list, stated by a caller
// THE THREE LIST-SHAPING EDITS TAKE A MAP, NOT A LIST, and that is the contract rather than a
// convenience. A caller who assembles the list is a caller who can drop a field from it, and that is
// precisely what the panel did: three `{ id: x.id, art: [...] }` expressions, each silently losing
// `name` and `color`. `copyTerrainMaterial` could not help — `withTerrainMaterials` already applies
// it to every entry, so it guards against THAT function dropping a field, not against being handed
// entries already stripped. These derive the list from `map.terrain.materials` instead, so nothing
// outside the module ever rebuilds a material.
function reorderTerrainMaterial(map, id, delta): Tilemap | null;   // off either end is REFUSED, not clamped
function removeTerrainMaterial(map, id): Tilemap | null;           // the last one is refused by the empty-list rule
function addTerrainMaterial(map): { map: Tilemap; id: number } | null;
// The id comes BACK because the caller needs it — a panel that adds a material selects it, and one
// left to guess "the count plus one" adopts the cells a removed material left behind.
function withTerrainArt(map, mask, index, material?): Tilemap | null;   // defaults to the first
const TERRAIN_MATERIALS_MAX = 16;
// REMOVING A MATERIAL LEAVES ITS CELLS ALONE, holding an id nothing draws. The cells are what the
// author MEANT; rewriting them to 0 would destroy the shape of a region on the way to changing how
// it looks. It draws as nothing until a material claims that id again, which is recoverable.
// EDITING one (`document/TilemapEdit`). Pure, whole-map in and out, and NULL MEANS NOTHING CHANGED
// in every one of them — an action that succeeded without changing anything puts an undo step on the
// stack that undoes nothing, which reads as undo being ignored.
interface TileEdit { col; row; index; flip? }   // flip omitted = leave the cell's orientation alone
function withTiles(map, edits: readonly TileEdit[]): Tilemap | null;   // off-grid edits DROPPED, not refused
// TERRAIN EDITS (schema 63). `withTiles` REFUSES an autotiled layer: its grid is derived, so a
// stroke would write a picture the derivation overrules — and the rebuild would drop the terrain
// on the way past, un-autotiling a layer with one click.
interface TerrainEdit { col: number; row: number; material: number }   // 0 is the eraser
function withTerrain(map, edits: readonly TerrainEdit[]): Tilemap | null;
function withTerrainArt(map, mask: number, index: number): Tilemap | null;   // one CLASS at a time
// One-way and deliberate: it throws the tiles away, because a stored grid and a derived one are
// two pictures that can disagree. Never something a brush stroke does.
function asTerrain(map, material: number, art): Tilemap | null;
// Which TERRAIN cell a point falls in, given the RESOLVED node's own space — the inverse of the
// dual grid's half-cell offset. Every consumer reads geometry from `computeGeometry`, which
// resolves internally, so a tool is answered in the DISPLAY grid and terrain lives in the other.
function terrainCellAt(map, localX: number, localY: number): { col: number; row: number } | null;
// Its unbounded twin, for the same caller and the same reason as `cellCoordAt`; `terrainCellAt` is
// derived from it so the half-cell offset exists ONCE. That offset already went wrong the one time
// it was written twice, in a tool.
function terrainCoordAt(map, localX: number, localY: number): { col: number; row: number } | null;
function rectCells(map, a, b): { col; row }[];                         // either corner first, clamped
function fillRegion(map, col, row): { col; row }[];                    // FOUR-connected, matches on index alone
// An independent copy, taken through the same rebuild every edit here uses so it cannot forget a
// field a hand-written clone would (terrain was added to this module AFTER that rebuild existed).
// What wants one: a gesture holding the map as it was BEFORE the gesture — the rectangle drag.
function copyTilemap(map: ReadonlyTilemap): Tilemap;
function resizeTilemap(map, cols, rows): Tilemap | null;               // keeps cells by COORDINATE
// `withTiles` and `resizeTilemap` are the ONLY places `flips` is built, and both drop the array when
// nothing is turned — the absent-when-unturned invariant on `Tilemap.flips` would otherwise last
// exactly one edit, and every file saved after would carry a zero per cell.
// TILESETS (`document/Tileset`, schema 67) — a tileset is the DOCUMENT's, so any number of layers
// may name one. It replaced a slicing rule stapled to one image on one node, which cost a measured
// 2.5x image duplication, made a COLLECTION set (1,207 per-tile images in the corpus)
// unrepresentable, and left per-tile data with no home.
interface TilesetTile { id: number; src?; width?; height?; probability?; userData? }  // SPARSE
interface Tileset { id: string; name: string; src: string | null; sheet: TileSheet | null;
                    tiles: TilesetTile[]; offsetX: number; offsetY: number }
const TILESETS_MAX = 256;  TILESET_TILES_MAX = 65_536;  TILESET_NAME_MAX = 120;
// EITHER SHEET-BACKED OR A COLLECTION, never both (two answers to "where does tile 7 come from")
// and never neither (a tileset that can draw nothing is a name). `probability` is NOT normalised,
// because Tiled does not normalise it either and rescaling would break a round trip.
function tilesetError(set: unknown): string | null;              // shared load + edit
function tilesetsError(sets: unknown): string | null;            // the table: cap + unique ids
// NULL RATHER THAN A THROW: a reference that stops resolving is INERT, so deleting a set a layer
// still names leaves an empty grid somebody can re-point, not a file that will not open.
function findTileset<T extends { id: string }>(sets: readonly T[] | undefined, id: string | undefined): T | null;
function tilesetTile<T extends { id: number }>(set: { tiles: readonly T[] } | null, id: number): T | null;
// WHERE a collection tile is drawn for one cell — the per-tile answer to `tileSourceRect`, and the
// ONE statement of the anchoring, shared by the SVG and Canvas backends. BOTTOM-LEFT of the cell,
// so art taller than the grid hangs ABOVE the square it occupies (which is what `<tileoffset>` is
// for); top-aligning is the same picture sunk through the floor. `<tileoffset>` is NOT applied
// here — the importer folds it into the node's own position for a grid layer.
function collectionTileBox(pictures, map, col, row, originX, originY):
    { href: string; x: number; y: number; width: number; height: number; flip: number } | null;
function copyTileset(t: Tileset): Tileset;                       // the ONE place a set is copied
// A WEIGHT OF 1 STORES NO RECORD, because 1 is what an unmentioned tile already means — and a tile
// left with nothing else to say drops out of `tiles` entirely.
function withTileWeight(set: Tileset, id: number, weight: number): TilesetTile[];
// AUTOTILING (`document/Autotile`) — terrain in, tiles out. STORED as `Tilemap.terrain` since
// schema 63; a layer that has it holds no tiles at all, because the picture is derived.
const AUTOTILE_MASKS = 16;   CORNER_TL = 1  CORNER_TR = 2  CORNER_BL = 4  CORNER_BR = 8
interface Terrain { cols; rows; cells: readonly number[] }        // one MATERIAL id per cell, 0 = none
interface AutotileCell { index: number; flip?: number }
// A LIST PER MASK, not one tile: the measured sets ship 185 tiles for 74 corner configurations,
// because an artist draws several tiles for one neighbourhood so the ground does not repeat.
type AutotileTable = readonly (readonly AutotileCell[] | null)[]; // 16 entries, indexed BY MASK
function autotileTableError(table: unknown): string | null;
function flipMask(flip: number, mask: number): number;            // ties the two conventions together
function autotileClasses(): number[];                             // the six orbits, DERIVED not listed
// TWO PASSES: an EXACT entry is authoritative, and only then are gaps filled by TURNING a drawn
// tile — by ASCENDING mask, so the table is a function of the art and not of its array order.
// The single pass this replaced let the first entry of an orbit claim the whole orbit: art for
// all sixteen masks kept SIX, and which six depended on how the document happened to store it.
// Sixteen entries have been schema-legal since terrain landed; only the expander refused them.
function rotatedTable(art: readonly { mask: number; index: number }[]): AutotileTable;  // 6 -> 16
function dualMask(terrain, material, col, row): number;
// HOW A CELL CHOOSES among the tiles that all satisfy its mask. Weights are INJECTED, because this
// module knows masks and the TILESET knows what a tile weighs; `resolveTilemaps` holds both and
// supplies them only when a set actually says something, so an existing document derives
// byte-identically. Deterministic: seeded by the cell's own position AND the material, or a
// derived picture would shimmer as you pan. Weight 0 EXCLUDES; all-zero falls back to the first.
interface AutotileChoice { weightOf?: (index: number) => number; seed?: number }
function autotile(terrain, material, table, opts?: AutotileChoice): AutotileResult;
function autotileLayers(terrain, materials, opts?: AutotileChoice): AutotileResult;  // paint order
interface AutotileResult { cols; rows; tiles: number[]; flips?: number[] }
```

**THE DUAL GRID IS THE CHEAP SCHEME.** Put the display grid half a cell off the terrain grid and every
display tile sits over the corner where four terrain cells meet: four cells, two states each, is
**16 tiles** against the **47** a blob set needs when a tile is chosen from its own cell's eight
neighbours. Both describe the same silhouettes. The display grid is therefore **one larger in each
direction** and offset by half a cell (`x - tileWidth/2`), because terrain cell `(cols-1, rows-1)`
needs a tile past its right and bottom edges to be drawn at all. `autotile` returns its own
dimensions rather than letting a caller derive them.

**AND SIX TILES WITH ROTATION.** The 16 masks fall into six classes under the symmetries of a square
— empty, one corner, two adjacent, two diagonal, three corners, full — so `rotatedTable` fills all
sixteen entries from six drawings, using the `flips` every backend already honours. The classes are
found by orbiting each mask under all eight flips, not written down: a hand-typed list of six numbers
is six chances to name a mask that is really in another class.

**`flipMask` is where two conventions are tied together**, and the only place they are. It transposes
FIRST and then mirrors, exactly as `flipMatrix` does, because that order is not commutative. A
disagreement here produces a table that is plausible and wrong — every mask has an entry, every entry
names a real tile, and the map comes out with its corners pointing the wrong ways. The test is
geometric rather than a second transcription: each corner's position inside the tile is pushed through
the matrix the backends draw with, and must land on the corner `flipMask` claims.

**MEASURED, AND THE CORPUS CANNOT VALIDATE A TABLE.** There is no terrain data in `freeassets` at all
— not one `<wangset>`, not one `<terrain>`, across 20 `.tmx` and 14 `.tsx`. Asking whether the maps
were nevertheless drawn *as if* autotiled — is each layer a function of some neighbourhood mask? —
gives **0.69** for the dual grid, 0.70 for edges and 0.72 for blob over 22,198 cells, and the layers
that score highest do so for a reason that is not autotiling: they use **four of the sixteen masks**,
so "the commonest tile for this mask" is just "the commonest tile". One layer puts 166 distinct tiles
in 1,650 cells. **So inferring terrain from an imported map is not a feature to build** — it cannot
work on this art — and the tables here are exercised by CONSTRUCTED fixtures, which is a weaker claim
than "it matches the corpus" and is said as such.

**ONE MATERIAL PER LAYER**, since a cell holds one tile: a map of grass and water is two tilemap
nodes, the same shape the importer already produces.

```ts
// FILLING THE GAPS BETWEEN POINTER SAMPLES IS THE TOOL'S JOB, not the document's: a tile grid is an
// integer grid, so the tile tool walks `PixelBuffer.linePoints` — the same Bresenham the pixel brush
// uses — rather than a second one that could disagree with it by a cell at some angles.
// THE SHEET'S PIXEL SIZE IS NOT DERIVED, and `sheetWidth`/`sheetHeight` are gone because they were.
// `sheetHeight` took the row count from the HIGHEST INDEX THE MAP USED, so a real 968x526 sheet
// whose map reached row 18 was called 305 tall: SVG places its inner `<image>` at that size so its
// viewBox measures source pixels, and the GPU divides by it, so both drew the whole map from the
// wrong rows 1.7x too far down. Canvas was right throughout — `drawImage` takes the bitmap and never
// asks — so the two wrong backends were wrong the SAME way and comparing them would have called it
// agreement. Both now read `naturalSize(href)` from the one cache all three share, and an undecoded
// sheet draws NOTHING rather than a guess. Found by importing a real map beside the node-per-cell
// import of the same file; a derived value that must equal a fact about a file is an assumption.
// A world rect in a node's LOCAL space. In the geometry engine because the render model may not
// compose coordinates — it needed this to cull a grid, and asking is allowed where deriving is not.
function localVisibleRect(state, nodeId, world: Rect): Rect | null;
Node.clipsContent?: boolean;
ComputedNode.clips?: readonly string[];   // clipping ANCESTORS, outermost first — a frame is not
                                          // in its own chain, so its own ink is never cut
interface ClipRegion { width; height; radius; world: Mat2D }   // box + matrix, so a ROTATED frame
                                                               // is still exactly a rounded rect
OpacityGroup.clip?: ClipRegion;           // a clip is a LAYER, sequenced by `layerTransition`
// The rest pose is this chain without `applyFrame` and without `applyIk` — the only two steps that
// move anything. A THUNK, so an unrigged document never builds it and a rigged one builds it once.
function resolveMeshes(doc: ReadonlyDocument, restOf?: () => ReadonlyDocument): ReadonlyDocument;
// The one composition rule for a node's local matrix, in `geometry/Matrix` because the document
// layer needs the same answer the geometry engine does. There were three copies before skinning.
function localMatrix(geo: Rect, t: Transform | undefined): Mat2D;
// All three backends implement it: SVG nests `<g opacity>`, Canvas opens an offscreen canvas per
// run, the GPU pushes a render target per nesting depth and fades it back through the composite
// shader's `u_fade`. They are pixel-identical on a translucent group, a group whose child has a
// shadow, nested groups, and a group followed by a sibling.

function buildRenderModel(
  size: { width: number; height: number },
  doc: ReadonlyDocument, state: RendererState, prev?: DisplayList | null
): DisplayList;                                          // pure, deterministic
function emitSVG(container: HTMLElement, model: DisplayList): void;   // SVG DOM transcription
function emitCanvas(ctx: CanvasRenderingContext2D, model: DisplayList, dpr?: number, into?: CanvasTarget): void; // Canvas 2D transcription
interface CanvasTarget {          // where, and on what, to transcribe — omitted = the whole canvas on the editor background
    x: number; y: number;         // destination offset in DEVICE px; `emitCanvas` sets the CTM absolutely, so a caller's own ctx.translate cannot survive it
    background: string | null;    // null = leave the destination TRANSPARENT (a sprite needs alpha; the editor backdrop does not belong in a texture)
}
function setImageReadyCallback(cb: (() => void) | null): void;       // fired when a lazily-loaded image decodes (→ repaint)
// TextRaster.ts — laying text out ONCE, for every backend that can measure.
type TextShape = Extract<Shape, { kind: "text" }>;
function drawTextInto(ctx, shape: TextShape, paint: Paint): void;   // wraps + aligns + clips; leaves ctx clipped
function wrapText(ctx, text, maxWidth): string[];                   // greedy, CSS-`normal`; first word of a line always fits
function wrapTextWith(measure: (t) => number, text, maxWidth): string[];   // the same, against any measurer
function textLinesFor(shape: TextShape): string[] | null;           // DOM-backed; null with no canvas to measure with
function textRasterScale(viewScale: number): number;                // QUANTISED to powers of two, bounded [1, 8]
function textRasterKey(shape, paint, scale): string;                // every field that changes the PIXELS; NUL-separated
const TEXT_RASTER_MIN: number; const TEXT_RASTER_MAX: number;
// The GPU has NO glyph atlas on purpose: an atlas is a second typesetter with its own wrapping,
// drifting from Canvas in ways only a screenshot would catch. Rasterising through `drawTextInto`
// means the GPU shows what Canvas shows because it IS Canvas, drawn once offscreen and uploaded.
// The key omits POSITION — the raster is drawn in local coordinates and placed by the geometry,
// so moving a text node must not throw its bitmap away. The scale is quantised for the same
// reason `displayTolerance` is: an exact-zoom key rebuilds the bitmap on every wheel tick.

// ImageCache.ts — decoded bitmaps, shared by every backend that draws one.
function resolveImage(href: string): HTMLImageElement | null;        // null while it loads / fails / no DOM
function imageGeneration(): number;                                  // bumps on each DECODE — a texture's cue to re-upload
// ONE cache for all backends: switching Canvas↔WebGL from the toolbar must not re-download the
// document. A failed load is remembered and never retried. `imageGeneration` exists for the GPU
// alone — Canvas hands `drawImage` a live element, while a texture is a COPY that would either
// be re-encoded every frame or keep forever the blank bitmap from before the load finished.
function renderSVG(container: HTMLElement, doc: ReadonlyDocument, state: RendererState): void;    // buildRenderModel ∘ emitSVG
function renderCanvas(container: HTMLElement, doc: ReadonlyDocument, state: RendererState, onAsyncReady?: () => void): void; // ∘ emitCanvas (sizes a <canvas> for the DPR; onAsyncReady repaints on image load)
function clearRenderState(container: HTMLElement): void;             // drop the container's cached prev frame (call when its DOM is cleared)
function emitWebGL(canvas: HTMLCanvasElement, list: DisplayList, vp: {x: number; y: number; zoom: number}, dpr?: number): boolean; // GPU transcription; false = unavailable
interface GLState { gl; program; buffer; normalBuffer; posLoc; normalLoc; viewLoc; colorLoc; zLoc; ambientLoc; lightCountLoc; lightDirLoc; lightColorLoc }
function initGL(canvas: HTMLCanvasElement): GLState | null;                          // program + buffer, or null when WebGL is refused
function parseColor(css: string): [number, number, number, number] | null;           // #rgb / #rrggbb / #rrggbbaa only; null = do not draw
function shapeToLocalCommands(shape: Shape, radius: number | null): PathCommand[] | null;   // LOCAL, so a stroke offsets in the units its width means
interface Draw { vertices: number[]; normals: number[]; locals: number[]; height: HeightTexture | null;
                 image: { href; x; y; width; height } | null; text: TextShape | null;
                 color: [number, number, number, number] }
function itemDraws(item: DrawItem, tolerance?: number): Draw[];   // pure — the tested part; fill then stroke, [] for what it cannot draw
const HEIGHT_TEX_SIZE: number;                                    // 64 — covers the finest grid a mesh may declare
interface HeightTexture { data: Uint8Array; size: number; min: number; max: number }   // RGBA; height is 16 bits over R+G
function heightTexture(mesh, box, size?): HeightTexture | null;   // null = flat: no relief, and no range to pack against
function decodeHeight(rByte, gByte, min, max): number;            // the shader's decode, given a checked definition
// `locals` is each vertex's position in the shape's OWN units — what the FRAGMENT stage marches
// the heightfield from. A position rather than an answer: interpolating a position across a
// triangle is exact, where interpolating occlusion computed at three corners smeared a
// discontinuity into a gradient. Only `lights[0]` casts, the light the drop shadow already
// privileges. SIXTEEN bits because eight quantises a 260-unit relief to a unit, and unit steps in
// the surface become visible steps in the shadow's edge.
function itemTolerance(item: DrawItem, viewScale: number): number;                   // how finely to cut THIS item's curves
function setLighting(gl, state, lights, ambient): void;                              // once per frame; unlit ⇒ ambient 1, no lights
// `normals` is one vector per VERTEX (`vertices.length / 2 * 3`), NOT unit — see `surfaceNormal`.
// The raw length is what survives the GPU's linear interpolation, and the FRAGMENT shader
// normalises what arrives. A collapsed cell's zero normal is replaced with (0,0,1) here rather
// than in `surfaceNormal`, because normalising zero in a shader is NaN, which is a hole.
// A shape carrying a `surface` also has its triangles SUBDIVIDED (`subdivideTriangles`) to one
// mesh cell: a value sampled per vertex can only vary where there are vertices, and ear clipping
// puts them only on the outline — which is why a dome first came out flat.
// `emitWebGL` derives the tolerance PER ITEM from `vp.zoom * dpr` and the item's own matrix. This
// backend is the only one that needed it: SVG and Canvas hand outlines to a rasterizer that knows
// the resolution, while a GPU has to be told how many vertices to take.
function viewMatrix(width: number, height: number, vpX: number, vpY: number, zoom: number): number[];             // world → clip, column-major 3x3
function renderWebGL(container: HTMLElement, doc: ReadonlyDocument, state: RendererState, onAsyncReady?: () => void): void; // ∘ emitWebGL, falls back to renderCanvas
// AND THE FALLBACK SAYS SO (2026-08-09). It was silent, and that hid a dead GPU backend for months:
// the fragment shader declared an identifier named `packed` — a RESERVED WORD in GLSL ES 1.00 — so
// `initGL` returned null and every frame went to Canvas while the menu, the backend stamp and the
// picture all looked right. The reason is now recorded in three places: `lastGLFailure()`, a
// `data-vde-gl-fallback` attribute on the container (`GL_FALLBACK_ATTR`, which App reads and shows in
// the toolbar), and a console warning, once per distinct reason.
const GL_FALLBACK_ATTR = "vdeGlFallback";
function lastGLFailure(): string | null;              // why the last initGL answered null
function readableGLLog(log: string | null): string;   // a driver's log fit for one line of UI (ANGLE NUL-terminates)
// Every shader the backend compiles, EXPORTED so a test can read the source: a shader is the only
// code here nothing in the gate compiles — tsc, esbuild and jest all see a string, and the first
// reader that knows the language is a driver on somebody's machine.
const GLSL_SOURCES: readonly { name: string; source: string }[];
type RenderBackend = "svg" | "canvas" | "webgl";
function renderScene(container: HTMLElement, doc: ReadonlyDocument, state: RendererState, backend: RenderBackend, onAsyncReady?: () => void): void; // the live backend selector
```

- Pure read of `(doc, state)`; no dispatcher reference, cannot write.
- `buildRenderModel` reads **all positions from `state.computed`** (world/local/bounds)
  and never composes coordinates — enforced by importing only the `Mat2D` *type*. `doc`
  supplies only type/style/text/src.
- `renderScene(container, doc, state, backend)` is the app entry point: it dispatches to
  `renderSVG`, `renderCanvas` or `renderWebGL`, and on a backend switch clears the container (removing the
  other backend's element) + drops the SVG grid cache (`clearRenderState`). `renderSVG`
  measures the container and threads the previous `DisplayList` (so an unchanged grid reuses
  its lines by reference); `renderCanvas` sizes a `<canvas>` for the device pixel ratio (model
  in CSS px, backing store in device px, DPR passed to `emitCanvas`).
- **The GPU backend is a PREVIEW, and says so.** `emitWebGL` is the third transcriber over the
  same `DisplayList`, but it is the first that cannot draw everything: a GPU takes triangles, so
  every filled shape goes through `shapeToWorldRings` → `triangulate` first, and the things that
  need a texture or an offset curve are not drawn at all. The gaps are DELIBERATE and listed in
  the module header — no text, no images, strokes only for `line` shapes, no effects or dashes.
  A backend that quietly drops content is worse than one that admits what it cannot do, so the
  toolbar labels it a preview. `renderWebGL` FALLS BACK to `renderCanvas` when a context cannot
  be had (old GPU, headless run, driver refusal); a renderer that shows nothing cannot be
  diagnosed by a user. The pure half (`itemTriangles`, `parseColor`, `viewMatrix`,
  `shapeToWorldRings`) is unit-tested in the `node` env like every other piece of geometry;
  the buffer uploads and draw calls are the untested DOM boundary, browser-smoke-verified.
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
  // ONE channel for every menu entry, carrying a command string ("file.save", "edit.undo",
  // "view.backend.canvas"...). It replaced a channel per item, which meant main, preload and
  // App.tsx all had to change to add one line to a menu. An unrecognised command is IGNORED:
  // the menu lives in the main process and the renderer is a separate build, so a newer menu
  // meeting an older renderer is a real state and must degrade to a dead click, not a crash.
  onMenuCommand(cb: (command: string) => void): () => void;   // returns disposer
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


## Runtime (`core/runtime/`)

The game runtime's mutable half (M18 slice 1). Pure and testable without a DOM or a clock; the clock
lives with the caller, because only the caller has one.

```ts
const FIXED_STEP: number;              // 1/60s. A fixed step, never the frame's own delta:
                                       // integrating a variable delta makes a jump height depend on
                                       // the frame rate, and makes a replay impossible.
const MAX_STEPS_PER_FRAME: number;     // 5 — the spiral guard. A backgrounded tab would otherwise
                                       // ask for 600 steps at once on the frame that resumes.
const DEFAULT_GRAVITY: number;         // 900 px/s². Positive is DOWN; y grows downward here.

// Body coordinates are WORLD space (slice 6 composes ancestor translations; applyWorld writes back
// through them). `groundFriction` is carried one step behind on purpose - see slice 4.
interface Body { x; y; vx; vy; onGround: boolean; groundFriction: number }
// `overlaps` and `contacts` are what make enter/leave and contact/separate EDGES rather than states;
// `jumpWas` is what makes a held jump key one jump. All three are carried, none are serialized.
interface WorldState {
    bodies: ReadonlyMap<string, Body>; time: number; jumpWas: boolean; jumpCut: boolean;
    overlaps: ReadonlySet<string>; contacts: ReadonlySet<string>; events: readonly WorldEvent[];
}
// A surface's Coulomb coefficient: 0 is ice, 1 decelerates a body at exactly one gravity. It is the
// GROUND's property — 44 of the corpus's 45 `friction` values sit on static objects — and it
// defaults to 1 because that is what 44 of them say. `floating` (24, all static) and `density` (1)
// are measured and deliberately NOT implemented.
// `oneWay` is solid only from ABOVE and only to a body that was above it when the step began — a
// platform you jump up through. It is the runtime's first INVENTION rather than a reading of the
// corpus, which declares nothing about them; it is a new VALUE on `bodyType` rather than a new
// field, because an unknown word is already not a body.
interface Solid { x; y; width; height; friction: number; oneWay: boolean }
function frictionOf(node: { userData?: UserData }): number;

// A REGION is a classed node that is NOT a body — the split the corpus already makes (26 classed
// non-bodies against 51 bodies with no class, and none carrying both). Zero-area is skipped, because
// `player-start` is a real POINT and a position is not a volume.
interface Region { nodeId: string; className: string; x; y; width; height }
interface WorldEvent { kind: "enter" | "leave" | "contact" | "separate";
    bodyId: string; nodeId: string; className: string; side?: ContactSide }
function regionsOf(doc: ReadonlyDocument): Region[];

// EVERYTHING ABOVE IS WORLD SPACE, and a node's `geometry` is its PARENT's — the runtime read one as
// the other and collided a nested floor fifty pixels above its own art. Ancestor TRANSLATIONS are
// summed (exact, and a frame is a position); a rotated or scaled ancestor, an auto-layout container,
// a missing parent or a cycle is REFUSED rather than approximated, because half-composing puts the
// art in one place and its collision in another.
function worldOffsetOf(doc, nodeId): { dx: number; dy: number } | null;
function runtimeRefusal(doc, nodeId): string | null;
function runtimeExclusions(doc): { nodeId: string; why: string }[];   // counted, never silent
// THE WORLD REPORTS AND DOES NOT ACT: nothing spawns a maggot, runs `chest-discovered.lua` or loads
// `sandbox2.json`. `WorldState.overlaps` carries the pairs so ENTER and LEAVE are edges rather than
// states — a coin is collected once, not on all sixty frames a player stands in it — and
// `WorldState.events` is what the step that produced it noticed.

// WHAT A BODY IS, measured rather than invented: of 248 objects in the corpus only 24 carry a class,
// and the level's real collision geometry carries NONE — six untyped rectangles whose only property
// is `bodyType=static`, the most-declared property in the tree (51 of 138). Values are read
// LENIENTLY because the same name is declared with two types in one file (`friction` is float 17
// times and untyped 28).
function propertyOf(data: UserData | undefined, name: string): string | null;
function bodyTypeOf(node: { userData?: UserData }): "static" | "dynamic" | "oneway" | null;

function worldFrom(doc: ReadonlyDocument): WorldState;         // dynamic bodies, at rest, where the
                                                               // document puts them
function solidsOf(doc: ReadonlyDocument): Solid[];             // static bodies, read fresh each step

// PER-TILE COLLISION (slice 3). A level is ONE node holding thousands of cells, so a solid per cell
// would build an array of thousands every step; asking which cells a BOX covers turns that into the
// four or six a body can touch, through the same `visibleCells` the renderer culls with. The tile's
// own answer comes from `TilesetTile.userData` — a field that has existed since schema 67, validates
// like a node's, round-trips through import and export, and had NO READER until this.
function tileIsSolid(set: Tileset | null, index: number): boolean;
function tileSolidsNear(doc, box: { x; y; width; height }): Solid[];
function documentHasSolidTiles(doc: ReadonlyDocument): boolean;   // one pass over SETS, never cells
const MAX_FALL_SPEED: number;          // 1200 px/s. A COLLISION bound before it is a feel
                                       // decision: capped, one step's travel is at most 20px, so
                                       // "a solid 20px or deeper is safe" becomes a constant rather
                                       // than a function of how far the body fell.
const MOVE_SPEED: number;              // 220 px/s — the TOP speed a held key builds up to (slice 17;
                                       // it was a speed you simply had, until then)
const SKID_TURN: number;               // 2. How much harder a TURN pushes than a start, and the only
                                       // new magnitude in slice 17 — in the original it is not a
                                       // constant at all but an `asl`/`rol` bit shift that fires
                                       // while facing and moving disagree, so the ratio is exactly
                                       // 2 rather than approximately 2.
function walkAccel(gravity?): number;  // ONE GRAVITY, and no new number: in the original's WALK tier
                                       // the acceleration byte and the release-friction byte are the
                                       // SAME byte, and this runtime's default friction is already
                                       // `mu * g` at `mu = 1`. Takes the STEP's gravity, so a level
                                       // that changes gravity keeps the identity.
function skidAccel(gravity?): number;  // that, doubled
function walkRunup(speed?, gravity?): number;    // DERIVED, not declared — `v^2 / 2a` = 26.89px, the
function skidDistance(speed?, gravity?): number;  // run-up to top speed, and 13.44px, the room a
                                       // full-speed turn costs. These are what a level is drawn
                                       // against (1.49 and 0.75 tiles, against the original's walk
                                       // tier at 1.90 and 0.75 blocks), but they are CONSEQUENCES of
                                       // one gravity and its double rather than knobs beside them.
const JUMP_HEIGHT: number;             // 72 px, stated as a HEIGHT because that is what a level is
                                       // built from; the launch speed is derived from it. It is the
                                       // height of a FULLY HELD jump (slice 16), not of every jump.
const HELD_JUMP_GRAVITY: number;       // 9/25. The fraction of gravity acting on a RISING controlled
                                       // body whose jump key is still down — variable jump height,
                                       // by two gravities rather than a velocity cut. The fraction
                                       // IS the ratio of the shortest jump to the tallest (same v0,
                                       // full g vs f*g), so it is one constant and not two heights:
                                       // a tap clears 25.92px and a hold 72. Measured against the
                                       // original's own acceleration tables, whose simulated
                                       // min/max heights are 0.350 / 0.371 / 0.344.
function jumpSpeedFor(height?, gravity?): number;      // v = sqrt(2*g*h) — the kinematic identity
function jumpLaunchSpeed(gravity?, height?): number;   // what a jump (or a stomp bounce) STARTS at:
                                       // `jumpSpeedFor(height * HELD_JUMP_GRAVITY, gravity)` = 216
                                       // px/s by default. The launch alone carries the SHORTEST
                                       // jump; every pixel above that is bought by holding the key.

interface Input { left: boolean; right: boolean; jump: boolean }
const NO_INPUT: Input;

// `controlled` names the body the input drives, and it comes from the CALLER: nothing in the corpus
// says which object is the player, so the app passes whatever was SELECTED when Play was pressed.
// A jump is an EDGE — `WorldState.jumpWas` is what makes a held key one jump rather than a bounce —
// and it fires only when `onGround`. The LAUNCH is an edge; the HEIGHT is not (slice 16): keeping
// the key down weakens gravity while the body rises, and `WorldState.jumpCut` LATCHES that off on
// the first step the key comes up OR the rise ends, whichever is first. Only a fresh launch reopens
// it, which is what stops fluttering the button from out-jumping an honest hold — and it is also
// why a stomp bounce does not answer the key: a stomp requires falling, so the latch is shut.
function stepWorld(doc, world,
    opts?: { gravity?; solids?; tileSolids?; regions?; input?: Input; controlled?: string | null }): WorldState;

// BODY MEETS BODY (slice 9), and the header of core/runtime/World says at length why this is an
// INVENTION rather than a reading: ONE object in the corpus declares bodyType=dynamic, it lives in a
// template file TiledMap.ts:644 refuses to import, the nearest declared pair sits 654px apart, and
// 24 contact-vocabulary stems (damage, health, bounce, mass, stomp...) are zero across all 65 files.
// It is here because the stated test game needs it, which is a different reason from every slice
// before it except `oneway`.
//
// IT REPORTS AND DOES NOT RESOLVE. Making bodies solid to each other was designed and rejected on
// three concrete failures: a body landing while overlapping a crate is driven INTO the floor by the
// else-branch and ejected the solid's full width next step; the same shove permanently disables a
// one-way platform under slice 7's `was.y + h <= s.y`; and the tunnelling guarantee ("any solid 20px
// or deeper is safe") is a fact about SOLIDS, which the corpus makes 32px+, while two 10px bodies
// give a margin of exactly zero.
//
// `side` says WHERE THE OTHER THING SITS, not which edge was touched - so a stomp is `below`, and
// the pair of events carries opposite sides, which is what tells a stomp from being stomped.
// `inside` is a refusal, in the same posture as runtimeExclusions.
type ContactSide = "above" | "below" | "left" | "right" | "inside";
function sideOf(a: ContactBox, b: ContactBox): ContactSide;   // pure; no document, no clock, no order

// THERE IS NO IMPULSE CHANNEL, and this bounds what an app can ever do with a contact. stepWorld's
// opts carry gravity, solids, tileSolids, regions, input and controlled - not one of them can set a
// body's velocity. An app owning `es.world` and rewriting the Map between frames is a hole, not a
// contract. Acting on an event (killing a stomped enemy, bouncing off it) is the NEXT slice's
// design, and it needs a channel that does not exist yet.

// THE `applyFrame` MOVE: the document with its bodies where the world says they are. A NEW document
// and a new map; nodes that did not move pass through BY REFERENCE, which is what lets the caller
// hand `computeGeometry` a dirty set and reuse everything else (measured 4.5x). Returns the SAME
// document when nothing moved, so an idle run costs nothing downstream.
function applyWorld(doc: ReadonlyDocument, world: WorldState): ReadonlyDocument;
function movedIds(doc: ReadonlyDocument, world: WorldState): Set<string>;

// How many whole steps a wall-clock gap earned, and what is carried. The remainder is KEPT — on a
// 59.94Hz display the leftovers add up to a whole step every few seconds — and a capped frame drops
// its debt rather than owing it back, which is the spiral in instalments.
function stepsFor(accumulator: number, elapsedSeconds: number):
    { steps: number; accumulator: number; dropped: number };
```

### `core/runtime/Camera` (M18 slice 8)

A SEPARATE MODULE FROM `World`, and the separation is the contract: it takes a viewport and gives
back a viewport, and cannot reach the bodies at all. Nothing in the physics may read the camera, or a
level would play differently depending on where you were looking — which is the one thing a fixed
step exists to prevent.

```ts
// Structurally the editor's viewport, re-declared rather than imported: `core` may not depend on the
// editor. The transform is `screen = zoom·world − vp`, the one `screenToWorld` inverts.
interface CameraView { x: number; y: number; zoom: number }

const DEADZONE_FRACTION: number;   // 0.34 — the middle third of the view, inside which the camera
                                   // does NOTHING. Pinning the target to the exact centre moves the
                                   // whole world on every footstep, which reads as the scenery
                                   // walking rather than the character. A CHOICE, like `oneway`: no
                                   // document in the corpus declares a camera.
const CAMERA_SMOOTHING: number;    // 0.18 of the remaining gap per FIXED STEP. 1 is a rigid camera.

// The nearest viewport that puts `target` back inside the deadzone — the current one, unchanged,
// whenever it is already inside. A target BIGGER than its own deadzone is CENTRED rather than
// slammed to whichever edge was tested last.
function cameraDesired(view, size, target, deadzone?): { x: number; y: number };

// SMOOTHING IS PER STEP, NOT PER FRAME: `1 − (1−k)^n`, so a 144Hz monitor and a 60Hz one get the
// same camera per unit of TIME. Closing a fixed fraction per frame is the same class of defect as a
// frame-rate-dependent jump, and far harder to see.
//
// BOUNDS ARE APPLIED AFTER THE SMOOTHING, so the view cannot leave the level part-way through a
// glide; clamping the DESTINATION instead is right only while the camera is already inside, which it
// is not on the first frame of a run begun with the canvas scrolled away. A level smaller than the
// view is CENTRED. Returns the input view unchanged when it cannot answer — no steps elapsed, a
// non-positive zoom, a non-finite target — because a camera that gives up should leave the picture
// where it is rather than jump it somewhere.
function followCamera(view, size, target, bounds: CameraRect | null,
    steps: number, smoothing?, deadzone?): CameraView;
```

**COLLISION IS DISCRETE AND IT TUNNELS**, measured: a solid thinner than one step's travel is passed
straight through — a 2px floor lets a body reach y=11,287. The rule that follows is that a solid must
be at least as deep as the fastest body's travel per step (15px after a second of falling, 20px after
two). Every solid in the measured corpus is 32px and up. A test pins both halves.
