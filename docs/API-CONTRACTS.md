# API Contracts

<!-- describes: src/core/actions, src/core/document, src/core/geometry, src/editor, src/renderer, src/electron/preload.js, scripts/build.js -->

> 🔒 Frozen contract · schema v54 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). The public surface each layer depends on.
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
function exportSVG(doc: ReadonlyDocument, linesOf?: TextLines): string;
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
```

- THE TAGS ARE CLIPS. `{ name, from, to }` is `Clip` field for field (schema 46), so the import is a
  rename. A cel's `x`/`y`/size is the TRIM — the padding never existed in the file.
- PARSING IS PURE, INFLATING IS INJECTED: without a decompressor the structure still parses and cels
  keep their compressed bytes, which is enough for clips, timing and layout.
- The SHORTEST frame duration sets the rate — the only choice that expresses every frame as a whole
  number of ticks, where an average rounds the quick ones away.
- Indexed/greyscale depths, tilemap cels and truncation are NAMED in the error, never half-read.

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
- Gradients flatten to their first stop and every approximation lands in `notes`.
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

**Not read yet:** materials, textures, animations (150 files), skins (26), morph targets, sparse
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
```

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
isometric on a diamond; the cells read identically either way.

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
  pendingGeometry: Map<string, Partial<Geometry>> | null; // move/resize preview, fed INTO computeGeometry
  viewport: { x: number; y: number; zoom: number };
}
function createEditorState(): EditorState;
function clampViewport(vp): void;            // zoom ∈ [0.05, 20]; pan ±10000 WORLD units (scaled by zoom)
// Pure viewport math (node-tested); each mutates vp then re-clamps.
function panBy(vp, dx: number, dy: number): void;                 // SCREEN-px pan (zoom-independent)
function zoomAt(vp, factor: number, cursorX: number, cursorY: number): void; // cursor-anchored zoom
// PROTOTYPE NAVIGATION (schema 36) — pure, and RETURNING a viewport rather than mutating one,
// because a navigation needs both ends to interpolate between.
function viewportToFit(bounds: Rect, size: Size, padding: number, fallbackZoom: number): EditorState["viewport"]; // "zoom to this frame": the tighter axis wins, the rect is centred, the result is CLAMPED; a degenerate rect keeps the current zoom rather than dividing by zero
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

### `renderer/Gaussian` — the blur kernel, as plain numbers

```ts
interface GaussianKernel {
    radius: number;      // taps per side; 0 means no blur
    weights: number[];   // 2*radius+1, symmetric, summing to 1
    clamped: boolean;    // true when the curve was cut at GAUSSIAN_MAX_RADIUS
}
function gaussianKernel(sigma: number): GaussianKernel;   // sigma in DEVICE pixels
function gaussianOuterProduct(kernel: GaussianKernel): number[][];
const GAUSSIAN_MAX_RADIUS: number;      // 64 taps per side
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
interface DisplayList {
  viewport: { x: number; y: number; zoom: number };
  grid: GridModel; content: DrawItem[]; overlay: DrawItem[];
  defs: FilterDef[];            // deduped effect filters (by id); emitSVG builds <defs> from these
  groups: OpacityGroup[];       // schema 32 — the groups `content` items refer to, outermost first
  lights?: readonly Light[]; ambient?: number;   // schema 42 — the DOCUMENT's, not a shape's
}
// `content` is sorted FAR-to-NEAR by `depth` before the tree's own order; equal depths compare
// zero, so a document that never mentions depth draws exactly as it always did.
// Pure, deterministic, INJECTIVE, SVG-id-safe filter id (the twin of commandsToPathData); null = no effect.
function effectFilterId(shadow: Shadow | null, blur: number | null): string | null;

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
