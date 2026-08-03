# Architecture

<!-- describes: src/core/actions/ActionDispatcher.ts, src/core/actions/applyMutations.ts, src/core/actions/HistoryManager.ts, src/core/geometry, src/renderer -->
<!-- re-read 2026-07-31 after the editor slices (align/distribute, full properties inspector): accurate at this doc's altitude -->


> 🔒 Frozen contract · schema v42 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins; see MILESTONES.md for deferred layout deliverables) + M3 renderer (shapes + culling + effects + Canvas backend) + M4 editor (pan/zoom, box-select, DOM-free handle picking, rotate, live SVG/Canvas backends, snapping/guides, group snapping + rotate). Describes the verified current implementation.

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

TEXT remains undrawn on the GPU: a glyph atlas is its own piece of work, and declining is better
than drawing something wrong.

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

## 5. Module map

| Layer | Files | Responsibility |
|-------|-------|----------------|
| Document | `core/document/{Document,Node,Serializer}.ts`, `core/ids/UUID.ts` | Source of truth, types, (de)serialization, identity |
| Document integrity | `core/document/{SceneGraph,Integrity}.ts` | Tree traversal/draw order; structural + range validation on load |
| Computed state | `core/geometry/{Matrix,GeometryEngine,LayoutEngine,SelectionHandles,Snapping,Ruler,GroupTransform,Tessellate,StrokeOutline,ConvexDecompose,Resolve}.ts` | 2D affine primitive; world matrices, local rects, rotation-aware bounds, draw order, DOM-free hit-testing (**M1**); auto-layout containers + bottom-up intrinsic ("hug") sizing computed inside the same pass (**M2**); DOM-free handle geometry + alignment snapping (move + resize; any translation-only chain) + group ops — union-box snapping, a group rotate knob + corner handles, `GroupTransform.rotateGroup` (rigid multi-node rotation about a shared pivot) and `scaleGroup` (proportional group resize about a fixed corner; transform-free groups only — a rotated set would shear) (**M4**) |
| Actions | `core/actions/{Action,types,applyMutations}.ts` + `*Action.ts` | Declarative mutations + delta protocol |
| Dispatch/History | `core/actions/{ActionDispatcher,HistoryManager}.ts` | Only write path; snapshot undo/redo |
| Editor | `editor/EditorState.ts`, `editor/tools/*`, `editor/{shortcuts,layerDrop,layerSelection,layerFilter}.ts` | Ephemeral state; input → Actions. The RULES a panel or tool applies are pure modules with tests, not logic inside a handler: which command a chord means, what a layer drag resolves to (parent + an index measured AFTER the node is detached), what a row click selects (a shift range spans the VISIBLE order, and the anchor does not move), and which rows a search leaves (a match keeps every ancestor, so the panel shows the path to it) |
| Renderer | `renderer/{RenderModel,emitSVG,emitCanvas,emitWebGL,SVGRenderer,CanvasRenderer,WebGLRenderer,renderScene}.ts` | Pure `(doc, state) → DisplayList`, then thin SVG + Canvas + WebGL backends (Canvas lazily loads + caches images, word-wraps text via `measureText`; WebGL triangulates fills via `geometry/Tessellate` and falls back to Canvas when no context can be had); `renderScene` selects the live backend; every COLOR slot resolves `$token` references against `doc.variables` under `doc.activeTheme` in the model (M5) |
| App | `app/App.tsx`, `app/index.tsx`, `app/index.html` | React shell + wiring |
| Shell | `electron/{main.js,preload.js}` | Native window, menus, file IO via IPC |
| Build | `scripts/build.js` | Three esbuild bundles → `dist/` |

## 6. Boundaries that must not be crossed

- The renderer, tools, and React **must not** write to the document except by
  dispatching an Action. (Drag previews use `EditorState.pendingGeometry`, which the
  renderer reads and the document never sees.)
- Nothing may hold a long-lived reference into a history snapshot, and hydrated
  snapshots must be deep-cloned before use (see [ACTION-SYSTEM.md](ACTION-SYSTEM.md)).
- `EditorState` is never serialized into the document.
