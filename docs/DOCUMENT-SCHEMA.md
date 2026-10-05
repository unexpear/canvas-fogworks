# Document Schema

<!-- describes: src/core/document -->
<!-- re-read 2026-10-04: schema 90 adds optional document saveMigrations. Older documents stay without a list. -->
<!-- re-read 2026-09-03 for the Canvas Fogworks rename: persisted schema and compatibility
     identifiers were unchanged; only product-facing prose changed at schema 76. -->
<!-- re-read 2026-08-14 after the dropHidden fix: accurate, and NO field moved. `hidden` (line 94)
     is described exactly right and always was — the defect was that `dropHidden` returned an
     enumerated literal and lost the document's OPTIONAL fields alongside the node, which this file
     never claimed otherwise about. Schema still 68. -->
<!-- re-read 2026-08-11 after the rotatedTable fix: accurate, and NO field moved. Art for all
     sixteen masks was already legal here — terrainError accepts any mask 0..15 — and only the
     derivation refused to use it. What the schema says a document may hold is now what the
     picture is derived from. -->
<!-- re-read 2026-08-10 after the cave generator: accurate, and NO field moved. The generator
     writes `Tilemap.terrain.cells` through the same edit path a brush stroke uses, which is the
     clearest evidence schema 63's split (store the question, derive the picture) was the right
     one — a whole generator landed without a schema change. The single `terrain.material` is
     the next real constraint: a generator wanting rock AND water has nowhere to put the second. -->
<!-- re-read 2026-08-10 for schema 64: `Node.className` and `Node.userData` are documented
     below. The earlier note stands — the rectangle gesture added no field. -->

> 🔒 Frozen contract · schema v90 (app v0.0.5). Types are in `src/core/document/`.

Schema 86 adds optional `Node.spatial3d.blockout`: editable box/wall/ramp dimensions, stair
count, or room thickness/ceiling. Geometry buffers are derived, not persisted. Dimensions are
0.001–10000 and stairs are limited to 256. Imported renderables, 2D composition and explicit
box/sphere colliders cannot coexist with blockout. Migration 85→86 preserves existing documents unchanged.
Schema 87 adds optional boolean `spatial3d.blockoutCollision`, initially valid only with a blockout.
Absent/false means visual-only; true derives convex parts for runtime collision. Migration 86→87
does not enable collision implicitly. Generated hulls are never serialized into documents or progress.

Schema 88 adds optional `spatial3d.solidTree`, mutually exclusive with `blockout`, `renderable`,
`composition2d` and explicit `collider`. The existing `blockoutCollision` opt-in also applies to
solid trees. Shape leaves store an ID, blockout parameters, position/rotation/scale triples;
rotation is in degrees applied X then Y then Z. Operation branches store an ID, add/subtract/intersect,
and left/right children. IDs are unique safe 1–64-character names. Trees are limited to 31 nodes
and depth 8; positions to ±10000, rotations to ±36000, and absolute scales to .001–1000.
Unknown fields, invalid topology, excessive evaluation and GPU-degenerate results are refused
before adoption. Rendering and collision share evaluated geometry; only editable operands are saved.
Migration 87→88 preserves existing scenes and does not convert blockouts or enable collision.

Schema 89 adds optional `animation.transitions[].fade` and `spatial3d.animation.fade`, both in seconds,
greater than 0 and at most 1. Absent still cuts to the next clip immediately. A fade blends the
outgoing and incoming timeline clips, or the previous and next glTF clips, and then finishes.
Migration 88→89 does not invent fade durations.

Schema 90 adds optional document `saveMigrations`: at most eight `{ fromGameId, versions }` records.
`fromGameId` is a previous package-content SHA-256. `versions` lists player-progress formats 1–6
that this document may adopt from that hash. Absent or empty means no cross-build adoption.
The inspector writes the list through `SetSaveMigrationsAction`. Export copies the entry
document's list onto the package. Migration 89→90 does not invent a list.

Schema 78 adds `Entity.rules`, `rulePolicy`, `gravity3d`, `restitution3d`, and `Spatial3D.animation`. Migration 77→78 preserves absent fields. Rules hold typed events, conditions and runtime commands; sound commands embed bounded audio data URLs. Mesh playback stores clip indices, optional secondary clip/blend, speed and loop—not joint buffers or clocks. See [Production workflows](PRODUCTION-WORK.md).

Schema 79 adds the optional `interact` gameplay event and positive `range` (at most 10,000),
`spawn` actions naming a template node ID, and `checkpoint` actions. Migration 78→79 preserves
all existing fields. Player-save format v1 is separate from project schema and document history.
See [Gameplay foundations](GAMEPLAY-FOUNDATIONS.md).

Schema 80 adds optional `Entity.behavior`: a version-1 graph with an enabled flag and at most
64 typed event/branch/action nodes. Links must resolve, cannot target events and cannot form
cycles. Node IDs, conditions and actions are validated by the same entity validator used by
load and Actions. Migration 79→80 leaves existing entities unchanged. See [Behavior graphs](BEHAVIOR-GRAPHS.md).

Schema 81 adds graph-v2 delay/repeat nodes and optional `behaviorAssets` (up to 128 unique named
graphs). An entity may bind `behaviorAssetId` instead of inline `behavior`; load and edit paths
reject missing references and simultaneous inline/reference fields. `SetBehaviorAssetsAction`
updates the table and optional entity binding atomically. Migration 80→81 is non-destructive.
Player-progress v2 is separate and saves bounded continuations without debugger state; v1 saves
still load with no pending jobs. See [Behavior graphs](BEHAVIOR-GRAPHS.md).

Schema 82 adds graph-v3 lifecycle/custom event declarations and emit nodes; old graphs keep their
versions. Player-progress v3 separately adds lifecycle notification bookkeeping and accepts v1/v2
saves. The broader gameplay goal remains in progress; see [its delivery plan](GAMEPLAY-FIVE-PART-GOAL.md).

Schema 83 adds optional `gameplayVariables`: up to 256 number, boolean or string declarations,
with entity-local or game scope and type-checked defaults. Graph-v4 assignment/comparison nodes
reference these declarations; deleting or changing a referenced type is refused. Arithmetic is
numeric only, finite and bounded; division by zero fails the current execution. Migration 82→83
leaves old graphs and design tokens unchanged. Player-progress v4 separately stores typed values
and accepts older v1/v2/v3 saves with declaration defaults. Shared game values span actors in the
active level. Player-progress v6, a separate save format, also carries those game values and
visited-level snapshots across transitions. Document schema 89 is unchanged by that save format.

Schema 84 adds optional `behaviorFunctions` (at most 128 uniquely named-ID definitions), with
typed inputs, outputs and invocation-local fields. Each body has an explicit entry and at most
64 nodes; call chains cannot recurse or exceed 16 levels. Local values start at scalar zero.
Load and library-edit Actions validate nested references and types; gameplay declarations cannot
be removed while a function uses them. Migration 83→84 is a pass-through. Library persistence and
single-instruction execution helpers were the initial delivery. Schema 85 adds graph-v5 `call`
nodes with typed input sources and output destinations. Root calls bind outputs to gameplay fields;
nested calls may bind to caller locals. Player-progress v5 stores bounded typed call frames without
definitions; older v1–v4 saves remain supported. The shared scheduler, root-call inspector,
qualified function breakpoints and frame watches are integrated. The function library also has
draft-based visual authoring with explicit validated Apply, Action-backed undo, typed ports,
local storage and nested-call bindings. Unapplied drafts are editor state, not serialized data.

### Animation controllers (schema 77)

`Node.animation?: AnimationController` stores `initial`, an optional driver node id,
1–64 named `{ name, clip, speed? }` states and up to 256 ordered `{ from, to, when }`
transitions. State names are unique, bounded to 64 characters; speed is finite, >0 and ≤16.
Initial/from/to references must resolve within the controller. Clip and driver references
may be unresolved after editing or importing; the panel reports them and affected playback
is inert. `when` is one of the typed conditions in `AnimationController.ts`.

The controller drives the node and descendants until another controller establishes a scope.
Runtime playheads and entry times are transient. `SetAnimationControllerAction` is the write
path, sharing validation with load. The 76→77 migration adds no fields to older documents.
See [Animation workflow](ANIMATION.md) for transition timing and current 3D limits.

### Typed 3D authoring state (schemas 74–76)

The document may carry an `assets3d` table of stable mesh, material and texture records,
and any node may carry `spatial3d` with a required position/quaternion/scale transform plus
optional camera, light, asset-backed renderable, collider, environment and 2D-composition
components. `composition2d` explicitly chooses a transform-following plane or camera-facing
billboard, a positive pixels-per-unit scale and lit/unlit behavior. These are separate
from the established 2D transform and deformation mesh contracts.

Asset `source` values are bounded, normalized project-relative paths. They are provenance for
reimport, not identity; scene references use `Asset3D.id`. References are allowed to be unresolved
so an asset removal leaves an inert component rather than a document that cannot be opened.

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
  entity?: Entity;                  // schema 73 — validated engine-owned gameplay declarations
}

interface Entity {
  body?: "static" | "dynamic" | "oneway";
  rules?: readonly GameplayRule[];
  rulePolicy?: "platformer" | "authored";
  gravity3d?: number;
  restitution3d?: number;
  friction?: number;
  player?: boolean;
  respawnAt?: string;
  transitionTo?: string;
  stompable?: boolean;
  patrol?: number;
  deadly?: boolean;
  goal?: boolean;
  collectible?: boolean;
  powers?: number;
  stars?: number;
  bounces?: number;
  warpsTo?: string;
}

`entity` is the typed runtime contract. Imported and custom `userData` remains lossless; migration
projects recognized schema-72 conventions into `entity` without deleting their original values.
Tileset tiles use the same entity shape and may additionally preserve Tiled class, properties,
collision, animation and wangset data.

interface Geometry { x: number; y: number; width: number; height: number; }
// COORDINATE SPACE: x/y are PARENT-RELATIVE. See the rule below.

// BACKGROUND (schema 70). Document.background?: string — what the document SITS ON: the sky, the
// paper, the stage. Absent = transparent, which is what every document was: nothing in the tree
// carried a background of any kind, so what a level appeared to sit on was the EDITOR'S chrome. A
// run therefore had no sky, an export emitted no ground colour, and a Tiled map's own
// `backgroundcolor` (3 of the 24 maps here declare one) was read by nothing.
// DOCUMENT-LEVEL RATHER THAN A NODE, for the reason `lights` is: it is a property of the SCENE. A
// giant rectangle behind everything would be selectable, draggable, deletable and INSIDE
// `contentBounds` — the bounds the follow camera clamps to and the death plane is derived from — so
// the sky would move the edge of the world.
// One string, because that is what the corpus declares. Validated for SHAPE, not colour: these are
// whatever CSS accepts, so a hex-only rule would refuse documents the renderer draws perfectly. An
// EMPTY string is refused — absent is how a document says it has no sky, empty is a typo.
// Written only by `SetBackgroundAction`, painted in SCREEN space by all three backends, and
// exported as a real `<rect>` rather than a style on the root. KNOWN DIVERGENCE: `gl.clearColor`
// takes floats, so the GPU parses hex and falls back to the editor backdrop on names and `rgb()`.
//
// SCREEN (schema 72). Document.screen?: { width, height } — ONE SCREEN of the game: the play
// area's size in world units, anchored at the origin (a size, not a rect — the one document whose
// play area starts elsewhere moves its content). Absent = undeclared, which is every pre-72
// document: drawing nothing, changing nothing. THE RECTANGLE AN EDITOR SHOULD SHOW IS NOT THE
// CONTENT'S EXTENT — content past the edge is normal in a scrolling level, and `contentBounds`
// measures where things happen to be (an empty scenery row once moved the death plane by 18px).
// Godot draws its project viewport this way (four translucent lines, nothing dimmed, on by
// default) and GameMaker its room views; the outline here is editor CHROME, emitted first in the
// render model's overlay, never a node and never exported. Validated FINITE AND POSITIVE, nothing
// else. Written only by `SetScreenAction`; a Tiled import declares the map's own pixel size in the
// same transaction, and never resizes a screen the document already declares. A document that
// declares its screen also OPENS on it (M18 slice 33): `viewportToScreen` pins the vertical axis
// (height exact, origin at the screen's — the same axis rule `playBounds` gives the run), so
// decoration cannot move what you see on open and no geometry is computed to frame a statement.
// READ by the runtime
// through `playBounds` (M18 slice 32): a declared screen pins the run's VERTICAL extent — the death
// plane and the camera's clamp — while the horizontal span stays measured, because a side-scroller
// is as long as its content but as tall as one screen. A vertically scrolling level wants the
// opposite axes and is not served yet; its author should not declare a screen.
//
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

// IMAGE REGIONS AND PIXEL ART (schema 51). The two things real game art needs and could not say.
// Node.sourceRect?: { x, y, width, height }   — a sub-rectangle of the SOURCE image, in its pixels
// Node.pixelated?: boolean                    — scale by NEAREST NEIGHBOUR; absent = smooth, as before
//
// EVERY BACKEND DREW WHOLE IMAGES. `emitCanvas` used the 5-argument `drawImage`, `emitSVG` wrote a
// plain `<image href>`, `emitWebGL` mapped the texture across the destination rect. So a tileset or
// a sprite strip could only ever be drawn entire — and that is how game art actually ships. Four of
// five real packs measured were grids inside single files: a creature strip is 20x4 cells of 32x32,
// an RPG tileset 15x7 of 24x24, a weapon set 24 columns of 16px.
//
// THE RECT IS IN SOURCE PIXELS, not fractions — the opposite of the call schema 43 made for mesh
// points, and for a reason that does not apply here. A mesh's box is IN the document, so a fraction
// stays meaningful when the box resizes. An image's pixel size is NOT in the document: it belongs to
// a file that may not have decoded yet, or at all. Pixels are also the unit the art is authored in —
// "the tile at column 3, row 2" is x=72, y=48, w=24, h=24 — and a fraction would force every author
// to divide by a number the document cannot see.
//
// IT CANNOT BE VALIDATED AGAINST THE IMAGE, and saying so is more useful than pretending otherwise.
// The loader checks that the rect is finite, positive and bounded; whether it lies inside the actual
// pixels is unknowable until the file decodes, and unknowable forever if it never does. A rect
// outside the image draws NOTHING, which is the same thing every one of these backends already does
// with an href that will not load.
//
// PIXELATED IS PER NODE, not per document. One scene legitimately mixes a 24px tileset that must
// stay crisp with a photographic background that must not, and a document-wide switch would force
// the author to choose which one looks wrong. Absent = smooth, so nothing already drawn changes.

// SPRITE-SHEET PLAYBACK (schema 52). `sourceRect` joins the fields a StateDefinition may carry.
// InstanceOverride.sourceRect?: SourceRect     — and so, therefore, may a keyframe and a state
//
// ONE ADDITION, THREE CAPABILITIES, because `StateDefinition` IS `InstanceOverride`: a region
// becomes keyframable, state-able and instance-overridable at once. Keyframable is the one that
// matters — a walk cycle is one image and a keyframe per cell, which is how every 2D engine plays
// a sheet. Instance-overridable is the one that makes a TILEMAP cheap: one tile node, an instance
// per cell, each naming its own region.
//
// A REGION STEPS, IT NEVER TWEENS, and this is the rule that makes the feature work rather than
// merely typecheck. Interpolating a rect slides a window across the sheet and shows a smear of two
// cells: the numbers blend perfectly and the picture is garbage. So `blendNode` takes the FROM
// keyframe's region for the whole interval — deliberately the opposite of the `{ ...to }` the rest
// of the node starts from, which would change the cell the instant an interval began and show
// every frame one keyframe early.

// INVERSE KINEMATICS (schema 49). Pose a limb by its HAND; the shoulder and elbow are derived.
// Node.ik?: IkConstraint             — carried by the END EFFECTOR, the node being placed
interface IkConstraint { x: number; y: number; bend?: 1 | -1; chain?: number }   // target in the ROOT's parent space
//
// The rig is the SCENE GRAPH — a parent's matrix already composes into its children, so a two-bone
// chain needs no bone type. What was missing is stating where the hand goes and having the angles
// follow. The constraint sits on the effector because that is the node whose position is being
// stated; the two bones it drives are its parent and grandparent.
//
// BONE LENGTHS ARE NOT STORED. A bone runs JOINT TO JOINT — parent's transform origin to child's —
// and its length is the magnitude of that vector, which the document already holds. The same
// "derive it, never duplicate it" the motion path makes about its endpoints. Measuring between node
// POSITIONS rather than joints is the subtle version of getting this wrong: the effector lands
// several pixels off and WANDERS as the middle joint turns, because the vector a rotation actually
// swings starts at the pivot, not at the corner.
//
// BEND is anatomy and is authored (+1 or -1). The triangle has two mirrored solutions and both are
// correct; inferring one from the current pose lets a knee flip inside out whenever the chain
// passes through straight.
//
// CHAIN is how many BONES the constraint drives, counted up from the effector. Absent = 2, which
// is the limb and the case that existed before longer chains did, so nothing reinterprets. Two
// bones are solved by the closed form; three or more by FABRIK, because past two there is no
// unique pose at all — the same hand position is reachable by infinitely many, and the solver's
// job becomes finding a natural one rather than finding the one.
//
// BEND AND A LONG CHAIN ARE REFUSED TOGETHER. A triangle has exactly two solutions and `bend`
// names one; a longer chain has a continuum and there is nothing for +1 or -1 to select. Carrying
// both is a statement the engine cannot honour, so it is refused rather than half-applied.
//
// A TARGET OUT OF REACH straightens the chain toward it rather than failing — the distance is
// clamped into [|l1 - l2|, l1 + l2] before the cosines, so the straightened pose IS the ordinary
// answer at the boundary and not a second code path.
//
// Applied at the DISPLAY SEAM beside `applyFrame`, so a solved rig is an ordinary document.

// MOTION PATHS (schema 48). A position tween that is a CURVE rather than a straight line.
// Keyframe.motion?: MotionPath      — shapes the position tween LEAVING this keyframe
interface MotionPath { c1: {x: number; y: number}; c2: {x: number; y: number} }   // OFFSETS, see below
//
// Everything moved in straight lines. A thrown ball travels on an ARC, and the only way to say so
// was to add keyframes along the curve — which is not the same animation: it is a polyline the
// author has to re-fit every time either end moves, and an editor then shows six keyframes nobody
// authored. One curve says it once.
//
// THE ENDPOINTS ARE NOT STORED. A segment's ends are the two keyframes' own positions, so only the
// two control points are kept and a path cannot come to disagree with the keyframes it joins.
// They are OFFSETS from their nearest endpoint — `c1` from the leaving keyframe, `c2` from the
// arriving one — for the same reason mesh points became fractions in schema 43: move a keyframe
// and the curve follows it, instead of snapping back to coordinates authored against an old
// position.
//
// PROGRESS IS ARC LENGTH, not the Bezier parameter. Equal steps in a cubic's parameter are NOT
// equal steps in distance — a curve with long handles crawls at its ends and races through its
// middle, which reads as an ease nobody asked for and would silently fight the easing curve that
// IS authored. Spacing is the whole subject of the exercises this engine is for, so `t` is
// resolved against a sampled length table: `easing` shapes the spacing and the path shapes only
// the route. See `document/MotionPath`.
//
// A KEYFRAME MAY NOT SAY IT TWICE. `easings` naming `geometry.x` or `geometry.y` on a keyframe
// that also carries a `motion` is refused: a route with one progress and its own coordinates
// separately eased are two different animations, and picking one would be a guess. A CHANNEL on
// either coordinate is refused for the same reason when the track segment under it has a path.

// CHANNELS (schema 47). Independent per-property TIMING — rotation keyed on frames position has none.
// Node.channels?: Record<string, Keyframe[]>   — keyed by property path; absent = the track is all
//
// A KEYFRAME HOLDS A WHOLE STATE, and that is the limitation this lifts. Until now a node had one
// track, so every property it animated had to key on the same frames: a ball that travels at a
// steady speed while bouncing seven times needed seven horizontal keyframes it did not want, and
// an arm that keeps swinging after the body stops could not be said at all. Overlapping action —
// the single most-taught principle after squash and stretch — is exactly the case where one
// property's timing must outlive another's.
//
// A CHANNEL IS A TRACK, not a new idea. Same `Keyframe`, same ascending-frame rule, same `hold`,
// same easing, validated by the same `trackError` and the same `overrideValueError`. The only
// added rule is that a channel's keyframes may name ONLY its own path — a channel called
// `transform.rotation` whose keyframe sets `geometry.x` is a statement with two meanings, and the
// loader refuses it rather than picking one.
//
// THE TRACK STILL WINS NOTHING AND LOSES NOTHING: channels are applied AFTER the track, so a
// property named by both takes the channel's value. That order is the useful one — a channel is
// the more specific statement, added deliberately to override the general one — and it makes an
// existing document's behaviour reachable by not writing a channel at all.
//
// PATHS ARE THE SAME SET `easings` accepts (`EASABLE_PATHS`), for the same reason: a path that
// interpolates nothing would silently animate nothing, which is indistinguishable from a curve
// that is wrong. `CHANNELS_MAX` bounds the map for the reason every other map here is bounded.

// CLIPS (schema 46). Named frame ranges over the one timeline — `idle`, `walk`, `jump`.
interface Clip { name: string; from: number; to: number; loop?: boolean }   // both ends INCLUSIVE
// Document.clips?: Clip[]                — absent = the whole timeline is the only animation
//
// A game character is not one animation, it is a dozen, and until now a document held exactly one
// timeline — so idle, walk and jump could not live in the same file. A clip is a NAMED RANGE
// rather than a separate timeline per animation, which is how sprite sheets and every 2D engine
// express the same thing: one strip of frames, cut into runs. Keeping one clock means a keyframe
// is still just a keyframe, the trace still measures frames, and nothing below this had to learn
// a new idea.
//
// BOTH ENDS INCLUSIVE, matching `traceTiming` and the timeline strip: a clip from 0 to 11 at 12fps
// is one second and twelve drawings, not eleven twelfths of one. An exclusive end would make every
// clip a frame short in a way nobody notices until the loop stutters.
//
// `loop` defaults to TRUE, because the overwhelming majority of character clips cycle — idle,
// walk, run — and the ones that do not (a death, a one-shot attack) are the ones an author will
// think about. Defaults should be the common case, not the safe-sounding one.
//
// NAMES ARE UNIQUE and are the identity: a clip is selected by name, and two clips called `walk`
// would make "play walk" ambiguous. The list is ORDERED because that is the order a person
// arranged them in, and an editor showing them in map order would reshuffle somebody's work.
//
// Every clip must lie INSIDE the timeline, and a document with clips must have a timeline at all —
// a range over a clock that does not exist cannot be played, and accepting one would push the
// failure to whoever tried.

// A keyframe is a StateDefinition at a time, so it inherits `overrideValueError` and
// `materializeNode`; a TWEEN is `blendNode`, written for state transitions. Animation added a
// field, not a second definition of what a node may say about itself. Outside a track's range the
// nearest keyframe is HELD, never extrapolated. `applyFrame` runs inside `resolveScene`, so a
// document at a frame is an ORDINARY document and nothing below the display seam knows time exists.

interface Style {
  fill: string | Gradient;  // color, token id ("$color/primary", resolved against variables, M5), OR a gradient (schema 56)
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
  parent. The bare reparent action still preserves stored local coordinates, not world
  position; callers that need a visually stationary reparent pair it with a geometry move.

**Rotation / scale — landed in schema 2 (Milestone 1).** `Node.transform` is optional:

```ts
interface Transform {
  rotation?: number;                    // radians, clockwise
  scaleX?: number; scaleY?: number;
  origin?: { x: number; y: number };    // fraction of the node's box; default centre
}
```

**`origin` IS THE ANIMATION ANCHOR, and it is how squash-and-stretch and joints are
authored.** This is written down because it was already true in the code and stated
nowhere, and the absence cost a wrong entry in the project's own notes: a demo
squashed a shape by animating `geometry.width`/`height`, watched it grow out of its
left edge, and concluded the engine had no pivot. It has one.

The distinction is the whole of it:

- Animating **`geometry.width`/`height`** moves the BOX. The box's origin is its
  top-left `x,y`, so a widening shape grows rightward and downward and the animator
  must hand-compensate `x` and `y` on every keyframe to keep it centred or planted.
- Animating **`transform.scaleX`/`scaleY`** scales about `origin`. With the default
  centre a squash grows symmetrically; with `{x: 0.5, y: 1}` the shape's FEET stay
  planted while it flattens, which is what squash-and-stretch means and what a
  character standing on the ground requires. Verified: a 100-tall box at y 100..200
  under `scaleY: 0.6` about `{0.5, 1}` occupies y 140..200 — the bottom does not move.
- Rotation about a non-centre origin is a JOINT. `{x: 0.5, y: 0}` swings a limb from
  its top end, which is the primitive skeletal rigging will be built on.

So: **animate `transform` for deformation, `geometry` for placement.** A demo or a rig
that animates width to squash is doing arithmetic the anchor already does.

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
  shrunk — flex-shrink had not landed at schema 5; schema 9 added it). `grow` and
  `alignItems: "stretch"` are orthogonal
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

> **Reserved-but-unused today:** the legacy `layout` constraint fields
> (`horizontalAlignment` / `verticalAlignment` / `spacing`) round-trip but are not
> interpreted by the current layout engine. **`states` (M7), `layout.container` plus
> grow/shrink (M2), and the `variables` store + `$token` resolution (M5) are live.**

## RasterSurface (pixels the document OWNS — schema 55)

```ts
type NodeType = ... | "core.raster";

interface RasterSurface {
    data: string;    // PixelCodec output: base64 of a run-length payload
    width: number;
    height: number;
}
interface Node { ...; surface?: RasterSurface }

function rasterSurfaceError(surface: unknown): string | null;
const RASTER_MAX_SIDE: number;   // 4096
```

**THE DIFFERENCE FROM `core.image` IS AUTHORSHIP.** An image node REFERENCES a picture somebody
else made — `src` is a URL or a data URI, and every import path in `core/import` produces one. A
raster node holds pixels the USER PAINTED, and it is the first node type in this engine that does.
Every paint tool writes here.

**DIMENSIONS LIVE BESIDE THE PAYLOAD, not inside it.** A surface resized in the document and a
payload written before that resize must not be able to disagree about which is authoritative, so
the node states the size and `decodeSurface` REFUSES a payload that does not fill it exactly —
rather than padding a transparent band, which reads as an art mistake.

**A SURFACE ONLY ON A RASTER, and the loader did not check it until 2026-08-09.** `AddNodeAction`
and `PaintSurfaceAction` both enforce the rule, and `Integrity` cites it as the precedent for its
tilemap check while never applying it — so a hand-edited or machine-generated file could carry pixels
on a rectangle: stored, saved, and drawn by nothing. Found by a SURVIVING MUTANT: removing
`BucketTool`'s type check changed no test, which is what sent me looking for whatever else was
supposed to be refusing that document. Nothing was. **Not a compatibility break** by the freeze
rule's own question — no build could ever write such a document, because both actions refuse it, and
a hand edit is not a contract.

**`rasterSurfaceError` checks SHAPE, not pixels.** Validation runs on every load; decoding a
4096-square surface to check it would cost a full decode per document. The payload is validated
when something actually needs the pixels.

**Schema 55 changes no existing field**, and that is precisely why the version had to move: schema
54 had no node type that could hold a surface, so an older build meeting a `core.raster` node would
find a `type` it does not know. `migrate_54_to_55` is a re-stamp, and the gate that refuses a
future schema is what makes that safe.

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

## Components & instances (schemas 21–29, Milestone 6)

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
REVERSIBLE (`splitVirtualId` → the owning instance + the master node it copies). A plain click
selects the owning instance; ALT-click asks `hitTest` to include virtual nodes and selects the
copy for override editing. Marquee selection continues to select stored nodes rather than
scattering across a component's internals.

**Overrides (schemas 22–29).** An instance may carry `overrides` — what THIS copy changes about
one node of its master subtree. Schema 28 made the key a PATH of master-node ids, so an outer
instance can target content through a nested instance:

```ts
interface InstanceOverride {
  geometry?: Partial<Geometry>;
  style?: Partial<Style>;
  text?: string;
  src?: string;
  sourceRect?: SourceRect;
  layout?: Partial<Layout>;
  transform?: Partial<Transform>;
  slotContent?: Record<string, string>;
}
```

Keying by an identity path (not position) means an override survives edits to the master and
goes INERT — never invalid — if a target master node is deleted. Each field is validated by the SAME
rule its stored counterpart obeys (`styleError`, finite geometry numbers), so an override can
never smuggle in a value the node itself could not hold; the map is capped by
`INSTANCE_MAX_OVERRIDES`. Expansion applies the overrides of the instance driving each level.
A ROOT override may resize the copy but never move it — its position is the instance's own
geometry. Layout and transform overrides landed in schema 26; nested override paths in schema
28; slot-content overrides in schema 29.

In the editor, ALT-clicking drills into a copy (`hitTest`'s `includeVirtual`). Geometry, style,
content, layout and transform edits route through `nodeEdit` factories, which write overrides
instead of stored-node edits. Transform overrides make the rotate control live on copies.

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

**Variants (schema 27).** A master may carry a `VariantKey`; an instance carries a sparse
property selection. `resolveVariantMaster` chooses an exact member of the same set and falls
back to the pointed-at master when nothing matches. Switching variants remaps overrides by
stable identity/name where possible and preserves unmatched entries inertly.

**Slots (schema 29).** Any node in a master may name a slot. An instance's `slotContent` maps
that name to a stored node used as the fill; absent or dangling fills fall back to the slot's
own children. Slot content is a reference, not a reparent, and nested slot fills travel through
the same override-path mechanism.

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

## Historical pre-schema-56 gradient note (superseded)

This was the schema-55 boundary: `core/document/Gradient.ts` existed while `Style.fill` was still
only a colour string, so there was then nothing to migrate and no schema bump to make.

It remains here as migration history, not current status. Gradients became persisted `Style.fill`
values in schema 56; the current contract is the later **Gradient (schema 56)** section below.

At this boundary `core/import/SvgGradient.ts` read them — 3,090 of the corpus's 3,127 gradient tags (the other
37 are duplicate ids, which a browser resolves to the first and so does this). Nothing consumes the
result yet, for the same reason: there is nowhere in a document to put one.

Making it a fill IS a schema change — `Style.fill` would become a colour **or** a gradient, which
alters the interpretation of a persisted field and therefore demands a `SCHEMA_VERSION` bump, a
`migrate_55_to_56` step, and this banner moving with it. That is the next commit's job, not a side
effect of adding a model.

The model's shape was measured before it was designed: 3,127 gradients across 516 of 5,279 SVG
files, 97% linear, 96% exactly two stops (worst case 11), **72% carrying a `gradientTransform`**,
and **95% using `userSpaceOnUse` rather than SVG's own default**. Exactly one stroke in the corpus
references a gradient against 2,491 fills, which is why stroke gradients are not modelled.

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
| `SCHEMA_VERSION` | on-disk document schema (read the current value and migration chain from `Document.ts` / `Serializer.ts`; do not duplicate the number here) | **only** when the persisted shape **or interpretation** changes | `document.version`, the migration gate |
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

## Nine-slice (a bitmap whose corners keep their size — schema 57)

```ts
interface NineSliceInsets { left: number; top: number; right: number; bottom: number }
Node.nineSlice?: NineSliceInsets            // only core.image / core.raster; absent = one stretched picture

nineSliceError(type, slice): string | null  // shared by the edit path and the load path
nineSliceRects(source, dest, insets): { src: Rect; dst: Rect }[]   // geometry/NineSlice
```

**Insets are in SOURCE pixels**, relative to `sourceRect` when there is one — so a sliced button
can live inside an atlas, and a four-pixel border stays four pixels however large the panel grows.
A fraction of the box would thicken as the panel grew, which is the exact thing nine-slice prevents.

**Solved as geometry, not three times in three backends.** Each backend already draws one
sub-rectangle of an image into one destination rectangle — Canvas has the nine-argument
`drawImage`, SVG a nested `<svg viewBox>`, the GPU a quad with a uv rect — so the whole feature is
a list of (source, destination) pairs and each backend doing nine of what it already does.

**The insets travel, not the nine rectangles.** The pieces depend on the source's pixel size, and
for a `core.image` with no `sourceRect` that is unknown until the file decodes — which the pure
render model can never wait for. So each backend calls the shared `nineSliceRects` with the size it
has: three call sites, one arithmetic.

**Overflow scales both corners.** A twelve-pixel border in an eight-pixel box cannot have both
corners at native size; clamping one makes it asymmetric, clipping loses the detail the corner
exists for, and overlapping draws the same pixels twice. Scaling both is what CSS `border-image`
does. A piece with no extent is omitted rather than drawn at zero — Canvas throws on a zero-width
source rect, and a panel whose middle has collapsed genuinely has four pieces.

**Stretched, not tiled.** Tiling needs a repeat count, a rule for partial tiles and a per-axis
choice; it is not pretended to exist.

## `core.tilemap` — a grid instead of a node per cell (schema 61)

```ts
Node.tilemap?: Tilemap                       // only on a core.tilemap, and required there
Tilemap { cols, rows, tileWidth, tileHeight, sheet: TileSheet, tiles: number[], flips?: number[] }
TileSheet { columns, tileWidth, tileHeight, spacing, margin }   // sheet pixels
TILE_EMPTY = -1        TILEMAP_MAX_CELLS = 1_048_576
```

**MEASURED BEFORE BUILDING.** Importing `Roguelike Base Pack/Map/sample_map.tmx` (100×100, 5 layers)
made one `core.image` per non-empty cell: **10,618 nodes, 22ms** to compute geometry and build the
render model — over a 16ms frame, before anything was drawn — and **5.66MB** of JSON. Every node
carried a full geometry, style, layout and transform to say "this 16px tile, here". It becomes
**five nodes** here, one per layer.

**AND MEASURED AFTER**, both halves in one run once `tilemapForLayer` existed — the same map imported
both ways, then the frame derived over the whole map:

| | nodes | saved JSON | first frame | warm frame | to place |
|---|---|---|---|---|---|
| one `core.image` per cell | 10,618 | 7.80 MB | 32.3 ms | 12.1 ms | 1,244 ms |
| one `core.tilemap` per layer | 5 | 0.77 MB | 0.8 ms | 0.1 ms | 4 ms |

Those figures are not corrections of the ones above: 22ms was a single cold derivation, and 32.3 ms
is the same kind of measurement on a machine and a schema several versions apart. What has not
changed is the shape of the answer. The per-cell import of that map could in fact never be **saved**
at all — every node carries the sheet's whole data URL, so `cloneDocument` throws
`RangeError: Invalid string length` at the first revision commit, ~650MB against V8's ~512MB cap.

**It is also what autotiling needs**, and that is the deeper reason. Autotiling is a function from
*terrain* to tile, and the node-per-cell document stored only the answer with nowhere to put the
question — the same shape of mistake as flattening a gradient to its midpoint colour.

**Indices, not GIDs.** Tiled's global ids are numbered across every set a map uses, so a cell's
meaning depends on a table it is not stored beside. A `Tilemap` names its sheet and indexes into
that one sheet, so a layer means the same thing wherever it is pasted. `TiledMap.tileSourceRect`
now keeps only the *gid semantics* and delegates the slicing arithmetic to `Tilemap.tileSourceRect`
— the same function the renderer calls, because an importer and a renderer that slice a sheet
differently draw the map one pixel out per column.

**The model emits ONE item and culls the cells itself**, because it is the only thing that knows
the viewport; three backends each deriving the range would be three chances to disagree about
which row is the last. The visible rect is *asked of* `localVisibleRect` in the geometry engine
rather than derived, since the render model may not compose coordinates — an invariant with its own
test.

**A cell can be TURNED (schema 62)** — `flips`, a parallel array of three bits per cell: horizontal,
vertical, and the diagonal, which is a transpose. **Measured**: 820 of the corpus's 22,808 non-empty
cells are flipped, in **14 of its 20 maps**, and every one of the eight combinations appears
including 351 with the diagonal bit. The node-per-cell importer already honoured these, so a grid
without them would have been a regression, not a gap.

A parallel array rather than bits packed into `tiles`, so an index stays an index — every reader and
every saved file shows the tile number expected rather than one with three invisible bits on top.
Absent is the common case and costs nothing. **Transpose first, then mirror**: Tiled's order, which
is not commutative, stated once in `flipMatrix` and shared by every backend that takes a matrix. The
GPU cannot take one, so it turns the within-cell coordinate instead — reading the three bits out of
the index texture's otherwise-unused **blue byte**, which costs no second texture or upload.

**AUTHORED METADATA: what the engine carries and never reads (schema 64).** Any node may carry
`className` — the author's own KIND for it, an imported object's `class` — and `userData`, a map from
a property NAME to `{ type, propertyType?, value }`. Both are validated on load (`classNameError`,
`userDataError`) and both are absent unless set; an empty value CLEARS the field rather than being
stored, so a document only ever mentions them where somebody meant something.

**THE VALUE IS TEXT, AND THE MEASUREMENT IS WHY.** All 41 custom properties in this tree live in ONE
file (`test-fixtures/tiled/object-only.tmx`, a real Tiled sample); the other 23 `.tmx` and all 20
shipped asset packs carry none. So "no int, no colour, no file anywhere" is one game's vocabulary —
`bodyType`, `friction` and `floating` are a physics engine's words — and not a survey. Storing a
parsed `string | number | boolean` would discard four of the format's eight declared types on the
authority of a sample of one, and this engine EXPORTS `.tmx`, so a type it cannot represent is data
destroyed by opening and saving. `type` is deliberately NOT an enum: a file written by a newer editor
has to come back out untouched, and a closed set would be a validator that deletes the future.

**NOTHING READS EITHER FIELD, AND THAT IS THE FEATURE.** They exist so that a map opened here and
saved again is the map that was opened. `className` is NOT `node.type`: that one is what the renderer
draws (`core.rectangle`) and is a closed set it switches on, while this is the author's word for what
the thing IS — two different questions the format happens to spell the same, so the one the renderer
does not read is the one that moved.

**A MATERIAL HAS A NAME AND A SWATCH (schema 66), both optional.** Nothing derives from either — the id is the identity and the picture comes from `art` — they are what tells four materials apart in a list where all of them would otherwise read as a number. Every `wangcolor` in a real tileset carries both. `copyTerrainMaterial` is the ONE place a material is copied, because a record rebuilt field by field is how this codebase has lost a field three times before — and a fourth: this sentence used to say four paths rebuild the list *and call it*, while the inspector panel hand-rolled `{ id, art }` and dropped both of these on every add, reorder and remove. A copier cannot protect a list somebody else assembled, so the three list-shaping edits (`reorderTerrainMaterial`, `removeTerrainMaterial`, `addTerrainMaterial`) now take a MAP and derive the list themselves. Nothing outside `TilemapEdit` rebuilds a material.

**A TERRAIN LAYER DRAWS A LIST OF MATERIALS, IN PAINT ORDER (schema 65).** `TerrainField.materials`
replaced the single `material` + `art` pair. The order is the RULE, not presentation: a display cell
sits on four terrain corners, those corners can belong to two different materials — a shore is exactly
that cell — and one cell shows one tile, so something must win. Later draws over earlier. Removing a
material LEAVES ITS CELLS ALONE, holding an id nothing draws: the cells are what the author meant, and
rewriting them to 0 would destroy a region's shape on the way to changing how it looks.

**TERRAIN: the question the grid answers (schema 63).** A `Tilemap` may carry `terrain` — which
cells hold a material, which material this layer draws, and one tile per SYMMETRY CLASS — and
`resolveTilemaps` derives the picture from it in the same chain `resolveMeshes` runs in. The document
then stores what the author MEANT rather than what the screen shows, so changing one cell re-derives
the eight tiles around it. The same bargain a gradient makes by storing stops instead of a midpoint
colour, and the reason `core.tilemap` exists at all.

**`terrain.cells` is sized by the GRID's own `cols * rows`**, not by dimensions of its own: two sizes
that must agree are two things that can disagree, and the disagreement shows as a coastline sheared
by one cell per row — which reads as art placed by hand rather than as a bad file.

**A terrain layer stores NO tiles**, and `tilemapError` refuses one that does. A stored grid and a
derived grid are two pictures that can differ, and the rule is what makes "is this layer autotiled?"
a question with one answer instead of a guess from whichever happens to be non-empty.

**Resolving MOVES AND GROWS the node's box.** The display grid sits half a cell off the terrain grid
so each tile covers the corner where four cells meet, which makes it one larger in each direction: a
stored node measuring the terrain resolves to a node measuring the display, shifted up and left by
half a cell. That is why terrain cannot live on the node whose box it measures without the
derivation — the two boxes are different boxes — and why `resolveTilemaps` runs LAST in the chain,
after everything that reads a box.

**A terrain layer is authored, not just stored.** `TilemapEdit` carries the three edits an author's
gestures go through — `withTerrain` paints cells, `withTerrainArt` assigns one tile per symmetry
class, and `asTerrain` converts a layer (one-way, discarding its tiles). `withTiles` REFUSES an
autotiled layer outright: painting a derived grid writes a picture the derivation overrules, and the
rebuild would drop the terrain on the way past — one click and the layer silently stops being
autotiled.

**Opening a 63 document in a 62 build loses the picture, not a detail of it.** The older validator
never heard of `terrain` so the file passes, and the stored tiles are all empty *by the rule above* —
so an autotiled layer comes back blank with nothing to say why. The loudest reason yet for a version
to move.

**A tilemap is born with a grid**, as a raster is born with its surface: `Integrity` refuses a
`core.tilemap` without one, so a node created without one could be made and never saved. The
default is 16×16 because 21 of the corpus's 40 Tiled maps use that size and no other comes close.

**`flips` ABSENT AND `flips` ALL-ZERO ARE THE SAME MAP**, and that is a rule rather than a
convention. `document/TilemapEdit` is the only place the array is built, and it drops it whenever
nothing is turned; `SetTilemapAction` treats the two as equal when deciding whether an edit changed
anything. Without both halves the invariant would last exactly one edit, and every file saved
afterwards would carry a zero per cell for a map with nothing turned in it.

**AUTOTILING HAS NO SCHEMA FIELD YET, on purpose.** `document/Autotile` is the whole derivation —
terrain in, display tiles out, by the dual-grid scheme — and it is deliberately a function before it
is a field, because the field has a decision in it that the arithmetic settles: **the display grid is
one larger in each direction and offset half a cell**, so a node carrying `terrain` cannot also be the
node whose box the terrain measures. Landing the arithmetic first means the schema slice starts from a
tested answer rather than guessing one. Storing terrain and deriving tiles is the same call as keeping
a gradient's stops instead of its midpoint colour, and it is what `core.tilemap` was for: the
node-per-cell document stored only the answer, with nowhere to put the question.

**And the corpus cannot validate a table** — no `<wangset>` and no `<terrain>` in any of its 20 maps,
and the maps were not drawn as if autotiled either (0.69 agreement for the dual grid over 22,198
cells; the best-scoring layers use four of the sixteen masks, which measures tile popularity). So
inferring terrain from an import is not a feature to build, and the tests for this are constructed.

**Editing is a whole-grid replace** (`SetTilemapAction`), unlike a stroke's pixel patch — the corpus's
largest grid is 10,000 small integers where a 4096-square surface is 67 MB, so the reason the two
differ is arithmetic rather than taste. The rules live in `document/TilemapEdit`, whose functions all
answer `null` for an edit that changes nothing: an action that succeeded without changing anything
puts a step on the undo stack that undoes nothing, which reads as undo being ignored.

**All three backends draw it, and the GPU does the LEAST work of the three.** SVG emits an
`<image>` per visible cell inside a cropping `<svg>` viewport and Canvas makes a nine-argument
`drawImage` per cell, because each has a blit and no other way. The GPU draws **one quad** and lets
each fragment work out which cell it is in, read that cell out of an index texture and sample the
sheet — ten thousand cells, one draw call, which is the whole reason the node stores indices.

WebGL 1 has no integer textures, so an index travels as two bytes (R low, G high) with **alpha as
the presence flag** rather than a reserved index — every index in range is a real tile somebody
drew. The shader insets its sample by **half a texel** on each side of the tile, which is the
standard atlas-bleeding fix: clamping only helps at the sheet's outer edge, not at a rect inside it.

## The eyedropper (no schema change)

Picking a colour reads the **document**, not the framebuffer. The SVG backend has no pixels to
read, Canvas and the GPU read them differently, and all three would answer with whatever the
display did to the colour on the way out — the zoom's resampling, the device pixel ratio. So
`pickColorAt` uses `hitTest` (which already honours clipping) and evaluates the node's own fill *at
that point*: a token resolved, a gradient sampled along its ramp, a painted surface sampled at its
texel. Exact, identical on every backend, and testable without a browser.

It answers **null** — and the tool then does nothing — for a miss, `fill: "none"`, a fully
transparent pixel, and a `core.image` whose pixels the pure core never decoded. An eyedropper that
quietly sets black when it misses is worse than one that misses visibly.

**It reports the shape's own colour, not the composited pixel.** Over a blended or faded shape those
differ, and most tools would say the blend. Compositing here would mean a second renderer, in the
core, free to disagree with the three real ones.

## Blend modes (schema 60)

```ts
Style.blendMode?: "multiply" | "screen" | "overlay"   // absent = normal
BLEND_MODES, blendModeError(mode)
Paint.blendMode: BlendMode | null                      // what the backends read
```

**THREE MODES, AND THE CORPUS PICKED THEM.** Of the 5,279 SVG files in `freeassets`, 65 use
`mix-blend-mode` and between them they name exactly three: **overlay (63), multiply (54), screen
(13)**. No darken, lighten, dodge, burn, difference, hue, saturation, colour or luminosity
anywhere. On the pixel-art side all **92 Aseprite layers across 26 files are `normal` at full
opacity** — so the `blendMode` that importer already parses is always zero. Eighteen modes across
three backends is a very different job from three, and two thirds of it would be for nothing.

`normal` is not a value: absent *is* normal, and offering both would put two spellings of "do
nothing" into every file and every comparison.

**The names are shared with CSS and Canvas**, deliberately — `multiply`/`screen`/`overlay` are
spelled the same in the document, in `mix-blend-mode` and in `globalCompositeOperation`, so the
value travels end to end with no translation table anywhere to disagree with itself.

**Chrome never blends.** Grid lines, handles, marquees and previews carry `null`: a selection
handle tinted by the art beneath it is unreadable, and a grid multiplied into the page vanishes
over dark artwork.

**All three backends agree to the channel.** SVG and Canvas each need one line, because both have
these modes natively. The GPU needed the one thing it did not have — a backdrop it can READ — since
fixed-function blending approximates multiply and screen only over an opaque backdrop and cannot
express overlay at all (overlay branches on the *destination*, and `blendFunc` has no branch). So a
frame containing a blended item renders into a target, each blended shape is drawn into a scratch
one, and a blend pass combines them; the result becomes the new backdrop and the consumed target
becomes the next scratch. One extra full-screen pass per blended item, nothing for a frame that
does not blend.

Verified by sampling the same four pixels on all three: over a `#4477cc` backdrop with `#ffcc00`
ink, every backend returns `68,95,0` / `255,228,204` / `136,190,153` — the W3C formulas exactly.

## Clipping content to a frame (schema 59)

```ts
Node.clipsContent?: boolean            // a container cuts its CHILDREN to its own box
ComputedNode.clips?: readonly string[] // the ancestors clipping this node, outermost first
ClipRegion { width, height, radius, world }   // what the backends get
```

**MEASURED FIRST, and the measurement cut the feature down.** Of the 5,279 SVG files in
`freeassets`, **zero** use `<mask>` and eight use clipping at all — 72 clip paths between them, and
every single one is a plain `<rect>` in user space. They are icon sets clipping each glyph to its
own viewBox, which is exactly this feature. A general path clip and a soft alpha mask have no
demand here, and `core.boolean` intersect already covers "cut this shape to that one" destructively.

**The clip is the node's OWN shape**, corner radius included. That is what makes it a boolean rather
than a subtree: nothing to place, nothing to keep in sync, and a resized frame clips to where it now
is. It is also what Figma and Sketch mean by the same words.

**It affects PICKING, not only drawing.** `computeGeometry` records each node's clipping ancestors
and `hitTest` refuses a point outside them — a thing you cannot see must not be a thing you can
click. The chain is inherited by reference, so a document that never clips allocates nothing.

**A frame does not clip its own ink.** `clipsContent` says what happens to what is *inside* it, so
the frame's own fill and stroke are drawn whole. Picking agreed from the start (it only ever
recorded ancestors); the renderer did not, because a node is in its own layer chain — right for a
fade, since a group's fill fades with the group, and wrong for a clip.

**One layer mechanism, not two.** A clip and a fade are the same *sequencing* problem — which
layers just ended, which just began — so a clipping node joins the same chain `layerTransition`
already walks. Each backend then takes its own cheap path: SVG a `<clipPath>`, Canvas a
`save`/`clip`/`restore` rather than an offscreen, and the GPU a coverage test in the **composite
shader**, where the layer already lands, rather than in every scene shader.

## Skinning (bones that deform the artwork — schema 58)

```ts
interface BoneWeight { node: string; weight: number }        // geometry/Skin
Mesh.points[i].bones?: BoneWeight[]                          // absent = not skinned
SKIN_MAX_BONES = 4

skinnedPoint(point, bones): { x, y }                         // geometry/Skin — space-agnostic
skinMesh(mesh, rest, posed, boneLookup): ReadonlyMesh        // document/Mesh
```

`Rig` posed a skeleton and `Mesh` bent a shape, and until schema 58 nothing joined them: a rig
could swing a limb and the artwork stayed exactly where it was drawn. A control point now names the
bones that carry it, and its new position is the weighted average of where each of those bones
would have put it — **`posed · rest⁻¹`**, where the bone has moved TO undoing where it started
FROM. Without the inverse a bone drawn already rotated would snap its artwork onto the axis on the
first frame, which is the same delta-from-rest reasoning `Rig` states for its own directions.

**A bone is an ordinary node**, because the skeleton in this engine IS the node tree — there is no
bone type and `Rig` already assumes this. It must **share the mesh node's parent**. That single rule
is what makes the whole feature need no world matrices: the bone and the artwork are placed by
matrices in one shared space, so the deform composes there and nowhere else.

**A binding that is not a live sibling is INERT, not invalid** — enforced in `resolveMeshes`, and
deliberately nowhere else. It threw in `Integrity` first, and that was wrong: of the five operations
that can move or remove a node, **three left a document that would not reload**. Dragging the rigged
shape into a group did it; so did dragging the bone out of one. Every other reference in this schema
already says as much — `Interaction.navigate` states it outright, and `componentId`, `slotContent`
and `$token` all resolve to nothing rather than to an error.

So a binding survives a regrouping, contributes nothing while it is foreign, and starts working
again the moment the two are siblings once more. Nothing strips it on the way out: a binding is
something the author wrote, and no gesture can produce a file that will not open. The inspector
marks such a binding *(inert)*, which is the whole cost of keeping it — otherwise the rig simply
stops and the panel looks exactly as it did when it worked. A node bound to itself is inert for the
same reason (it cancels exactly); `boneChoices` never offers it.

**Four influences, measured.** Every one of the 52 skins in the 5,037 glTF models in `freeassets`
carries `JOINTS_0`/`WEIGHTS_0` and never a `JOINTS_1`, and 47 of the 52 have six or seven joints.
The cap is what the art actually uses, and a bound on a hand-editable list besides.

**Weights are normalised, not trusted.** A rig summing to 1.2 does not deform 20% more, it deforms
wrongly — and exported weights miss by a rounding error constantly. Zero is legal: it is how a bone
is unbound without rewriting the list. Negative is refused, because it can shrink or flip the
normalising sum and send a point to infinity.

**Skinning produces a MESH, and that is the whole design.** The deform could have been applied to
the outline after the warp, but then a skinned shape and a warped one would be two pipelines and a
shape that was both would depend on which ran first. Folding the pose into the control points
instead means the warp, the conversion to `core.path`, hit testing and all three backends need no
knowledge that a skeleton exists — exactly as they already need none for a hand-dragged point. A
skinned limb is therefore **clickable where it is drawn**, for free.

**Out through rest, back through posed.** A point is a fraction of the box (schema 43), so it is
scaled into the node's own units, pushed out through the node's REST matrix into the space its
bones live in, skinned, and pulled back through the node's POSED matrix. The artwork is already
carried by wherever the node is now; the rig adds only what the bones did beyond that.

**The rest pose is the document without `applyFrame` and without `applyIk`** — the two steps that
move things. `resolveScene` builds it as a **thunk**, so an unrigged document pays nothing and a
rigged one builds it once per derivation rather than once per meshed node. A binding is looked up
under the copy's own scope first (`I::B` before `B`), so a rigged component instance poses to the
bone beside it rather than the master's.

**Not dual-quaternion blending.** Linear blending collapses a joint bent past about 120° — the
"candy wrapper" — and every 2D rigging tool ships with it anyway, because at the angles a limb
actually bends the difference is invisible and the arithmetic is a quarter the size.

**Authored by picking a point and choosing a sibling.** Pressing a mesh handle records the pick in
`EditorState.meshPoint`, which outlives the gesture — a drag forgets which handle it moved on
release, and binding is a choice made in a panel about a point you are looking at. The inspector
then lists that point's influences with a weight slider each, and offers `boneChoices` to add one.

**A handle is drawn where the artwork WENT**, not where the point is stored. The overlay has to
read the stored mesh — the resolved scene folded the bend into a path and dropped it — and stored
points are the rest pose, so a rigged shape used to deform and leave its control points behind in a
neat grid. `meshHandles` and `meshHandleAtPoint` both take the resolved scene and run the same
`posedMesh` the derivation does, so drawing and picking cannot drift apart.

And the drag SOLVES for the fraction that puts the point under the pointer, rather than adding a
world delta to it. Those are the same thing only while nothing in between turns: on a 90° node a
+10 drag used to move the handle (−4.5, +8.9), *away* from the pointer — already wrong before rigs
existed, and skinning only widened it. The map from a stored fraction to a drawn position is
exactly affine, so probing it three times recovers it and one solve lands on the answer.

**Or with the WEIGHT BRUSH**, which is the one an author reaches for most: the places a guess gets
wrong are a *region* — a shoulder, the inside of an elbow — and correcting a region is a stroke
rather than a dozen visits to a panel. Pick a bone, set a size and a flow, and drag.

A dab LERPS each covered point toward the bone (or toward zero, erasing) by `falloff × strength`,
so a stroke held in one place converges instead of overshooting and going back over an area does
what it looks like it should. The profile is `(1 − t²)²` rather than linear, because a linear one
has a corner at the rim that repeated strokes accumulate into a visible ring. The point's other
influences are rescaled to fill what is left, so its weights still sum to 1 — `skinnedPoint`
normalises anyway, so this changes no geometry; it makes the stored number mean what it says. A
point already at `SKIN_MAX_BONES` gives up its *smallest* influence, which is by definition the one
contributing least.

The brush acts on where the points are **drawn**, asking `meshHandles` for their positions with the
posed scene — so on an animated rig you paint over the handles you can see, and the brush and the
overlay cannot disagree about where a point is.

**Or by pressing Auto-bind**, which binds every control point to the sibling nodes nearest it. That
is what makes a rig a starting point rather than an afternoon: by hand it is one point and one
dropdown at a time.

Two numbers in it are MEASURED, from the 52 skins and 91,290 skinned vertices in `freeassets`.
**63.4% of vertices name exactly one bone and 28.3% name two** — 92% at two or fewer — so an
automatic pass produces at most two, which is a different limit from the four a rig may contain.
And **every weight in the corpus sums to 1.0** (worst deviation 0.0000), so the pass normalises.
Split by file the picture is bimodal rather than average: 26 of the 31 skinned files are 100%
single-bone, because low-poly characters are rigidly bound, and all the twos, threes and fours live
in the smooth-skinned five.

The falloff itself is a CHOICE, not a measurement, and the distinction is worth keeping: the corpus
says how many bones a vertex uses, not how weight decays with distance. Weight is inverse distance
to the bone's joint — `Rig.jointOffset`, the same point IK rotates *about*, so the weights and the
pose cannot disagree about where a bone is — and a second bone takes a share only within
`AUTO_BIND_BLEND_RATIO` of the nearest. Smooth rather than rigid, which departs from the corpus
majority on purpose: a dense 3D mesh tolerates a hard seam where the artist put one, but a warp grid
is a few points across and would move in blocks and tear between them.

The offered list IS the sibling rule, walked from the parent's own children rather than restated —
so an illegal binding is *unreachable* from the UI rather than merely refused by `Integrity`. The
edits themselves are pure functions in `document/MeshEdit` (`withBone`, `withoutBone`,
`withBoneWeight`), each returning a whole mesh, which `SetMeshAction` already takes: binding a point
needed no new action.

**Deleting a bone changes nothing about the binding.** It becomes inert like any other reference
that stopped resolving. `DeleteNodeAction` did strip them, back when a dangling one was invalid;
once reparenting showed the sibling half of the rule breaking far more easily than existence, the
rule moved and the stripping went with it — preserving on reparent but destroying on delete would
be two answers to one question, and the destructive one would win.

## Gradient (a fill that changes across the shape — schema 56)

```ts
interface GradientStop { offset: number; color: string; opacity: number }   // offset 0..1
type GradientUnits = "objectBoundingBox" | "userSpaceOnUse";

interface Gradient {
  kind: "linear" | "radial";
  stops: readonly GradientStop[];      // >= 1, non-decreasing offsets, <= GRADIENT_MAX_STOPS (64)
  units: GradientUnits;                // SVG's own default is objectBoundingBox
  transform: Mat2D;                    // `gradientTransform`, CARRIED and not baked
  x1, y1, x2, y2: number;              // LINEAR: the axis. SVG's defaults are (0,0)-(1,0)
  cx, cy, r, fx, fy: number;           // RADIAL: the end circle and the focal point
}

defaultGradient(kind): Gradient        // SVG's own defaults, so a gradient stating nothing is legal
gradientError(g): string | null        // what makes a ramp unpaintable; reached through styleError
normalizeStops(stops): GradientStop[]  // clamped, stably sorted, back-tracking offsets raised
sampleGradient(g, t): GradientSample | null   // the STOP PAIR and the ratio, never a blended colour
flatFill(fill): string                 // one colour: the string, or the FIRST stop
```

**Only `fill`.** `stroke` stays a string — SVG and Canvas can both stroke with a paint server, but
exactly one stroke in the 3,127 gradients measured across the SVG corpus references one, and
widening `stroke` too would double the work in three backends and the exporter to serve that one.

**Measured before designed.** 97% of those gradients are linear; 2,860 of 2,969 have exactly two
stops and the most any file uses is 11 (so a stop LIST, not a from/to pair — a two-colour model
would have needed a schema migration the first time an 11-stop file arrived); 2,977 state
`userSpaceOnUse`, which is *not* SVG's default, so a reader assuming the default is wrong by a
whole coordinate system on the common case; and 72% carry a `gradientTransform`, which is why it
is a field and not an optional extra.

**The transform is carried, not baked.** It can be folded into the coordinates for a linear
gradient and cannot for a radial one, where a non-uniform matrix turns the circle into an ellipse
no `cx/cy/r` can express. Carrying it keeps one representation for both, and it is what every
renderer wants: SVG has the attribute, Canvas and the GPU both want a matrix rather than
pre-distorted points.

**What paints it, today:**

| Surface | A gradient fill |
|---------|-----------------|
| SVG backend (the default) | painted exactly — `<defs>` + `fill="url(#id)"`, with `gradientUnits` and `gradientTransform` verbatim |
| `exportSVG` | painted exactly, including on TEXT (a real `<text>` element takes the paint server) |
| SVG backend, TEXT | flattened to the first stop — text is drawn through a `foreignObject` div, and CSS `color` takes no paint server |
| Canvas backend | painted exactly — the path's coordinates are fixed when it is BUILT and a gradient is evaluated in the space live at the FILL, so moving the CTM between the two places the ramp and leaves the shape. No clip, and `shadow*`/`ctx.filter` are device-space so effects survive it untouched |
| Canvas backend, TEXT | flattened to the first stop — the glyphs are rastered by `TextRaster`, which agrees with the SVG backend so a label looks the same on both |
| GPU backend | painted exactly, up to **16 stops** — a per-fragment walk with a constant loop bound and an early break, since GLSL ES 1.00 cannot size a loop from a uniform. WebGL 1 only guarantees 16 fragment uniform vectors, so a longer ramp falls back to `flat` (the corpus's worst case is 11) |

The flat colour is decided once, in the render model (`PaintGradient.flat`), so every surface that
falls back shows the same colour rather than each choosing.

`objectBoundingBox` is a fraction of the shape's own box, and the Canvas backend is the one surface
that has to apply that box itself (SVG has the attribute; the GPU flattens). The box travels on
`DrawItem.localBox` rather than on `PaintGradient` — the ramp is deduped by content into one
`<defs>` entry, and a size on it would split one ramp used on two differently-sized shapes into two
defs. It is also not derived in the backend: a `path` item carries commands, not an extent.

**Authored in the inspector.** The Fill row is a solid/gradient pair; `gradientFromColor` makes the
ramp from the colour already there — the SAME colour at both ends, opaque to transparent — so the
shape does not jump when you press it. `GradientEdit` holds the operations (`withStop`, `withoutStop`,
`withStopColor`, `withStopOffset`, `withKind`); the panel holds only which stop is selected and
dispatches an ordinary `UpdateNodeStyleAction`, so a drag is one undo like every slider.

Two of those operations RETURN AN INDEX with the gradient, and it is not a convenience: stops are
kept sorted, so inserting one or dragging one past its neighbour renumbers the list. A panel
tracking "the selected stop" as a number of its own starts editing a different stop mid-drag.

**Placed on the canvas.** A selected node with a gradient fill shows where the ramp runs: two ends
for a linear one, centre/rim/focus for a radial, joined by a dashed axis. `gradientPaintMatrix`
(in `geometry/SelectionHandles`) is the one mapping — gradient space → the box, when `units` says
`objectBoundingBox` → the node's local space, via `transform` → world — and BOTH directions go
through it, so a handle lands back exactly where it was picked up. `withHandleAt` then says what
each handle means: the rim reads the DISTANCE from the centre rather than an x offset, the focus
travels with the centre, and a focus dragged outside the circle is pulled onto its edge because
SVG does that before painting.

**Imported whole.** `SvgDocument` resolves a `url(#id)` fill through `SvgGradient` and hands the
ramp to the node — 2,785 shapes across the 5,279-file corpus. Only STROKES still flatten. The
gradient is MOVED with the shape at two points, and both are invisible to the type system: this
importer bakes the group transform into the coordinates, so `placeGradient` premultiplies the same
matrix; and `svgNodeSpecs` normalises the path onto the origin, so it premultiplies that
translation too. `objectBoundingBox` becomes `userSpaceOnUse` by folding `translate(box) ·
scale(size)` into the matrix rather than multiplying the coordinates — a radial ramp in a
non-square box is an ellipse, which a matrix states exactly and `cx/cy/r` cannot state at all.
A reference that does not resolve, or resolves to a stopless ramp, leaves the shape unfilled and
says so in `notes`; the literal `url(#g)` never reaches `Style.fill`, where it would be read as a
colour name.

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

---

## Schema 67 — a tileset as a thing the document holds

> **BUILT (2026-08-13).** This section was written as a design first and is kept as the record of
> the evidence, because the numbers are what shaped it. They came from counting the corpus with
> `scripts/measure-tilesets.py`, which is in the repo so they can be re-derived rather than
> believed. Where the design and the code came apart, the code is described below under *What
> changed while building it*.

### What a tileset is today, and why that is the defect

A tileset is not a thing. It is a **slicing rule stapled to one image on one node**: a
`core.tilemap` node carries the picture as its own `src`, and `Tilemap.sheet` (`columns`,
`tileWidth`, `tileHeight`, `spacing`, `margin`) says how to cut it. Nothing else can refer to it,
nothing can be said about an individual tile, and a set whose tiles are separate files cannot be
described at all.

Three defects follow, each measured rather than asserted:

**1. Every layer carries its own copy of the sheet.** Tiled's own examples hold 41 tile layers
drawing from 12 distinct tilesets, so importing them produces 41 copies of 12 images —
**1,003 KB where 407 KB would do, a 2.5x duplication**, and that is before the ~1.37x that base64
adds on the way into the document. One map (`rule_006.tmx`) is six layers of one tileset: six
copies.

**2. A COLLECTION tileset cannot be represented.** Tiled allows a set whose tiles are separate
image files rather than cells of one sheet, and this is not an edge case — it is the dominant
per-tile feature in the corpus by three orders of magnitude:

| feature | files | occurrences |
|---|---|---|
| collection `<tile><image>` | 7 | **1,207** |
| per-tile `probability` | 2 | 25 |
| `<tileoffset>` | 8 | 8 |
| `<grid>` (isometric set) | 6 | 6 |
| `<wangsets>` | 3 | 3 |
| per-tile `<properties>` | 1 | 3 |
| per-tile `<animation>` | — | **0** |
| per-tile `<objectgroup>` (collision) | — | **0** |
| per-tile `class`/`type` | — | **0** |
| `<terraintypes>` (legacy), `<transformations>` | — | **0** |

`TiledMap` already *parses* collection sets into `TiledTileImage[]`; there is nowhere in the
document to put them, so they fall back to the node-per-cell path.

**3. Per-tile data has no home.** Across 63 files a `<tile>` element carries exactly two
attributes — `id` (1,235 of them) and `probability` (25) — and 1,210 have a body, of which 1,207
are a collection image and 3 are properties. So the per-tile payload worth modelling is small,
sparse, and precisely known.

### The shape

`Document.tilesets`, a document-level table like `variables` and `clips`, with tilemap nodes
referring to an entry by id.

```ts
interface TilesetTile {
    id: number;                  // the tile's id WITHIN the set
    src?: string;                // a COLLECTION set's own image for this tile
    width?: number;              // its natural size; a collection tile is not on a grid
    height?: number;
    probability?: number;        // weight when a brush picks among equivalent tiles (25 in the corpus)
    userData?: UserData;         // the same shape a node carries (schema 64) — 3 in the corpus
}

interface Tileset {
    id: string;                  // what a tilemap node names
    name: string;
    src: string | null;          // ONE image cut by a grid, or null for a collection set
    sheet: TileSheet | null;     // the existing slicing rule, null for a collection set
    tiles: TilesetTile[];        // SPARSE — only tiles that say something appear
    offsetX: number;             // <tileoffset>: a tall tile hanging above its cell (8 files)
    offsetY: number;
}
```

and on the node: `Tilemap.tilesetId: string` replacing the node's own `src` + `sheet`.

Four decisions worth stating, because each is the corpus talking rather than taste:

- **Document-level, not per-node**, because 41 layers share 12 sets. Deduplication is the largest
  measured win and it cannot be had while the picture lives on the node.
- **`tiles` is SPARSE.** 28 of 1,235 tiles say anything at all. A dense array of 1,235 records to
  carry 25 numbers and 3 property bags would be a hundredfold of nothing, and would make every
  tileset's serialised size proportional to its tile count rather than to what an author authored.
- **A set is EITHER sheet-backed OR a collection**, never both — Tiled enforces that and the
  corpus contains no counterexample. `src`/`sheet` both null with a non-empty `tiles` is the
  collection case; the validator should refuse the mixture rather than pick one.
- **NO animation, collision, class or terrain fields.** All four are absent from the entire
  corpus. This project's own rule is that a field designed against nothing is a field that will be
  wrong when something finally arrives — the `sourceRect` history is the precedent. Add them when
  a file that uses them exists.

### The migration, 66 -> 67

Not a pass-through. For each `core.tilemap` node holding a `src`:

1. Key it by `(src, sheet.columns, sheet.tileWidth, sheet.tileHeight, sheet.spacing, sheet.margin)`
   — the src alone is not the key, because two nodes can cut one image differently and folding them
   would silently re-slice a layer.
2. Create the tileset on first sight of a key, reuse it after. This is where the 2.5x collapses.
3. Set `tilemap.tilesetId`, and REMOVE the node's `src` and `tilemap.sheet`.

Name each from the node's own name, deduplicated — a document with two sets called `Terrain` is a
picker nobody can use.

The reverse is not possible, which is the usual asymmetry and worth saying out loud: a 66 build
opening a 67 document sees tilemap nodes with no picture. That is what the version gate is for.

### What has to move with it

The freeze rule means these land in the same change, not after:

- **`Integrity`/`tilemapError`** — `sheet` stops being required on the node; a `tilesetId` must
  resolve; a dangling one must be INERT rather than fatal, per `dangling-references-are-inert`.
- **`RenderModel`** — reads `href` from the resolved tileset instead of `node.src`. One resolver,
  used by every backend, so the three cannot disagree.
- **`tileImport`** — emits one tileset per Tiled tileset instead of one `src` per layer. This is
  where the measured 2.5x actually gets collected.
- **`ExportTiled`** — writes `<tileset>` once and references it, which is what the format wanted
  in the first place.
- **A panel** — otherwise this is a schema change nobody can reach, which this project treats as a
  defect rather than a milestone.

### The thing to be careful about

`Tilemap.sheet` is load-bearing in `tileSourceRect`, in all three backends and in the exporter. The
temptation is to add `tilesetId` and leave `sheet` in place as a fallback, so nothing breaks. That
is the built-and-unreachable pattern this project keeps paying for: two sources of truth for one
picture, and the new one optional means the old one is what actually runs. The migration must MOVE
the data, and `sheet` must leave the node in the same change.


### What changed while building it

Three things the design did not anticipate, each recorded because the reasoning matters more than
the outcome:

**An empty `tilesetId` is legal, and means "none chosen yet".** The design said the id names a
tileset; `emptyTilemap()` then had nothing to name. An empty grid waiting for a picture is exactly
the state an unset `src` used to hold, so refusing it would have removed an authoring state to
protect an invariant that does not exist — a DANGLING id behaves identically, both drawing nothing.
`tilemapError` therefore requires a string and not a non-empty one.

**`tilemapForLayer` takes an identity FUNCTION, not an id.** Deduplication is the caller's, because
only the caller sees every layer at once and can tell that six of them name one set. Passing the
function in also means no `Tilemap` ever exists carrying an empty id awaiting a fix-up — a validator
with a hole for "not filled in yet" is a hole.

**The exporter gained a fix nobody was looking for.** It compared layers by SHEET GEOMETRY to decide
whether they shared a tileset, so two DIFFERENT images cut on the same grid — the common case, since
a pack's sheets usually share a tile size — compared equal and exported silently wrong. Comparing
tileset identity makes the question exact. It also now REFUSES to write a `.tmx` when the first
layer's tileset has no sheet, rather than emitting a file whose every gid is derived from something
that is not there.

### What is still open

- **~~A panel.~~ DONE.** The inspector's Tileset section retargets a layer, renames a set and sets a
  tile's weight, through `SetTilesetsAction` — which did not exist when this schema shipped. That
  was the defect the panel work found: **nothing could write `Document.tilesets` at all**, the
  importer built a list and dropped it, and every imported layer named a set the document did not
  have. Second time this exact gap has appeared here, after `Document.clips`. A field with no write
  path is not a feature with a gap; it is a feature that does not exist.
- **~~Per-tile data is WRITABLE but still unread.~~ DONE — the autotiler reads it.** A weight of 1
  stores NO record, because 1 is what an unmentioned tile already means. Making it readable meant
  giving the autotiler something to weight: `AutotileTable` entries are now a LIST of candidates per
  mask, because the measured sets ship **185 tiles for 74 corner configurations** — an artist draws
  several tiles for one neighbourhood so the ground does not repeat. Those variants were being
  discarded at the door: `rotatedTable` took a `Map<mask, index>`, which cannot hold two tiles for
  one mask at all, while `TerrainMaterial.art` has always been an ARRAY that could.

  The choice is **deterministic**, seeded by the cell's own position and the material — the picture
  is DERIVED, so it is recomputed on every open, undo and scroll, and a stream of random numbers
  would give grass that shimmers as you pan. Weights are INJECTED (`weightOf`), because this module
  knows masks and the tileset knows what a tile weighs; `resolveTilemaps` is the only thing holding
  both, and it supplies them only when a set actually says something — so an existing document
  derives byte-identically. A gap filled by TURNING a tile gets exactly one candidate: a rotation
  substitutes for art nobody drew, and offering several would make a mask the artist never addressed
  look deliberately varied.
- **Collection tilesets: MEASURED, and the entry above was wrong.** "Representable and not drawable"
  described the `core.tilemap` GRID path and read as though a collection set drew nothing at all. It
  draws. A layer whose tileset gives each tile its own file is refused by `tilemapForLayer`
  (`draws from a tileset that gives each tile its own file`) and takes the NODE-PER-CELL path, where
  `tileImageFor` gives every cell its own picture at its own size with both the set's `<tileoffset>`
  and the layer's offset applied. The importer loads all of them (`set.tiles.map(t => t.image)`),
  cached by path. So the 203 tile-objects and the 51 painted cells in the corpus all arrive and all
  draw.

  What does not exist is a collection layer as ONE node — and the corpus says nothing needs it.
  Counted over every `.tmx`/`.tsx` in the tree plus Tiled's own examples: **5 distinct collection
  sets, 1,207 per-tile images, and ZERO orthogonal tile layers drawing from one.** Two sets are used
  by object layers only (`sandbox.tmx`, `sandbox2.tmx` — 199 tile-objects, no `<layer>` at all),
  three sit in blank 60×60 maps, and the single set painted into tile layers is
  `isometric-sample.tmx` — **isometric**, which `tilemapForLayer` already refuses for an unrelated
  reason a grid cannot fix ("is isometric, which a grid cannot place").

  And that one file says the grid path would be wrong anyway: its tiles are **256×512 on a 256×128
  cell** — four times the cell height — with `offsety="-78"` on a layer, and the three Sketch sets
  carry `<tileoffset x="-12" y="6">`. A cell is one cell; art that hangs three quarters of its height
  outside it is what the per-cell path exists for.

  A grid path would also cost a **stated backend divergence**: SVG and Canvas already draw one image
  per cell, but the GPU tilemap is ONE QUAD sampling ONE sheet texture, so a collection would need a
  runtime atlas — and measured on the real sets, trimmed to their alpha boxes, Sketch Town needs
  16.0 Mpx against a 4096² page's 16.78 Mpx, i.e. ~95% packing efficiency, which no packer achieves.
  Two pages or 8192².

  **BUILT ANYWAY, on SVG and Canvas, because the user asked for it with that measurement in hand.**
  `RenderModel` resolves a collection set's per-tile pictures into `pictures: Map<index, {href,
  width, height}>` — the other half of `sheet`, and never both. Sizes come from the DOCUMENT
  (`tilesetError` requires a positive width/height on any tile carrying a `src`), so the model states
  the box without waiting for a decode, which it must: it may not wait for anything. A Map, not an
  array, because real ids are sparse — one corpus set has no id 47 and another starts at 12.

  **THE ANCHORING IS THE FEATURE.** `collectionTileBox` is the one statement of it, shared by both
  backends for the reason `flipMatrix` is shared. A tile is anchored BOTTOM-LEFT of its cell, so art
  taller than the grid hangs ABOVE the square it occupies — which is what `<tileoffset>` exists for
  and what this repo already describes as "a building rooted in one square standing over the three
  behind it". Top-aligning is the same picture sunk through the floor, and it is invisible on any
  fixture whose tiles are exactly one cell tall, so the fixtures' tiles are THREE cells tall.

  **THE GPU DOES NOT DRAW THEM, and `emitWebGL`'s header now says so** — the first entry in its
  known-gap list since schema 62. One quad sampling one sheet texture cannot express a picture per
  tile; closing it needs a runtime atlas, and the packing measurement above says that is a project.

  **AND A COLLECTION SET NOW HAS A PICKER, which is what made the drawing usable.** Two defects sat
  in one line of the panel. The tile picker was an `<img>` of the set's sheet, gated on a sheet a
  collection has not got — so such a layer could be painted with tile 0 and nothing else, on a set of
  244. Worse, the whole panel began `if (!mapSet?.sheet) return null`, so pointing a layer at a
  collection set — which the panel's OWN dropdown offers — removed every control it had, including
  the dropdown that would point it back. A dead end reachable in one click, out of which there was no
  click. Only the RING is sheet-shaped now; the collection palette is one button per tile in ID
  order, labelled with that id (real sets skip ids), thumbnails CONTAINED rather than stretched
  because the measured art is 256x352 and 256x512 and a picker that misrepresents the shape of the
  art is one people stop trusting.

  Verified in the running app on a real document pushed through the `file-opened` channel: SVG emits
  six `<image>` elements for six painted cells at y = -32 and -16 (the overhang), and Canvas's own
  pixels show the tall tile's white cap two cells ABOVE its row with the row below's overhang
  correctly covering the tile behind it. The picker was driven the same way, end to end: clicking
  tile 1 moved the selection border and the weight label, and a click on the canvas over an EMPTY
  cell painted it — a seventh `<image>` at exactly that cell, carrying the data URL of the picker's
  own thumbnail for tile 1, which is the ground truth for which picture is which. A screenshot diff of the two backends over the map region
  (11,264 ink pixels) differs on 0.9% of pixels, worst channel 101 — all of it the top edge row,
  where SVG blends the image against the backdrop and Canvas does not. **That is pre-existing, not
  new: the same diff on a SHEET-backed document differs on 2.9%, worst channel 202.** Recorded
  rather than claimed as parity, and worth its own look.
- **~~The exporter writes ONE tileset.~~ DONE — one `<tileset>` per distinct set.** Each carries its
  own `firstgid`, in first-seen order, and a set is entered once however many layers name it. The
  bug it closes is one the schema change made reachable and then left standing: with a single
  element written, every other layer's cells indexed the FIRST set's picture — right places, wrong
  pictures, in a file that parses and opens in Tiled and reads as an art mistake. A set declares the
  tile count ITS OWN layers reach, not the map's highest, or a small set inherits a large one's
  count and every set after it starts at the wrong gid.

  **A tile object follows the picture it names.** An image node has no `tilesetId` — it carries a
  `src` and a `sourceRect`, because it is an image and not a cell — so the `src` is matched against
  each written set's. It falls back to the first set, which is what it did when there could only be
  one, and the fallback is not a silent guess: `tileIndexAt` refuses a rect that is not a cell of
  the sheet it is handed, so the object leaves with a note rather than a gid pointing elsewhere.

  **A layer whose set has no sheet is dropped WITH THE REASON**, which is where a collection set
  lands: writing one means a `<tile><image>` per tile, and that is the same gap the renderer has.
  When nothing is writable the export says so and writes no file, because a map declaring a layer
  and no tileset is one Tiled opens as an error dialog.

## Schema 68 — the sheet leaves the tilemap node for good

**66→67 moved the picture and the importer went on writing the old copy.** The migration said it in
as many words — *"MOVED, NOT COPIED: `sheet` leaves the map and `src` leaves the node, or the old
path is still what runs and the duplication this exists to remove stays exactly where it was"* — and
then `tileImportActions` passed `{ src, tilemap }` to `AddNodeAction`, `srcError` still allowed a
`core.tilemap` to carry a src, and nothing read it. `RenderModel` has resolved the picture from
`Document.tilesets` since 67 and never once from the node.

**MEASURED, not inferred.** Six layers of one tileset imported through the real action path, then
serialised: the sheet appeared **seven times** — once per layer plus once on the set — **1,374KB
where 202KB would do**. That is worse than the 2.5× duplication that justified schema 67, because
the new home was added without the old one being closed.

**So `srcError` now refuses it** ("only a `core.image` node may carry a src") and `migrate_67_to_68`
strips what is already out there. The strip is what makes this a migration rather than a breaking
change: every map imported between 67 and 68 has a `src` on every tilemap node, and tightening the
validator alone would make each of those files fail to load. Nothing is lost — the picture is on the
tileset the layer names.

**AND IT TOOK A CONTROL WITH IT.** The inspector's tile picker — the only thing that says WHICH TILE
to paint — read `stored.src`, the node's. So for every document that had been through the 66→67
migration the picker was already gone, silently, while the terrain panel went on saying *"pick a
tile below, then click a shape"*. It reads the tileset's `src` now. A read of a field nothing writes
is as dead as a write nothing reads, and this repo had one of each pointing at the same field.


## Tile anchoring — a tile sits at the BOTTOM of its cell

The per-cell import path placed every picture at the cell's TOP. Correct for the ~98% of layers
whose art is exactly cell-sized, and wrong for every layer where it is not: **nine maps in the
measured tree**, from a 64x64 tile on a 60x60 grid to 384x332 art on 32x32 cells. The error is the
difference between the two heights, so it grew with the overhang and read as badly drawn art rather
than as arithmetic.

**THE EVIDENCE IS WHAT TILED'S OWN AUTHORS DID NOT HAVE TO WRITE.** Both bundled examples with
oversized tiles declare SMALL `<tileoffset>`s, which is only possible if the default anchoring
already stands the art up:

| file | art | cell | its `<tileoffset>` | top-alignment would have needed |
|---|---|---|---|---|
| `perspective_walls.tsx` | 64x64 | 31x31 | `x="-32" y="0"` | `y="-33"` |
| `isometric_grass_and_water` | 64x64 | 64x32 | `x="0" y="16"` | `y="-32"` |

That is the same rule `objectBox` implements for a tile OBJECT and the same one `collectionTileBox`
draws with, so the reader, the writer and the renderer now agree. `tileImageBox` is the one
statement of it.

**MEASURED ON REAL FILES, before and after:** Scribble Dungeons' `sampleMap.tmx` moves all **348** of
its tiles by 4px (64x64 art on 60x60 cells); `isometric-sample.tmx` moves all **51** of its by
**384px** (256x512 on 256x128). No cell-sized layer moves at all, which is the half that matters —
if it did, the fix would be a regression dressed as a correction.

**THE X CONVENTION IS LEFT ALONE**, deliberately. Bottom-LEFT means the picture's left edge sits at
the cell's, which `tilePosition` already gives for an orthogonal map; for isometric, Tiled measures
from the diamond's bounding box, which differs from this by a constant half-tile for EVERY cell. A
constant translates the whole layer and preserves how tiles of different widths line up against each
other, so it is a placement question rather than an anchoring one, and the node's own position is
where it belongs.

**FOUND WHILE PROVING IT, and now fixed:** `perspective_walls.tmx` — the file that supplies half the
evidence above — imported as NOTHING. Its tileset declares neither `columns` nor `tilecount` and its
`<image>` carries no size, so `tileSourceRect` computed `index % 0` and all 79 painted cells dropped.

**THE SWEEP CHANGED THE SHAPE OF THAT FIX.** Counted over every `<tileset>` in the tree — 46 of them:

| | count |
|---|---:|
| declaring no usable `columns` | 32 |
| …of those, COLLECTIONS (no grid to cut — not a defect) | 6 |
| …of those, sheet-backed | 26 |
| …of the 26, declaring `<image width height>` — **already recovered** by `deriveGrid` at parse time | 25 |
| …of the 26, declaring neither, so only a decoded bitmap can say | **1** |

So this was never twenty-six broken files. `deriveGrid` has recovered the count from a DECLARED size
all along — it is why the sewer maps round-trip — and it bails on its first line when `imageWidth` is
null because there is nothing to divide. One file in the corpus reaches that line.

**THE PARSER STAYS PURE.** `withImageSize(set, w, h)` is exported and re-derives; the caller is the
only thing holding both the set and the bitmap, which is the same division that makes `inflate` an
argument and external `.tsx` files the caller's job. It NEVER overrides what the file said — a set
that declares its own size or count is returned untouched, because a measured bitmap contradicting
the map would be a second answer to a settled question, and that property is what makes it safe to
call on every set rather than only the broken ones. Measured before and after: `perspective_walls.tmx`
goes **0 → 79** cells (columns 0 → 4), and `sewers.tmx` (2,530 cells), `rule_006.tmx` (26),
`hexagonal-mini.tmx` (400) and `zlib-embedded.tmx` (10,618) are all unchanged, column counts identical.

**AND THE DECODE HAD TO BE AWAITED, WHICH IS A NEW HAZARD.** `naturalSize` answers null while an image
decodes, which is right for a renderer — it draws nothing this frame and the load asks for a repaint.
An import has no next frame. `imageSizeAsync` waits, through the SAME cache the backends draw from, so
the import and the renderer cannot disagree about how big a picture is. The trap is that the cache
never retries a failure: an href that already failed has fired its `error` and will not fire another,
so a listener attached afterwards waits forever and the import hangs with nothing reported. `complete`
is the only thing that can tell, and a test asserts the hang by racing a timeout — it reports `"HUNG"`
without the guard.
Schema 75 adds `Spatial3D.environment = { textureAssetId, intensity, rotationDegrees }`. The id
must name a project-relative texture asset for rendering; unresolved references are inert and use
the neutral fallback. A document may author one scene environment. Decoded RGBE pixels are
transient renderer data and never serialize.

Schema 76 adds
`Spatial3D.composition2d = { mode: "plane" | "billboard", pixelsPerUnit, lit }`. Absent keeps a
2D node out of the 3D frame exactly as schema 75 did. Plane mode follows the authored 3D transform;
billboard mode preserves its 3D position and faces the active camera. The 2D geometry remains in
pixels and is converted to world units only by the positive `pixelsPerUnit` value. A node cannot
carry both `renderable` and `composition2d`; the validator refuses that ambiguous double surface.
