# Architecture

<!-- describes: src/core/actions/ActionDispatcher.ts, src/core/actions/applyMutations.ts, src/core/actions/HistoryManager.ts, src/core/geometry, src/renderer -->
<!-- re-read 2026-07-31 after the editor slices (align/distribute, full properties inspector): accurate at this doc's altitude -->


> 🔒 Frozen contract · schema v54 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins; see MILESTONES.md for deferred layout deliverables) + M3 renderer (shapes + culling + effects + Canvas backend) + M4 editor (pan/zoom, box-select, DOM-free handle picking, rotate, live SVG/Canvas backends, snapping/guides, group snapping + rotate). Describes the verified current implementation.

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

**Coverage is measured, not assumed.** Running every reader over the whole measured tree —
88,815 files — reads 62,444 of them (70.3%) with nothing refused and nothing failing. The rest has
no reader at all rather than a broken one: 24,051 3D files, 1,342 audio, and the remainder project
files, archives and readmes. That sweep is what pointed at the three Tiled forms above — but only
partly, and the shortfall is the lesson. It failed on two files, and it failed on them for their
QUOTING rather than for being collections; the third collection set used ordinary double quotes,
took its first tile's image as the whole sheet, and PASSED, because the sweep's only question was
whether parsing threw. "Did it parse" is the same complacency as per-format testing, one level up.
The sweep now asks something that can fail — `tilesetOverflow` — and the old reader is the proof
it discriminates: run against it, that check puts the last tile of a 352-pixel image at y=122,144.

**`inflateSync` is the one synchronous channel in the app.** Both `parseTiledMap` and
`parseAseprite` call their injected `inflate` DURING the parse, which is what keeps them pure; an
async bridge cannot satisfy that. Both shipped with the injection point and nothing to inject.
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

**A `<g transform>` cannot become a node transform.** VDE's `Transform` is rotation, scale and an
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

**Gradients flatten to their first stop, and SAY SO.** VDE has no gradient, and 2,491 fills are
one — about three percent. Refusing those files would cost the other ninety-seven percent of their
shapes; silently dropping the fill would produce an invisible shape. Taking the first stop keeps the
drawing recognisable, and every approximation is reported in a `notes` list rather than left for
someone to notice.

**It reads the shapes this format defines, not XML in general** — the same promise `TextureAtlas`
makes, and for the same reason: core is pure and has no DOM, and a regex that claims to parse XML
is a liability. What it cannot make sense of it names.
### SVG path data — the one format that has to be converted, not just read

**Vector art is the largest remaining import gap: 5,279 files holding 95,160 `<path>` elements.**
Unlike a sheet or an atlas, this cannot be read across — VDE's `PathCommand` is `M`/`L`/`C`/`Q`/`Z`
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
