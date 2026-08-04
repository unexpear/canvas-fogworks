# Document Schema

<!-- describes: src/core/document -->

> 🔒 Frozen contract · schema v43 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins). Types are in `src/core/document/`.

## ProjectDocument

The complete, authoritative state of a project (`Document.ts`).

```ts
interface ProjectDocument {
  version: string;                 // = SCHEMA_VERSION on new docs (NEVER the app version)
  metadata: DocumentMetadata;
  nodes: Map<string, Node>;        // UUID → Node, O(1) lookup
  rootNodeUuids: string[];         // top-level nodes, in order
  variables: VariableStore;        // design tokens — LIVE at schema 19 (see VariableStore below)
  activeState?: string;            // the named STATE every node resolves against (M7, schema 30); absent = base
  activeTheme: ThemeMode;          // "light" | "dark" — the mode token resolution reads (schema 19)
}

interface DocumentMetadata {       // runtime shape (date is a live Date)
  project_name: string;
  created_by: string;
  date: Date;
}
```

- `nodes` is the flat repository of **all** nodes (roots and descendants alike).
- The tree is expressed by `rootNodeUuids` + each node's `parent`/`children`, not by nesting.
- New documents are stamped `SCHEMA_VERSION`. `createEmptyDocument()` returns a valid empty document
  (`"Untitled Prototype"`, `created_by: "system"`, empty maps/arrays).

## Node

Every object in `nodes` (`Node.ts`). **Nodes are never mutated directly — only via Actions.**

```ts
const NODE_TYPES = ["core.rectangle", "core.text", "core.image", "core.ellipse", "core.line", "core.path", "core.instance", "core.boolean"] as const;
type NodeType = typeof NODE_TYPES[number];   // derived — one edit adds a type
function isNodeType(v: unknown): v is NodeType;  // membership, checked on BOTH paths
// Stored node ids are constrained on BOTH paths (AddNodeAction + Integrity): not the
// document-delta sentinel, and free of "::" — the separator instance expansion builds
// VIRTUAL ids with, which a stored id must never collide with.
const RESERVED_NODE_ID = "__document__";
const RESERVED_ID_SUBSTRING = "::";
function nodeIdError(id: string): string | null;                                       // shared edit+load
// core.ellipse fills its box (cx=w/2 …). core.line is the box DIAGONAL (0,0)→(w,h); core.path
// is drawn from its `path` commands (the box is just the declared bbox). line + path may collapse
// ONE box axis (a horizontal/vertical line, or a flat path bbox); see dimensionError.
function dimensionError(type: NodeType, width: number, height: number): string | null; // shared edit+load
function pathError(type: NodeType, path: unknown): string | null;                      // shared edit+load
function srcError(type: NodeType, src: unknown): string | null;                        // shared edit+load (schema 23)
function srcValueError(src: unknown): string | null;                                   // the type-free half; the override seam runs it too (schema 24)
const IMAGE_SRC_MAX = 4_000_000;   // a picked file is inlined as a data: URL — bound it or a document becomes unsavable
function styleError(style: Partial<Style>): string | null;                             // shared edit+load (all Style fields, incl. effects)

// core.path drawing commands: ABSOLUTE, explicit, local-space. Relative/shorthand/arcs are
// deferred to a future SVG-import normalizer (whose output feeds this same type through pathError).
type PathCommand =
  | { c: "M"; x; y } | { c: "L"; x; y }
  | { c: "C"; x1; y1; x2; y2; x; y } | { c: "Q"; x1; y1; x; y } | { c: "Z" };
const PATH_MAX_COMMANDS = 100_000;  // OOM cap on the hand-editable path array (mirrors GRID_MAX_TRACKS)

interface Node {
  id: string;                       // UUID, equals the map key
  type: NodeType;
  parent?: string | null;           // null/undefined ⇒ a root
  children: string[];               // ordered child UUIDs
  geometry: Geometry;
  style: Style;
  layout: Layout;
  states?: Record<string, StateDefinition>; // named STATES (M7, schema 30) — LIVE; a StateDefinition IS an InstanceOverride
  text?: string;                    // core.text
  src?: string;                     // core.image — URL, relative path, or a data:image/* URL (schema 23: srcError)
  path?: PathCommand[];             // core.path (absent = empty path, draws nothing)
  componentId?: string;             // core.instance → the MASTER node it copies (schema 21, M6)
  overrides?: Record<string, InstanceOverride>; // core.instance → per-copy changes, keyed by a PATH of master node ids (schema 22; +layout/transform at 26; paths at 28)
  variant?: VariantKey;             // this node's place in a variant SET (schema 27) — any node may carry one
  variants?: Record<string, string>; // core.instance → the variant SELECTION; SPARSE (unnamed properties keep the master's value)
  slot?: string;                    // a named HOLE in a master (schema 29) — its own children are the default content
  slotContent?: Record<string, string>; // core.instance → slot name → the id of a node to draw there
  hidden?: boolean;                 // schema 31 — dropped from the DISPLAYED scene with its subtree; still stored, still listed
  locked?: boolean;                 // schema 31 — still drawn, not selectable; INHERITED by the subtree
  name?: string;                    // display name
}

interface Geometry { x: number; y: number; width: number; height: number; }
// COORDINATE SPACE: x/y are PARENT-RELATIVE. See the rule below.

// LIGHTING (schema 42). Document.lights?: Light[] (max 4) + Document.ambient?: 0..1.
interface Light { x: number; y: number; z: number; color: string; intensity: number }
// DIRECTIONAL only, and that is a decision: a design document has no scale — a 200-unit rectangle
// may be a button or a building — so a light with a radius would need a distance the document
// cannot supply. A direction needs no scale. Stored un-normalised; a ZERO direction is refused
// rather than given an axis. AMBIENT is not a light but a FLOOR: without it an unlit face goes to
// pure black. Absent lights = ambient 1 = every colour multiplied by one, so an unlit document
// draws byte-identically to how it did before lighting existed.
// Mesh control points gain `z` (absent = 0), which is what turns the grid into a SURFACE: a warp
// alone is in-plane and tilts nothing. `warpPoint` still reads only x and y, so height changes how
// a shape is LIT without changing what it covers.
// Shapes DO now cast shadows on each other, and not via a shadow map. Every occluder here is a
// flat shape at a known height under a DIRECTIONAL light, so its shadow is its own outline
// translated and intersected with what it lands on — a boolean, not a pass. That is why all three
// backends get it, why it is node-testable, and why it stays sharp when you zoom (`CastShadow`).
// RAISED IS NEGATIVE DEPTH. `depth` counts AWAY from the viewer, so the shape that floats above
// the page and throws a shadow is the one in FRONT of it; a shape sunk behind the page throws
// nothing. `shadowOffset` had this backwards for two commits.
// A shadow's LENGTH is the gap between the caster and what it lands on, not the caster's height:
// a card 40 above the page throws 40 onto the page and 20 onto a card at 20. Also wrong for two
// commits, and invisible until a document has TWO raised shapes.
// ALSO HERE: SELF-shading, Lambert per FRAGMENT on the GPU — the vertex stage hands over an
// un-normalised normal, which is what survives linear interpolation intact, and the fragment
// shader normalises it.
// RAY CASTING through the heightfield (`geometry/RayMarch`) answers what a normal cannot: a
// crease beside a raised edge faces the light squarely and is still dark, because the edge is in
// the way. Binary, like the cast shadows and for the same reason — a directional light has no
// penumbra. Marched PER FRAGMENT: the mesh crosses to the shader as a 16-bit heightfield texture
// and each pixel walks it for itself, so the shadow's edge no longer depends on how finely the
// shape happened to be tessellated.
// STILL NOT DONE: a cast shadow lands on the receiver's OUTLINE as if the receiver were flat, so
// it does not bend over a domed one.

// MESH POINTS ARE FRACTIONS OF THE BOX (schema 43), not local units. `{x: 0.5, y: 1}` is the
// middle of the bottom edge at any size, and a point may sit outside [0, 1] because dragging a
// corner beyond the box is ordinary. This is an INTERPRETATION bump of the purest kind — the file's
// shape is unchanged and the same three numbers mean something else — and it exists because
// absolute points did not survive a RESIZE: the rest grid was implied by the CURRENT box while the
// points recorded the OLD one, so an untouched mesh stopped being the identity and pinned the shape
// to the size it was created at. Rescaling in the resize action would not have worked: a node's
// size is COMPUTED by auto-layout, hug sizing and constraints, none of which is an action.
// `migrate_42_to_43` divides each point by the node's own geometry, so the shape draws identically;
// a ZERO-sized box has no fraction to divide into and its mesh is DROPPED rather than made
// infinite. HEIGHT (`z`) stays ABSOLUTE — a distance above the page, like `depth`.
//
// MESH (schema 41). Node.mesh?: { cols, rows, points } — a grid of control points that BENDS the
// node's outline. Points are in LOCAL units, row-major, exactly (cols+1)*(rows+1) of them, and
// hold the DEFORMED positions; the rest positions are implied by the box, so a mesh sitting on
// that grid is the identity and is skipped. Deformation is BILINEAR per cell — exact at the
// control points, which is what a person dragging one checks. Resolved at the display seam into
// an ordinary `core.path` (`resolveMeshes`, LAST, after booleans), so nothing downstream knows a
// mesh from a drawing and a warp is CLICKABLE where it is drawn. Curves are flattened first: a
// cubic through a bilinear warp is not a cubic, the same trade booleans and strokes already make.

// DEPTH (schema 40). Node.depth?: number in [-1000, 1000]; absent = 0, the plane of the page.
// ONE number, THREE consumers: display ORDER (far draws first, ahead of the tree's own order, and
// in the MODEL so all three backends agree), the GPU's Z-BUFFER (a vertex carries a clip z that
// decreases with depth, so nearer wins whatever order it was drawn in), and PARALLAX (a distant
// layer follows only 1/(1+d) of a pan; negative depth is the foreground and outruns it).
// Parallax is applied at the DISPLAY SEAM as a position offset, never in the renderer, so a shape
// is CLICKABLE where it is drawn — picking, marquee and snapping all read that same geometry.

// ANIMATION (schema 39). A document has no clock until somebody asks for one.
interface TimelineSettings { frames: number; fps: number }   // frames >= 1, fps in [1, 240]
// Document.timeline?: TimelineSettings   — absent = not animated
// Document.frame?: number                — where the playhead was SAVED (the live one is ephemeral)
// Node.track?: Keyframe[]                — the node's animation
interface Keyframe {
  frame: number;            // whole, >= 0, and the track must be in ASCENDING order
  hold?: boolean;           // stay put until the next keyframe — the whole of frame-by-frame
  easing?: Easing;          // shapes the tween LEAVING this keyframe; ignored when held
  values: StateDefinition;  // the same statement a state and an instance override make
}
// A keyframe is a StateDefinition at a time, so it inherits `overrideValueError` and
// `materializeNode`; a TWEEN is `blendNode`, written for state transitions. Animation added a
// field, not a second definition of what a node may say about itself. Outside a track's range the
// nearest keyframe is HELD, never extrapolated. `applyFrame` runs inside `resolveScene`, so a
// document at a frame is an ORDINARY document and nothing below the display seam knows time exists.

interface Style {
  fill: string;             // color OR token id, e.g. "$color/primary" (resolved against variables, M5)
  stroke?: string;
  strokeWidth?: number | string; // border thickness in WORLD units, >= 0, or a number-token (schema 25); absent = a 1-SCREEN-px hairline
  strokeJoin?: "miter" | "round" | "bevel";   // how a corner turns (schema 37); absent = "miter"
  strokeCap?: "butt" | "round" | "square";    // how an open end finishes (schema 37); absent = "butt"
  strokeMiterLimit?: number;                  // miter length / stroke width, >= 1 (schema 37); absent = 4
  fillRule?: "nonzero" | "evenodd";           // which points a closed outline encloses (schema 38); absent = "nonzero"
  // The two disagree only where a contour crosses itself or contours overlap — a five-pointed
  // star drawn in ONE stroke is solid under nonzero and hollow under even-odd. SVG takes it as
  // `fill-rule` and Canvas as an argument to `fill()`; the GPU has nothing to hand it to, so
  // there the rule is resolved into the geometry (`geometry/Resolve`) before tessellation.
  // Picking reads it too — a click has to agree with the paint, or an even-odd hole would
  // swallow clicks meant for whatever shows through it.
  // NO strokeAlign, deliberately. Neither SVG nor Canvas can draw an inside or outside border, so
  // a document field for one would render three different ways on three backends. Alignment is an
  // argument to the OUTLINE STROKE command instead (`actions/outlineStrokeActions`), whose result
  // is a plain `core.path` — and a fill draws identically everywhere.
  radius?: number | string; // corner radius, or a NUMBER-token "$radius/medium" (schema 20)
  opacity: number;          // 0..1 — INHERITED since schema 32: a node draws at its own × every ancestor's
  fontSize?: number | string; // core.text; world units, default 14 — number or a number-token (schema 20)
  shadow?: Shadow;          // drop shadow (schema 18); absent = none
  blur?: number;            // whole-node gaussian blur radius, world units, >= 0 (schema 18); absent/0 = none
}
// A string radius/fontSize MUST be a "$token" (arbitrary strings are rejected on both paths);
// the RESOLVED value is range-checked at render time — broken/out-of-range falls back visibly
// (radius: none; fontSize: 14), never a throw.
interface Shadow { dx: number; dy: number; blur: number; color: string }  // offset + gaussian softness + colour (world units)

interface Layout {     // constraint intent, not absolute position (Milestone 2)
  horizontalAlignment?: "left" | "right" | "center";  // reserved (constraints, deferred)
  verticalAlignment?: "top" | "bottom" | "center";    // reserved (constraints, deferred)
  spacing?: number;                                    // reserved
  container?: LayoutContainer;                         // M2 auto-layout (flex) — LIVE
  grow?: number;                                       // M2 flex-grow (child hint) — LIVE
  shrink?: number;                                     // M2 flex-shrink (child hint) — LIVE
  grid?: LayoutGrid;                                   // M2 grid — LIVE; EXCLUSIVE with container
  constraints?: Constraints;                           // M2 anchors (child of a PLAIN parent) — LIVE
  constraintRef?: { width: number; height: number };  // frozen parent-size reference for `constraints`
  position?: "absolute";                               // M2 out-of-flow escape — LIVE
  margin?: number | Margins;                           // M2 flex spacing / grid-cell inset — LIVE (uniform or per-side)
  colSpan?: number;                                    // M2 grid item span — LIVE; integer [1, GRID_SPAN_MAX]
  rowSpan?: number;                                    // M2 grid item span — LIVE; integer [1, GRID_SPAN_MAX]
  gridColumn?: readonly [number, number];              // M2 explicit grid line pin (schema 15); 1-indexed, end-exclusive
  gridRow?: readonly [number, number];                 // M2 explicit grid line pin (schema 15); both needed to pin
}

interface Margins { top?: number; right?: number; bottom?: number; left?: number }  // per-side; any omitted side = 0

interface Constraints {              // how this child responds when its PLAIN parent resizes
  horizontal?: "left" | "right" | "left-right" | "center" | "scale";  // default "left"
  vertical?: "top" | "bottom" | "top-bottom" | "center" | "scale";    // default "top"
}

interface LayoutContainer {          // this node's DIRECT CHILDREN are auto-positioned
  direction: "row" | "column";
  gap?: number;                      // between children AND between wrapped lines, >= 0
  padding?: number;                  // inset from the container's edges, >= 0
  alignItems?: "start" | "center" | "end" | "stretch";  // cross-axis (per-line); stretch resizes
  wrap?: boolean;                    // multi-line flow (schema 12); cross-hug sizes to the lines
  alignContent?: "start" | "center" | "end" | "space-between" | "space-around" | "stretch"; // line distribution (schema 15)
  wrapReverse?: boolean;             // stack wrapped lines from the far cross edge (schema 15)
  hugWidth?: boolean;                // size width to contents (schema 4); absolute axis
  hugHeight?: boolean;               // size height to contents (schema 4); absolute axis
}

type TrackSize = { px: number } | { fr: number } | { auto: true }; // fixed px, share of leftover, or sized to content

interface LayoutGrid {               // children auto-flow row-major into cells and fill them
  columns: TrackSize[];              // ≥1 column tracks; defines the column count
  rowHeight: TrackSize;              // IMPLICIT row size — used for rows not sized by rows[] (px, fr, or auto)
  rows?: TrackSize[];                // explicit per-row tracks (schema 10); rowHeight is the fallback beyond the list
  hugWidth?: boolean;                // size width to the tracks (schema 11), like LayoutContainer hug
  hugHeight?: boolean;               // size height to the tracks (schema 11)
  autoFlow?: "row" | "row dense" | "column" | "column dense";  // placement flow (schema 15); default "row"
  columnGap?: number; rowGap?: number; padding?: number;  // >= 0
}

type StateDefinition = InstanceOverride;  // same shape of statement: "in this context, these fields differ"
```

A variant SET has no object of its own — it is the masters that name it, so tagging a node
creates the set and untagging the last member ends it. Resolution (`resolveVariantMaster`)
overlays the instance's sparse selection on the pointed-at master's own values and takes the
member carrying exactly that; it is TOTAL, and every failure draws `componentId`. Switching
also resizes the instance to the new variant UNLESS its box was deliberately resized, and
remaps `overrides` onto the new variant's nodes (root structurally, the rest by a name unique
in both subtrees; an unmatched entry is kept and is inert, like any dangling key).

An override KEY is a PATH of master node ids (schema 28). `MC` names a node of this
instance's own master; `OI::IM` names a node inside the expansion of the nested instance
`OI`, which is how an outer instance reaches through a nested one. The override still lives
on the owning STORED instance — a virtual instance node cannot hold one — so this is a
question of addressing, not of storage. A path that resolves to nothing is inert, like any
dangling key, and `resolveOverridePath` is what the type-aware validator walks.

A STATE says what a node looks like in a named context — `hover`, `pressed`, `error` (M7,
schema 30). `activeState` selects one for the WHOLE document, exactly as `activeTheme` selects
a token mode: one choice, resolved at display time, with nothing persisted about a node being
"currently" hovered. `resolveScene` applies states to STORED nodes and THEN expands instances,
so a master in its hover state produces hovered copies; the other order would leave every copy
showing the base. A node that does not define the active state is untouched, and a document
where nothing defines it is returned unchanged.

A SLOT is a named hole a master leaves for its instances (schema 29). The slot node supplies
the BOX — position, size, layout — and its own children are the DEFAULT content; an instance's
`slotContent` names a node to draw there instead. The fill is a REFERENCE, like `componentId`:
the content keeps living where it is, and clearing the fill moves nothing back. It is
re-origined into the slot exactly as a master root is into its instance, and it opens a new
instance path (`…::slotCopy::filled`), so a fill nests like a nested instance and the
path-keyed override lookup reaches inside it unchanged. Unfilled, dangling, or naming a slot
that does not exist all fall back to the default children.

## Read-only views

`Document.ts` also exports `DeepReadonly<T>` and `ReadonlyDocument`
(`= DeepReadonly<ProjectDocument>`). `ActionDispatcher.getDocument()` returns the
latter, so "the dispatcher is the only write path" is enforced by the compiler rather
than by convention — see [ARCHITECTURE.md](ARCHITECTURE.md) invariant 3.

## Coordinate space (the M1 contract)

**`geometry.x/y` is PARENT-RELATIVE.** A node's world position is a *computed
output*, never stored:

```
world(node) = world(node.parent) + node.geometry.{x,y}      // root: world == stored
```

- Resolved by `computeGeometry(doc, pending?, previous?, dirty?)` → `ComputedState`
  (`src/core/geometry/GeometryEngine.ts`), which walks the scene graph parents-first
  and multiplies each node's local matrix into its parent's world matrix.
- **Nothing outside that module may compose coordinates.** The renderer, hit-testing
  and tools all read the computed rects.
- Composition is full 2D affine (`Mat2D`): rotation and scale propagate from parent to
  child. World→local uses a real inverse matrix (`toLocal`), not subtraction.
- **Reparenting keeps stored (relative) coordinates**, so a node moves with its new
  parent. World-position-preserving reparent is deferred to M2.

**Rotation / scale — landed in schema 2 (Milestone 1).** `Node.transform` is optional:

```ts
interface Transform {
  rotation?: number;                    // radians, clockwise
  scaleX?: number; scaleY?: number;
  origin?: { x: number; y: number };    // fraction of the node's box; default centre
}
```

It is a separate field rather than a widening of `Geometry`, which stays a pure
axis-aligned box so Milestone 2 layout can compute it. `origin` is normalized so the
pivot survives a resize, and is settable via `UpdateNodeTransformAction`
(the write-path primitive; the M4 rotate handle will invoke it). A zero scale is
rejected — it is non-invertible, so `toLocal`/hit-testing would break. **Absent means
identity**, so every schema-1 document is a
valid schema-2 document — which is exactly why `migrate_1_to_2` is a pass-through.

**Auto-layout — landed in schema 3 (Milestone 2, core).** When a node carries
`layout.container`, its **direct children are positioned by the layout engine**: their
stored `geometry.x/y` is *ignored* and replaced by a computed one (a row/column flex
stack with `gap`, `padding`, and cross-axis `alignItems`). This is precisely what
"store *center inside parent* instead of `x = 240`" means — for a laid-out child,
position is a **result**, not stored intent. `alignItems: "stretch"` additionally
overrides the child's cross-axis *size*. Containers nest: an inner container lays out
within its own (possibly stretched) size.

- Computed by `LayoutEngine.layoutChildren`, invoked *inside* `computeGeometry` when it
  visits a container parent — so the result composes through the same matrix pipeline
  and a laid-out child still inherits parent world position and transform.
- **The stored `x/y` of a laid-out child is vestigial** but retained: removing the
  container (`UpdateNodeLayoutAction` with `{ container: undefined }`) reverts the child
  to honouring it again.
- Settable via `UpdateNodeLayoutAction` (the write-path primitive; an M5 layout inspector
  will invoke it). Validated by `layoutError`, **shared with the load path** so the
  round-trip closure holds — a hand-edited container the loader rejects is one the editor
  could never author.
- **Absent means no auto-layout**, so every schema-2 document is a valid schema-3
  document — which is why `migrate_2_to_3` is a pass-through. The bump is still required:
  a schema-2 *build* would ignore the container and draw the children at their now-
  vestigial stored `x/y`, silently misstating the document (the same "old build, not old
  file" hazard as the schema-2 bump below).

**Intrinsic ("hug") sizing — landed in schema 4 (Milestone 2).** A container may set
`hugWidth` / `hugHeight` to size a **physical** axis to its contents instead of using
its stored `geometry`: the hugged width/height becomes a computed *result*, exactly as
a laid-out child's position is.

- `hugWidth` → width = (row: Σ child widths + gaps; column: max child width) + 2·padding.
  `hugHeight` is the same on the other axis. Absolute axes (not "main"/"cross") on
  purpose — flipping `direction` must never silently re-interpret which axis hugs, which
  is exactly the kind of interpretation change the freeze rule exists to catch.
- Hug **composes**: a hug container inside a hug container ripples upward until a fixed
  ancestor absorbs it. So sizing needs a **bottom-up measure pass** (`measureIntrinsicSizes`)
  that runs before positioning — see [ARCHITECTURE.md](ARCHITECTURE.md). The measure reads
  only stored/pending sizes and container rules (never a child's *stretched* size), so it
  is an acyclic fold: `hugHeight` + `alignItems: "stretch"` are coherent (a container hugs
  to its children's pre-stretch cross-size, then stretches them to fill it).
- Validated by the shared `layoutError` on both the edit and load paths (a non-boolean
  `hugWidth` is rejected identically), and settable via `UpdateNodeLayoutAction`.
- **Absent means fixed size**, so every schema-3 document is a valid schema-4 document —
  hence `migrate_3_to_4` is a pass-through. The bump is still required: a schema-3 *build*
  would draw a hug container at its now-vestigial stored width/height, misstating the doc.

**Flex-grow — landed in schema 5 (Milestone 2).** A child sets `Layout.grow` (a number,
default 0) to claim a share of its flex parent's **leftover main-axis space**, split
among siblings in proportion to their `grow`. It lives on the child's own `Layout` (like
CSS `flex-grow`), and is consumed by the container parent during positioning.

- Applied in the **position pass only** — it never feeds back into the bottom-up measure
  pass, so there is no cycle and a growing child does not change a hug ancestor's size.
- **Inert when there is no free space:** a *standalone* container that hugs its main axis,
  or one whose children already overflow, has nothing to distribute (overflow is *not*
  shrunk — flex-shrink is deferred). `grow` and `alignItems: "stretch"` are orthogonal
  (main vs cross axis).
- **grow wins over hug on a shared axis.** A node can be both a hug *container* and a grow
  *child*: it hugs its own content, but if its parent grows it, the grown size wins and its
  children lay out within the grown box (matching CSS `flex-grow` overriding content size).
- **Intentional divergence from CSS:** all free space is distributed by `grow` ratio, so a
  lone `grow: 0.5` still fills the row — the `(1 − Σgrow)` fraction CSS leaves empty when
  `Σgrow < 1` is *not* reserved. `grow` means "my share of the space", not "my fraction of
  one unit".
- Validated by the shared `layoutError` on both paths (`grow` must be finite and ≥ 0);
  because a `{ grow }` patch may carry no `container`, the check runs *before* the
  no-container early return. Settable via `UpdateNodeLayoutAction`.
- **Absent means 0**, so every schema-4 document is a valid schema-5 document —
  `migrate_4_to_5` is a pass-through. The bump is still required: a schema-4 build would
  draw a growing child at its base size instead of filled.

**Flex-shrink — landed in schema 9 (Milestone 2).** The mirror of grow: when the flex
children OVERFLOW (main-axis `free < 0`), a child with `Layout.shrink > 0` gives up a share
of the deficit, **weighted by `shrink × base-main-size`** (CSS-style — a bigger item gives
up more even at equal shrink), clamped so a child never goes below 0. Grow (`free > 0`) and
shrink (`free < 0`) are mutually exclusive by the *sign* of the free space; margins are
counted into `used` first, so they are never shrunk. Absent = 0 = never shrinks (the
pre-schema-9 overflow behaviour), so `migrate_8_to_9` is a pass-through — the bump is
required because a schema-8 build would draw an overflowing child at full size. (CSS would
redistribute when a child hits 0; we accept the small overshoot — a documented
simplification.)

**Flex wrap — landed in schema 12 (Milestone 2).** `LayoutContainer.wrap` makes children
that overflow the container's inner MAIN axis flow onto new lines. A single shared
`breakFlexLines` (the flex analogue of `resolveGridTracks`) is called by BOTH the position
pass and the measure cross-hug fold, so a cross-hug container's own size equals the stack it
lays out — the fuzz-blind property the grid slice taught us to pin directly. A new line starts
when the current line is non-empty and the next child (its `2·margin + main`, plus one `gap`)
would exceed the inner main (strict `>`, so an exact fit stays); the first child on a line
always stays even if it alone overflows. Each line distributes its OWN grow/shrink free space;
lines stack on the cross axis separated by `gap` (reused for both axes); `alignItems` aligns
each child within its line's cross band, except a SINGLE line fills the whole container cross
(keeping nowrap byte-identical). A cross-axis-hug container sizes its cross to `2·pad + Σ line
cross + gap·(lines−1)`. Constraints, all resolved acyclically:
- Wrap is **inert when the MAIN axis hugs** (no definite main to wrap against — the direct
  analogue of `grow` under a hugged main); the layout stays a single line.
- Wrapping is measured against the container's OWN size; a parent that STRETCHES/grows the main
  axis wider does NOT re-flow into the extra space (a documented deferral that keeps the measure
  pass acyclic — both passes break against the same own-size, so they never disagree).
- **align-content**/wrap-reverse landed in schema 15 (below); a separate cross-gap stays deferred.
- **Absent = nowrap**, so every schema-11 document is a valid schema-12 one — `migrate_11_to_12`
  is a pass-through; the bump is required because a schema-11 build would draw a wrapping
  container's children on one overflowing line and mis-size a cross-hug container. `wrap` is
  validated (a boolean) on both paths.

**Grid — landed in schema 6 (Milestone 2).** `Layout.grid` is an ALTERNATIVE to
`container` (the two are **mutually exclusive**). A grid's direct children auto-flow
row-major into `columns.length` columns × `ceil(count/columns)` rows and **fill their
cell** — their stored *position* is ignored, like a laid-out flex child. Column tracks are
`{ px }`, `{ fr }` (sharing the leftover inner width), or `{ auto: true }` (sized to the max
child content — schema 11). Rows size the same
way: **explicit per-row `rows[]` tracks** (landed in schema 10) give each row its size, with
`rowHeight` as the IMPLICIT fallback for any row past the `rows[]` list (CSS
`grid-template-rows` + `grid-auto-rows`); with `rows` absent every row is `rowHeight`. Both
axes run through one `resolveTracks`, so `fr` rows share the leftover inner height after the
`px` rows, exactly as columns do. Row COUNT is still derived from the child count — `rows[]`
only *sizes* the rows, it does not add or place them. `columnGap`/`rowGap`/`padding` inset as
expected.

- Grid resolves through one shared `LayoutEngine.resolveGridTracks` (columns + rows). A
  `px`/`fr` grid with no hug reads no child sizes and stays effectively position-pass. But
  `auto` tracks and grid-hug (schema 11) pull grid INTO the bottom-up measure pass: an `auto`
  track sizes to the **max measured own-size** of the children flowed into it, and a hugging
  grid sizes its own axis to `2·pad + Σtracks + gaps` — exactly like flex hug (and, like hug,
  it reads children's PRE-fill own-sizes, so it stays acyclic and total). The SAME
  `resolveGridTracks` feeds both the measure fold (hug size) and the position pass (cells), so
  a hugged grid's own size equals the sum of its cells by construction. The dirty climb
  (`containerHugs`) now recognises grid hug flags, so a grid-child resize ripples up.
- **Mutual exclusivity is enforced on write** (`UpdateNodeLayoutAction` carries the clear
  IN its delta — setting one emits the other as `undefined` — so even a transaction that
  merges a container-set and a grid-set resolves last-wins rather than dropping both) AND
  on read (`layoutError` rejects a node carrying both), so the two can never coexist — a
  hand-edited file with both fails to load. `TrackSize` is validated (exactly one of
  `px` ≥ 0, `fr` > 0, or `auto` = true) on both paths by the exported `trackError`.
- **Tracks are stored STRUCTURED, and authored as TEXT.** `TrackSize` stays an object for
  the reason `core.path` stores commands rather than a `d` string: one shared field-by-field
  validator, and no renderer has to parse. The inspector's `1fr 1fr 200px` field is a pure
  text↔structure pair in `TrackList.ts` (`parseTrackList` / `formatTrackList`) that defers
  every judgement to `trackError`, so the field cannot author a track the loader would refuse.
  A bare number means pixels; `auto` and unit suffixes are case-insensitive; empty input is
  an error rather than an empty list (`columns` may not be empty). Nothing about the text
  form is persisted — it is an authoring convenience over the structured value.
- **Absent means no grid**, so every schema-5 document is a valid schema-6 document —
  `migrate_5_to_6` is a pass-through. The bump is still required: a schema-5 build would
  ignore the grid and draw the children at their stored `x/y`.
- **Per-row `rows[]` (schema 10):** absent = every row is `rowHeight`, so every schema-9
  document is a valid schema-10 one — `migrate_9_to_10` is a pass-through; the bump is
  required because a schema-9 build would ignore the per-row tracks and lay every row out at
  `rowHeight`. `rows[]` is validated (a non-empty array of valid `TrackSize`, when present)
  on both paths.
- **`auto` tracks + grid hug (schema 11):** absent `auto` / hug false = a fixed-size grid of
  `px`/`fr` tracks, so every schema-10 document is a valid schema-11 one — `migrate_10_to_11`
  is a pass-through; the bump is required because a schema-10 build would not understand an
  `{ auto: true }` track or size a hugging grid to its contents. On a HUGGED axis `fr` tracks
  collapse to 0 (no definite size to share, so nothing to distribute). `{ auto: true }` (exactly
  `true`) and the boolean hug flags are validated on both paths.
- **Grid spans (schema 13):** `Layout.colSpan`/`rowSpan` (per-child, default 1) make a grid item
  occupy multiple cells. Placement is a CSS-style SPARSE auto-flow — a forward-only, row-major
  cursor gives each item the next FREE `colSpan × rowSpan` block, skipping cells occupied by
  earlier items' spans (`LayoutEngine.placeGridItems`, the single placement authority shared by
  the measure fold and the position pass, so a hugging grid's size matches its cells). The row
  COUNT is DERIVED from the placement (a `rowSpan` can push it past `ceil(count / cols)`); a
  spanning cell covers its tracks + internal gaps. `colSpan` is clamped to the column count —
  **this is load-bearing: an un-clamped `colSpan > cols` would never fit and loop forever** — and
  both spans are validated as integers in `[1, GRID_SPAN_MAX]` on both paths. Because the
  occupancy set is `Σ colSpan·rowSpan` (NOT the row count), the per-item span cap alone does not
  bound memory; so the COLUMN count is capped at `GRID_MAX_TRACKS` (validated) and the DERIVED row
  count is capped in placement, together bounding the occupancy to `GRID_MAX_TRACKS²` — a grid
  larger than that is out of scope (use a flex column for a long list). A spanning item does NOT
  drive `auto` track sizing (CSS's first sizing pass only — a documented simplification). Absent = 1, so every schema-12 document
  is a valid schema-13 one (`migrate_12_to_13` pass-through); the bump is required because a
  schema-12 build would ignore the spans and mis-place the cells. DEFERRED: explicit line-based
  placement (`grid-column: 2 / 4`), dense packing, column auto-flow.

**Constraints / anchors — landed in schema 7 (Milestone 2).** A child of a **plain**
(non-flex, non-grid) parent uses `Layout.constraints` to pin to the parent's edges and
respond when the parent resizes: `left`/`right`/`left-right`(stretch)/`center`/`scale`
horizontally, and `top`/`bottom`/`top-bottom`/`center`/`scale` vertically. Absent =
`left`/`top` = the pre-M2 static behavior. Flex/grid children are laid out and ignore
constraints (inert).

- The response is resolved **statelessly** in `computeGeometry` (`resolveConstraints`)
  against a **frozen** reference `Layout.constraintRef` — the parent size the child's
  geometry is "at rest" against, captured ONCE when `constraints` is first set and never
  rewritten by resize. `offset = parentCurrentSize − constraintRef` is therefore non-zero
  for a **direct** resize (parent's stored size moves, ref frozen) AND a **layout-driven**
  one (a grown/stretched/celled frame's computed size moves, ref frozen) — one formula,
  both sources. `scale` guards `ref > 0` (validated).
- **The ref is auto-captured from the parent's STORED size, but ONLY for a non-container
  parent** — a container's stored size is unreliable (hug/grow/stretch make its computed
  size differ), so auto-capturing from it would place the child against the wrong box and
  teleport it at rest. So an `absolute` child of a **container** gets no auto ref and stays
  static until a tool provides a computed-derived ref (the M5 re-baseline). An **explicit**
  `constraintRef` in the patch always wins, so `absolute` + constraints under a container is
  fully supported once the ref is set correctly.
- A per-CHILD reference (not per-parent) means authoring one child never re-baselines its
  siblings. Constraints need **no new dirty machinery**: a parent size change dirties the
  parent and the child inherits top-down.
- **Known limitation (M5 tool-layer):** moving/resizing a constrained child while its
  parent is off-reference writes geometry in the wrong frame; the re-baseline (rewrite the
  child's rect + reset `constraintRef` to the parent's current size) is not yet built.
- **Absent means static**, so every schema-6 document is a valid schema-7 document —
  `migrate_6_to_7` is a pass-through. The bump is still required: a schema-6 build would
  draw a constrained child unanchored, misstating a responsive layout.

**Out-of-flow escapes + margins — landed in schema 8 (Milestone 2).** `Layout.position:
"absolute"` takes a child OUT of its flex/grid parent's flow: it claims no slot/cell, does
not contribute to the parent's hug size or consume flex free-space, and is positioned by
its stored geometry + `constraints` relative to the parent's box (like CSS
`position: absolute`) — so it stays draggable. `Layout.margin` (schema 8, uniform ≥ 0) is
per-child spacing in a **flex** parent's flow: main-axis before/after + a cross-axis inset.
**Absent means in-flow / 0**, so every schema-7 document is a valid schema-8 document —
`migrate_7_to_8` is a pass-through; the bump is required because a schema-7 build would lay an
absolute child into the flow and ignore its margin.

**Per-side + grid-cell margins (schema 14).** `Layout.margin` widens to `number | Margins`: a
plain number stays uniform, a `Margins` object gives per-side top/right/bottom/left (any omitted
side = 0, every side ≥ 0). Physical sides map to a flex container's LOGICAL axes by `direction`
(row: left/right = main before/after, top/bottom = cross; column transposed) — the measure fold
and the position pass map identically, so a hugged container agrees with its children. Margins
now also apply to a **grid** child: they INSET it within its cell, and an `auto` track grows to
fit the child + its horizontal/vertical margins (so the inset gives the child its own size). A
plain number is the old behaviour, so `migrate_13_to_14` is a pass-through; the bump is required
because a schema-13 build would not understand a per-side object and would ignore a grid child's
margin. Validated (number ≥ 0, or a `Margins` of finite ≥ 0 sides) on both paths.

**Layout close-out — schema 15 (Milestone 2).** The final layout-engine batch, all optional/
additive (so `migrate_14_to_15` is a pass-through):
- **`LayoutContainer.alignContent`** distributes the wrapped LINES in leftover cross space
  (`start`/`center`/`end`/`space-between`/`space-around`/`stretch`) — a NO-OP for a single line or a
  cross-hug container (`freeCross == 0`), so it needs no measure-fold change. **`wrapReverse`**
  reflects the cross layout so lines stack from the far edge (also flipping alignItems + align-
  content, as CSS). Both are pure position-pass arithmetic downstream of `breakFlexLines`.
- **`LayoutGrid.autoFlow`** = `"row"` (default) / `"column"` / `+ " dense"`. Column flow fixes the
  ROWS (from `rows`, default 1) and DERIVES the columns (implicit columns are `auto`) — implemented
  as the exact TRANSPOSE of row flow, reusing the one placement kernel. Dense backfills earlier gaps.
- **`Layout.gridColumn`/`gridRow`** (`[startLine, endLine]`, 1-indexed, end-exclusive) PIN an item
  to fixed cells; a pre-pass marks the pinned cells so auto items flow around them. Both axes are
  required to pin (single-axis placement is deferred); explicit-under-column-flow is deferred.
- The bump is required because a schema-14 build would mis-distribute wrapped lines, flow a grid the
  wrong way, or auto-place a pinned item. Everything is validated on both paths. **`minmax()`/
  `fit-content` track sizing** stays deferred (a genuine iterative track-sizing algorithm).

> **Still deferred (not in schema 15):** `minmax()`/`fit-content` tracks, single-axis explicit
> placement, a separate cross-gap, responsive/breakpoint rules (→ M5), the constrained-child
> re-baseline (→ M5 tool layer), drag-to-reorder (→ M4). See
> [MILESTONES.md](../MILESTONES.md) § Milestone 2.

> **It bumped `SCHEMA_VERSION` to `"2"`** — as the freeze rule required, with a
> matching `migrate_1_to_2` step. The bump was necessary even though the migration is
> a pass-through *by content*: without it a schema-1 **build** would load a rotated
> node, pass the exact-match gate, and draw it unrotated with no error.
>
> Do not be tempted by "it's optional and additive, so old files still load." That
> reasoning is backwards: the risk is not old *files*, it is old *builds*. Without a
> bump, an old build reads a rotated node, passes the exact-match gate, and draws it
> **unrotated with no error** — and the user then edits against a canvas that misstates
> their document. With a bump, `migrateIfNeeded` throws *"newer than this build
> supports"* and fails loudly. **There is no "additive so it's safe" exception.**
>
> ⚠️ *"Fails loudly" is a property of the READER, not of the bump.* Builds released
> before the newer-than-schema gate existed simply treat an unknown version as an
> unreadable file — the installer checked into `exe/` is one of them: it exact-matches
> its own `CURRENT_VERSION` and swallows the failure. So before bumping, check the
> oldest build you still support: for those readers a bump is silent data loss, not a
> clear error.

### Field invariants — and where each is enforced

| Invariant | Action path | Load path (`deserializeDocument`) |
|-----------|-------------|-----------------------------------|
| `geometry.*` finite; `width`/`height` `> 0` (a `core.line` may collapse ONE axis, not both) | ✅ `validate()` / `dimensionError` | ✅ `validateDocumentIntegrity` / `dimensionError` |
| `opacity ∈ [0,1]`; `radius ≥ 0`; `fontSize > 0` | ✅ `validate()` | ✅ `validateDocumentIntegrity` |
| `id` equals the `nodes` map key | — | ✅ throws on mismatch |
| node shape (required fields/types) | ✅ by construction | ✅ `isValidNode` |
| `type` ∈ `NODE_TYPES` | ✅ `AddNodeAction.validate()` | ✅ `isNodeType` |
| `parent` resolves; no dangling refs | ✅ `AddNodeAction`/`ReparentNodeAction` | ✅ `validateDocumentIntegrity` |
| `children` resolve, claimed once, back-point via `parent` | ✅ | ✅ |
| roots exist, unique, parentless; parentless nodes are roots | ✅ | ✅ |
| tree is acyclic | ✅ `ReparentNodeAction` rejects cycles | ✅ `validateDocumentIntegrity` |

`validateDocumentIntegrity(doc)` (`src/core/document/Integrity.ts`) runs at the end
of `deserializeDocument`, so a hand-edited or third-party file with `opacity: 5`,
`width: -10`, a dangling `parent`, or a ghost root now **fails loudly at the
boundary** instead of corrupting state later.

> **Reserved-but-unused today:** `states` and the `layout` *constraint* fields
> (`horizontalAlignment` / `verticalAlignment` / `spacing`) are part of the schema so
> later milestones don't require a breaking change, but the current renderer/actions do
> not yet interpret them. **`layout.container` (M2 auto-layout) and the `variables`
> store + `$token` resolution (M5 design tokens) are live.**

## VariableStore (design tokens — LIVE at schema 19, Milestone 5)

```ts
type ThemeMode = "light" | "dark";                 // doc.activeTheme picks the mode

interface Variable {
  type: "color" | "spacing" | "font";
  value: string | number;                          // color/font: string · spacing: number
                                                   // — OR an ALIAS "$other/key" (any type)
  modes?: Partial<Record<ThemeMode, string | number>>; // per-theme overrides (same rules)
}
interface VariableStore { [key: string]: Variable } // key e.g. "color/primary"
```

A `Style` color field referencing `"$color/primary"` resolves against the store under
`doc.activeTheme` at render time (`resolveColor` in `src/core/document/Variables.ts`):
the override for the active theme wins, absent override falls back to `value`, and
aliases chain (token inheritance) with a seen-set — a cycle, a dangling target, or a
wrong-typed target (a spacing number in a color slot) resolves to the visible debug
fallback `#ff006e`, never a throw. Keys must not start with `$` (ambiguous with an
alias), must not be the prototype-machinery names `__proto__`/`constructor`/`prototype`
(RESERVED — `store[key] =` would fire the prototype setter on the edit path, so the rule
keeps edit and load symmetric), are capped at 200 chars, and the store at
`VARIABLES_MAX = 10 000` entries (the OOM-guard discipline; the 18→19 migration truncates
an over-cap legacy store so the file stays loadable). Aliases are NOT required to resolve
at rest: deleting a variable leaves referencing styles/aliases dangling-but-valid (they
render the fallback), so a delete can never corrupt a document. Validation is
`variableStoreError` (+ `variableKeyError`), SHARED by the load path (`Integrity`) and the
edit path so the two cannot drift. The NODE id `"__document__"` (`RESERVED_NODE_ID`) is
likewise reserved on both paths — it is the delta-map key document-level (variables)
deltas travel under.

`doc.activeTheme` ("light"/"dark", absent on the wire = "light") is persisted — a
document reopens in the theme it was saved in — and changed only through an action.

## Components & instances (schema 21, Milestone 6)

A component **master** is an ordinary node subtree in the document — no new storage, so it
reuses every existing mechanism (validation, geometry, layout, serialization, actions,
editing). An **instance** is a `core.instance` node carrying `componentId` (the master's node
id); it draws nothing itself and has **no children in the stored document**.

`expandInstances(doc)` (`Components.ts`) materializes each instance's master subtree as
**virtual** children, returning a DERIVED document — never persisted, never mutated, never
seen by an Action. `computeGeometry` runs it first, so layout, transforms, culling,
hit-testing and both backends work on an ordinary tree with no special cases. Because nothing
is copied into the document, editing a master updates every instance on the next frame.

Virtual ids are `<instance path>::<master node id>`, so they are stable, unique and
REVERSIBLE (`splitVirtualId` → the owning instance + the master node it copies — what
per-child overrides will key on). Virtual nodes are **not selectable** in this slice:
`hitTest`/`nodesInRect` skip them, so clicking instance content selects the instance.

**Overrides (schema 22).** An instance may carry `overrides` — what THIS copy changes about
one node of its master subtree, keyed by MASTER NODE ID:

```ts
interface InstanceOverride { geometry?: Partial<Geometry>; style?: Partial<Style>; text?: string; src?: string }
```

Keying by identity (not position) means an override survives edits to the master and goes
INERT — never invalid — if that master node is deleted. Each field is validated by the SAME
rule its stored counterpart obeys (`styleError`, finite geometry numbers), so an override can
never smuggle in a value the node itself could not hold; the map is capped by
`INSTANCE_MAX_OVERRIDES`. Expansion applies the overrides of the instance driving each level,
so a nested instance applies the ones it carries from the master; overriding THROUGH a nested
instance is deferred. A ROOT override may resize the copy but never move it — its position is
the instance's own geometry. `layout`/`transform` overrides are a later slice.

In the editor, ALT-clicking drills into a copy (`hitTest`'s `includeVirtual`); moving or
resizing it routes through `nodeEdit`'s action factory, which writes an override instead of a
stored-geometry edit. The rotate knob is not offered on a copy (transform overrides are
deferred), in both the renderer and the picker.

Each field is ALSO checked by `overrideAgainstMasterError`, which resolves the key's master node
and applies the same per-type `dimensionError` a stored geometry edit obeys — `overridesError`
alone cannot (it validates a bare map and never learns the master's type), which would let an
override hold a size the node itself could not. Both the load path and the edit path run both
halves, so the routing seam cannot become a validation hole.

**Detach (M6 slice 3).** `DetachInstanceAction` bakes an instance into ordinary nodes and
severs the link to its master — the escape hatch that makes overrides safe to rely on, since
they deliberately reach a limited set of fields. Each baked node is built by the SAME
`materializeNode` expansion uses, so what lands in the document is exactly what was on screen;
the detach adds only the instance's POSITION (which is what placed the content) and fresh ids.
The baked root takes the instance's place in its parent's `children`, keeping the z-order. A
NESTED instance is copied AS an instance, so detaching the outer component does not silently
detach the inner ones — they go on tracking their own masters. A DANGLING instance draws
nothing and so has nothing to bake: the action refuses rather than deleting the node.

Three guards bound recursion (a master containing an instance of itself, or a cycle through
several masters, and nested instances that MULTIPLY rather than add): a per-path master
**chain** (a cycle stops expanding), `INSTANCE_MAX_DEPTH`, and a total materialized-node cap
`INSTANCE_MAX_NODES`. A stopped expansion draws nothing — it never throws. A **dangling**
`componentId` is valid at rest and draws nothing, so deleting a master can never make a
document unloadable (the same rule dangling `$token` aliases follow).

## Boolean nodes (schema 33)

A `core.boolean` combines its CHILDREN — it is the non-destructive form of union / subtract /
intersect / exclude.

```ts
const BOOLEAN_OPS = ["union", "subtract", "intersect", "exclude"] as const;
type BooleanOp = typeof BOOLEAN_OPS[number];
interface Node { booleanOp?: BooleanOp }                       // absent = "union"
function booleanOpError(type: NodeType, op: unknown): string | null;   // shared load + edit
```

The operands stay in the document as an ordinary subtree; the combined shape is DERIVED, by
`resolveBooleans` inside `resolveScene`. So moving a child, restyling it, or switching the
operation re-derives the result, and undo is just an edit to a child. Everything downstream —
layout, picking, snapping, culling, both backends — sees an ordinary `core.path` and needs no
knowledge that booleans exist, exactly as it needs none about instances.

**Field invariants**

| Field | Rule | Enforced |
|-------|------|----------|
| `booleanOp` | only on a `core.boolean`; one of the four names; absent = `"union"` | `booleanOpError`, shared by `Integrity` (load) and `SetBooleanOpAction` (edit) |
| `geometry.width/height` | DERIVED — the resolver sizes the node from the result's tight bounds | `dimensionError` takes the permissive rule (like `core.path`), since a stored box may be stale |
| `children` | the operands, combined in order, innermost boolean first | `resolveBooleans` (a cycle resolves to nothing rather than recursing) |
| `style` | paints the RESULT | the resolved path keeps the boolean's own style |

`booleanAction` (destructive) bakes the same `booleanPaths` result into a plain `core.path` and
deletes the operands; `makeBooleanNodeAction` builds this live form instead.

## Prototype interactions (schema 35, Milestone 7)

A node can respond to a pointer. This is what makes a document a PROTOTYPE rather than a picture.

```ts
const TRIGGERS = ["click", "hover", "press"] as const;
const EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out"] as const;
const TRANSITION_MAX_MS: number;   // 60_000 — a hand-editable field, so bounded
const INTERACTIONS_MAX: number;    // 64 per node — the OOM guard, like STATES_MAX
interface Interaction { trigger: Trigger; state: string | null; target?: string; duration?: number; easing?: Easing }
interface Node { interactions?: Interaction[] }
function interactionsError(interactions: unknown): string | null;   // shared load + edit
```

The only thing an interaction can DO is select a named state, because that mechanism already
exists (schema 30) and `applyActiveState` is a pure pass every consumer reads through. A dangling
state name is INERT, not invalid — deleting a state must never make a document unloadable, the
same rule `componentId`, `$token` aliases and slot fills follow. `state: null` means the base
state, which is what makes hover reversible without a second concept.

**Transitions are the engine's first time dimension**, and they do not bend the architecture:
`blendStates(doc, from, to, t, applyState)` is a PURE function returning an ordinary document, so
an animation frame is just another frame — exactly as a drag preview is an input rather than a
mutation. It interpolates geometry, opacity, fill/stroke, transform (rotation and scale, from the
IDENTITY when one side has none) and the concrete numeric style slots. At `t = 0` and `t = 1` it
returns the corresponding state's own document, so a finished transition is indistinguishable
from having selected that state.

| Rule | Why |
|------|-----|
| a running prototype's state lives in EDITOR state, not `activeState` | playing must not edit the document; stopping leaves it exactly as it was |
| a numeric style slot blends only when BOTH ends are concrete | a `$token` is a reference; averaging it with a number produces neither |
| a non-hex colour SNAPS at the halfway point | it has no channels to mix before the render model resolves it — visible and explainable beats silently wrong |
| easing CLAMPS outside [0,1] | a frame that arrives late must land on the end state, not past it |
| `target` (schema 36) NAVIGATES: the viewport moves to fit that node | changing SCREEN is the other half of prototyping; a dangling target is inert, like the state name |
| a navigation's zoom interpolates GEOMETRICALLY | linear zoom over a wide range barely moves, then lurches |
| the blended document carries NO `activeState` | every consumer resolves through `resolveScene`, which applies it again — naming the target overwrote the interpolation with the target's own values |
| a captured state records geometry and transform, not just style | `blendStates` interpolates them, so style-only capture left most of the transition machinery with no authorable input |

## Serialization

`Serializer.ts` converts to/from a versioned JSON **envelope**. Because JSON has no
`Map` or `Date`, the wire form differs from the runtime form — this is captured by a
distinct type.

```ts
interface SerializedMetadata {          // wire shape: date is an ISO string
  project_name: string;
  created_by: string;
  date: string;
}

interface SerializedDocument {
  version: string;
  document: {
    metadata: SerializedMetadata;
    nodes: Record<string, Node>;        // Map flattened to an object
    rootNodeUuids: string[];
    variables: ProjectDocument["variables"];
    activeTheme?: ThemeMode;            // absent (old/hand-edited files) = "light"
  };
}
```

- `serializeDocument(doc): string` — stamps `version`, writes `date` as `toISOString()`,
  flattens `nodes` via `Object.fromEntries`, `JSON.stringify(..., 2)`.
- `deserializeDocument(json): ProjectDocument` —
  1. `JSON.parse` wrapped to throw a descriptive `"Invalid JSON…"` on failure;
  2. envelope validation (root object, `version` string, `document` object, `nodes` object);
  3. `migrateIfNeeded` (below);
  4. rebuilds the `nodes` `Map`, rehydrates `date` to a `Date`, falls back to
     `createEmptyDocument()` defaults for any missing `metadata` fields.
- `compareDocuments(a, b): boolean` — structural equality over version,
  `metadata.project_name`, `rootNodeUuids` (order-sensitive), and each node.

## Versioning & migration

There are **two independent version identifiers**. Confusing them is a data-loss bug:

| Constant | Meaning | Changes when | Used for |
|----------|---------|--------------|----------|
| `SCHEMA_VERSION` | on-disk document schema (currently `"27"`; chain tail: …17→18 effects, 18→19 design tokens — the first migration with CONTENT: stamps `activeTheme`, coerces legacy string-spacing, drops unvalidatable entries — 19→20 number-token radius/fontSize (pass-through), 20→21 components: pass-through for the new type/field but it RENAMES stored ids containing the now-reserved `::`, 21→22 per-instance overrides (pass-through), 22→23 the image `src` rule: DROPS a src the new `srcError` refuses so an older file still opens, 23→24 the same rule reaching a per-instance OVERRIDE `src`: drops the offending entry so the copy just shows the master's source, 24→25 `Style.strokeWidth` (pass-through: a NEW optional field, so nothing previously-valid becomes invalid), 25→26 `layout`/`transform` on a per-instance override (pass-through, same reason), 26→27 variants: `Node.variant` + `Node.variants` (pass-through — two new optional fields), 27→28 override keys became PATHS (pass-through — every old key is a one-segment path — but required in the other direction, since a schema-27 build REJECTS a key containing `::`), 28→29 slots: `Node.slot` + `Node.slotContent` (pass-through — an old build would draw the slot's DEFAULT children instead of the fill), 31→32 opacity INHERITS — nothing stored changed, which is the point: an INTERPRETATION bump, since an old build renders the children of a 50% group fully opaque, 30→31 layer flags: `Node.hidden` + `Node.locked` (pass-through — an old build would DRAW a node the file says to hide), 29→30 STATES: `Node.states` became a real type + `activeState` — the first SANITIZING migration since 18→19, because `states` was `{[key: string]: any}` validated by nothing, so entries that fail the real rules are DROPPED rather than making the file unloadable) | **only** when the persisted shape **or interpretation** changes | `document.version`, the migration gate |
| `CURRENT_VERSION` | app/release version (injected from `package.json` via esbuild `define`; literal fallback in tests) | every release | display only (status bar, About) |

They are deliberately decoupled: **shipping a new build must never orphan saved
documents.** A drift test pins `CURRENT_VERSION` to `package.json`, and another
asserts `SCHEMA_VERSION` is *not* the app version.

`migrateIfNeeded(raw, currentSchema = SCHEMA_VERSION)` behaviour (the schema is a
parameter so the future-bump case is testable today):
- version **equals** `SCHEMA_VERSION` → pass through.
- **legacy semver** (`0.0.5` etc., written before the split) → same shape as schema 1;
  re-stamped and accepted.
- **numerically newer** than `SCHEMA_VERSION` → throws *"newer than this build supports"*.
- anything else → throws *"Migration not implemented…"* (fails loudly rather than
  silently corrupting).

- **When you bump `SCHEMA_VERSION`:** add the migration step in `migrateIfNeeded`,
  update this doc, and add a round-trip + migration test. (See the freeze rule.)
  Bumping the **app** version requires none of this.

## Persistence (localStorage convenience wrapper)

```ts
type LoadResult =
  | { status: "empty";   document: null }              // nothing saved
  | { status: "loaded";  document: ProjectDocument }
  | { status: "corrupt"; document: null; error: Error };// present but unreadable

Serializer.loadResult(): LoadResult   // distinguishes the three cases
Serializer.load(): ProjectDocument | null   // back-compat: document or null
Serializer.save(doc): SaveResult   // { status: "saved" } | { status: "failed"; error }
```

- Storage key `"vde-document"`; a corrupt payload is preserved to
  `"vde-document.corrupt-backup"` and logged, never silently dropped.
