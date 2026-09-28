# Architecture

<!-- describes: src/core/actions/ActionDispatcher.ts, src/core/actions/applyMutations.ts, src/core/actions/HistoryManager.ts, src/core/geometry, src/renderer -->
<!-- re-read 2026-08-13 after schema 67-68, the collection draw path and the column recovery:
     accurate at this altitude, with two additions below. The render model now RESOLVES a layer's
     picture from the document's tileset table — a sheet, or a per-tile map for a collection — which
     is what keeps three backends ignorant of tilesets; and `ImageCache` gained one function that
     AWAITS a decode rather than answering null, because an import has no next frame to try again
     in. It goes through the same cache the backends draw from, so no arrow in the chain moved.
     (Three earlier stamps meant for this file never landed: the insert matched a `\n`-terminated
     line in a file read with CRLF preserved, and failed silently. Written with an exact edit.) -->
<!-- re-read 2026-08-10 after schema 64: accurate at this altitude. `applyMutations` gained two
     fields whose whole behaviour is that NOTHING derives from them, so no arrow in the chain
     moved — which is the clearest case the derivation picture still holds. -->
<!-- re-read 2026-07-31 after the editor slices (align/distribute, full properties inspector): accurate at this doc's altitude -->
<!-- re-read 2026-08-09 after pixel selection: still accurate, and it surfaced a real omission — `core/paint` had never been in the module table at all, eleven modules in. Added, with the clip rule. -->
<!-- re-read 2026-08-10 after the adjustments and the WebGL fix: accurate. The renderer row now records that the GPU fallback speaks; the paint row gained `Adjust`. -->
<!-- re-read 2026-08-10 after the Tiled object reader: accurate at this altitude. The importer is
     not in the module table (it never has been) and the table is about the engine's own layers,
     not its readers; API-CONTRACTS carries the reader's surface. -->


> 🔒 Frozen contract · schema v89 (app v0.0.5). Includes typed gameplay rules, offline 2D delivery, native mesh playback and opt-in oriented 3D contact resolution.

The file lifecycle is separate from editor history (`ProjectSession`); runtime event/command execution is shared with the standalone player (`GameplaySession`). Imported skeletal buffers remain transient and derive from confined source files, not document history. [Production workflows](PRODUCTION-WORK.md) records the current limits and measurements.

Animation controllers are authored per node through Actions. `AnimationPlayback` owns pure
state transitions and clip-relative clocks; `AnimationWorld` adapts settled world facts.
The 2D shell calls the adapter after rules on every fixed step; `World3D` calls its adapter
inside each fixed step. `applyAnimations` stamps only derived node playheads, which timeline
sampling consumes in both 2D and composed 3D surfaces. See [ANIMATION.md](ANIMATION.md).

## 1. The five invariants

Everything in the engine — now and in every future milestone — rests on these:

1. **The document is the single source of truth.** All persisted state lives in one
   `ProjectDocument`. Nothing authoritative lives in the renderer, the tools, or React.
2. **Actions are declarative.** An `Action` computes *what should change* (a
   `MutationResult` of deltas) and returns it. It never mutates the document. Deltas are
   per-node (add/delete/patch) plus one DOCUMENT-level kind — `"variables"` (M5 design
   tokens: whole store + active theme, under the reserved `DOCUMENT_DELTA_KEY`).
3. **The Dispatcher is the only write path — enforced by the compiler.**
   `getDocument()` returns `ReadonlyDocument` (a `DeepReadonly<ProjectDocument>`), so a
   tool, the renderer, or a React handler that tries to assign to `node.geometry` or
   push to `rootNodeUuids` **fails to build**. The mutable document is held privately by
   the dispatcher, and exactly one function mutates it: `applyMutationsToDocument`.
4. **History is snapshot-based.** Each committed revision is an immutable, deep-cloned
   JSON snapshot. Undo/redo restore a snapshot; they never replay actions. Restored
   state is deep-cloned so it can never alias the history stack. Retention is bounded
   by *memory* rather than a step count; at the truncation boundary undo stops rather
   than teleporting, and `revertToOriginal()` is the explicit way back.
5. **The renderer is completely independent, and split into a pure model + a backend.**
   `buildRenderModel(size, document, RendererState) → DisplayList` is a pure, DOM-free
   read (testable in the `node` env like the layout engine); a backend transcribes the
   display list to the screen — `emitSVG` to DOM elements, `emitCanvas` to a 2D context, or
   `emitWebGL` to triangles on the GPU. `renderScene` picks the live backend; picking is
   DOM-free, so they are interchangeable (the GPU one is a preview — see below). Nothing here holds a reference to the
   dispatcher, and nothing can write.

## 2. Layered design

```
            ┌──────────────────────────────────────────────┐
   input →  │  Editor (EditorState + Tools + ToolController)│
            └───────────────┬──────────────────────────────┘
                            │ constructs Actions
                            ▼
            ┌──────────────────────────────────────────────┐
   WRITE →  │  ActionDispatcher   (validate→execute→apply→  │
            │                      commit→notify)           │
            └───┬───────────────────────────┬──────────────┘
                │ applyMutationsToDocument   │ commitRevision
                ▼                            ▼
        ┌───────────────┐            ┌────────────────┐
        │ ProjectDocument│──────────▶│ HistoryManager │
        │ (source truth) │  snapshot │ (revisions)    │
        └───────┬────────┘           └────────────────┘
                │ read-only
                ▼
        ┌───────────────┐   onChange   ┌──────────────┐
        │  renderScene   │◀────────────│   App (React)│
        │ (SVG / Canvas) │   re-render  └──────────────┘
        └───────────────┘
```

- **Editor** turns pointer/keyboard input into `Action` objects and dispatches them.
  It owns only *ephemeral* UI state (`EditorState`: selection, hover, viewport, drag
  previews) — never document state.
- **Dispatcher** enforces the lifecycle and is the sole mutator.
- **Document** is passive data.
- **HistoryManager** stores snapshots and serves undo/redo (plus `rollbackTo(checkpoint)` — a hard
  cancel that discards revisions since a checkpoint, used to erase a cancelled live-committed gesture).
- **Renderer** reads the document plus `EditorState`-derived `RendererState` and paints via the
  selected backend (SVG or Canvas).
- **App (React)** wires the pieces and re-renders on a tick. It subscribes to
  `dispatcher.onChange` so **document** changes repaint from any source. It is also a
  second input surface: the inspector constructs and dispatches Actions directly (through
  the `nodeEdit` routing seam, so every field works on an instance COPY too), and the
  toolbar/wheel handlers mutate `EditorState`. The inspector reaches every `Style` field,
  the node's transform, its content (text / image src / name), and its LAYOUT (auto-layout
  container + the child-side grow/shrink/margin/absolute, or constraints under a plain
  parent) — engine capabilities that existed and were validated for several milestones with
  no way to reach them. Which child-side fields appear depends on whether the PARENT lays
  its children out, since the other set would be inert.
- **Ephemeral editor state** (selection, hover, viewport, drag previews) does **not**
  flow through the dispatcher, so tools call the explicit `refresh()` callback for it.

## 3. Data flow (a single edit)

1. A tool builds an `Action` bound to the current document.
2. `dispatchAction`: `validate()` → `execute()` (returns `MutationResult`) →
   `applyMutationsToDocument` (the mutation) → `historyManager.commitRevision` (snapshot)
   → `notify` (listeners).
3. **Dispatch never throws — no boundary.** Every stage is guarded: `validate()` and
   `execute()` share a try/catch, listener callbacks are isolated, and the
   apply/commit stage (`applyMutations` → `serialize` → `commitRevision`) is wrapped
   with a **rollback to the last committed revision**, so a throw there cannot leave
   the live document ahead of history. Failures are always `{ success: false }`.
4. React's `onChange` subscriber bumps a render tick; the effect calls `renderScene`
   (SVG or Canvas). (Ephemeral editor-state changes bump the same tick via `refresh()` directly.)

Undo/redo: `historyManager.undo()/redo()` returns a **deep-cloned** snapshot;
the dispatcher swaps `currentDocumentState` and notifies with `fullReload: true` so
delta-driven listeners reload wholesale.

## 4. Current vs. target data flow

The roadmap (M1/M2) inserts a computed layer. **The seam now exists:**

```
Document → GeometryEngine ─(runs)→ LayoutEngine → ComputedState → Renderer
                 ▲
                 └── pending drag patches (previews are an INPUT)
```

`computeGeometry` first resolves **component instances** (M6): the pure `expandInstances`
materializes each instance's master subtree as virtual children, so everything below this
point — layout, transforms, culling, picking, both backends — operates on an ordinary tree.
The renderer resolves node data through the same expansion, so the two never disagree. Each
copy is built by `materializeNode`, which `DetachInstanceAction` also uses to BAKE an instance
into stored nodes — so detaching produces exactly what was being drawn (through the resolved
VARIANT, not blindly `componentId`). Which affordances a copy offers is the single
`isHandleOffered` rule, read by the renderer, the picker and the hover cursor alike, so what
is drawn, what a press grabs and what the pointer promises cannot drift apart. Every copy now
offers all of them — resize corners since M6, the rotate knob since schema 26 gave overrides a
`transform`, and a copy nested inside another instance since schema 28 made an override key a
PATH. A plain click RESOLVES a copy to its instance rather than skipping it, so content drawn
outside the instance's own box stays clickable; alt-click is the deep pick.

A dirty set names STORED ids, so `computeGeometry` translates it into the expanded id space:
a copy is dirty when any node on its `::` path is. Reuse therefore survives expansion — the
`incremental === full` property test covers instanced documents too.

`computeGeometry(doc, pending?, previous?, dirty?)`
(`src/core/geometry/GeometryEngine.ts`) resolves parent-relative stored intent into a
`ComputedState`: per node a **world matrix**, its **local rect**, and a rotation-aware
**world AABB**, in scene-graph draw order. The renderer reads *only* that for
positions and emits the matrix directly; hit-testing tests in each node's local space
through the inverse matrix, so a rotated node hits against its true shape rather than
its bounding box, and never touches the DOM. `hitTest` takes an optional world-space
`tolerance` (a pick halo, `screen-px / zoom`) that inflates the test, so a zero-extent
target — an axis-aligned `core.line` whose box has zero area — stays selectable.
**All picking is DOM-free** (M4): point selection (`hitTest`), marquee/box-select
(`nodesInRect` — the nodes whose world AABB overlaps a rect), and resize/rotate-handle
grabbing (`handleAtPoint` over `selectionHandles`, the SAME handle geometry the renderer
draws, so pick and draw can't drift). Rotate spins the node about its world-AABB centre and
live-commits a coalesced `UpdateNodeTransformAction` (a continuous drag = one undo). Tools convert the pointer once via the shared
`screenToWorld` (the inverse of `screen = z·world − vp`). Because nothing reads
`data-node-id`/`data-resize-handle`, the editor works unchanged under the Canvas backend — even the
handle hover cursor (an idle-hover `handleAtPoint` → `EditorState.hoverCursor`, applied by the app,
since the single canvas element can't set a per-region cursor like SVG's per-element `style.cursor`).
Drawing covers every drawable node type through one `ShapeTool` (rectangle, ellipse, line,
text, triangle, N-gon and image). Triangle and N-gon both author `core.path` commands — a
polygon is not a new node type, just a path with N generated vertices — so the shared
`pathError` has an edit-path caller as well as the loader. The vertex maths lives in the pure
`geometry/Polygon`, normalized so the polygon fills the box you drag, which makes the 3-gon
come out as exactly the box-filling triangle the editor already shipped. The **pen** (`PenTool`) and
**vertex editing** author the same commands through `geometry/PathBuilder`: a pen click/drag builds
world-space `PenPoint`s and re-bases them onto a box (`penNodeFrom`), and dragging a vertex handle
moves the point *and* the handles on both sides of it (`movePathVertex`), then re-normalizes the box
around the ink (`normalizePathNode`) — bounds are what selection, snapping, culling and hit-testing
all read, so ink that outgrew its box would break all four. The vertex handles the renderer draws and
the ones a press grabs come from ONE producer, `pathVertexHandles`; adding them to the renderer alone
is exactly the drift that made them appear and do nothing. `FrameSelectionAction` is the editor's only way to
BUILD a hierarchy: nesting existed at the document layer from the start, but nothing in the UI
could create a parent, so every drawn node was a root and auto-layout, constraints and
multi-node component masters were unreachable by drawing.

**Picking follows the INK, not the box (`geometry/ShapeHit`).** Alongside each node's box the
engine derives what that node actually covers — an ellipse fills its box, a `core.line` is the box
diagonal, a `core.path` is its own commands, everything else is the (possibly rounded) box — and
`hitTest` runs that test in local space instead of the local rectangle. The empty half of a
triangle, the corner outside a circle and the cut-off corner of a rounded rect all used to select
a node that draws nothing there and, worse, swallow the click meant for whatever sits behind. Each
variant mirrors exactly what `buildRenderModel` emits for that type, because the point is that hit
and ink agree; a path's INTERIOR follows its FILL rather than an explicit `Z`, since both backends
close an open subpath implicitly when they fill it, and nonzero winding is summed across subpaths
so a donut keeps its hole. Curves are flattened by ADAPTIVE de Casteljau subdivision: a cubic is
split at its midpoint until its control hull is flat to `FLATTEN_TOLERANCE` (0.05 of the path's own
units), bounded at `FLATTEN_MAX_DEPTH` halvings. The tolerance is read from the CURVE, never from
the zoom or the viewport, which is the property the earlier fixed 16 segments was defending — an
adaptive count driven by screen size would make the same click hit at one zoom and miss at another.
A fixed count could not defend accuracy at the same time: 16 segments is wasteful on a short curve
and visibly wrong on a long one, and both errors land in picking, booleans and now tessellation,
which all share this one flattener.

**And the MARQUEE follows the ink too, which took a decomposition (`geometry/ConvexDecompose`).**
Box-select was the last place the box was still trusted. The old argument — a marquee is a fuzzy
affordance, so an AABB is close enough — was wrong in exactly the way the argument about clicks
had been: a square rotated 45° has a box nearly a third empty, and dragging through one of those
corners selected a shape the marquee visibly never touched.

Making it exact needed a way to ask "does this shape meet this region". For CONVEX polygons the
separating axis theorem answers it outright, and answers containment in the same breath — a region
inside a shape simply admits no separating axis. For concave ones there is no such theorem, and
the usual substitute is three cases, two of which exist only to catch containment. So the shape is
decomposed into convex pieces first (HERTEL–MEHLHORN over the triangles `Tessellate` already
produces, merging neighbours wherever the merge stays convex), and the three cases collapse into
one. Bounds still run first as the cheap reject; only survivors pay. The marquee is carried INTO
the node's local space rather than the shape out to world, so the decomposition is computed on the
node's own untransformed outline — the same numbers a click is tested against — and is memoised on
the `HitShape` it came from, which needs no invalidation because an edit derives a new one.

Ink with no AREA takes the other branch, on the distinction `hitsShape` already makes: a
`core.line` and an unfilled path ARE their outlines, so their segments are the operands. Without
that, decomposing a pen stroke would yield nothing and it would become impossible to marquee —
the same way an earlier rule once made one impossible to click.

**One display list, four consumers.** `emitSVG` draws it, `emitCanvas` draws it, `emitWebGL`
draws it, and `exportSVG` serializes it — so a feature that reaches the model reaches all four
without a second description of any shape. Text is the one place that needed care: the backends and the exporter
each lay it out, so the HARD BREAK rule is a single shared `textParagraphs` and only the MEASURED
wrapping is per-backend (the canvas has `measureText`; a pure exporter has nothing to measure with,
which is why exported text honours newlines but does not wrap).

**Booleans work on outlines, not node types (`geometry/ShapeToPath` → `geometry/PathBoolean` →
`actions/booleanActions`).** A rectangle and an ellipse can be combined because both convert to
commands first, by the same rules `ShapeHit` and `buildRenderModel` use — the three now agree on
what a node's outline IS, which is what lets a boolean, a hit test and the drawing describe the
same shape. The combine runs in WORLD space (the only space nodes with different parents and
transforms share), folds bottom-most first so `subtract` cuts the shapes above out of the one
below, and lands as ONE transaction: create the result, set its commands, delete the operands —
one undo.

**A STROKE stops being a parameter (`geometry/StrokeOutline` → `actions/outlineStrokeActions`).**
Until this slice a border was something only a rasterizer knew about: SVG and Canvas take a width
and a colour and draw it themselves, so no layer here ever had to know what area a border covers.
Three things wanted that answer and could not have it — a GPU, which fills triangles and cannot
"stroke"; an OUTLINE STROKE command, which every design tool has; and stroke ALIGNMENT, which
neither backend can express. One pure module answers all three, by POLYLINE OFFSETTING over the
same `flattenPath` picking and tessellation already use.

The two sides of a corner are not symmetric, and that asymmetry is the whole algorithm. The OUTER
side opens up and the JOIN fills it — a miter, degrading to a bevel past `miterLimit` exactly as
SVG defines it, or a round arc, or a bevel. The INNER side folds over itself, and the correct
outline is the two offset edges TRIMMED to where they cross. Leaving them untrimmed would make a
self-intersecting ring, which the nonzero rule hides on SVG and Canvas and the triangulator cannot
— the same stroke would look right on two backends and wrong on the third.

ALIGNMENT is the piece that shows where a feature belongs. `Style` carries `strokeJoin`,
`strokeCap` and `strokeMiterLimit` (schema 37) because all three backends draw those natively from
the document's own values. It carries no `strokeAlign`, because an inside border is not something
SVG or Canvas can draw — a document field for it would render three different ways on three
backends. So alignment is an argument to the outline COMMAND instead: what comes out is a
`core.path`, and a fill draws identically everywhere. The same reasoning that put the boolean bake
in the action layer rather than in a renderer.

**LIGHTING, and where the tilt comes from (`document/Light`, `Mesh.normalAt`).** The obstacle is
that a 2D warp is IN-PLANE: it bends a shape sideways and tilts nothing, so every normal it could
produce points straight at the viewer and a light would find nothing to shade. So mesh control
points gained a `z`. That one field turns the grid from a deformation into a SURFACE, and normals
fall out of it as the cross product of the patch's two tangents — the same bilinear patch the warp
already uses, so the direction a light sees and the outline a click tests are two readings of one
surface rather than two descriptions that could disagree. `warpPoint` still reads only x and y, so
height changes how a shape is LIT without changing what it covers.

Lights are DIRECTIONAL and document-level. Directional because a design document has no scale — a
200-unit rectangle may be a button or a building — so a light with a radius would need a distance
the document cannot supply, and every scene would need retuning when somebody scaled it.
Document-level because two shapes lit from different directions do not read as two shapes, they
read as a mistake. AMBIENT is separate and is not a light but a floor, without which an unlit face
goes to pure black.

HEIGHT subdivides the outline, and finding out why took a measurement. Shading needs vertices to
live on, and a rectangle tessellates to two triangles whose vertices are only its four CORNERS —
where a raised mesh's gradient is exactly zero. So every normal came out flat and the Lambert term
had nothing to do, while the unit tests passed because they fed `itemDraws` a surface directly and
never asked whether a document produces vertices to sample it at. `resolveMeshes` now converts a
mesh that has height as well as one that warps: the outline is unchanged, but cut at the grid's own
resolution, which is where the surface varies. INTERIOR tessellation finishes the job
(`subdivideTriangles`): the outline alone still leaves a rectangle as two triangles spanning the
whole shape, so the triangles are split four ways until no edge is longer than a mesh cell —
bounded by depth as well as length, because a tolerance alone is a recursion nobody has bounded.

The GPU carries ONE NORMAL PER VERTEX, which is the whole point: a mesh raised in the middle faces
a different way there than at its edges, and a single normal per shape would light a dome exactly
like a flat card. Tessellation moved into LOCAL space to make that possible — a normal is sampled
from the mesh, the mesh is in local units, and a world-space triangle has no way back to the
coordinate that produced it. The triangles are unchanged, the transform being affine. An unlit
document sets ambient to 1 and no lights, multiplying every colour by one, so it draws exactly as
it did before any of this existed.

Those normals are UN-NORMALISED, and the shading is per-FRAGMENT because of it. Faceting you could
count along the triangle edges survived every amount of subdivision, because the fault was not a
shortage of vertices: normalising is nonlinear and it was happening before the GPU's linear
interpolation. Inside one cell the patch is `A + Bu + Cv + Duv`, so the cross product of its
tangents is `B×C + u(B×D) + v(D×C)` — the `uv` term cancels against itself and what remains is
AFFINE, which is exactly what interpolation between three vertices reproduces to the digit. Scaling
each vertex's vector to length 1 first replaces that with a function agreeing only at the corners,
and the gap is the facet. So `surfaceNormal` hands over the raw vector, `normalAt` is its
normalisation for everything on the CPU, and the fragment shader normalises what arrives. The
tangents are divided by their own step for the same reason: the samples are clamped inside the box,
so on the rim the span is half what it is inland, and an uncorrected length would say where it was
sampled rather than what the surface does. The seams that remain are the mesh's own cell
boundaries, where a bilinear surface genuinely is only C0 — a crease, not an artifact. A COLLAPSED
cell (two control points dragged onto each other) has no normal at all; `surfaceNormal` answers
zero, and the substitution to flat happens at the GPU boundary, because normalising zero in a
shader is NaN and a NaN fragment is a hole rather than a dark shape.

A raised shape DOES cast a drop shadow, derived from the scene's light and its own depth rather
than typed in per shape — so moving the light moves every shadow together and they cannot disagree
with each other the way hand-set ones eventually do. It throws further and softer the higher the
shape sits. An EXPLICIT `style.shadow` still wins: somebody who set one meant it, and a scene light
silently overruling a per-shape decision would be the tool arguing with its user.

**Shapes DO cast shadows on each other, and a shadow map was the wrong technique for it
(`geometry/CastShadow`).** That gap was restated three times, each time with the same reasoning: a
second pass from the light's point of view, a depth texture to sample, a texture path this
renderer has never had. The reasoning was sound about shadow maps and wrong about the problem. A
shadow map is what you reach for when the occluder is arbitrary 3D geometry; here every occluder
is a FLAT shape at a known height under a DIRECTIONAL light, and the shadow such a thing casts is
its own outline TRANSLATED and INTERSECTED with whatever it lands on. Both halves already existed
and were hardened. Doing it as geometry means all three backends get it (SVG and Canvas cannot
sample a depth texture; they can fill a path), it is deterministic and checkable by area in the
`node` env rather than by running a GPU, and it stays sharp under zoom instead of becoming a
texture's texels. A shape casts only on shapes STRICTLY further away, which is also what stops it
shadowing itself; the patch is spliced directly after its receiver in paint order, unpickable and
idless, because a shadow is not a thing you can select.

Patches landing on the SAME receiver are merged into one before they are drawn. Two raised shapes
over one card each throw a patch onto it, and where those overlap a second translucent fill lands
on the first — so the overlap comes out darker than either. That contradicts the model this
module argues for in its own comment: a directional light is infinitely far away, every ray is
parallel, occlusion is total or nothing, and there is no "twice occluded". The union is
`resolveRings` under NONZERO; even-odd would be the opposite mistake, punching the overlap out as
a hole so the doubly-shadowed band came out LIGHTER.

A shadow's length is the GAP the light crosses, not the caster's height above the page. That
distinction is invisible until two things are raised — with one raised shape over a flat page the
two formulas agree exactly — so it shipped wrong and the whole suite stayed green. A stack of
cards came out with every shadow the same length, which reads as one flat layer rather than a
stack.

Finding all this cost a correctness bug elsewhere too, which is the better half of the story — see
the boolean note below.

**RAY CASTING answers the question a normal cannot (`geometry/RayMarch`).** A crease beside a
raised edge may face the light squarely and still be dark, because the edge is between it and the
light. No amount of shading arithmetic finds that; you have to follow the ray and look. The march
is deliberately the simplest honest form — fixed steps from the surface point toward the light,
occluded if the surface is ever above the ray — and it is BINARY, because a directional light is
infinitely far away and its occlusion is total or nothing, the same argument `CastShadow` makes.
`maxHeight` bounds it: once the ray is above everything, nothing further along can occlude, and
that altitude is the whole of the ray worth walking. It knows nothing about meshes or lights —
`height` is injected, exactly as `castShadows` takes an `offsetOf` — so it is pure geometry a mesh,
an imported heightmap, or a test surface whose shadowing can be worked out on paper can all drive.

Three of its lines turned out to be COST rather than correctness, and the comments now say which:
the already-above-everything short-circuit, measuring the ray's length from the start height rather
than from zero, and beginning the loop at step one. Each was written as a guard, and a mutation of
each changed no answer — the first because a zero-length march reaches the same conclusion, the
second because a longer ray is still correct and only spreads the same sixteen samples thinner, the
third because step zero is the point itself and the strict comparison already excludes it. They
stay, labelled as what they are.

**The march runs per FRAGMENT, and building that meant the TEXTURE PATH this renderer had never
had.** It shipped once as a per-vertex term, which was the honest approximation available at the
time and wrong in a specific way: occlusion is genuinely discontinuous, so interpolating an answer
computed at three corners smeared the shadow's edge into a gradient. Normals had an exact fix at
no cost (the affine argument above); this had none, because no function of the three corners
produces a discontinuity between them.

What crosses to the shader now is a POSITION rather than an answer — interpolating a position
across a triangle is exact — plus the surface itself as a 64x64 texture. Two decisions in that are
worth keeping: the height is packed into SIXTEEN bits across two channels, because eight quantises
a 260-unit relief to about a unit and unit steps in the surface become visible steps in the
shadow's edge; and the decode is written so every intermediate stays near 1 rather than reaching
65535, because `mediump` is only guaranteed to ±16384 and the obvious decode overflows it on
exactly the hardware that needs the care. The texels are sampled at their CENTRES, where
`texture2D` reads them — aligning to the box's edges instead puts every value half a texel from
where the GPU looks, which reads as the whole surface sliding under its own lighting.

The shader's march is a TRANSCRIPTION of `marchOccluded`, which is where it is specified and
tested. A shader cannot call TypeScript, so the arithmetic exists twice and only one copy can be
checked — the same standing arrangement as this shader's Lambert term and `lambert`, neither of
which has a runtime caller either. Both are specifications the GLSL restates; the packing has
`decodeHeight` for the same reason.

That texture path is also what `emitWebGL`'s gaps have always named, and IMAGES are now drawn
because of it — an image is the same path with a picture in it instead of a surface. It is the
same triangles as any rect, so a picture is lit and shadowed by exactly the arithmetic a fill is,
which is why it goes through the fragment shader rather than being blitted. The picture REPLACES
the fill rather than covering it (Canvas returns before it fills, for the same reason: a colour
under a transparent PNG shows through). Decoded bitmaps moved to `ImageCache`, shared by both
backends — switching Canvas↔WebGL from the toolbar must not re-download the document — and it
carries a GENERATION counter that exists for the GPU alone: Canvas hands `drawImage` a live
element, while a texture is a copy that would otherwise be re-encoded every frame or keep forever
the blank bitmap from before the load finished. `WebGLRenderer` now registers the image-ready
callback too, which it had never needed; without it, opening a document straight into the GPU
backend left images missing until something else happened to repaint.

**DASHES are cut as GEOMETRY (`geometry/DashPath`).** SVG and Canvas take a pattern as an
instruction and do the cutting themselves; a GPU has to be handed the pieces. That the GPU is the
only caller does not make it a GPU concern — the pieces are a property of the path and the
pattern, computable without a screen, so they live in `geometry` where they can be checked by
length. SVG's semantics are followed exactly, because agreeing with the other two backends is the
whole point: an odd pattern repeats to become even, the offset is taken modulo the cycle, and each
subpath restarts the phase. Runs come out OPEN even from a closed contour — a dash has two ends
and they take the stroke's CAP.

Chasing that turned up an unrelated defect in the CANVAS backend: `setLineDash` was called only
when an item HAD a dash, and it is sticky context state, so every later stroked item in the frame
inherited the last pattern. The box-select marquee came out dashed because the rectangle preview
had run before it — two overlays with nothing to do with each other, which is why it reads as a
rendering glitch rather than as a bug in either. SVG never had it, because there a dash is an
attribute on an element rather than a mode on a shared painter. Found by measuring pixels in the
live app while trying to verify something else.

**TEXT is drawn too, and the reason there is no GLYPH ATLAS is the interesting part
(`renderer/TextRaster`).** An atlas is the standard answer and it would have been the wrong one
here: it means a second typesetter, with its own wrapping, its own kerning and its own idea of
where a line breaks, drifting from the Canvas backend in ways only a screenshot comparison would
catch. Text is the one thing in this engine whose shape cannot be computed from the document alone
— how many words fit a line depends on the font the machine actually has — so there must be
exactly one answer to it.

So the wrapping moved out of `emitCanvas` UNCHANGED, and the GPU rasterises through that same
function into an offscreen 2D context and uploads the result. The GPU shows what Canvas shows
because it IS Canvas. Verified side by side: identical line breaks, identical centring.

The same extraction paid a second time, in the place it matters most. The SVG EXPORTER could not
wrap: it is pure, wrapping has to measure, and a pure module has no canvas — so a long paragraph
ran past its box in the exported file while the editor wrapped it on screen. That is content
fidelity in the artefact you hand somebody, which is worse than any of the on-screen gaps. Wrapping
is now INJECTED (`TextLines`), the exporter keeps its hard-breaks-only default for callers with no
DOM, and the app passes the same `textLinesFor` the backends use. One typesetter, four outputs.

What it costs, stated: a raster per text item rather than a shared atlas — more memory, and a
re-raster when the text or the zoom changes materially. The scale is QUANTISED to powers of two
for the same reason `displayTolerance` is, so a zoom crosses a rebuild boundary a handful of times
instead of continuously; the cache key omits POSITION, so dragging a text node does not rebuild
its bitmap every frame; and the cache is bounded and evicted least-recently-USED, because an
unbounded one is a leak that only shows after a long session. For a design document — tens of text
nodes, not thousands of glyphs a frame — that is the cheaper mistake.

A text node's `fill` is its GLYPH colour, so the box is never filled underneath: doing so would
paint a solid rectangle over whatever is behind it. Same rule as an image, where a colour under a
transparent PNG shows through.

WHAT IS STILL NOT HERE: a CAST shadow lands on the receiver's OUTLINE as if the receiver were
flat, so it does not bend over a domed one. That is now the only part of the lighting still
waiting on work rather than on a missing capability. What exists is SELF-shading, which is what
makes a bevel look like a bevel, and a drop-shadow OFFSET derived from the light and the node's
depth, which is what a 2D tool has always meant by a drop shadow — the difference being that it is
now computed from the scene's own light rather than typed in per shape, so moving the light moves
every shadow and they cannot disagree.

**A shape can BEND, and it stays an ordinary path (`document/Mesh`).** Every shape here was rigid
until now — the only things that could change one were its own numbers. A mesh is a grid laid over
a node's box whose points you drag, with the outline following: the envelope warp every serious
vector editor has, and the thing normals and lighting will hang off, since a flat shape has nothing
to light.

`resolveMeshes` runs at the display seam, LAST — after booleans, so a warp bends a COMBINED shape
rather than one operand of it — and turns a meshed node into a `core.path`. That is the whole
reason it costs so little: picking, marquee selection, snapping, tessellation, the decomposition
and all three backends see a path. It is also why a warp is CLICKABLE where it is drawn, which a
deformation applied inside a renderer could never be.

The derived node DROPS its mesh, because the bend is now in the commands and leaving it on would
warp an already-warped outline on the next derivation — the `activeState` trap in a new costume,
and a test resolves twice to prove it does not happen.

Deformation is BILINEAR per cell. Smoother schemes exist and every one of them is more arithmetic
for a difference that only shows on a coarse grid, which a user fixes by adding a row; bilinear is
exact AT the control points, which is the property somebody dragging one actually checks. Points
outside the box are CLAMPED rather than extrapolated, because a bilinear patch diverges fast beyond
its corners and an overhanging outline would be flung across the canvas instead of following the
edge it is near. Segments are subdivided at the grid's own resolution first: a warp bends the space
between two points, so an edge that kept only its ends would chord across every bend.

**DEPTH is one number and three consumers (`document/Depth`).** A layer panel says which shape is
on top of which SIBLING; depth says which is nearer the VIEWER, and those are different questions.
Adding the second one buys three things at once.

ORDER is decided in the MODEL, far first, with the tree's own order breaking ties — sorted there
rather than in a backend because only one of the three has a depth buffer, and a document that drew
one way on the GPU and another on SVG would be a document with two meanings. The Z-BUFFER is the
other half: a vertex carries a clip z that DECREASES with depth, so a fragment nearer the viewer
wins whatever order its draw call arrived in. Sorting is belt; the depth buffer is braces, and it
is the half that does not depend on anybody sorting correctly.

PARALLAX is applied at the DISPLAY SEAM as an offset to a node's position, never inside the
renderer. It has to be: picking, marquee selection and snapping all read the computed geometry, so
a shape shifted in the renderer alone would draw where it could not be clicked — the rule this
codebase has already had to learn twice. A layer at depth d follows `1/(1+d)` of a pan; negative
depth is the FOREGROUND and outruns it. The offset is in world units, so zoom does not pull layers
apart, and the size is deliberately untouched — a layer that shrank with distance would read as the
shape resizing itself.

A document that never mentions depth is untouched by all of it: the sort is stable, the item
carries no depth at all, and `applyParallax` returns the same reference — which matters, because it
runs on every pan.

**ANIMATION is one mechanism, not four (`document/Timeline`).** Cutout animation, frame-by-frame,
tweening and onion skinning sound like four features. They are one plus a display option, and
saying so is what kept the whole thing small.

A KEYFRAME is a statement that certain fields differ at a certain time — and this engine already
had that statement twice over. An instance OVERRIDE and a named STATE are both "in this context
these fields differ", sharing `overrideValueError` and `materializeNode`. A keyframe is the same
shape with a frame number on it, so it inherited both and animation added no second definition of
what a node may say about itself. TWEENING is `blendNode`, written for state transitions and
identical here. FRAME-BY-FRAME is tweening turned off: a keyframe marked `hold` shows its values
until the next one and then snaps, which is what a sequence of cels does — a flag, not a second
animation model. CUTOUT animation is keyframes on a rig's TRANSFORMS, and the scene graph already
composes a parent's matrix into its children, so animating an upper arm carries the forearm and
this module knows nothing about limbs.

`applyFrame` slots into `resolveScene` beside `applyActiveState`, so a document at a frame is an
ORDINARY document: layout, picking, snapping, culling, all three backends and the exporter needed
no changes at all. TIME is applied BEFORE states, because a keyframe says where a node is and a
state says how it looks in a situation, so a situation may override the animation rather than the
reverse. A document nobody animated is returned by reference and costs exactly what it did before.

ONION SKINNING is not animation — it draws neighbouring frames faintly, so it lives in the renderer
(`RendererState.ghosts`). The app derives those frames because the model reads every position from
a `ComputedState` and composes none itself; ghosts are drawn BEHIND and made unpickable, since a
ghost is a picture of another moment and clicking one would select a node where it isn't.

The PLAYHEAD is ephemeral. Scrubbing is not an edit — an undo step per frame would bury a day's
work under a second of dragging — so it lives in editor state and is stamped onto a shallow copy,
the same treatment the marquee and the drag preview get. `doc.frame` records only where the
playhead was when the file was saved.

**Cutting a curve is a question about the SCREEN, and only one backend had to answer it.** Every
curve here is flattened to `FLATTEN_TOLERANCE` — 0.05 of the path's own units, fixed, deliberately
viewport-independent so that a click lands the same at every magnification. For picking that is
exactly right and must not change. For DRAWING it is wrong in both directions at once: at 20x a
fifth of a pixel of allowed error is blown up to four and circles visibly facet, and at 0.05x a
hundred segments go into a curve three pixels long.

SVG and Canvas never had to care — they hand an outline to a rasterizer that already knows the
resolution. A GPU has to be told how many vertices to take, so the WebGL backend now derives its
tolerance per item from `vp.zoom * dpr` and the item's own matrix (`displayTolerance`,
`localScaleOf`). A node scaled 10x needs a tolerance ten times finer, and under a non-uniform scale
it follows the larger axis, because erring toward more detail is the error nobody can see.

The tolerance is QUANTISED to powers of two, which is what makes it usable rather than merely
correct: one that tracked the zoom continuously would change the vertex count on every frame of a
pinch, and a silhouette whose vertex count changes every frame shimmers. Two hundred magnifications
across two octaves produce three tessellations between them. So the engine now carries two
tolerances that are different KINDS of number — one in world units that never moves, one in device
pixels that follows the view — and keeping them apart is the whole design.

**A drawn path is not a polygon, and the missing word was the FILL RULE (`geometry/Resolve`).**
Everything built on top of `Tessellate` inherited a precondition nobody had supplied: ear clipping
is defined on a SIMPLE polygon, and a path someone draws crosses itself. A five-pointed star drawn
in one stroke — the way anyone draws one — came out of the GPU as overlapping triangles while the
other two backends drew it correctly, because they were handed an outline and a rule and this one
was handed only an outline.

Resolution is the missing step, and it is `PathBoolean`'s own method turned on a single input:
split every edge against every edge including its own contour, keep a piece only where the fill
differs on its two sides, direct it with the filled side on the LEFT, and chain the survivors. What
comes out never crosses itself and means the same region under NONZERO that the input meant under
whichever rule was asked for — so after this point nothing carries the rule any further.

Two things had to be fixed to make chaining produce SIMPLE rings rather than merely closed ones.
At a vertex where several boundaries meet, the continuation is now chosen by ANGLE — reverse the
edge just travelled and take the first outgoing edge clockwise from it, which is how a half-edge
structure walks a face. Picking arbitrarily threads two faces into one ring that touches itself,
and a self-touching ring cannot be ear-clipped: an even-odd pentagram is five triangles meeting at
five points, and as one loop it produced no triangles at all. And a walk that returns to a point it
already passed now closes there and carries on, which catches the same thing from the other side.

The rule itself is a document field (`Style.fillRule`, schema 38) because all three backends can
honour it: SVG takes `fill-rule`, Canvas takes an argument to `fill()`, and the GPU — having
nothing to hand it to — resolves it into the geometry. Picking reads it too, because a click that
disagreed with the paint would swallow clicks meant for whatever shows through an even-odd hole.
That is the same test `strokeAlign` failed and this passes: a document may say a thing when every
backend can draw it.

It also closed a gap `StrokeOutline` had documented as closed. A stroke wide relative to the
corners it turns overlaps itself, and that module concluded no single ring could describe the
result. True, and beside the point — the overlap is a union, and resolving computes unions. Stroke
outlines are now resolved before they are handed out, so a thick stroke is an ordinary shape to the
tessellator and the decomposition instead of the one input they could not take.

**A fill becomes TRIANGLES for the GPU, by the same outline everything else uses
(`geometry/Tessellate`).** SVG and Canvas both take an outline and a fill rule and rasterize it
for us; a GPU takes triangles and nothing else. Rather than let the GPU backend invent a fourth
private idea of what a shape is, `emitWebGL` converts through `ShapeToPath` → `commandsToRings`
— the same conversions picking and booleans go through — and `triangulate` ear-clips the result.
So the GPU fills exactly the outline a click tests against, and the hard part is a pure function
tested in the `node` env rather than something only a GPU can answer for.

Ear clipping was chosen for the reason edge classification was chosen for the booleans: every
step is separately checkable, and each of its three conditions is held by a shape that fails
without it — a star (convexity), a slit reaching across the shape (containment), a rounded
rectangle (the reflex restriction, which reads like a speed filter and is not one). It is O(n²)
worst case, which is the right trade here: the alternative is substantially more code for a
speed-up at vertex counts a design document does not reach, and this runs once per shape per
change, not per frame.

The GPU backend is a **PREVIEW and says so in the toolbar**. It draws fills AND strokes — the
latter through `StrokeOutline`, offset in local space and transformed afterwards so a scaled
node's border thickens exactly as it does on the other two, and which is also why the selection
frame now appears there at all. What it still cannot do is text and images (a texture path) and
effects (render targets); both are stated in the module header rather than discovered later. A
backend that silently drops content when you switch to it is worse than one that admits its gaps.

Its `GLState` — the program, the two buffers and the uniform locations — is EXPORTED, which was
not a style choice. `initGL` returns it and `setLighting` takes it, both documented in
API-CONTRACTS, and while it was private neither signature could be written down outside
`emitWebGL.ts`. Nobody noticed until the API pin tried to state the contract and could not: a
documented type that cannot be named is a contract with no second party.

**A correctness bug the shadows found: the booleans dropped shapes that shared an edge.** The
first shadow patch computed came back empty for two rectangles at the same `y` — the arrangement a
design tool is largely made of. `PathBoolean.booleanRings` classifies each split edge piece by
whether its MIDPOINT lies inside the other shape, and a midpoint sitting exactly ON the other's
boundary has no answer: a ray cast from a boundary point lands on the parity of its own rounding.
The visible consequence was not subtle. The UNION and the INTERSECTION of two axis-aligned
rectangles at the same `y` returned EMPTY; two rectangles merely touching edge-to-edge unioned to
nothing; a shape unioned with ITSELF returned nothing. `subtract` and `exclude` happened to
survive, which is exactly why it went unnoticed for so long — three of four operations have a
passing test.

`Resolve` already had the robust engine and did not know it. Its rule is "keep an edge where the
answer CHANGES across it", with the probe sampling the two faces either side and never the edge
itself — which is defined even when the edge lies on top of another. Generalising it from a fill
rule to any membership predicate (`resolveWith`) makes the four booleans fall out as their own
definitions: in the union when in either, in the intersection when in both. `resolveBoolean` now
serves every call site — the boolean tool, the live `core.boolean` node, and the shadows. The
non-degenerate cases come out identical to the digit, which is what says this replaced a broken
classifier rather than a working one. Coincident survivors are DE-DUPLICATED, or a union across a
shared edge emits that edge twice and this module's promise of non-overlapping rings quietly stops
holding — it still fills correctly under nonzero, which is why that too would have gone unseen.

That flat form is the *bake*. The default is a **`core.boolean` node** (schema 33) that keeps its
operands as an ordinary subtree and is resolved by `resolveBooleans` inside `resolveScene` — so
moving a child, restyling it or switching the operation re-derives the shape, and undo is just an
edit to a child. Resolving at the display seam is what keeps the cost at zero everywhere else:
layout, picking, snapping, culling and both backends see an ordinary `core.path` and need no
knowledge that booleans exist. It is the same trick `expandInstances` plays for components, and
the reason a second node type cost no changes below the seam.

**The selection frame is the node's own box, turned with it (`geometry/OrientedBox`).** The frame,
its four handles and the rotate knob all come from the world matrix applied to the local box, not
from the world AABB: an AABB corner is a point a turned node does not touch, so the frame drew
bigger than the shape with its handles floating in empty space. Each cursor is picked from the
direction its corner actually points on screen, and the knob rides the turned top edge. Resizing
then runs in the node's OWN units — the pointer delta is mapped through the inverse of the world
matrix captured at the press — and the stored position is compensated for the transform-origin's
shift, so the corner opposite the one being dragged stays exactly where it is drawn. (The origin is
a FRACTION of the node's size, so changing the size moves it and swings the whole box; without the
compensation the anchor slides out from under the cursor.) Dragging a corner past its opposite
clamps at the minimum size rather than flipping the box.

Path **bounds are tight** (`pathBounds`), taken over each axis's bezier turning points rather than
the control hull: a handle routinely reaches far outside the curve it shapes, and a box drawn
around it left the selection frame visibly larger than the shape — with snapping, culling,
alignment and the marquee all working from that phantom margin.

The renderer's `buildRenderModel` also
uses that world AABB to **cull** off-screen content — dropping any node whose bounds
don't intersect the viewport's world rect — so a large document only pays for what is
on screen (content only; overlay and grid are not culled).

**Layout runs *inside* that pass (M2).** When `computeGeometry` visits a node carrying
`layout.container`, it calls `LayoutEngine` to position that node's children — so a
laid-out child's local rect is a computed **result** (a row/column flex stack) that then
composes through the same matrices. It is not a second engine or a second tree walk; it
is a producer feeding the one `ComputedState`. Layout's cross-sibling dependency (moving
one child shifts the others) is reconciled here too, via `expandDirtyForLayout`.

**Intrinsic ("hug") sizing makes it two passes.** A container may size an axis to its
contents, and hug **composes upward** (a hug parent of a hug child depends on the
grandchildren). So `computeGeometry` first runs `measureIntrinsicSizes` — a **bottom-up**
fold over the same scene walk (reversed) that resolves every node's own size, folding a
hug container's hugged axis from its children — then the existing **top-down** position
pass consumes those sizes. The measure pass is deliberately run *fully* on every compute
(never memoized): that makes the size layer byte-identical between a full and an
incremental recompute, so the `incremental === full` invariant reduces to the dirty walk.
That walk (`expandDirtyForLayout`) climbs a change **up the hug chain** to the first fixed
container, so a deep resize re-lays-out every ancestor it actually moves. **Flex-grow**
(`Layout.grow`) is the inverse of hug — children fill a fixed container's leftover
main-axis space — and is applied purely in the position pass, so it needs no measure
feedback and no new dirty-tracking (a growing sibling reflows through the same ripple).
**Flex-shrink** (`Layout.shrink`) is its mirror: when the children overflow, it gives up
the deficit weighted by `shrink × base-size` (grow and shrink are exclusive by the sign of
free space) — likewise position-pass-only.
**Flex wrap** (`LayoutContainer.wrap`) breaks children into multiple lines when they overflow
the main axis. Like grid-hug, it pulls flex INTO the measure pass: a single shared
`breakFlexLines` is called by both the position pass and the measure cross-hug fold (a
cross-hug container sizes its cross to the stacked lines), so the container's own size equals
the lines it lays out. Each line flexes its own grow/shrink; wrap is inert under a hugged main
axis, and breaks against the container's OWN size (a parent-stretched main is not re-flowed
into — a documented deferral that keeps the fold acyclic). **`alignContent`** distributes the
lines in leftover cross space and **`wrapReverse`** reflects them from the far edge — both pure
position-pass arithmetic downstream of `breakFlexLines` (no-ops under a cross-hug, so the measure
fold is untouched).
**Grid** (`layoutGridChildren`) auto-flows children into cell tracks and fills them, reusing
the same dirty machinery (once `isLayoutContainer` counts a grid as a container). Both axes
size through one shared `resolveGridTracks`: columns, and per-row tracks (`LayoutGrid.rows` —
explicit sizes for the leading rows, `rowHeight` the implicit fallback). A `px`/`fr` grid with
no hug reads no child sizes. But an **`auto` track** (sizes to the max child content) and
**grid-container hug** (`LayoutGrid.hugWidth/hugHeight` — the grid sizes its own axis to
`2·pad + Σtracks + gaps`) pull grid INTO the bottom-up measure pass, exactly like flex hug:
the measure fold and the position pass call the SAME `resolveGridTracks` off the SAME measured
own-sizes, so a hugged grid's own size equals the sum of its cells by construction, and
`containerHugs` recognises grid hug flags so a grid-child resize ripples up. On a hugged axis
`fr` collapses to 0 (no definite size to share). **Item spans** (`Layout.colSpan/rowSpan`) run a
CSS-style auto-placement (`placeGridItems`, called once inside `resolveGridTracks` so measure and
position share it): a forward-only cursor gives each item the next free `colSpan × rowSpan` block,
the row count is DERIVED (a `rowSpan` can grow the grid), and a spanning cell covers its tracks +
internal gaps. **`autoFlow`** adds dense packing (backfill gaps) and column flow (fix the rows,
derive the columns — the exact transpose of row flow, reusing the one kernel); **`gridColumn`/
`gridRow`** pin an item to explicit lines (a pre-pass marks it so auto items flow around it).

**Constraints / anchors** (`resolveConstraints`) are the responsive-positioning model for
children of a **plain** (non-flex/grid) parent: each child pins to the parent's edges and
repositions when the parent resizes. The stateless engine resolves this against a **frozen
per-child reference** (`Layout.constraintRef`, captured once at opt-in) rather than a
resize delta — `offset = parentComputed.local.size − constraintRef` is non-zero for BOTH a
direct `ResizeNodeAction` (stored size moves, ref frozen) and a layout-driven resize (a
grown/stretched/celled frame's computed size moves, ref frozen). It is pure top-down (no
measure feedback, no `expandDirtyForLayout` change): a parent size change dirties the
parent and the child inherits. *Known limitation (an M5 tool-layer concern): editing a
constrained child while its parent is off-reference writes geometry in the wrong frame; the
re-baseline is not yet built.*

**Out-of-flow escapes and margins.** `Layout.position: "absolute"` takes a child OUT of
its flex/grid parent's flow (no slot/cell, excluded from hug size and grow free-space),
positioned instead by its stored geometry + constraints against the parent box — so the
constraint gate admits an absolute child of any parent, and `MoveTool` leaves it draggable.
`Layout.margin` (`number | Margins`) is flex-flow spacing / a grid-cell inset, folded into the
grow free-space and the hug measure. Per-side margins map physical sides to the flex logical
axes by `direction` (via `resolveMargin`/`logicalMargin`), and both the measure fold and the
position pass map identically so a hugged container agrees with its children. All are small
position-pass/measure additions with no new dirty-tracking.

Still outstanding for the computed layer: **resolved style** (M5 tokens) belongs in
`ComputedState` and is not there yet; and M2's **remaining layout** — `minmax()`/`fit-content`
tracks, single-axis explicit placement, a separate cross-gap — is deferred (see MILESTONES.md).
Layout output today is expressed *as* geometry (computed local rects), not as a distinct channel.

## 4b. The motion trace — measuring what actually happened

**`core/diagnostics/MotionTrace` records where every node ACTUALLY is, at every frame.** It exists
because for a whole session the only way to answer "did it move, and by how much" was to drive the
running app over a debugger and read bounding boxes off the DOM by hand. That found real bugs — a
tweened shape that never moved, a ball that sped up sideways as it slowed vertically, a squash that
drifted its own centre — and every one of them was found by measuring positions frame by frame.
Making that a first-class, tested instrument is worth more than the next feature.

**It samples the COMPUTED world, not the stored document.** The stored `geometry` is an intent; a
node's ink lands where `computeGeometry` says after layout, constraints, instance expansion,
parallax, the parent chain and the transform have all had their say. A trace of stored values would
agree with the document and disagree with the screen, which is the opposite of an accuracy
instrument. So each sample runs the real pipeline — `applyFrame` then `computeGeometry` — and
records the resulting world matrix and bounds.

**It is PURE and DETERMINISTIC.** Same document, same frames, same trace, byte for byte. That is
what makes it diffable: two traces of the same animation before and after a change is a regression
test that needs no screenshots and no eyes. Wall-clock timing is deliberately NOT part of it —
elapsed milliseconds are a property of the machine, not of the animation, and mixing them in would
make every trace differ from every other.

**Timing is expressed in FRAMES, and the timeline's own fps converts to seconds.** An animation
authored at 12 fps and played on a machine managing 60 redraws a second is the same animation; the
trace records the former. `traceTiming` reports the seconds a frame range occupies so an animator
can ask "how long is this beat" without doing arithmetic against a fps they have to remember.

**Movement is DERIVED from position rather than recorded separately**, because two records of the
same thing drift. `traceVelocity` differences consecutive samples, so speed and direction cannot
disagree with the positions they came from.

**It is differenced at the node's ANCHOR, not at its bounding box.** A sample carries both: the
world bounds (where the ink is) and the world position of the node's transform origin (where the
node *is*). They are different measurements and only one of them is a position. A squashing ball
widens about its feet, so its bounding box's left edge moves outward while the ball itself travels
at a perfectly steady speed — difference the box and you get a velocity that reports the squash as
sideways motion. This was found by asserting the bouncing ball's horizontal speed was uniform and
watching it fail against a ball that was, in fact, moving uniformly. Spacing is a property of where
a thing is; the box is a property of how big it has become.

**The ACTION journal is the other half, and it is deliberately separate.** What a person did — the
actions dispatched, in order, with the revision each produced — is a history of the EDIT, while the
motion trace is a measurement of the RESULT. They answer different questions ("what did I change"
versus "where did it end up") and they have different determinism: the journal carries wall-clock
timestamps because when something was done is exactly what it is for. Keeping them apart is what
lets the trace stay diffable.

Both are BOUNDED. A trace over a long timeline with many nodes is quadratic in a way that a design
document is not, so the frame range and the node set are explicit parameters rather than defaults
that quietly walk the whole document; the journal keeps a fixed number of the most recent entries
and says how many it dropped.

### Inverse kinematics — posing a limb by its hand instead of its shoulder

**The rig already exists.** The scene graph composes a parent's matrix into its children, so
animating an upper arm already carries the forearm and the hand with it; `wavingLimb` is a two-bone
chain and needed nothing but `transform.origin` at the joint. What was missing is not a bone type —
it is the ability to say where the HAND goes and have the shoulder and elbow work themselves out.

**That is the whole difference between forward and inverse kinematics, and it is the difference
between a rig being usable and not.** Planting a foot on the ground with forward kinematics means
hand-tuning two angles per frame and re-tuning both whenever the hip moves, because the foot's
position is a consequence of the angles rather than a thing you can state. With IK the foot is the
thing you state and the angles are derived — which is also why a walk cycle authored this way
survives its own character being re-proportioned.

**TWO BONES, SOLVED ANALYTICALLY.** A two-bone chain is the limb — arm, leg, wing — and it has a
closed-form answer: the triangle with sides `l1`, `l2` and the root-to-target distance, by the law
of cosines. No iteration, no convergence to reason about, exactly one answer per bend direction, and
the same result every run.

**LONGER CHAINS USE FABRIK, and the closed form STAYS.** A spine, a tail or a tentacle has more
joints than a triangle has corners, and past two bones there is no unique answer at all — the same
hand position is reachable by infinitely many poses, so the solver's job stops being "find the
answer" and becomes "find a natural one". FABRIK does that by alternately dragging the chain back
from the target and forward from the root, which converges quickly and, because every step is a
projection onto a segment, always produces a chain whose bones are still the right lengths. The
two-bone case is NOT routed through it: an iterative approximation where a closed form exists would
be slower, less exact, and would make the commonest rig in animation depend on a convergence
argument. Picking the solver by chain length costs one comparison.

**ITERATION IS BOUNDED AND THE TOLERANCE IS FIXED**, which is not a performance choice. The whole
diagnostics layer rests on the same document always producing the same motion — a trace that
differed run to run would stop being comparable with another trace, and every regression check
built on it would evaporate. So the loop runs a fixed maximum and stops on a fixed distance, never
on elapsed time or an adaptive budget.

**BEND DOES NOT APPLY PAST TWO BONES.** A triangle has exactly two solutions and `bend` names one;
a longer chain has a continuum, and there is nothing for +1 or -1 to select. A document carrying
both is refused rather than quietly ignoring the field — the same call the motion path makes about
a keyframe that eases coordinates the route already owns.

**BEND DIRECTION IS AUTHORED, NOT GUESSED.** The triangle has two solutions mirrored about the
root-to-target line — elbow up or elbow down — and they are both correct. Which one a limb uses is
anatomy, so it is a stored `bend` of +1 or -1 rather than something inferred from the current pose,
which would let a knee flip inside out mid-animation whenever the chain passed through straight.

**OUT OF REACH IS NOT AN ERROR.** A target further away than `l1 + l2` has no triangle, and the
honest answer is the one every rig gives: the chain STRAIGHTENS and points at it. Solved by clamping
the distance into `[|l1 - l2|, l1 + l2]` before the cosines rather than by a special case, so the
straightened pose is the ordinary answer at the boundary instead of a second code path that can
disagree with the first.

**IT IS SOLVED IN THE ROOT'S PARENT SPACE, which is what keeps it out of the geometry engine.**
A bone runs JOINT TO JOINT — parent's transform origin to child's — and its length is the magnitude
of that vector, invariant under rotation, so the whole solve needs the document and nothing else.
Measuring between node positions instead is the subtle way to get this wrong: the effector lands
several pixels off its target and WANDERS as the middle joint turns, because the vector a rotation
swings starts at the pivot rather than at the corner. A planted foot drifting 11px is what that
looks like, and measuring it is how it was found. `applyIk` therefore slots in
beside `applyFrame` — a document with a solved rig is an ORDINARY document, and layout, picking,
snapping and all three backends learn nothing about skeletons.

**THE SOLVED ANGLE IS A DELTA FROM THE REST POSE.** A bone's rest direction is the direction of its
child's authored offset, so a rig posed by IK composes with however the character was drawn instead
of assuming every limb was authored pointing down the y axis.

**AND THE BONES NOW CARRY THE ARTWORK (schema 58).** Until then a rig could swing a limb and the
drawing stayed exactly where it was — `Rig` posed a skeleton, `Mesh` bent a shape, and nothing
joined them. A mesh control point may now name up to four bones, and lands at the weighted average
of where each would have put it: `posed · rest⁻¹`, the same delta-from-how-it-was-drawn the solved
angle already is, one dimension up.

Skinning **produces a mesh**, which is the design decision the rest follows from. Deforming the
outline after the warp would make a skinned shape and a warped one two pipelines, and a shape that
was both would depend on which ran first; folding the pose into the CONTROL POINTS instead means
`resolveMeshes` proceeds exactly as it always did, and a skinned limb is clickable where it is
drawn for the same reason a warped one is. The constraint that buys it is that a bone must SHARE
the mesh node's parent — one shared space, so the deform needs no world matrices and `Integrity`
can check the rule.

The rest pose is this same chain **without `applyFrame` and without `applyIk`**, the only two steps
that move anything, built as a thunk `resolveScene` hands to `resolveMeshes` — so an unrigged
document never builds it and a rigged one builds it once, not once per meshed node.

**AND THE HANDLES HAD TO LEARN IT.** `resolveMeshes` folds the pose into the outline and drops the
mesh, so the overlay reads the STORED points — which are the rest pose. A rigged shape therefore
deformed and left its control points behind in a neat grid, reported from a screenshot and measured
at 80 units on the fixture that reproduced it. Both the drawing and the PICKER now take the resolved
scene and run the same `posedMesh`, because this is the module whose whole reason for existing is
that the two cannot drift.

Chasing that turned up an older one. The mesh drag added a WORLD delta to a stored FRACTION, which
is the same thing only while nothing in between turns — on a 90° node a +10 pull moved the handle
(−4.5, +8.9), away from the pointer, and the comment beside it claimed rotation was "refused rather
than silently skewed" when it was not. It predates rigs; skinning only widened it, since a bone's
rotation lands in the same composition. `meshPointFromWorld` now SOLVES for the fraction that puts
the point under the pointer: the map from fraction to drawn position is exactly affine — matrices
throughout, and blend weights that do not depend on position — so probing it three times recovers
it and a single solve is exact. It inverts the very map the overlay draws with, which is what keeps
a handle from disagreeing with its own drag.

### Motion paths — the route, kept apart from the spacing

**Everything moved in straight lines.** A thrown ball travels on an arc, and the only way to say so
was to put keyframes along the curve — a polyline the author re-fits by hand every time either end
moves, which an editor then shows as six keyframes nobody authored. One curve says it once.

**The endpoints are not stored.** A segment's ends are the two keyframes' own positions; only the
two control points are kept, so a path cannot come to disagree with the keyframes it joins. They
are OFFSETS from their nearest endpoint, for the same reason mesh points became fractions in schema
43 — move a keyframe and the curve follows instead of snapping back to coordinates authored against
a position that no longer exists.

**Progress is ARC LENGTH, and that is the part worth getting right.** Equal steps in a cubic's
parameter are not equal steps in distance: a curve with long handles crawls at its ends and races
through its middle. Evaluated naively, a motion path would add an ease nobody authored and silently
fight the easing curve that IS authored — and spacing is the entire subject of the exercises this
engine exists to serve. So `t` is resolved against a sampled cumulative-length table by binary
search plus one linear step inside the bracketing sample. The easing shapes the spacing; the path
shapes only the route. The two stay separable, which is what makes either of them meaningful.

**The sampling is the approximation, and it is bounded rather than adaptive.** A cubic's length has
no closed form, so the table is the honest way to do this; the count is fixed so that the same
document always produces the same motion, which is what makes a trace diffable.

### Channels — when one property's timing must outlive another's

**A keyframe holds a whole state, and that is a limitation as well as an economy.** It is what let
animation cost almost nothing — a keyframe is an instance override with a frame number, so it
inherited the field rules and the blending already written. But it also means every property a node
animates must key on the SAME frames. A ball travelling at a steady speed across seven bounces needs
seven horizontal keyframes it never wanted; an arm that keeps swinging after the body stops cannot
be said at all. Overlapping action is the most-taught principle after squash and stretch, and it is
precisely the case where one property's timing has to outlive another's.

**A channel is a track for one property path — not a second animation model.** Same `Keyframe`,
same ascending-frame rule, same `hold`, same easing, the same `trackError` and the same
`overrideValueError`. The single added rule is that a channel's keyframes may name only its own
path, because a channel called `transform.rotation` that also sets `geometry.x` is a statement with
two meanings and the loader should refuse it rather than pick one.

**Channels are applied AFTER the track**, so a property named by both takes the channel's value.
That is the useful order — a channel is the more specific statement — and it means a document
written before channels existed behaves identically by not having any.

**The blending is not re-implemented.** A channel's value at a frame is computed by materializing
its two keyframes and running the same `blendNode` the track uses, then taking the one path it
owns. Interpolation rules for colours, angles and numbers live in exactly one place, so a channel
cannot drift from a track about what "halfway" means.

## 4b-bis. Image regions and pixel art — what real game art needed

**Every backend drew whole images, and that is not how game art ships.** `emitCanvas` called the
five-argument `drawImage`, `emitSVG` wrote a plain `<image href>`, and `emitWebGL` mapped its texture
across the destination rect. Measuring five real asset packs settled it: four of them are grids
inside single files — a creature strip that is 20x4 cells of 32x32, an RPG tileset 15x7 of 24x24, a
weapon set of 24 columns. Without a source rectangle, none of that content can be used at all.

**And nothing set the filter.** Nothing in `src/` touched `imageSmoothingEnabled`, `emitWebGL`
hardcoded `gl.LINEAR`, `emitSVG` set no `image-rendering`. Every pixel-art pack measured a soft-edge
fraction of **0.0000** — hard alpha, palettes of 13 to 31 colours — which is art that must not be
interpolated, and all three backends interpolated it unconditionally.

**Both live on the NODE and travel through the display list**, so the three backends read one
decision rather than each inventing it. That is the same split every other rendering choice here
makes, and it is why the pixel-art flag could not be a canvas-level setting: one scene mixes a
tileset that must stay crisp with a photograph that must not.

**The Canvas backend must set the filter for EVERY image, not only for pixelated ones.**
`imageSmoothingEnabled` is sticky context state, exactly like `setLineDash` — and this codebase has
already shipped that bug once, when a dash set for one item leaked onto the next. Written the same
careless way, one pixel-art tile would make every later photograph in the frame crunchy.

**SVG has no source rectangle**, so a region is drawn as a nested `<svg>` carrying a `viewBox`: the
viewBox maps the source rect onto the destination box and the nested element clips the overflow.
That needs the image's natural size, which comes from the shared `ImageCache` the other two backends
already use — so an undecoded image draws nothing here exactly as it draws nothing on Canvas, rather
than each backend inventing its own answer for "not ready yet".

**A TILEMAP'S SHEET IS SIZED THE SAME WAY, and briefly was not.** The tilemap branch is the same
nested-`<svg>` trick per cell, and it sized its inner `<image>` from a size *derived* from the grid
description — whose height came from the highest index the map happened to use. A real 968×526 sheet
whose map reached row 18 was therefore called 305 tall, so every tile was sampled 1.7× too far down
and the whole map drew from the wrong rows. **Canvas was right throughout**, because `drawImage`
takes the bitmap and never asks, and the GPU had exactly the same bug — so the two wrong backends
were wrong the *same* way, and a cross-backend comparison would have called it agreement. Both now
read `naturalSize` from this cache, and the derived helpers are deleted: a derived value that must
equal a fact about a file is an assumption with arithmetic around it. It was found by importing a
real map and diffing it against the node-per-cell import of the same file.

### A raster on the GPU — the href is a key, not a URL

**A `core.raster` holds pixels the DOCUMENT owns**, and its href is `raster:<id>:<w>x<h>:<len>:<sum>`
— an identity, not something to fetch. This backend called `resolveImage` on it, got null, and drew
nothing: a painted canvas invisible on the GPU while SVG and Canvas both showed it. The payload now
rides on the draw, exactly as it already rides on the display list, and the shared cache turns it
into a canvas synchronously — a `TexImageSource` like any bitmap.

**The texture key carries no decode generation**, unlike the image path. An image's href is stable
while its bitmap loads, so that path needs the generation to notice the arrival; a surface decodes
at once and its href already carries the size, length and checksum of the payload. The href
changing IS the pixels changing.

### Editing text where it is

**A real `<textarea>` laid over the node by `overlayTransform`** — the same relationship
`screenToWorld` inverts, so the field lands on the letters under any rotation, scale or zoom
rather than square over the AABB. Its typography comes from `resolveTypography`, which the render
model itself now calls: a field whose metrics disagree with the render puts the caret beside the
letters and makes the text jump the moment editing ends. Five defaults written twice is five
chances for one to drift, unseen until somebody types into a node that uses that slot.

**There is no buffer to commit.** Every keystroke goes through the ordinary coalesced content
action, so an in-place edit undoes exactly like one made in the inspector and nothing can be lost
by closing the field. Escape and blur both leave, and neither is a cancel — a cancel would have to
undo an unknown number of coalesced steps, which is what Ctrl+Z already means everywhere else.

**Keys stop at the field.** Without that, Delete reaches the canvas handler and removes the node
being typed into, and every letter switches tools.

### Framing the view — and which layer owns a chord

**`viewportToFit` had existed, tested, since the prototype NAVIGATE interaction**, and nothing in
the editor could reach it. The View menu's Zoom to Fit and Zoom to Selection are that same
arithmetic with a trigger; the padding is shared for the same reason, since a navigate and a fit
are one gesture.

**A chord belongs to exactly one layer.** `shortcuts.ts` owns the editor's chords and the Edit menu
deliberately carries no accelerators for them; the View menu owns its own, because a chord the
native menu claims is handled before the renderer ever sees the key. Binding one in both places
leaves the renderer's copy dead and both of them looking authoritative.

**A menu command is a string crossing a process boundary**, which is a seam no unit test on either
side can watch — this codebase has shipped two items that sent a command nothing handled. A
structural test now checks every `send()` in the menu against a `case` in the renderer.

### An opacity group is a LAYER, not an alpha folded into its parts

**A node with children and opacity below 1 composites as one and is then faded.** SVG nests a real
`<g opacity>`; Canvas draws the group's run into an offscreen canvas and brings it back under the
group's alpha at the identity transform, so no resampling happens. Folding the alpha into each item
instead — which is what Canvas used to do, and said it did — makes overlapping children show
through one another. That is not an edge case: a group is usually a group precisely because its
parts touch.

**`layerTransition` is the shared part, and it is a RUN rather than a lookup.** Creating a layer the
first time a group is named and reusing it later would pull that group's items back together in
draw order, changing what is in front of what — `content` is sorted by depth before the tree's own
order, so a group whose children sit at different depths genuinely is not contiguous. Closing and
reopening preserves the z-order the model published, at the cost of compositing such a group in two
pieces, which is the lesser wrong.

**The GPU keeps a STACK of render targets, one per nesting depth**, and composites each back
through the composite shader's `u_fade` — the target is premultiplied, so fading it is one multiply.
Two things had to change with it. The effect detour bound the DEFAULT framebuffer to composite a
shadowed item, which would jump that item out of its own group and onto the screen unfaded; it now
composites into the current destination. And a layer's own texture is still bound to unit 0 from the
composite that closed it last frame, so opening one unbinds units 0 and 1 — the same feedback loop
that once made a blurred shape come out as a hole.

**A CLIP IS A LAYER TOO (schema 59).** A container that cuts its children to its own box is the
same sequencing problem as a fade — which layers just ended, which just began — so it joins the
chain `layerTransition` already walks rather than getting a parallel one, which would be two
orderings to keep consistent and one wrong nesting away from a bug nobody could see. What differs
is what each backend does at the seam: SVG a `<clipPath>` on the group, Canvas a `save`/`clip`/
`restore` instead of an offscreen (a fade must composite before it can fade; a clip need not), and
the GPU a coverage test in the COMPOSITE shader — the one place that already sees the finished
pixels and knows which frame they belong to. Teaching every scene shader instead would mean the
same uniforms in each, and the next shader anybody added would quietly not clip.

The clip travels as a box plus the frame's world matrix rather than a world-space rectangle,
because a rotated frame's clip is not axis-aligned and flattening it would throw away the only form
in which it is still exactly a rounded rect.

**BLENDING NEEDED A BACKDROP THE GPU COULD READ (schema 60).** `multiply` and `screen` are almost
expressible with a `blendFunc` — almost, because that is only exact while the backdrop is opaque —
and `overlay` is not expressible at all, because it branches on the DESTINATION and fixed-function
blending has no branch. So a frame containing a blended item renders into a target instead of the
default framebuffer; each blended shape is drawn into a scratch target (through the ordinary path,
effects and all, by pointing `destination` at it for the length of the item); and a blend pass
combines the two with the W3C rule. The result becomes the new backdrop and the target just
consumed becomes the next scratch, so a frame with N blended items costs N extra full-screen passes
and a frame with none costs nothing.

Both images arrive PREMULTIPLIED and the blend formulas are not defined on that, so each is divided
by its own alpha before blending and composited back with `co = as(1-ab)Cs + as·ab·B + (1-as)Cb'`.
Dropping the first and third terms looks right over an opaque backdrop, which is every fixture that
does not think to make one translucent.

The one bug in getting there was the hazard this file already documents twice: the final composite
leaves the scene's own texture bound to unit 0, so the next frame bound that target and drew into
it — a feedback loop, every draw discarded, the backdrop simply absent. This time the console said
so in as many words.

**A TILEMAP IS ONE QUAD ON THE GPU (schema 61)**, and it is the one shape where this backend does
less work than the other two rather than more. SVG emits an element per visible cell and Canvas a
blit per cell, because that is all either can do; here the whole grid is a single rectangle and the
FRAGMENT stage does the work — floor the local position into a cell, read that cell's index out of
an index texture, and sample the sheet at the tile it names. Ten thousand cells, one draw call.

WebGL 1 has no integer textures, so an index arrives as two bytes with alpha as the presence flag,
and the index texture is sampled NEAREST because an interpolated tile index is not a tile. The
sample into the sheet is inset by half a texel on each side, which is the standard atlas-bleeding
fix — `CLAMP_TO_EDGE` guards the sheet's outer edge and does nothing for a rect inside it.

**THE SHEET IS RESOLVED ONCE, IN THE RENDER MODEL (schema 67).** A tilemap layer names a tileset
the DOCUMENT holds; `RenderModel` looks it up and hands each backend an `href` and a `sheet` exactly
as it hands any image an href, so all three stay ignorant of tilesets entirely and cannot disagree
about which picture a layer draws from. That resolution is the whole reason a document may hold
several sets without the backends changing at all. A dangling `tilesetId` yields null and draws
NOTHING while the file still opens — the inert-reference rule this schema follows everywhere — and a
COLLECTION set yields null and hands over `pictures` instead — a map of tile index to its own file
and that file's own size, resolved in the same place for the same reason. SVG and Canvas draw those
a cell at a time, anchored BOTTOM-LEFT so art taller than the grid stands over the row behind it;
`collectionTileBox` is the single statement of that arithmetic, shared, as `flipMatrix` is. THE GPU
DOES NOT: its tilemap is one quad sampling one sheet texture, so a picture per tile has nowhere to
come from, and `emitWebGL`'s header carries that as its only known gap rather than dropping the
content silently.

**A CELL CAN BE TURNED (schema 62)**, three bits per cell — horizontal, vertical, and a diagonal
that is a transpose. Measured before building: 820 of the corpus's 22,808 non-empty cells are
flipped across 14 of its 20 maps, all eight combinations appear, and the node-per-cell importer
already honoured them — so a grid without orientation would have been a regression rather than a
gap. Transpose first, then mirror: Tiled's order, not commutative, stated once in `flipMatrix`.
The GPU cannot take a matrix per cell, so it turns the within-cell coordinate instead and reads the
three bits from the index texture's otherwise-unused blue byte.

**Depth is off inside a layer**, which is correct rather than a compromise: `content` is already
sorted far-to-near by the model, so painter's order gives what the depth test would have. The call
is redundant — GL says a depth test against a framebuffer with no depth attachment always passes —
and is kept for the reason the effect detour keeps its own: code that is correct only because of an
attachment nobody asked for is worse than one extra call per layer.

### A gradient on the GPU, and the blend that was wrong all along

**The ramp is walked per fragment, with a CONSTANT loop bound and an early break.** GLSL ES 1.00
cannot size a loop from a uniform — `i < u_gradStops` does not compile at all — so the loop runs to
a compile-time 16 and leaves as soon as the real stop count is reached. Sixteen is the shader's
cap and not the schema's: WebGL 1 guarantees only 16 fragment uniform vectors, and the document
allows 64. A longer ramp falls back to the flat colour, which is what this backend already does
with anything it cannot draw.

**The radial case is SVG's focal formula, not a distance.** The colour at a point is how far along
the ray *from the focus* through that point it sits, as a fraction of where that ray leaves the end
circle. With the focus at the centre it collapses to `|p - c| / r`, which is exactly why a fixture
that never moves the focus cannot tell a correct implementation from a lazy one.

**And the alpha blend was wrong, and had been.** `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` applies
`SRC_ALPHA` to the ALPHA channel too, so a half-transparent fill over an opaque background leaves
`dst.a = 0.5·0.5 + 1·0.5 = 0.75`: the colour correct, the surface no longer opaque, and the canvas
then composited over the page with that alpha. `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA,
ONE, ONE_MINUS_SRC_ALPHA)` is the fix. It predates gradients — any translucent fill hit it — and it
survived because the RGB is right, `gl.getError()` is 0, and on a dark page the result looks
plausible. A ramp fading to transparent is simply the first thing that made a whole shape wrong
rather than one shade off. It was found by comparing pixels with the other two backends, which is
the only thing that could have found it.

### A gradient on Canvas — two moments, and the gap between them

**A path's coordinates are fixed when each segment is ADDED; a gradient is evaluated in the space
live at the FILL.** Those are two different moments, and everything the Canvas backend does with a
ramp lives in the gap: build the path, then move the CTM, then fill. The ramp moves and the shape
does not.

**Which is why there is no clip.** The obvious construction — clip to the shape, transform into
gradient space, flood a rect — also works, and then needs its own answer for the drop shadow the
clip eats. This one needs none: `shadow*` and `ctx.filter` are DEVICE-space and the CTM never
touches them, so effects set before the fill survive it unchanged. Both facts were measured in the
running app before the code was written, not read off a specification.

**`objectBoundingBox` is applied as a second `ctx.transform`, not as a multiplied matrix.** SVG's
order is the box and then `gradientTransform`; issuing them as two context calls means this backend
still composes nothing. The box arrives on `DrawItem.localBox`, because deriving it here would mean
computing a `path` item's extent — the arithmetic a backend must not do — and putting it on the
deduped `PaintGradient` would split one ramp across two differently-sized shapes into two defs.

**Verified by pixels, not by inspection.** A browser harness rendered one display list through both
backends and compared: seven cases including a sheared `gradientTransform`, a radial ellipse and a
rotated node, all identical to the channel. See TESTING.md for what makes that check falsifiable —
and for the way it lied the first time it was run.

### Reading `.aseprite` — the source of truth, not the export

**The sheet importers reconstruct by measurement what this file simply states.** Slicing recovers a
grid by dividing an image; `imageInkBounds` recovers a trim by scanning pixels; `sequenceTrack`
invents a frame duration because a folder of PNGs has none. Open the `.aseprite` that shipped in the
same pack as one of those sheets and it declares all three outright — 27 frames at 100 ms, 6 layers,
53 cels each carrying its own position and size, and five animation tags with exact frame ranges.

**The tags ARE clips.** `{ name, from, to }` is `Clip` field for field (schema 46), so importing them
is a rename rather than a translation — `Idle fast [0..3]`, `Attack animation [4..7]`. That
correspondence is the strongest argument for reading this format at all: the thing a PNG export
throws away is the thing this engine already models.

**And a cel's position IS the trim.** Aseprite stores each cel as a rectangle placed on the canvas,
so the padding was never in the file — it appears only when the sheet is exported. Reading the
source means the pixel scan `Trim` performs is unnecessary, not merely faster.

**PARSING IS PURE; INFLATING IS INJECTED.** Cel pixels are zlib-compressed, and this codebase has no
business choosing between `node:zlib` and `DecompressionStream`. The parser takes an optional
inflate function, exactly as `blankCells` takes an ink test and `drawSheet` takes a context: without
it the structure still parses and cels carry their compressed bytes, which is enough for clips,
timing and layout and is testable with no decompressor at all.

**All three colour depths are read, and `pixels` means SAMPLES rather than RGBA.** Aseprite stores
32-bit as RGBA, 16-bit as value-plus-alpha, and 8-bit as palette indices — three different things
under one field name, so the field says what the file says and `celRgba` does the conversion. Naming
it `pixels` while silently converting would make a caller believe it had the file's own bytes.

**Indexed is not a niche case.** It is how most pixel art is authored — the palette is the artist's
working vocabulary, not a compression trick — so a reader that handled only RGBA would refuse the
majority of the format's real use. The transparent INDEX comes from the header rather than from an
alpha channel, because an indexed file has no alpha to read.

**What is still refused is refused LOUDLY.** Tilemap cels and tileset chunks are named in the error
rather than half-read: they reference a tileset by index and reading one as an image produces a
picture of the wrong shape. A partly-understood file that loads looking almost right is worse than
one that says which feature it met and did not know.

**Honest about the verification.** The 32-bit path is checked against a real 210KB file from the
measured pack. No indexed or greyscale `.aseprite` was available to test against, so those paths
rest on the published spec and on fixtures built from it — which is weaker evidence, and is said
here rather than left for someone to assume otherwise.

### Trimming — and why the offset is the whole feature

**The padding is not small.** The measured stick-figure frames are 512x512 PNGs whose ink covers
**4.0% of the file**. Everything else is transparent: texture memory, fill rate, and a selection box
four times wider than the character it claims to be.

**TRIMMING NAIVELY IS WORSE THAN NOT TRIMMING.** Each frame's ink sits at a different place in its
padding — measured across four consecutive run frames, the ink origin moves (223,210), (209,204),
(222,208), (225,215) and the size ranges from 106x164 to 122x146. Trim each frame to its own ink,
drop them all into one box, and the character jitters sixteen pixels sideways and changes size every
frame. The padding is what was holding the animation still.

**So a trim is a rectangle AND a placement, never a rectangle alone.** Narrowing the source region
has to be paid for by moving and shrinking the destination by exactly the same proportion, which
leaves every pixel of ink exactly where it already was. That arithmetic is pure and is the part
worth testing; a trim that changed what the frame LOOKS like would be a bug wearing an optimisation's
clothes.

**Measuring the ink needs pixels, so it lives in the renderer** beside `ImageCache`, and the pure
half takes the measurement as an argument. The same split `SpriteSheet` makes between planning a
sheet and drawing one, and `SheetSlice` makes between a grid and whether a cell has ink in it.

**The threshold is a parameter defaulting to fully transparent.** The measured packs disagree about
edges — the pixel-art sets are hard-alpha (0.0000 soft-edge fraction) while the stick figure is
antialiased (0.0686) — so a fixed cutoff would either keep a halo of near-invisible pixels or eat
the antialiasing off a character's outline.

### The import panel — making the readers reachable

**Three importers existed that no user could invoke.** `SheetSlice`, `TextureAtlas` and `Sequence`
were pure, tested and mutation-checked, and reachable only from a test file. That is the same gap
the sprite-sheet exporter had before it grew a button: a feature nobody can run is not shipped, and
its being correct is beside the point.

**It operates on the SELECTED IMAGE NODE**, not on a file picker of its own. The node already
carries the `src`, the document already knows where it sits, and `sourceRect` is already a field on
it — so importing is a matter of filling in numbers the node has room for, rather than of inventing
a parallel place to put an image. It also means the result is visible the moment it is applied,
because the node is on the canvas being looked at.

**Two ways in, because sheets arrive two ways.** A GRID is stated by the author (a cell size, and a
margin and gutter if the packer used them) and recovered by division. An ATLAS is pasted in and
read, which is the only route for the 57% of real sheets that are packed irregularly. They produce
the same thing — regions — so the panel offers them side by side rather than as separate features.

**Slicing produces an ANIMATION, not a pile of nodes.** The cells of a sheet are almost always the
frames of something, and a region is keyframable (schema 52), so the natural result is one node
whose track steps through the cells. Placing forty nodes would be the same information arranged so
that nothing can play it.

**The natural size comes from the decoded image**, so the panel refuses to slice an image that has
not loaded rather than guessing at its dimensions — the same rule `emitSVG` follows for a region,
and for the same reason: a grid computed against the wrong size is wrong everywhere at once.

### Tiled maps — the last 2D format, and the one that already fits

**A `.tmx` is a grid of references into a sheet, which is exactly what this engine now models.** A
tile is a `sourceRect` (schema 51), a tileset is a grid `SheetSlice` already recovers, and the
spacing Tiled writes is the gutter that slicer already takes. So the reader's job is to resolve a
GID to a tileset and a cell, and everything downstream is machinery that exists.

**THE TOP THREE BITS OF A GID ARE FLIP FLAGS.** A raw id of 2,684,354,697 in the measured maps is
tile 137 with two flips set, and a reader that took the number at face value would index past the
end of every tileset it met. Masking them off is not optional and neither is reporting them: a
flipped tile drawn unflipped is a wrong picture, not a missing one.

**Layer data arrives three ways** — CSV in 18 of the files, base64 in 2, and zlib-compressed base64
in those same 2. Inflating is injected exactly as `Aseprite` injects it, so the parser stays pure
and testable with no decompressor present.

**Tilesets arrive two ways too**: embedded in the map, or as an external `.tsx` the map names. Both
appear (11 and 18), so both are read — and an external one is RESOLVED BY THE CALLER, because a
parser that reached for a file would need a filesystem and stop being pure.

**Orientation changes placement, not parsing.** Four maps are isometric, where a cell's screen
position is a diamond rather than a grid, so the placement formula is part of the reader and the
orientation is reported rather than assumed.

**Placing a map costs one decoded image.** Every tile is the same sheet at a different `sourceRect`,
so a 10,618-tile map holds one `data:` URL and ten thousand rects — which is the whole reason the
region field went in before this did.

**A `.tmx` names paths, and a `.tmx` is plain text anyone can write.** The bridge that resolves them
confines every one to the folder the USER picked rather than to the map's own directory: real maps
reference `../Spritesheet/sheet.png` one level up from themselves and still well inside the pack.

**Coverage is measured, not assumed — and re-measured, because the tree moves.** Running every
reader over it reads 62,929 of 90,360 files (69.6%) with nothing refused and nothing failing. The
rest has no reader at all rather than a broken one: ~25,700 3D files, 1,342 audio, and the remainder
project files, archives and readmes. THE COUNT IS A SNAPSHOT: the tree grew by 2,044 files between
two runs, which is how the AppleDouble problem below surfaced — so the sweep is re-run rather than
its last answer quoted.

**465 FILES IN THE TREE ARE NOT ASSETS.** A macOS copy onto a non-HFS volume leaves an AppleDouble
sidecar beside every file — `._sheet.png` next to `sheet.png` — holding a resource fork rather than
an image. 410 carry a `.png` extension. An extension test alone therefore puts 410 entries in the
asset browser that every decoder then refuses, which reads as corrupt art rather than as metadata,
so `walkDir` skips them along with `.DS_Store` and `Thumbs.db`. The readers were already right to
refuse them; the fault was in what was offered to them. That sweep is what pointed at the three Tiled forms above — but only
partly, and the shortfall is the lesson. It failed on two files, and it failed on them for their
QUOTING rather than for being collections; the third collection set used ordinary double quotes,
took its first tile's image as the whole sheet, and PASSED, because the sweep's only question was
whether parsing threw. "Did it parse" is the same complacency as per-format testing, one level up.
The sweep now asks something that can fail — `tilesetOverflow` — and the old reader is the proof
it discriminates: run against it, that check puts the last tile of a 352-pixel image at y=122,144.

**`inflateSync` is the one synchronous channel in the app.** Both `parseTiledMap` and
`parseAseprite` call their injected `inflate` DURING the parse, which is what keeps them pure; an
async bridge cannot satisfy that. Both shipped with the injection point and nothing to inject.
### glTF — geometry this engine cannot draw yet, read correctly anyway

**3D starts as a READER, not a renderer.** 5,286 glTF files sit in the measured tree and nothing can
open one. Reading them is a self-contained problem with a right answer; drawing them is a schema, a
node type and a pipeline. Doing the first well is what makes the second small — the same order every
2D format went in.

**THE VERTEX DATA IS INTERLEAVED.** 9,596 bufferViews in the tree declare a `byteStride`, meaning a
primitive's positions, normals and UVs are woven together rather than stored one array after
another. A reader that walks an accessor tightly-packed produces coordinates from whatever happened
to sit at that offset — a mesh, drawable, made of nonsense. This is glTF's flip-flag: it is the
common case, not the exotic one, and there is no error to notice.

**AN ACCESSOR IS TWO OFFSETS, NOT ONE.** It carries its own `byteOffset` INTO a bufferView that
carries another into the buffer. Adding one and not the other is off by a fixed amount that looks
like a model built slightly wrong rather than a model read wrongly.

**Indices arrive in three widths** — unsigned byte, short and int all appear — so the index reader
is driven by the declared component type rather than by a guess that holds for most files.

**A REQUIRED extension is refused by name.** 246 files list `KHR_materials_unlit` in
`extensionsRequired`, which is the file stating that ignoring it changes the picture. Reading such a
file silently is choosing to be wrong; naming it lets a caller decide.

**The buffer is supplied, not fetched.** A `.glb` carries its BIN chunk inside it, but the 254
`.gltf` files name an external `.bin`, and 3,941 images are sidecar files. The reader resolves
neither — the same rule the Tiled reader follows, and for the same reason: a parser that reached for
a file would need a filesystem and stop being testable.
### OBJ — three index streams that a GPU cannot use as three

**`v`, `vt` and `vn` ARE INDEPENDENT.** A face names a position, a texcoord and a normal by SEPARATE
indices, and nothing requires them to line up. A GPU wants one index per vertex, so the obvious
implementation — build the vertex buffer from the `v` lines and index it by the position index — is
wrong the moment a position is shared by faces with different normals. It is wrong in 598 of 600
measured files. A cube's corner takes whichever normal was written last, and a hard-edged model
shades like a soft one: well-formed geometry, quietly wrong lighting, no error anywhere.

So the reader DE-DUPLICATES `v/vt/vn` triples into unique vertices. The measured expansion is 1.87
vertices per position on average and 3.5x at worst, which is the cost of being right.

**FACES ARE NOT ALWAYS TRIANGLES.** 81,712 of the 2,605,375 faces in the tree have more than three
vertices — mostly quads, up to a 13-gon. A reader that took the first three vertices would drop 3%
of every model's surface, leaving holes that look like a broken exporter. They are fan-triangulated,
which is exact for the convex faces an exporter emits.

**Indices are 1-BASED, and may be NEGATIVE** — counted back from the end of what has been read so
far. None of the measured files uses a negative index, which is exactly why it has to be tested
rather than assumed absent.

**The material library is a sidecar.** Every one of the measured files names an `.mtl` and every one
of those resolves beside it, but the reader does not fetch it — the same rule Tiled and glTF follow.

**One mesh becomes several.** `usemtl` splits a file into runs, 13,852 of them across the tree, and
each run is its own primitive so a model with a painted and a metal part is two draws rather than
one with an arbitrary material.
### Backend parity — the shadow that was half as soft

**Three backends must draw one document the same way**, and until this was measured they drew it
three ways. `Shadow.blur` is a gaussian SIGMA — it is what SVG's `feDropShadow stdDeviation` takes
and what CSS `filter: blur()` takes — but the canvas shadow property is the odd one out: its spec
defines the blur as a gaussian of sigma `shadowBlur / 2`. The Canvas backend passed sigma straight
through, so every drop shadow it drew was HALF as soft as the same document on the SVG backend. That
does not look like a bug; it looks like a slightly crisper render.

MEASURED, NOT READ OFF THE SPEC — the reach of a shadow's alpha in pixels from a square's edge, in
the real renderer:

    sigma:            4    8   20   40
    SVG feDropShadow: 8   17   45   89
    canvas, raw:      4    8   22   46      <- what shipped
    canvas, doubled:  8   18   46   87      <- matches

**Only the softness was wrong.** The OFFSETS are distances rather than deviations and were already
right, and `ctx.filter: blur()` already takes a sigma, so it already agreed. Correcting the whole
shadow block would have moved every shadow twice as far as SVG puts it — which is why the test
asserts the RATIO of each argument to its source value rather than three literals.

The remaining parity gap is the GPU backend, which ignores both effects outright — and closing it
starts with the arithmetic rather than the plumbing.

**THE KERNEL IS PURE, THE PLUMBING IS NOT.** A framebuffer, a second program and two passes cannot
be unit-tested without a GL context; the weights can, and they are where a blur that still looks
like a blur hides being wrong. So `Gaussian` holds the numbers and the backend spends them.

**Separability is the whole reason this is affordable.** A 2D gaussian is the outer product of two
1D ones, so blurring horizontally and then vertically costs `2r+1` taps rather than `(2r+1)^2` — at
sigma 20, 121 against 14,641.

**It was checked against the backends it must match, not against its own formula.** Convolved with
a hard edge and compared PER PIXEL to what `ctx.filter: blur(sigma)` actually draws:

    sigma:           2        5       12
    worst |diff|: 0.0017   0.0027   0.0026     (alpha, 0..1)

Under 0.7 of one 8-bit level, with the midpoints agreeing exactly — so the pixel-centre convention
matches too.

**Normalised AFTER truncation.** A kernel cut at 3 sigma keeps 99.73% of the curve, and spending
0.9973 of the light is a blur that DARKENS what it touches, more the wider it gets — which reads as
a shadow too weak rather than a kernel too short. **The radius is clamped** at 64 taps and says so,
because zoom multiplies sigma: a 500-tap kernel is reachable by zooming in, not by an odd document.

**Where this has got to.** The kernel, the blur program with its render targets, and the composite
pass all exist and are each verified against something independent — the kernel per-pixel against
`ctx.filter`, the shader against a CPU convolution, the composite against hand-computed tint and
offset expectations. What remains is the LOOP WRAP: binding a target before an effected item's
draws and compositing the shadow under the shape afterwards.

**Three things were caught by measuring rather than reasoning, and each would have survived a
reading.** An `initBlur` that left `ARRAY_BUFFER` bound, safe only because its one caller happened
to rebind twenty lines later. A composite that declared an offset its shader never used, so every
shadow would have landed exactly on its shape. And a y axis pointing the wrong way — GL's
framebuffer grows upward, the document's downward, so `dy: +4` rose instead of falling.

**Unwired code is ABSENT, not merely inert.** `ensureTarget`, `blurPass` and `compositeTarget` were
tree-shaken out of the shipped bundle entirely until the loop wrap called them — worth knowing
before trusting any claim that something was "verified in the bundle" about a path nothing calls.

**A WIDE BLUR IS COMPUTED SMALL.** `blurPlan` halves the resolution until the sigma fits the kernel,
because the clamp alone is a COLLAPSE rather than a taper: past sigma 21.3 every blur came out the
same width, and a 20px blur at 1:1 on a Retina display already reaches that, since device sigma is
`blur * zoom * dpr`. Sigma 320 now renders where 21.3 was the ceiling.

### The effects path was broken by a FEEDBACK LOOP, and the cause was state, not maths

A shape carrying a blur rendered as a HOLE on the WebGL backend — the centre pixel `[74,144,217]`
on Canvas and `[26,26,46]`, the clear colour, on WebGL, with 59.7% of the shape's region differing.

Every component had been verified on its own — the kernel to 0.0027 against `ctx.filter`, the
shader to 0.0018 against a CPU convolution, the composite's tint and offset against hand-computed
values, `blurPlan`'s invariant across seven sigmas. The assembly was still wrong, because every
piece WAS correct.

**The blur and composite passes bind their SOURCE texture to unit 0, and the scene program samples
the height field on unit 0.** So drawing an item into `targets[0]` while `targets[0]`'s own texture
was still bound there — left over from the previous item's blur — made the active program reference
a texture attached to the bound framebuffer. WebGL calls that a feedback loop and DISCARDS THE DRAW
with `INVALID_OPERATION`. Nothing reached the target, the blur filtered an empty image, and the
composite brought back nothing: a hole exactly the size of the shape.

Fixed by unbinding units 0 and 1 straight after binding the target. A draw that needs either
texture binds it immediately before drawing, so nothing else had to change. `emitWebGL.ts` has no
GL context in the node suite, so the fix is held by a SOURCE PIN that was proven to fail when the
unbinds are deleted — it catches removal, which is the realistic regression.

**The diagnostic was the one this section already said to take**: read the target's own pixels after
the item draws and before any blur. `drawnPixels` came back 0 with `errorsFromDraws: [1282]`; after
the fix, 360,996 with no errors, and a band across the shape shows 647 pixels of fill plus the
blur's intermediate edge values.

**Two measurement traps it walked into first, both worth remembering.** `gl.getError()` read AFTER
the probe's own `readPixels` conflates the two — drain the error before reading. And reading the
DEFAULT framebuffer outside the frame that drew it returns black, because WebGL clears the drawing
buffer once it is presented; the long-standing note that "gl.getError() is 0, so diff pixels not
errors" came from exactly that kind of reading taken at the wrong moment, and it sent the
investigation away from the error that was there all along.

### Pixels — the one thing no import can add

**A `core.raster` NODE IS NAMED, RESOLVED AND DRAWN — on the Canvas backend.** `buildRenderModel`
emits it as an image whose `href` identifies the surface, the same seam `core.image` uses, and
`ImageCache.resolveSurface` decodes it.

**THE HREF CARRIES IDENTITY, NOT THE PAYLOAD** — deliberately, since a base64 surface in a cache key
would be enormous and would be rebuilt every frame. `resolveImage` works by `img.src = href`, which
for a `raster:` key simply fails to load, so the cache cannot decode a surface it cannot see.

**The registration question dissolved rather than being answered: the SHAPE carries the payload**
along the display list. That is a reference to a string the document already holds, not a copy, so
the model stays plain data and stays pure — and the cache decodes lazily on a miss. All three
alternatives cost something this codebase already refuses: registering from inside
`buildRenderModel` makes the model impure, which is the property the codec decision exists to
protect; registering on every document change decodes whether or not anything drew the node;
lazy-on-miss costs one frame without the picture, which is exactly what an ordinary image load
already costs — the ESTABLISHED behaviour rather than a new one.

**ONE NOTION OF "LOADED" ACROSS THE BACKENDS.** A raster could have been handed to each as raw
pixels — `putImageData` for Canvas, `texImage2D` for the GPU — but SVG has no such path and would
still need a URL, so the three would have disagreed about when a surface was ready. Turning it into
the same `HTMLImageElement` every other href resolves to means they cannot, and the `onload` path
that bumps the generation and asks for a repaint stays in one place. `data` is already straight RGBA
in exactly the order `ImageData` wants — which is WHY the paint layer is not premultiplied.

Verified in the real renderer rather than by construction: an 11-byte run-length payload decodes,
reaches a canvas, survives `toDataURL` and an `Image` load, and reads back `[255,0,0,255]` where it
should be red and `[0,0,0,0]` where it should be clear. `putImageData` is present in the shipped
bundle, where it was tree-shaken before.

**THE GPU BACKEND IS NOT WIRED.** Its `Draw` carries an image structure with no payload field, so
threading it through `itemDraws` is a real change rather than a two-line one. It continues to skip
rasters, alongside the effects regression already recorded against it above.

**SVG WAS THE SAME, AND IS NOW FIXED.** It emitted `<image href="raster:<id>:<w>x<h>:<len>:<sum>">`
— an identity key, not a URL — so the element was present, correctly placed, carried
`image-rendering="pixelated"`, and loaded NOTHING. A painted canvas was invisible on the DEFAULT
backend while behaving normally everywhere else. Found by driving the running app; no test in 1312
could see it, because the emitters have no DOM coverage.

`emitSVG` now resolves the surface through `ImageCache.resolveSurface` — the SAME cache the Canvas
backend uses, so there is one notion of "loaded" rather than a second that could disagree — and
sets the decoded element's `src`. **While it decodes there is NO href at all**, rather than the
unusable key: an `<image>` with a broken href is a broken-image glyph in some renderers, which is a
WRONG picture rather than a missing one.

Verified live end to end: the emitted href is a `data:image` URL, and decoding it back gives a
70x50 picture holding exactly 51 opaque black pixels — the stroke — against 3,449 transparent.
`emitSVG.test.ts` pins the half a DOM-less run can see (the key is never emitted as an href) and was
proven to FAIL on the pre-fix line with the exact signature.

**The whole loop was driven over CDP** and each step read back rather than assumed: drawing with the
▦ tool creates a `core.raster` with an 80x60 surface for an 80x60 drag; a brush stroke moves the
payload from 128 to 404 bytes; ONE undo returns it to exactly 128 and redo restores 404 byte for
byte; and the Canvas backend really does display it — 63 magenta and 36 black pixels counted inside
the node's own box.

**PAINTING IS NO LONGER A REPAINT BEHIND** — `resolveSurface` decodes into an offscreen CANVAS and
returns it synchronously, so the frame that asks for the pixels gets them. The `Image` round-trip it
replaced was the whole cause: `toDataURL` then `onload` is asynchronous, and while one late frame is
nothing for a picture that arrives once, a brush changes the cache key on EVERY MOVE, so every move
paid it. All three backends take a canvas (`drawImage` accepts a `CanvasImageSource`, `texImage2D`
accepts a canvas); SVG alone needs a URL and gets it from `surfaceUrl`, which encodes lazily and
caches per entry because `toDataURL` re-encodes the whole surface.

**The cache is now keyed by NODE, not by href.** The href folds in a pixel checksum, so an
href-keyed cache kept one full-size canvas PER STROKE for the life of the session — a 512-square
surface is a megabyte and a few minutes of drawing is hundreds. One entry per node, replaced when
the payload changes, is the only version that does not leak while somebody paints.

Measured live: a stroke is visible after ONE animation frame (46 near-black pixels found with no
settling delay, where the previous build found nothing).

> **RESOLVED — and it was the implementation this replaced.** The open question here was that two
> strokes on one surface left the stored surface holding BOTH (rows 24 and 39 of a 70x50) while the
> Canvas backend drew only the newer one. Re-measured against the synchronous cache: Canvas draws
> BOTH — surface rows 12 and 36 appear as device rows 11/12 and 35/36 at dpr 2.41, 128 dark pixels
> each, which is a 53px stroke scaled. The divergence belonged to the `Image` + `onload` version,
> where every stroke minted a NEW href-keyed entry and the load was asynchronous, so which entry a
> frame drew from could depend on which had finished loading. Two consumers can no longer disagree
> because `resolveSurface` and `surfaceUrl` both go through one `surfaceEntry`, keyed by node, and
> the decode has no load to race.
>
> Two things that cost time and are worth not repeating. **Sampling with 3,500 separate
> `getImageData` calls crashed Chromium's network service** — read the region ONCE and scan the
> buffer in the page. And the backend switch is no longer a toolbar button (it moved to the View
> menu, which CDP cannot click), so putting the Canvas backend under test now means flipping the
> default in `App.tsx`, measuring, and reverting.

**The superseded reasoning, for the record:** The cache is
keyed on the href, the href folds in a checksum of the pixels, so EVERY STROKE IS A FRESH MISS —
`resolveSurface` returns null, decodes, and asks for a repaint. The "lazy on miss costs one frame"
trade recorded above was reasoned about a picture that arrives once; a brush changes the key on
every move. The first sample after a stroke found nothing and only a settled repaint showed the
paint. Left as it is for now because the fix is a decoded-buffer fast path for the node being
painted, which is a second source of truth for the picture — the thing this seam exists to avoid.

**The previous state, for the record:** `buildRenderModel` does
not know the type, so it falls through to a `rect` shape carrying the node's `fill` — which for a
raster node is `"none"`. The node exists, validates, serializes, round-trips and accepts paint
through the dispatcher; nothing draws it. Measured, not assumed: a document with a raster node and
a rectangle produces two items, both `shape: "rect"`, neither carrying an image.

**That is the same failure class as the delta layer dropping `surface`** — no error, no log, just
nothing. Twice in one sitting, which says the shape is systemic: a field or a type that one layer
emits and the next does not recognise fails SILENTLY here, because every layer is permissive about
what it does not understand.

**The design question it opens.** A backend draws pictures by `href`; a `RasterSurface` is
run-length text. Three ways out, none obviously right:
- decode to pixels in the render model and have each backend upload them (`putImageData`,
  `texImage2D`) — but SVG has no such path and would still need a URL;
- encode to a PNG data URL at render time — needs a canvas, so the render model stops being pure,
  which is the property the whole codec decision was made to protect;
- cache a data URL beside the node, invalidated on paint — impure at the edge only, but a cache is
  a second source of truth for what the picture is.

Settle that before writing any of it.



**Every node type this engine has is composed from geometry or references an image someone else
made.** Nothing holds pixels Canvas Fogworks authored, which is why no amount of import work adds up to pixel
art: a sprite editor's whole subject is a buffer you can change one dot at a time.

**THE OPERATIONS ARE PURE FUNCTIONS OVER A BUFFER, not methods on a canvas.** A 2D context would do
all of this and could not be unit-tested, undone, or replayed — and the action layer needs exactly
those three. Keeping the arithmetic in `core/paint` means a stroke is a VALUE, which is something
the document can hold and the dispatcher can reverse.

**A plot's x bound is not implied by its index.** `(y * width + x) * 4` is a valid offset for an x
of -1 or of `width`; it simply lands on the previous or next ROW. Bounding only the total index
draws a stray column down the opposite edge whenever a stroke runs off the side — a rendering
artefact rather than missing arithmetic.

**Painting REPLACES rather than blends**, because an eraser is a pencil with a transparent colour.
A blending plot cannot erase, and every editor that blends by default grows a separate eraser path
that then disagrees with the pencil about edges.

**Fill is four-connected and queue-driven.** A diagonal seam is a WALL in pixel art — it is exactly
the join an artist uses to enclose a shape — so eight-connected leaks through the corner and floods
the sprite. And the obvious recursive fill is 16.7 million deep on a full 4096-square surface, which
gives out as a stack overflow in the middle of a stroke.

**Still to come:** a node type that holds one of these, the serialization decision (a 4096-square
RGBA buffer is 67 MB, which is also what one undo step would weigh), and the tools.
### Fonts — a family name is not a font

**`style.fontFamily` has always been a STRING and nothing else.** A document could ask for "Kenney
Blocks" and every backend would hand that name to the platform, which would shrug and draw something
else — the text still laid out, just in the wrong typeface, which is the kind of wrong that looks
like a rendering bug. 56 font files sit in the measured tree and none of them could be used.

**The name has to come OUT of the file, not off the filename.** `Kenney Future Narrow.ttf` is a
guess; the `name` table states the family the platform will match on, and the two are not reliably
the same — a file renamed on download would silently never match. So the family is read from the
font, along with the weight and italic flag that map onto `style.fontWeight`.

**Parsing is pure and stops at the name.** Reading glyph outlines would be a typesetting engine, and
this engine does not need one: the platform already rasterises text once a face is registered. What
it needs is the handful of facts required to register the face and to describe it in a picker —
family, subfamily, weight, italic, and which flavour of outline the file carries.

**Registration is the impure half**, and belongs with the other decode work in the renderer layer
beside `ImageCache`, for the same reason: it needs a DOM, and keeping it out of core is what lets
every rule above be tested without one.
### SVG documents — flattened, because the transform model does not reach

**A `<g transform>` cannot become a node transform.** Canvas Fogworks' `Transform` is rotation, scale and an
origin; SVG's is an arbitrary affine matrix, and `matrix()` accounts for 23,276 of the 24,861
transforms in the measured art. Decomposing one into rotate-and-scale works only when it contains
no skew, and silently produces the wrong shape when it does.

**So the transform is BAKED INTO THE COORDINATES instead**, and that is exact rather than a
compromise. A Bézier curve is affine-invariant: transforming its control points transforms the
curve itself, with no error at all. Paths are absolute command lists, so composing the group stack
down to each `<path>` and multiplying through every coordinate loses nothing — it loses the group
STRUCTURE, which is a different and much smaller loss than losing the shape.

**`<use>` is expanded, because it is not a corner case here.** 19,194 elements reference a defined
symbol, and a reader that skipped them would silently drop most of the drawing in the files that use
them. It is expanded with a depth bound, since a symbol that references its own ancestor is a loop
rather than a picture.

**A gradient fill arrives WHOLE (schema 56).** 2,491 fills reference one and every one of them used
to arrive as its first stop; `Style.fill` can hold a ramp now, so `SvgDocument` reads it through
`SvgGradient` and hands it to the node — 2,785 shapes across the corpus. Only STROKES still flatten,
because `Style.stroke` is a colour string and exactly one stroke in 3,127 measured gradients
references a ramp. Every remaining approximation is reported in a `notes` list rather than left for
someone to notice.

**And the ramp is MOVED with the shape, at two points that no type can check.** This importer bakes
the group transform into the coordinates, so a gradient left where the file put it would paint in a
system the shape has already left; `placeGradient` premultiplies the same matrix. `svgNodeSpecs`
then normalises the path onto the origin, so it premultiplies that translation too — and skipping
that one puts every ramp where the ink used to be. `objectBoundingBox` is turned into
`userSpaceOnUse` by folding `translate(box) · scale(size)` into the matrix rather than multiplying
the coordinates, because a radial ramp in a non-square box is an ellipse that no `cx/cy/r` states.
The corpus cannot check that fold at all: not one of its 2,491 references uses `objectBoundingBox`,
which is why the fold is pinned on hand-computed fixtures instead.

**It reads the shapes this format defines, not XML in general** — the same promise `TextureAtlas`
makes, and for the same reason: core is pure and has no DOM, and a regex that claims to parse XML
is a liability. What it cannot make sense of it names.
### SVG path data — the one format that has to be converted, not just read

**Vector art is the largest remaining import gap: 5,279 files holding 95,160 `<path>` elements.**
Unlike a sheet or an atlas, this cannot be read across — Canvas Fogworks' `PathCommand` is `M`/`L`/`C`/`Q`/`Z`
and absolute, while SVG's `d` grammar has twenty letters, relative forms, implicit repetition and
elliptical arcs. Every one of those appears in the measured tree, so the conversion is the feature.

**WHAT TO BUILD WAS MEASURED, NOT ASSUMED.** Counting command letters across all 95,160 paths:
`L` 478,757 · `Q` 377,390 · `M` 227,024 · `Z` 40,263 · `l` 35,475 · `c` 28,273 · `a` 16,205 ·
`h` 7,371 · `v` 5,547 · `z` 5,205 · `C` 4,183 · `A` 2,788 · `V` 2,589 · `H` 1,884 · `s` 1,400 ·
`S` 444 · `m` 366 · `q` 311. Arcs alone number about nineteen thousand — the piece it would have
been most tempting to skip, and the one that would have silently dropped a fifth of the shapes.

**Arcs become CUBICS, split at quarter turns.** An ellipse arc has no exact cubic form, so the
sweep is divided into segments of at most 90° and each approximated with the standard
`4/3·tan(Δ/4)` control-point distance — the error of which is under a thousandth of the radius at
that step size, far below anything a canvas resolves. Splitting matters more than the constant: one
cubic across a half-turn is visibly not a circle.

**Everything else is normalisation.** `H`/`V` become `L`, relative letters are resolved against the
current point, `S` and `T` reflect the previous control point (and degrade to the current point when
the previous command was not the matching curve, as the spec requires), and a coordinate pair
following an `M` is an implicit `L` — the rule that makes `M 0 0 10 10` two commands rather than a
syntax error.

**The subpath origin is tracked, because `Z` returns to it** — not to the document origin, and not
to the last `M` if several subpaths have been drawn since. Getting that wrong closes every shape to
the wrong corner, which looks like a rendering bug rather than a parsing one.

### Reading an atlas — when there is no grid to recover

**Most real sheets are not grids.** Surveying 421 atlases shipped with 88,815 files of game art:
**206 are irregularly packed, 33 are uniform but not aligned, and only 182 are true grids.** One
holds 359 sprites in 135 distinct sizes at coordinates like 455,849 and 520,179. `SheetSlice` cannot
read any of the first two groups — dividing that image by anything produces nonsense — so more than
half of the real sheets are unreachable by measurement.

**They do not need to be measured, because they come with a descriptor.** The Starling/ShoeBox
`<TextureAtlas><SubTexture>` format is what almost every packer emits, and its fields land exactly
on what this engine already has: `x,y,width,height` IS a `sourceRect` (schema 51), and
`frameX/frameY/frameWidth/frameHeight` IS the trim placement `core/import/Trim` computes. Reading
one is a rename plus arithmetic already written.

**THE TRIM ARITHMETIC IS REUSED, NOT REWRITTEN.** An atlas states the untrimmed size and where the
kept piece sits inside it; `trimmedPlacement` states where a kept piece goes so its ink does not
move. They are the same question with the inputs named differently, so the atlas reader hands its
numbers to that function rather than growing a second copy of the multiply-and-offset that would
drift from it.

**IT IS A TEXTUREATLAS READER, NOT AN XML PARSER**, and the distinction is deliberate. Core is pure
and has no DOM, and a regex that pretends to parse XML is a liability the moment it meets a CDATA
section or a namespace. This reads exactly the shape the format defines and refuses anything else by
name, which is a much smaller promise and one that can be kept.

**Rotation is refused rather than ignored.** No atlas in the surveyed tree uses it — the one genuinely
fiddly feature of the format is simply absent — but a packer that emitted it and a reader that
skipped the flag would draw every affected sprite on its side, so the flag is an error and not a
shrug.
### Slicing a sheet — why the grid, and not the ink

**Reading a sheet is not the inverse of writing one.** `SpriteSheet` exports a texture plus an
atlas that says which rectangle is which frame; a sheet that arrives from an artist has no atlas at
all, just pixels. So the importer's whole job is recovering the grid that the file no longer
states.

**AND IT MUST BE THE GRID, NOT THE INK.** The tempting approach — find the transparent gutters
between frames and cut there — was measured against the real packs and is wrong. On the creature
strip the ink runs come out ragged (widths 17, 22, 29, 21…; start pitch 24, 34, 35, 31…) because
each drawing fills its cell differently, and adjacent frames' ink MERGES where two drawings touch.
Ink-boundary detection finds 19 "frames" in a sheet that really holds 80. A grid recovers the
truth; nothing else does.

**The grid is stated, or inferred from a cell size.** An author knows their sheet is 32×32 or
24×24 — it is usually in the filename — so the honest API takes the cell size and derives the
counts, rather than guessing a number that must be exactly right and has no safe default.

**Slicing is PURE and produces plain data**, not a document: cells in reading order, each a
`SourceRect`. Building keyframes from them is a separate step, because "which rectangles" and "how
fast, in what order, looping or not" are different decisions and an importer that fused them would
force a re-slice every time the timing changed.

**Empty cells are reported, never silently dropped.** A tileset legitimately has holes — the
measured dungeon sheet fills 87 of its 105 cells — and which indices are blank is exactly what a
tilemap author needs. Dropping them would renumber every cell after the first hole, so an atlas
written against the file would no longer agree with it.

## 4c. Sprite sheets — a character leaving the editor

**`core/export/SpriteSheet` turns clips into a strip of cells and the descriptor an engine reads.**
It is the first piece aimed squarely at the game direction, and it is deliberately core-shaped
rather than engine-shaped: a plan and a JSON atlas, not a packaging pipeline.

**The PLAN is pure and holds every decision** — how many columns, which frames, where each cell
sits, how big the sheet ends up. The RASTERISER is a separate function that takes a 2D context,
which is the same split `TextRaster` uses and for the same reason: a layout can be asserted in the
`node` environment, while pixels can only be looked at. Everything worth getting wrong is in the
half that can be tested.

**Frames come from CLIPS, in clip order.** A sheet laid out as an undifferentiated run of the
timeline would throw away the structure the author put in — an engine reading it back has to know
that frames 12 to 27 are the walk, and that is exactly what a clip already says. Each clip's frame
list is asserted against `clipLength` over the same range, so the sheet and the timeline cannot
drift about what a frame range means. A document with no clips exports its whole timeline as one
unnamed run, which is the honest reading of "one animation".

**The cell is sized from the union of every frame's INK, not from a node's box.** A character
squashes and travels, so it leaves its own box constantly; a cell cut to the box would clip exactly
the extremes — the impact frame, the full stretch — that an animator spent the effort on. The union
is computed from the same motion trace that measures everything else, so the sheet is framed by
measurement rather than by a guess with padding bolted on.

**It is bounded.** A long clip at a large cell size is how an export becomes a request for a
texture no GPU will accept, and discovering that at upload time is much worse than being told.

**Getting the two files out is a THREE-part seam, and the split is the security boundary.** The
renderer plans (pure), draws into an offscreen canvas (needs a DOM), and hands the main process
finished bytes; the main process only writes. Neither half chooses a path on its own: every folder
workflow starts from a folder the user picked in a native dialog, and the writer reduces whatever
filename it is handed to a BASENAME, sanitises it, and re-checks that the resolved target is still
inside that folder before touching the disk. A renderer that asked for `../../.ssh/authorized_keys`
gets a file called `.._.._.ssh_authorized_keys` in the folder the user picked.

The PNG writer is a separate channel from the text one rather than the same channel with a flag,
and it accepts ONLY a `data:image/png;base64,` payload — decoding arbitrary renderer-supplied
strings into bytes on disk is a wider door than this feature needs, and the narrow one costs a line.
It is bounded by the same reasoning as the plan: a sheet is refused before it is drawn, not after
the encoder has already been asked for a gigabyte.

## 5. Module map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Document | `core/document/{Document,Node,Serializer}.ts`, `core/ids/UUID.ts` | Source of truth, types, (de)serialization, identity |
| Document integrity | `core/document/{SceneGraph,Integrity}.ts` | Tree traversal/draw order; structural + range validation on load |
| Computed state | `core/geometry/{Matrix,GeometryEngine,LayoutEngine,SelectionHandles,Snapping,EditorGrid,Ruler,GroupTransform,Tessellate,StrokeOutline,ConvexDecompose,Resolve}.ts` | 2D affine primitive; world matrices, local rects, rotation-aware bounds, draw order, DOM-free hit-testing (**M1**); auto-layout containers + bottom-up intrinsic ("hug") sizing computed inside the same pass (**M2**); DOM-free handle geometry + alignment and visible-grid snapping (move + resize; any translation-only chain) + group ops — union-box snapping, a group rotate knob + corner handles, `GroupTransform.rotateGroup` (rigid multi-node rotation about a shared pivot) and `scaleGroup` (proportional group resize about a fixed corner; transform-free groups only — a rotated set would shear) (**M4**) |
| Paint | `core/paint/{PixelBuffer,PixelPatch,PixelCodec,Brush,Stroke,Symmetry,SurfaceSpace,Palette,Quantize,Selection,SelectionContent,SelectionOutline,Adjust}.ts` | Pixels a person put there, as PURE FUNCTIONS over a buffer rather than methods on a canvas — a `CanvasRenderingContext2D` would do all of it and could not be unit-tested, undone or replayed, and the action layer needs all three. A stroke is therefore a VALUE. Which pixels an edit may touch is a binary MASK (`Selection`), handed to the primitives as a `PixelClip` predicate so nothing down here knows what a selection is: `stampBrush` tests it per DAB, `floodFill` tests it where NEIGHBOURS ARE QUEUED (a wall, not a filter), and a whole-surface edit is confined by restoring what fell outside. `SelectionContent` copies that mask with tight RGBA payloads for move/cut/copy/paste/clear and lossless flips/quarter-turns; holes survive and destination writes clip at the surface edge. The mask and clipboard are EDITOR state, never the schema. `Adjust` is the destructive colour family, and every one of its functions is shaped `(buffer, ...args) => number` — the shape `surfaceEditAction` takes — so an adjustment becomes a panel button by being written, obeys the selection for free, and leaves no undo step when it changes nothing |
| Actions | `core/actions/{Action,types,applyMutations}.ts` + `*Action.ts` | Declarative mutations + delta protocol |
| Dispatch/History | `core/actions/{ActionDispatcher,HistoryManager}.ts` | Only write path; snapshot undo/redo |
| Editor / file boundary | `editor/EditorState.ts`, `editor/tools/*`, `editor/{shortcuts,layerDrop,layerSelection,layerFilter}.ts`, `app/{ProjectFileWorkflow,AssetImportWorkflow}.ts`, `electron/{confine,atomicWrite}.js` | Ephemeral state; input → Actions. Panel/tool rules are pure tested modules. File workflows adopt only valid projects, refuse partial image sequences, confine asset reads to the chosen folder, and replace project/export files only after a sibling temporary file is flushed |
| Renderer | `renderer/{RenderModel,emitSVG,emitCanvas,emitWebGL,SVGRenderer,CanvasRenderer,WebGLRenderer,renderScene}.ts` | Pure `(doc, state) → DisplayList`, then thin SVG + Canvas + WebGL backends (Canvas lazily loads + caches images, word-wraps text via `measureText`; WebGL triangulates fills via `geometry/Tessellate` and falls back to Canvas when no context can be had — and SAYS SO, in the toolbar and the console, because a silent fallback hid a dead GPU backend for months: a shader identifier named `packed` is a reserved word in GLSL ES 1.00, and a shader is the only code here that nothing in the gate compiles); `renderScene` selects the live backend; every COLOR slot resolves `$token` references against `doc.variables` under `doc.activeTheme` in the model (M5). The overlay carries the editor's ephemerals — selection frames, handles, guides, the node marquee, and the PIXEL selection's marching ants, which are merged runs of grid line placed through `SurfaceSpace.surfaceCornerToWorld` so they turn with a rotated canvas |
| 3D renderer | `renderer/{Scene3D,EnvironmentIbl3D,emitWebGL3D,CameraOrbit3D,Gizmo3D,emitGizmo3D}.ts` | Backend-neutral authored frame and fitted directional-shadow camera; deterministic HDR convolution; WebGL 1 PBR, prefiltered IBL, packed shadow pass, picking, bounded uploads, capability reporting, context restoration and eager resource disposal; Action-backed camera/gizmo editing |
| Runtime | `core/runtime/{World,World3D,RunFlow,Rules,Parts,Camera}.ts` | Separate deterministic transient 2D and 3D projections. Both preserve the authored document, spend bounded fixed steps and expose restart/respawn/transitions; `World3D` adds typed box/sphere queries, runtime camera following and replay digests |
| App | `app/{App,AppShellControls,ThreeDInspector,FoldersDrawer}.tsx`, `app/index.tsx`, `app/index.html` | React shell + wiring; DOM-tested workspace/runtime controls, 3D inspector and folders drawer are isolated from the remaining shell |
| Shell | `electron/{main.js,preload.js}` | Native window, menus, file IO via IPC |
| Build | `scripts/build.js` | Three esbuild bundles → `dist/` |

## 6. Boundaries that must not be crossed

- The renderer, tools, and React **must not** write to the document except by
  dispatching an Action. (Drag previews use `EditorState.pendingGeometry`, which the
  renderer reads and the document never sees.)
- Nothing may hold a long-lived reference into a history snapshot, and hydrated
  snapshots must be deep-cloned before use (see [ACTION-SYSTEM.md](ACTION-SYSTEM.md)).
- `EditorState` is never serialized into the document.
## Runtime flow and typed entities (schema 73)

`Node.entity` is the engine-owned gameplay contract. Runtime readers prefer it and retain legacy
`userData` fallback, while migration and Tiled import project recognized legacy declarations into
typed fields without deleting imported metadata. `RunFlow` owns pure restart/respawn behavior.
Cross-document goals issue a transition command; the Electron boundary confines the relative target
to the opened project's real sibling directory, validates the complete document, then adopts it.
The 3D play path projects `Spatial3D` transforms and colliders into `World3D`, advances the same
bounded-clock pattern, and stamps only a derived render document. Schema 76's `composition2d`
component is the explicit bridge between workspaces: plane mode follows its 3D transform and
billboard mode faces the active camera; a node cannot also carry an asset-backed renderable.

## SVG and Canvas scene lighting parity

`renderer/Lighting` computes the flat-surface ambient plus coloured directional Lambert factors once
from the `DisplayList`. SVG transcribes those factors as an sRGB `feComponentTransfer`; Canvas uses
the same component-transfer document through its URL-backed filter support. Applying the filter to
content items keeps the document background, grid and editor overlay unchanged and places lighting
before each item's blend operation. Invalid non-hex light colours are skipped exactly as WebGL skips
them, and no valid lights means an identity/unlit frame. WebGL remains the higher-fidelity backend
for meshed surfaces because it interpolates their normals and ray-marches their height field per
fragment; SVG and Canvas currently light those shapes as flat 2D content.
