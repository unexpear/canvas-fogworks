# Testing Strategy

<!-- describes: src/core/tests, src/renderer/RenderModel.test.ts, src/renderer/emitCanvas.test.ts, jest.config.js, scripts/check-module-headers.js -->

> 🔒 Frozen contract · schema v54 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins) + M3 render-model extraction + viewport culling + ellipse/line/path node types + Canvas backend + effects + M4 pan/zoom + box-select + DOM-free handle picking + rotate + live Canvas backend + snapping/guides (move + resize) + rulers + canvas images + group snapping/rotate. Suites: `src/core/tests/document.test.ts` (1101) + `src/renderer/RenderModel.test.ts` (69) + `src/renderer/emitCanvas.test.ts` (40) = 1210 tests.

## Philosophy

The engine's correctness lives in the **core** (document, actions, dispatcher, history,
serializer) — the layer every other layer trusts. That layer is deterministic, pure,
and has no DOM, so it is tested exhaustively with fast unit tests. The renderer's
**pure model** (`buildRenderModel → DisplayList`) is DOM-free too and unit-tested the same
way; the **Canvas backend** (`emitCanvas`) is unit-tested via a recording-mock ctx (its call
sequence IS its output). The **GPU backend** is split so the same rule holds: everything that
turns a shape into numbers (`itemTriangles`, `shapeToWorldRings`, `parseColor`, `viewMatrix`, and
`geometry/Tessellate` beneath them) is pure and tested in the `node` env; only the buffer uploads
and draw calls need a GPU. Only the DOM shims — `emitSVG`'s output, the `renderSVG`/`renderCanvas`/
`renderWebGL`/`renderScene` wiring, and pixel-level parity between the three — stay validated by targeted browser
smoke tests (the Canvas backend was live-verified end-to-end: background, grid, a drawn rect,
selection overlay, and a clean SVG↔Canvas toggle).

**Milestone 0 bar:** no change to a frozen contract lands without a test. Regressions get
a test that is proven to fail before the fix and pass after (see *regression discipline*).

## Commands

```bash
npm test                                   # jest (ts-jest), 1210 tests
npx tsc --noEmit                           # typecheck the app
npx tsc --noEmit -p tsconfig.test.json     # typecheck the tests too
npm run lint                               # module-header rule (no ESLint dependency)
npm run check                              # typecheck + lint + test + build (the gate)
```

- `npm run lint` also refuses a BACKTICK inside a shader template literal. GLSL lives in template
  strings, so a comment quoting a symbol the way every other comment here does ends the string —
  and it surfaces as a TS1005 pointing at a line of GLSL, which reads as anything but its cause. It
  cost a round twice before the check existed. The check itself was verified by reintroducing the
  bug on purpose: the first version counted matched backtick pairs and passed, because an injected
  backtick simply becomes the closing one.
- Runner: **Jest** via **ts-jest**, `testEnvironment: node` (`jest.config.js`).
- `tsconfig.json` excludes `*.test.ts` from the app build; `tsconfig.test.json` type-checks
  them. Both must be clean.

## What is covered (1210 tests)

| Area | Representative cases |
|------|----------------------|
| Document creation / empty-doc edges | version = `SCHEMA_VERSION`, **schema/app version decoupling**, empty round-trip, dispatch on empty doc |
| **Scene graph authoring** | nested add via `parentId`, duplicate-id rejected, reparent + undo, insertion index, self-parent/cycle rejected, `traverseSceneGraph` tree order + cycle safety + orphans |
| **History coalescing / retention** | a 50-event slider run = one undo step; discrete actions not coalesced; **initial revision survives overflow** |
| `AddNodeAction` | adds node, undo removes, rejects width/height = 0, empty type, NaN coords |
| `DeleteNodeAction` | leaf, cascading children, undo restores tree, missing node fails |
| `TransactionAction` | batched moves = one undo entry; failing child rejects all |
| `UpdateNodeGeometry/Style`, `ResizeNodeAction` | partial patches, undo restores, invalid rejected |
| Dispatcher `onChange` | called with `MutationResult`; unsubscribe; ordered; fires on undo |
| History sequences | dispatch-after-undo clears redo; undo to initial; **edit-after-undo doesn't corrupt revisions (R2)** |
| Serializer | unknown schema throws, **newer schema** throws, **legacy semver accepted**, invalid JSON throws, malformed node / key-id mismatch, root-order comparison, variables & metadata round-trip |
| `Serializer.loadResult` | empty vs loaded vs **corrupt** (with backup) — localStorage mocked |
| `ActionDispatcher.loadDocument` | replaces doc, resets history |
| **`Matrix` / `GeometryEngine`** | multiply order; inverse round-trip + singular→null + **non-finite input / subnormal-det → null**; rotated AABB from all four corners; parent rotation propagates to children; `toLocal`/`toWorld` round-trip through a rotated ancestor; rotated hit-test uses true shape not AABB; subtree/selection bounds; dirty reuse by reference + descendant invalidation |
| **`UpdateNodeTransformAction`** | sets rotation/scale, undoable, round-trips, rejects zero-scale/non-finite, allows flip, composes with a move; **load path rejects the same transforms** (shared `transformError`, raw-JSON `Infinity`) |
| **GeometryEngine dirty tracking** | `incremental === full` over a 300-op seeded fuzz; the **pending/preview path** (Escape-cancel reuse, `prevPending` load-bearing, engine's own current-pending clause); a companion proves the equivalence is not vacuous |
| **Restore dirty set** | undo reports only the changed node, not the whole document |
| **Document integrity (load path)** | rejects `opacity: 5`, negative size, dangling parent, ghost root, unclaimed child, parentless non-root; accepts a well-formed nested doc |
| **M2 `LayoutEngine`** (flex-stack math) | row/column packing; gap + padding; cross-axis `start`/`center`/`end` placement and `stretch` (resizes the child); defaults (no gap/pad, `start`); `isLayoutContainer` |
| **M2 layout through `computeGeometry`** | children get computed positions **replacing stored `x/y`**; stretch changes the rendered local size and hit-tests at it; removing the container reverts to stored geometry; **nested containers** compose within a stretched size; a laid-out child **composes through the container's transform** (2× scale scales its computed position + size), so layout does not bypass the matrix pipeline |
| **M2 sibling ripple** | `expandDirtyForLayout` dirties a container from a dirty child (and does NOT drag in a non-container parent); resize / **reparent-out** / **delete** of a child reflows its siblings incrementally though only the acted-on node was reported (each non-vacuous: the sibling genuinely moves); a **pending** resize of a laid-out child reflows siblings in the live preview (pins the `pending?.width` branch, not just the committed fallback) |
| **M2 `UpdateNodeLayoutAction`** | sets/removes a container, undoable, round-trips through the current-schema loader; rejects invalid containers on the edit path **and the load path** (shared `layoutError`, raw-JSON `Infinity`) |
| **M2 `MoveTool`** | a laid-out child records no pending move (position is computed); the container itself stays draggable |
| **M2 intrinsic (hug) sizing** | `measureIntrinsicSizes` folds a hug axis from children (row/column, one-axis, empty→padding); a hug container is **sized to its contents** through `computeGeometry` (stored size vestigial); **hug-cross + stretch** is coherent (pre-stretch measure, no cycle); a size change **ripples up a 3-deep hug chain, halts at the first FIXED container, and reflows its siblings** (incremental === full, non-vacuous); **pending** resize of a deep leaf hugs the chain in the live preview (pins the pending→seed union); reparent **into/out of** a hug container resizes it; measure stays **total** on a missing child; current-schema round-trip + a non-boolean hug flag rejected on **both** paths |
| **M2 flex-grow** | `layoutChildren` distributes leftover main-axis space **proportional to `grow`** (single/multiple growers, gap+padding subtracted first); **inert** with no free space (exact fit or overflow — no shrink); a fixed container grows a child to fill while a **hug-main** container leaves nothing to grow; resizing one child **reflows a growing sibling** incrementally (non-vacuous, only the resized node reported); a **pending resize of a grow child previews the SAME layout as committing it** (regression for the review-found double-apply); **grow overrides hug** on a node that is both a hug container and a grow child; schema-5 round-trip + a negative `grow` rejected on **both** paths (incl. a `{grow}` patch with no container, guarding the early return) |
| **M2 grid** | `layoutGridChildren` auto-flows row-major with fixed + **`fr`** column tracks (share leftover width), a uniform `rowHeight` (px or `fr` equal-share), gaps and padding; **explicit per-row `rows` tracks** size each row with `rowHeight` as the IMPLICIT fallback beyond the list, and a single case pins explicit-wins + implicit-fallback + prefix-sum row-Y + fr-shares-leftover-after-px at once; **`rows` absent is byte-identical to the uniform-`rowHeight` path** (backward compat); a grid **sizes children to cells** through `computeGeometry` (stored size ignored); deleting an item **reflows survivors** into earlier cells incrementally; **adding to an `fr`-row grid reflows every existing row's height** incrementally (pins the grid's dirty-climb path — a `px`-row grid or a delete cannot); `isLayoutContainer` recognises a grid; resizing a grid item **stays in its cell** (a pending patch on a laid-out child is absorbed, not leaked to its stored x/y — review regression); a transaction that sets **container then grid keeps the grid, not neither** (review regression); **grid ⊕ container mutual exclusivity** enforced in the write delta and on read; current-schema round-trip + malformed `TrackSize` / empty `rows` / both-set rejected on **both** paths |
| **M2 constraints / anchors** | `resolveConstraints` per-mode math (left/right/left-right/center/scale × top/bottom/top-bottom/center/scale) on a grown parent; static fallback (absent, or `ref ≤ 0`); **source (a)** a direct `ResizeNodeAction` on a plain parent moves its right-pinned child incrementally (non-vacuous, only the parent reported); **source (b)** a flex-grow-driven parent resize moves its constrained grandchild (the responsive cascade); `UpdateNodeLayoutAction` **auto-captures `constraintRef`** from the parent's stored size; constraints **inert** under a flex/grid parent; a damaged-tree constrained child of a container parent stays static (the `!isLayoutContainer` gate); a **later mode edit does NOT re-capture the frozen `constraintRef`** (review regression — a second edit must not un-freeze the reference and teleport the anchored child); schema-7 round-trip + bad mode / non-positive `constraintRef` rejected on **both** paths |
| **M2 margins + absolute** | `layoutChildren` uniform margin spaces on the main axis and insets on the cross (incl. stretch − 2·margin and grow after margins); a **hug container's size includes child margins**; an **absolute child is out of flow** (siblings ignore it, it uses its stored geometry, and it does not contribute to hug size); an absolute child of a container **can still be constrained** (pins to the parent box); `MoveTool` keeps an absolute child **draggable** while an in-flow sibling is not; schema-8 round-trip + a negative `margin` / bad `position` rejected on **both** paths |
| **M2 flex-shrink** | `layoutChildren` shrinks overflow weighted by **`shrink × base`** (even/weighted/**unequal-base** cases — the last distinguishes `×base` from `shrink`-alone), clamped at 0; **inert** without overflow, and a child with no shrink factor overflows unchanged; grow and shrink are **mutually exclusive by the sign of free space** (a child with both grows when it fits, shrinks when it overflows) incrementally; schema-9 round-trip + a negative `shrink` rejected on **both** paths |
| **M2 grid measure-integration** | `auto` COLUMN sizes to the **max child own-width** (a narrower child stretches to fill), `auto` ROW to the max own-height; `auto` + `fr` coexist (**fr shares the leftover AFTER auto's content**); **`hugWidth`/`hugHeight` size the grid to `2·pad + Σtracks + gaps`**, pinned by the **fuzz-blind `hug-size == sum-of-cells`** structural check; **`fr` collapses to 0 on a hugged axis**; a resize / a **pending** drag of a grid child in an `auto` column **ripples the grid's hug up to a hug-flex root incrementally** (guards the `containerHugs` grid arm — the climb), and a non-hug grid reflows its column; an empty hugging grid stays **total**; `resolveGridTracks` never throws on an `auto` track (the `"px" in t` footgun) and clamps a 0-column grid; schema-11 round-trip + `{auto:false}` / non-boolean hug flag rejected on **both** paths |
| **M2 flex wrap** | `breakFlexLines` break predicate (strict `>` keeps an exact fit; first-child-always-fits; margin/gap accumulation; empty → `[]`; nowrap → one line); a **`hugHeight` wrap row sizes its height to the stacked lines** and that equals the cells (the **fuzz-blind `cross-hug == Σ line heights`** structural check); **grow is distributed PER LINE**, not across the container; a **single wrap line still fills the container cross** (nowrap-preserving band); wrap is **inert under a hugged main axis**; **column-direction is symmetric**; a **grown wrap container wraps against its OWN main, not the stretched main** (the measure/position consistency guard); a **grown hug-MAIN wrap container still grows its children** (the measured-main override is gated on `effectiveWrap`, not `wrap` — review-found); a resize / **pending** drag that pushes a child onto a new line **grows the container incrementally**; schema-12 round-trip + a non-boolean `wrap` rejected on **both** paths |
| **M2 grid spans** | `placeGridItems` sparse forward placement (a `rowSpan` pushes later items off occupied cells; **sparse — a gap is NOT backfilled**; derives `rows > ceil(n/cols)`); **`colSpan > cols` clamps** (and would otherwise loop forever — a totality guard); fractional/non-positive spans clamp to 1; empty / 0-column total; a pathological `rowSpan` **clamps to `GRID_SPAN_MAX`**, and — **review regression** — many WIDE-spanning children in a WIDE grid stay **bounded (no `Set`-cap throw)** via the column-count + derived-row caps, while a tall thin grid is not over-restricted; a **spanning cell covers its tracks + internal gaps**; a **spanning item does NOT drive `auto` sizing** (single-span only); a `rowSpan` **grows a `hugHeight` grid** and the height **== the cells** (fuzz-blind); deleting a spanning item **reflows survivors incrementally**; schema-13 round-trip + non-integer / out-of-range spans rejected on **both** paths |
| **M2 per-side + grid-cell margins** | `resolveMargin` (a number is uniform; an object is per-side; omitted/negative sides → 0); per-side margins in a **ROW map left/right → main, top/bottom → cross** and a **COLUMN transposes** them; a **hug row's main size includes the asymmetric margins**; a **grid-cell margin insets the child within its cell**, and an **`auto` track grows to fit child + margins**; `breakFlexLines`'s `marginMain` **changes where lines break** (non-vacuous: same items wrap only once the margin is added); schema-14 round-trip + a negative side / non-object rejected on **both** paths |
| **M2 align-content + wrap-reverse** | `alignContent` distributes wrapped lines in leftover cross space (start/center/end/space-between/space-around/stretch — exact offsets on a fixed-cross container); `stretch` grows each line's band (feeding `alignItems: stretch`); `wrapReverse` reflects the lines from the far edge; both are a **NO-OP on a cross-hug container and a single line** (`freeCross == 0`); validation + schema round-trip |
| **M2 grid auto-flow** | **dense** backfills a gap sparse leaves empty; **column flow** fills down-then-across, deriving the column count (a `colSpan` under column flow spans COLUMNS — pins the transpose, which 1×1 items can't); a `hugWidth` column-flow grid derives its `auto` columns from the children; validation + round-trip |
| **M2 grid explicit line placement** | a fully-pinned item takes its `[start,end)` lines and **auto items flow AROUND it**; lines span `end − start` tracks; single-axis placement **auto-flows** (deferred, and does not throw on the missing axis); a pin **grows a `hugHeight` grid to its row** (hug == cells); validation (`start<end`, integer, in-cap) + both-paths rejection |
| **M2 fuzz** | `incremental === full` over a 300-op seeded sequence that adds **hug flags, flex-grow/shrink, WRAP (+alignContent/wrapReverse), GRID (per-row `rows`, `auto` tracks, hug, `colSpan`/`rowSpan`, `autoFlow` row/column/dense, explicit `gridColumn`/`gridRow` pins), constraints, margins (uniform AND per-side), absolute escapes, container toggles, reparents and deletes** to the M1 op set (nesting + reparent build multi-level hug chains; resize drives grow/shrink by sign, constraints from both sources, and — now that wrap and grid enter the measure pass — a child's size feeds its line/`auto` track and the container's own hug size; spans exercise the placement in both passes) |
| **Depth / mesh / lighting (schemas 40–42)** | `depth` drives display ORDER, the GPU's clip **z**, and PARALLAX (an unlayered doc returns BY REFERENCE, so a pan costs nothing); a warped node resolves to an ordinary `core.path` and is **clickable where it is drawn**; a rest mesh is the identity and is skipped; bilinear is **exact at the control points** and clamped outside the box; `lambert` is **clamped at 0** so a second light can never darken; a flat mesh faces the viewer *exactly*; a MIRRORED patch still faces the viewer; the shadow a light casts is **derived** and an explicit `style.shadow` still wins; every one validated on **both** paths + a migration from the previous schema |
| **Discrete mode (schema 54)** | WHICH END a non-interpolatable value takes is the caller's question, and both answers are pinned against each other so neither can quietly become the other: a timeline STEPS (a drawing appears on its own keyframe) while a state transition SWITCHES (a hover means it now), asserted side by side on one fixture — without that pairing, a `blendNode` ignoring the parameter entirely would pass the timeline half. `switch` is proven to be the DEFAULT, so a caller that has not thought about it keeps what transitions were written against. `text` is the field that proves the rule generalised: it was never special-cased and behaves correctly because the rule covers it, replacing a per-property list that had already grown a clause for `src` and another for `sourceRect`. The STYLE half needs its own case — `text` is a node field, so a mutation ignoring the mode for `style` alone left every text assertion passing — using a numeric slot with a TOKEN on one end, which cannot be averaged and so falls through to whichever end the mode chose. And the CHANNEL blend needs its own again, since it is a second call site with its own argument to keep in step |
| **Aseprite import** | fixtures are bytes assembled from the PUBLISHED SPEC field by field, never from the parser — an encoder written by reading the decoder proves only that the two agree with each other. The independent check is that the same parser reads a real 210KB `.aseprite` and recovers exactly what an unrelated script found in it: 640x32, 27 frames, 6 layers, 53 cels, 5 tags, every decoded cel holding w*h*4 bytes and every cel accounted for as pixels, a link or compressed bytes. The tags are asserted to be CLIPS field for field AND to pass `clipsError` against the timeline the same file implies — shaped like clips is not the same as accepted as clips. The SHORTEST duration sets the rate (an average would round the quick frames away) and zero-length durations are excluded rather than dividing by zero. Injection is pinned from both sides: with no inflate the structure still parses and the compressed bytes are KEPT, with one the function is handed exactly the pixel bytes rather than the chunk around them. Refusals are asserted to NAME what they met — colour depth, tilemap cels, bad magic, truncation — because a partly-understood file that loads looking almost right is worse than one that says what it did not know. The canvas bound is asserted on BOTH sides, since a fixture sitting exactly on it proves nothing about the comparison |
| **Trimming** | the assertion is that the INK DOES NOT MOVE, not that the rectangles match: where a source pixel lands is computed before and after and must agree, since a trim that changed the picture would be a bug wearing an optimisation's clothes. Fixtures are the REAL measurement — `fighter_run_0017` is 512x512 with ink at 223,210 sized 108x165, four percent of the file. A naive per-frame trim is shown to produce four DIFFERENT boxes on four consecutive frames (their ink origins genuinely differ, asserted non-vacuously) while each frame's ink still lands where it did, which is what separates a correct trim from a jittering one. Four mutants survived the first pass because my fixtures were too regular, and each needed a deliberately irregular case: every box was SQUARE so an X-for-Y scale swap was invisible (a 200x50 box from a 100x100 cell separates them), the cell ended where the image did so an unclipped far edge landed on the same number (a cell in the middle of a larger image separates them), and the real frames all happen to share a right edge of 331 so a union taking the LAST rect matched exactly (ragged edges separate them). The degenerate-source guard is an EQUIVALENT mutant and labelled: the overlap test refuses the same inputs |
| **Sequence import (schema 53)** | the fixtures are the REAL pack's spellings, including the one that breaks the obvious regex: `fighter_wallslide0084.png` has its number glued on while all 83 of its neighbours use an underscore, so a `_(\d+)` pattern drops it and one frame goes missing from one animation invisibly. Numbering is asserted NOT to restart per stem (`fighter_run` genuinely begins at 0017) and case is asserted kept (`fighter_Idle` beside `fighter_run`), since folding would merge animations an artist named apart. Ordering is BY NUMBER, pinned with an unpadded set where a lexicographic sort would play 10 before 9 — a stutter invisible to any assertion that only counts frames. Files carrying no number are skipped rather than becoming one-frame animations, because a sprite folder routinely also holds a licence and a preview. The emitted track is UNHELD, and that is the design decision rather than an omission: `hold` freezes the WHOLE node, so a running character could not both cycle its drawings and move — which is why `src` had to step, asserted through the real pipeline with the position still tweening to x=40 at the midpoint. The clearing half needed its own case the sequence tests cannot reach: a first keyframe with no `src` must leave the node's own image showing until one is authored |
| **Sheet slicing (grid import)** | checked against the packs' REAL dimensions with the grids derived independently from pixel analysis, so it is measured against a measurement rather than against itself: 360x168 at 24px is 15x7, 640x128 at 32px is 20x4, 384x80 at 16x80 is 24x1. An inexact cell size is REFUSED, never rounded — and the refusal is pinned ONE AXIS AT A TIME, because the obvious case (the dungeon sheet read at 32px) misses on both axes at once so either check alone would still catch it and neither is really under test; 100x64 and 64x100 separate them. The gutter arithmetic is pinned by a spaced sheet where N cells take N widths and N-1 gutters — dividing without adding the gutter back loses the last column — and margin is proven to come off BOTH sides by a sheet that stops dividing when it is forgotten. Cells come back in READING ORDER, asserted by their coordinates rather than their count, since column-major looks identical in a count. Blank cells are reported as INDICES and never filtered, because removing them renumbers every cell after the first hole. The non-finite guard is an EQUIVALENT mutant and labelled: the cell bound rejects an infinite grid anyway and NaN fails the exact-fit comparison |
| **Sprite-sheet playback (schema 52)** | the rule that makes the feature work rather than merely typecheck: a keyframed region STEPS. Asserted BETWEEN keyframes, not on them — an interpolated rect reads x=4 halfway from cell 0 to cell 1, a window straddling two cells whose numbers blend perfectly and whose picture is a smear. Also asserted NOT to show the arriving cell early, which is the trap `blendNode`'s `{ ...to }` sets and which a `hold` would hide entirely — so the demo's keyframes are deliberately UNHELD, putting the rule genuinely under test. The other half needed its own case, because the demo cannot reach it: a first keyframe with NO region blending toward one that has it must leave the image whole until the cell is authored. Nothing else moves — the traced box is one value across the run, since a demo whose shape drifted would pass every region assertion while proving something else. And the override half is pinned too: `StateDefinition` IS `InstanceOverride`, so one addition made a region keyframable, state-able and instance-overridable at once, validated by the SAME shared rule the stored field uses |
| **Tile-sheet demo (schema 51)** | one file addressed FIVE ways — a demo pointing every tile at the same region would look like four copies and pass any assertion that only counted them, so the four regions are asserted DISTINCT as a set. Both new fields are checked to survive a serialize/deserialize round trip, which is exactly what this codebase's recurring hand-written-field-list defect eats. It is registered as a STILL in `STILL_DEMOS` and named individually rather than inferred from a one-frame timeline, because the cheap inference would let a demo that was meant to animate quietly stop and still pass — and the reason it is a still is itself the next gap: `sourceRect` is not among the values a keyframe carries, so sprite-sheet PLAYBACK is not reachable even now that regions are |
| **Image regions + pixel art (schema 51)** | fixtures are a REAL tile from the measured dungeon tileset — a 15x7 grid of 24px, so column 3 row 2 is x=72 y=48 w=24 h=24 — rather than invented numbers. `sourceRectError` refuses non-finite coordinates, a zero or negative extent (not a small region but one nothing can sample, since every backend divides by it) and an out-of-bound coordinate, while deliberately ACCEPTING a rect outside the image: the document holds a URL, not a bitmap, and whether it fits is unknowable until the file decodes and unknowable forever if it never does. `normalisedUV` divides each axis by its OWN dimension, asserted against a non-square sheet so that normalising both by the width would fail; it does not clamp (clamped wrapping already reads the edge, and silently resizing a region hides the mistake) and answers with the identity rather than a NaN for a zero-sized texture. The display list carries `source` as NULL rather than absent, and `pixelated` on EVERY image rather than only when true — `imageSmoothingEnabled` is sticky context state, the same shape of bug this backend already shipped with `setLineDash` leaking a dash onto later items, and an always-present flag is what makes "set it only when true" impossible to write by accident. The shape's destination is LOCAL while its source is in image pixels — two rectangles in two spaces, and the thing about this feature most likely to be confused |
| **Longer IK chains / FABRIK (schema 50)** | the target is reached AND every bone keeps its length — the second is the defining property, since a solver that reached while quietly stretching would pass the first. Bones are UNEQUAL, because equal ones hide which link absorbed the bend. The root never moves. Out of reach straightens; DETERMINISM is asserted directly, because a trace that differed run to run would dissolve every regression check built on the diagnostics layer. Two constructed edge cases, both of which took a probe rather than a guess: a target sitting exactly on an interior joint is the only way two points coincide inside the projection (a zero-length bone does NOT do it — the joints separate on the first step) and the chain must be NON-COLLINEAR to get there, because the collinear seed nudges a straight chain off-axis before any projection sees it; and a chain with one bone longer than the rest combined cannot fold small enough to reach a target near its root, which is the only path that runs the loop out of passes and so the only one where the reported `reached` means anything. The demo pins a six-bone tip within the solver's own tolerance — the honest bar for an iterative method — while its base travels 100px, and EVERY driven bone is shown changing, since an old build ignoring `chain` would pin the tip with just the two nearest bones. Two bones keep the CLOSED FORM, pinned by precision: the planted foot lands 100x inside FABRIK's tolerance, which an iterative takeover could not do. `bend` with a chain longer than two is refused, having nothing to select from a continuum. The out-of-reach short-circuit and the effector-dropping slice are EQUIVALENT mutants and labelled as such |
| **Inverse kinematics (schema 49)** | the solver is checked by WALKING the chain it returns — root, along bone one, along bone two — and asserting the end lands on the target, because asserting the angles would only prove the arithmetic matches itself. Bones are UNEQUAL in at least one case, since equal ones make an isosceles triangle that hides which side is which. Bend mirrors the joint about the root-to-target line and both solutions reach. OUT OF REACH straightens toward the target and TOO CLOSE folds as tight as it goes, both with `reached` false and every returned number finite — `acos` outside [-1,1] is how this silently poisons a limb. `rotationDelta` takes the short way round, so a rig cannot spin backwards when something tweens through it. The demo is measured through `traceMotion`: the hip moves more than 60px, the solved foot sits on its target to the pixel on every frame, the CONTROL twin's foot swings the same 60px (without it, a foot that simply never moved would pass), the knee actually bends, and the knee is on the AUTHORED SIDE — both bend directions reach the target, so only the side can show `bend` is honoured. `applyIk` returns an unrigged document by reference and never writes into a stored transform, asserted on a node that ALREADY HAS one, since a node without one gets a fresh object either way and cannot show it. Both ends of the reach clamp are EQUIVALENT mutants and labelled as such: the ratio clamp below subsumes them |
| **Motion paths (schema 48)** | progress is ARC LENGTH, proven against its own CONTROL: `motionPolyline` samples by PARAMETER and its steps spread by more than 2x on the same curve, while `motionPointAt`'s spread stays under 1.1 — without that control the claim would be satisfied by a straight line. Endpoints land EXACTLY on the keyframes (a sampling error there makes a shape jump at every keyframe) and outside [0,1] is clamped, never extrapolated. Control points are OFFSETS, checked by translating a whole segment and getting the same curve back. The demo is measured end to end through `traceMotion`: the ball arcs 150px above the identical no-path chord, AND travels — height alone does not pin the route, since a segment whose two ends were read from the same keyframe still arcs upward and back while never leaving the throwing hand, so the horizontal progression and the arrival point are asserted too. `motionPathError` refuses non-finite offsets (a NaN makes every sampled length NaN and the shape vanishes frames from the cause). Two AMBIGUITIES are refused rather than resolved: a keyframe carrying a path while also easing `geometry.x`/`y`, and a node with a path plus a position channel — the latter checked through the real load path, in the one place that sees both. The zero-length short-circuit is an EQUIVALENT mutant and labelled as one: the `span > 0` fallback already reaches the same answer |
| **Channels (schema 47)** | a property keyed where the track has NOTHING, measured through `traceMotion` rather than asserted off the document: after the body's last keyframe the cart's anchor is a single value while the flag's rotation still takes a dozen, and the last swing is smaller than the first, so it settles rather than wobbles on. A channel BEATS the track on the property it owns and leaves the rest alone (x from the channel, y from the track, in one measurement). A node with ONLY channels animates — `applyFrame` returns the document by reference when nothing is animated, so a channel-only node has to count as animated or it is silently returned unmoved. The stored document is never written into: a channel-only node's copy shares the very `geometry` object the document holds until the group is cloned, and that case is asserted separately because the tracked case is already safe by accident. `channelsError` refuses a path that eases nothing, a keyframe naming a second property, an EMPTY keyframe, and delegates the timing rules to `trackError` — proven by feeding it two keyframes on one frame and getting the track's own message back |
| **Sprite-sheet DRAWING** | the half that exists only as ctx calls, and the half that was wrong: every cell draws its OWN frame (the base CTM differs per cell, counted — the ellipse ARGUMENTS are identical by design, so asserting those would have passed on a sheet with one ball and forty-seven empty cells), each cell is CLIPPED (the `rect` alone is a path nobody used, so the `clip` calls are counted too), the sheet carries NO full-canvas backdrop, and NO grid — proven non-vacuous by drawing the same document the editor's way and finding grid strokes there. `emitCanvas`'s target is pinned on both axes and on all three background modes (null, a colour, no target at all). The overlay blanking is an EQUIVALENT mutant and labelled as one: every overlay item is gated on selection/hover/preview, which the export supplies none of |
| **Sprite sheets** | frames come from CLIPS in clip order, and the count a clip contributes is asserted EQUAL to `clipLength` so the sheet and the timeline cannot drift about what a range means. PADDING sits between cells, never inside: each cell's OWN `width` is asserted, not just the plan's `cellWidth` — a mutation taking padding out of the cells left that field correct while every sampled region was two pixels short, and survived the first version of this test. The cell is framed on the UNION of every pose, checked by asserting the frame rect contains every traced sample and exceeds the node's own box in both axes. The atlas carries clip ranges as authored with `loop` resolved to its default, and its frame LIST must agree with its RANGE, or a sheet plays differently depending which field an engine reads. Oversize is refused at plan time, on AREA — a wide short sheet is fine |
| **Named clips (schema 46)** | ranges are INCLUSIVE of both ends, so 0..11 is twelve drawings — asserted against `traceTiming` so a clip's duration and a trace of it cannot disagree, which is the mismatch that shows up as an export being one frame short. A looping clip wraps in its OWN frame numbers (a caller plays `walk` without knowing where in the strip it lives); a one-shot HOLDS its last frame rather than wrapping or stopping elsewhere, because a character that has died stays dead; `loop` defaults TRUE, since idle/walk/run all cycle. Refused on BOTH paths and for the reason each rule exists: duplicate names (a clip is selected by name, so `play walk` would be ambiguous), a range past the last frame (plays silence, reads as broken), a backwards range, fractional frames, and clips with no timeline at all |
| **The motion trace + action journal** | the trace samples the COMPUTED world, pinned by the case that distinguishes it: the ball's stored box never changes size, so a trace of stored values would report a constant 80x80 for every frame while the computed one reports the squash. DETERMINISTIC — two runs equal, digest equal — and the digest must NOTICE a change, asserted with an edit that actually reaches the motion (nudging stored `x` does nothing, because the track overrides it every frame, which this test got wrong first). VELOCITY differences the ANCHOR, not the bounds: a squashing ball's box widens while the ball travels steadily, so differencing the box counts the squash as sideways motion — which is how the uniform-speed assertion failed against a ball that was in fact uniform. TIMING is inclusive of both ends (0..11 at 24fps is half a second, not eleven twelfths). The JOURNAL is bounded and reports what it dropped, with the LAST sequence number asserted — the first is 26 either way, so only the last distinguishes a session counter from a sliding-window index |
| **The transform ANCHOR** | the rule DOCUMENT-SCHEMA states, pinned as assertions: a squash authored as `transform.scale` about `{0.5, 1}` keeps the shape's BOTTOM and its CENTRE fixed (the centre is what caught the old bug — it drifted 165→176 when squash was a width change), and conserves AREA, because widening by the reciprocal rather than by the same amount added back is the difference between an impact and the ball deflating each bounce. A limb's JOINT — its box's top-centre pushed through its own world matrix — lands on the same world point at every frame of the swing, which is what a pivot IS, with a non-vacuous check that it genuinely swings; and the forearm LAGS, so a chain reads as connected |
| **The classic exercises (schema 45)** | the demos are documents, so the tests assert what the MOTION does rather than that a fixture parsed. Bouncing ball: horizontal speed uniform to a rounding hair ACROSS beat boundaries — sampling one arc hides a demo that advances a fixed distance per bounce — while vertical speed varies more than tenfold, and squash conserves volume (wider by as much as it is shorter). Jumping square: down and wider BEFORE up, and it lands back on the ground line. Pendulum: rotation returns so it can loop, and is fastest through the middle — sampled OFF the midpoint, where a symmetric swing reads zero for any curve. Cel: a held drawing does not creep, and the next replaces it. Every demo round-trips and produces more than one distinct frame |
| **Cubic-Bézier easing (schema 44)** | exact at BOTH ends whatever the control points (a tween that misses its keyframe leaves the next one starting from the wrong place); the inversion checked DIRECTLY — the parameter returned must put the curve's x where it was asked and stay inside [0,1] — rather than through the eased value that hides it; FLAT-ended curves, where Newton stalls and the bisection fallback carries it, asserted for ACCURACY and not merely finiteness (asserting the answer exists is what lets a stalled solver pass); OVERSHOOT above 1 and anticipation below 0 both reachable, while x outside [0,1] is refused on both paths because x is TIME; a keyframe curve round-trips and measurably shapes the tween against a linear one |
| **The playhead actually moves things** | a source-level test pins BOTH halves of the incremental-geometry guard — `!es.playing` AND `!frameChanged` — because it is one expression and losing either half silently reuses the previous frame's geometry, which shows up as a tweened shape not moving at all while the playhead runs its whole track. The engine's dirty set only names nodes an ACTION touched, and scrubbing dispatches none, so nothing tells it a tween moved anything |
| **Mesh points as fractions (schema 43)** | an untouched mesh is the IDENTITY at every size — the property absolute units could not have — and a real warp scales with the box instead of staying at the coordinate it was dragged to, checked through the display seam at two sizes; the 42→43 migration divides each point by the node's OWN geometry so the shape draws identically (a per-axis divide, so mixing them up dies), leaves HEIGHT alone because `z` is a distance above the page, and DROPS the mesh on a zero-sized box rather than writing infinities the loader would reject; mesh handles scale by the box or they sit away from the corner they control |
| **The exporter wraps** | with no measurer the exported text breaks on explicit newlines ONLY — the behaviour it always had, kept as the default for callers with no DOM; with one injected, a paragraph becomes several `<tspan>`s at evenly stepped baselines, no word lost or duplicated. The shared wrapper is checked directly: a narrower box breaks more, and a word WIDER than its box keeps its own line rather than being preceded by an empty one (the first-word-always-fits rule — the difference is a blank line above any long word, visible only in the exported file). A source-level test asserts EVERY `exportSVG` call site passes the measurer, since one that forgot would silently export unwrapped text |
| **Dashes as geometry** | run lengths ARE the pattern (five 10s over a 100 line, starting at 0/20/40/…); a path that does not end on a cycle boundary keeps its PARTIAL dash; the offset shifts the phase, is taken modulo the cycle and works when negative; an odd pattern repeats to become even; an invalid or all-zero spec draws SOLID, never blank; a closed contour dashes all the way ROUND (a 10/5 pattern on a 40-perimeter square gives three dashes where stopping at the last corner gives two) and each contour restarts the phase; every run is well formed `M` then `L`s — an earlier version stepped over a zero-length gap without opening a run, so dashes after the first began with a bare `L`. Through the backend: a dashed stroke covers under 70% of a solid one's triangle area, and a malformed spec covers exactly as much. **Canvas**: a dash must not LEAK onto the next stroked item |
| **Text on the GPU** | a text shape produces one draw carrying the shape to rasterise, and NONE when the text is empty; its box is never filled underneath, because `fill` on a text node is the glyph colour and filling it would paint a rectangle over what is behind. The raster SCALE is quantised to powers of two (an exact-zoom key rebuilds the bitmap on every wheel tick) and bounded at both ends; the cache key omits POSITION — dragging a text node must not rebuild its bitmap — and includes everything that changes the pixels. The NUL separator is pinned by the one collision that needs it: text `"a"` in a 12-wide box versus `"ab"`… i.e. `"a1"` in a 2-wide box, which plain concatenation cannot tell apart. The typesetting itself has NO new test — it is the same `drawTextInto` the Canvas suite already covers, which is the point of sharing it |
| **Images on the GPU** | an image now produces a draw carrying its href and its OWN rect (the rect the shader turns into texture coordinates, not the origin box the triangles start from); the item's opacity rides in the colour's alpha because an image has no fill; a picture REPLACES the fill rather than covering it, so a transparent PNG shows the page and not a colour; no href means no draw at all rather than a white rectangle. The pre-existing assertion that images produce NOTHING was the gap written down as a test, and is now the assertion that they produce one. A decode advances the GENERATION exactly once per href — the cue a texture needs, since a cached lookup must not re-upload |
| **The heightfield texture** | the packing ROUND-TRIPS against `warpHeight` at texel CENTRES — where `texture2D` reads, so a half-texel slide is caught; sixteen bits asserted by resolving a 260-unit relief to two decimals, which eight cannot; a surface that goes BELOW the page packs against its own range (the only case that distinguishes normalising by the span from subtracting the floor — every all-positive surface makes the two identical); a flat mesh has no relief and no range and yields NULL rather than a divide by zero; the GPU gets LOCAL positions, checked against the world ones. The shader's own copy of the march and the decode cannot be tested — they are transcriptions of `marchOccluded` and `decodeHeight`, which are, and the live CDP run observes the 16 KB uploads reaching the driver |
| **Ray casting through a heightfield** | a raised edge shadows the ground BESIDE it (which the ground's own normal calls fully lit); the same point is clear when the light moves to the other side; the ray CLIMBS, so a steep light clears a low bump and a shallow one does not; a surface lit exactly along its OWN SLOPE is grazed rather than blacked out (the `>` vs `>=` case, which the flat-surface test cannot reach because the short-circuit returns first); a flat surface never shadows itself under any direction; a light at or below the HORIZON is refused, including the direction that would otherwise march backwards into a wall; the miss on a spike thinner than the step spacing is asserted, so the stated limit cannot be quietly narrowed. On the GPU path: the term is per vertex and binary, the HIGHEST vertex is lit (the assertion that survives an inversion, which "some dark, some light" does not), and it is empty for no surface / no light / no relief / a light below the horizon |
| **Cast shadows + the boolean fix** | a caster throws a SHORTER shadow onto a raised receiver than onto the page (the gap between them, not its own height — invisible with only one raised shape, which is why it shipped wrong and the suite stayed green); one shape's shadow lands on another only where they OVERLAP, and misses cleanly when the throw carries it past; only a STRICTLY nearer shape casts (equal depth is the same plane, which is also what stops self-shadowing); the patch is spliced ABOVE its receiver and below its caster, unpickable and idless; an unlit document does no quadratic work at all. **The booleans**: union and intersection of two axis-aligned rectangles at the same `y`, two rectangles merely TOUCHING, and a shape unioned with ITSELF — every one returned empty before, every one asserted by area now — while the non-degenerate case is asserted EQUAL to the old classifier's output, so the replacement is pinned as a fix rather than a change |
| **Per-fragment normals** | a triangle's three RAW normals, averaged and normalised, match the surface's own normal to **12 digits**, where the same done with unit normals is off by degrees — the faceting, measured rather than asserted; the raw length does not depend on **where in the box** it was sampled (the rim's step is half the inland one); a COLLAPSED cell never reaches the GPU as a zero normal, because normalising zero in a shader is NaN |

## The API-surface pin

`src/core/tests/apiSurface.ts` is never executed. It imports every symbol documented
in [API-CONTRACTS.md](API-CONTRACTS.md) and asserts its shape, so `tsc` fails if a
documented export is renamed, removed, or changes signature.

**Its coverage was itself the failure once.** For six schemas — 37 stroke joins/caps,
38 fill rules, 39 animation, 40 depth, 41 mesh, 42 lighting — API-CONTRACTS grew
entries for `Mesh`, `Light`, `Depth`, `Timeline`, `emitWebGL`, `PathBoolean`,
`Resolve`, `StrokeOutline`, `Tessellate`, `ConvexDecompose`, `ShapeHit`,
`ShapeToPath`, `OrientedBox` and `TrackList` while this file imported none of them.
A pin that quietly stops covering new work is worse than no pin, because it reads as
enforcement. **When a module gains a documented export, it gains a line here in the
same commit.** Closing the gap also surfaced a real defect: `GLState` — the return
type of the documented `initGL` and a parameter of the documented `setLighting` —
was not exported, so neither signature could be written down by anyone outside its
own file.

The pin is verified the way every guard here is: by breaking the code on purpose.
Eight documented signatures were mutated — a rename (`surfaceNormal`), a dropped
interface field (`Draw.normals`), a changed return type (`shadowOffset`), an
un-exported type (`GLState`), a widened generic (`applyParallax`) and three dropped
parameters (`resolveRings`, `subdivideTriangles`, `SetLightingAction`) — and each
failed `tsc` **with `apiSurface.ts` named in the error**. That last clause is the
scoring rule: a `tsc` failure that does not name this file is the mutation breaking
its own module, which scores nothing. One mutation was written badly (`T extends
never | {…}` collapses to `T extends {…}` — a no-op) and read as a survivor until
the mutation itself was fixed; the same trap as `if (false)` failing to compile.

It exists because API-CONTRACTS.md drifted in three places during one pass **while the
freeze rule was in force**, and the drift was found by accident. Two mechanisms were
measured against that drift before this one was kept:

| Mechanism | Result |
|---|---|
| Identifier-existence checker over backticked names in docs | caught **0 of 4** — the drift was semantic (`ProjectDocument` still existed, it was just the wrong type), and 5 of 5 hits were false positives |
| Assignability assertion (`expectType<ReadonlyDocument>(…)`) | **passed** even with `getDocument()` reverted to mutable — mutable widens to readonly |
| Generic conditional (`expectNotMutable`) | **fails** correctly: `Argument of type 'ProjectDocument' is not assignable to parameter of type 'never'` |

The lesson is in the middle row: an assertion that only checks *assignability* cannot
detect a guarantee weakening, because weakening is exactly the direction assignability
allows. Guarantees that must not weaken need a conditional generic over the argument's
own type — and the check must be verified by breaking the code on purpose.

**Not covered:** prose describing behaviour that has since changed. Nothing mechanical
catches that; it needs review.

## Mutation testing (verifying the tests, not the code)

"A check is worthless until you have broken the code on purpose and watched it fail"
applies to the whole suite, not just to new regression tests. Every guard added during
the audit campaign was weakened one at a time, with the suite run against each
weakening. A guard nothing notices is not protected.

First pass over 18 guards: **13 killed, 2 survived, 3 unverified** (the mutation string
did not match — *unverified*, not passing). The survivors were real gaps:

| Guard | Why nothing caught it |
|---|---|
| `MoveTool` selection-root filter | the test exercised `selectionRoots` + `computeGeometry` directly, never `MoveTool` — so the CRITICAL parent+child double-apply could have been reintroduced silently |
| coalesce anchored to the last commit | the existing test happened to land on `currentIndex === 0`, so a *different* guard was rejecting the merge; the anchor itself was never exercised |
| legacy → schema-1 normalisation | `LEGACY_SCHEMA` and `SCHEMA_VERSION` are both `"1"` today, so correct and incorrect behaviour are indistinguishable until a future bump — exactly when it would bite |

Three tests were added to close them; the third required making the schema injectable
(`migrateIfNeeded(raw, currentSchema)`) so the future-bump case can be exercised now.

**Three of the mutations were themselves wrong**, and they failed in BOTH directions:

- Two produced false *survived* results — one changed an object field but not the local
  variable set on the next line; the other left the `try/catch` in place while claiming
  to remove listener isolation. Corrected, both were killed.
- One produced a false ***killed*** result. The unresolved-parent
  mutation did not compile (dropping the `continue` leaves `parentRect` possibly
  undefined at the deref), so jest exited non-zero having run **zero tests** — and the
  harness read any non-zero exit as "a test caught it". Mutated validly, by restoring
  the exact pre-fix code, it **survived**: nothing protected that guard. A test was added.

> **Harness rule:** a mutation run must assert that the suite actually RAN. Treat
> `Tests: 0 total`, or a non-zero exit with no failure count, as **unverified** — never
> as a kill. A false *survived* prompts investigation; a false *killed* is silent, and
> is the one that leaves a guard unprotected while looking green.

**Milestone 2 pass — 6 guards, 1 survivor, closed.** The auto-layout guards were each
weakened and the suite re-run: the dirty-ripple (`expandDirtyForLayout`), the reparent
and delete dirty-reporting, the `MoveTool` laid-out-child guard, the load-path
`layoutError`, and the flex-stack `gap` math. Five were killed immediately (2–3 tests
each). One **survived**: disabling `ReparentNodeAction`'s old-parent reporting broke
nothing — the 300-op fuzz, by chance, never reparented a child *out* of a multi-child
container at this seed, and there was no targeted test. A deterministic
reparent-out (and a matching delete) test was added; both now kill it. This is the whole
point of the discipline: **a fuzz is a sampler, not a proof of coverage — a survivor is
a missing test even when everything is green.** Two mutation attempts also reproduced the
"does not compile → `Tests: 0 total`" trap (a short-circuited `&&` un-narrows the
variable on the next line); per the harness rule they were re-authored to compile before
being trusted.

**Intrinsic-sizing pass — 5 hug guards, all killed.** Each weakened one at a time:
(1) the climb continuing only while hugging — reduced to one level → killed by the 3-deep
chain + pending-hug tests; (2) adding the first fixed container **before** the hug check
(so it's never added) → killed by 5 tests; (3) the measure fold ignoring children → killed
by 5; (4) dropping the pending→seed union → killed **only** by the deterministic
pending-hug test (the fuzz passes `pending=null`); (5) measure ignoring pending sizes →
killed by 2. Notably the one-level mutation (1) **survived the fuzz** — this seed never
builds a 2-deep hug chain with a bottom resize — and was caught only by the pinned
deterministic chain test, the same fuzz-is-a-sampler lesson as the M2 reparent-out gap.
The one-level and add-order mutations again hit the unreachable-code `Tests: 0` trap and
were re-authored to compile before being trusted.

**Flex-grow pass — 4 guards, all killed.** (1) not applying the distribution → killed by
3 tests; (2) dropping the `free > 0` guard so an overflow would shrink to a negative size
→ killed precisely by the overflow test; (3) moving the `grow` validation *after*
`layoutError`'s no-container early return (so a `{grow:-1}` patch with no container slips
through) → killed by the write-path test, which deliberately validates a container-less
patch; (4) `layoutContainerPass` dropping the child's `grow` → killed by the integration
tests (the pure `layoutChildren` unit tests still pass, since they feed `grow` directly).

**Adversarial agent review found one real bug the fuzz could not.** A multi-lens review of
flex-grow confirmed a preview-only defect: a **pending resize of a grow child** was
double-applied — the pending width fed the measure pass (so the child grew *past* it),
then the position-pass override clamped it back, leaving a gap before its sibling. The
`incremental === full` fuzz cannot see it (the override is in the shared path; the fuzz
passes `pending=null`), and the one prior pending-resize test used a non-grow child where
the override is a coincidental no-op. Fixed by having a pending patch on a laid-out child
preview **position only** (its size is already the layout's result); a regression test
proves preview == commit and fails without the fix. The review pass itself also perturbed
the working tree and dropped the `grow` wiring in `layoutContainerPass`; the same new test
caught that too. *Lesson: an agent review catches semantic/interaction bugs the property
fuzz is structurally blind to — but re-run the full gate afterward, because the review can
disturb the tree.*

**Grid pass — 5 guards, all killed, one gap surfaced.** Weakened: (1) auto-flow row
placement (all items in row 0) → killed by 2 tests; (2) `fr` tracks getting no share →
killed by 2; (3) `isLayoutContainer` not recognising a grid → killed; (4) the
mutual-exclusivity clearing in `applyMutations` → killed; (5) the `TrackSize` `fr > 0`
check → killed by the write-path test. Guard (3) was initially killed **only** by its unit
test — the delete-reflow test reports the parent directly (no climb), and `px`-row grids
don't resize on count — so mutation testing exposed a missing case: an `fr`-row grid's
heights depend on the item count, so **adding** an item (which reports only the new node)
must reflow existing rows via the climb. A deterministic `incremental === full` test was
added and now co-kills the mutation — the same "a survivor is a missing test" lesson.

**Constraints pass — 4 guards, one survived (a defensive gate), pinned.** Killed
immediately: the reference delta (`d = C − R` → `d = 0`, killed by the per-mode math + both
source tests), the `constraintRef` auto-capture, and the `layoutError` mode check. The
`!isLayoutContainer` gate **survived** — a valid container child has `computedLocal` and
never reaches the constraint branch, so no test exercised the gate (it only fires for a
damaged tree: a child claiming a container parent that does not list it). Added a
deterministic damaged-tree test (the child stays static, not repositioned to the container's
box) that now kills it — the gate is defensive but no longer unprotected.

**Constraints adversarial review — math clean, one write-path bug.** A read-only review
(a reference reimplementation matched `resolveConstraints` over 30,375 mode×size cases;
400+ constraint-heavy fuzz seeds with transforms and pending overlays found no
`incremental === full` divergence; all five design claims held) confirmed one medium
defect: the `constraintRef` auto-capture guard inspected only the incoming patch, so a
**second** constraints edit (a mode change, or an M5 inspector setting the two axes in
separate patches) re-captured the reference from the parent's *current* size — un-freezing
it, zeroing the delta, and teleporting the anchored child back to its rest position, which
undermines the whole frozen-reference model. Fixed by capturing only on **first** opt-in
(when the node has no existing `constraintRef`); an explicit ref in the patch (a deliberate
re-baseline) still wins. A regression test was proven to fail on the unfixed code.

**Margins + absolute pass — 5 guards, all killed.** Weakened: margin dropped from
positioning (killed by the flow-math test), absolute not excluded from the flex flow (2
tests), absolute not excluded from the hug measure, the constraint gate's `|| isAbsolute`
allowance (the absolute-can-be-constrained test), and `MoveTool`'s `&& !isAbsolute` (the
absolute-draggable test) — each killed by its targeted test. Both features degrade to the
pre-M2 behaviour when absent (in-flow / margin 0), so every existing test was byte-identical.

**Margins + absolute adversarial review — the margin math and absolute exclusion held (400×400
fuzz clean, every axis cross-checked); ONE high bug found.** Letting an absolute child of a
container be constrained exposed a latent flaw: `UpdateNodeLayoutAction` auto-captures
`constraintRef` from the parent's STORED size while `resolveConstraints` positions against
its COMPUTED size. Fine for a plain static parent (equal), but a container's computed size
routinely differs (hug), so a badge pinned to a hug-card corner flew off at rest (`x = 0 +
(50 − 400) = −350`). The fuzz was blind (both paths share the frozen ref and agree on the
wrong value); the one absolute+constraint test used a *fixed* container, sidestepping it.
Fixed by skipping the auto-capture for **container** parents (their stored size is an
unreliable reference — that capture is the M5 tool-layer's job, from the computed size); an
explicit ref still activates it. Regression test proven to fail on the unfixed code.

**Grid adversarial review — found TWO real bugs the fuzz was blind to.** A read-only
multi-lens review (100k random grids and 400 fresh fuzz seeds found the cell math and all
five design claims clean) confirmed two high-severity defects, both preview/edge-only so
`incremental === full` never diverged: (1) **resizing a grid item teleported it to its
ignored stored x/y** — the earlier "laid-out child previews position only" fix guarded
size but *leaked* position, and the resize tool's pending patch carries stored-based x/y;
fixed by having a laid-out child ignore a pending patch **entirely** (its whole rect is the
layout's result — size already folded through measure), with a regression test. (2) a
**transaction merging a container-set and a grid-set on one node dropped BOTH** layouts —
the merged delta held both and the post-hoc "clear both" in `applyMutations` cleared both;
fixed by carrying grid⊕container exclusivity **in the delta** (`UpdateNodeLayoutAction`
sets the other field to `undefined`), so the field-by-field transaction merge is last-wins.
Both regression tests were proven to fail on the unfixed code. *Reinforces: the property
fuzz cannot see a bug that is uniformly wrong across incremental and full — an adversarial
review can.*

## Doc-staleness tripwire (`npm run doc-drift`)

Each doc that describes specific code declares it in the doc itself:

```html
<!-- describes: src/core/actions, src/core/document/Serializer.ts -->
```

`scripts/check-doc-drift.js` flags a doc when any declared source has been **committed
to since the doc was last committed to**. Clearing the flag means committing the doc —
which is the re-read it exists to force.

It cannot tell you prose is wrong; nothing can. It targets the failure that actually
occurred: editing one section and never re-reading the rest, so drift accumulated where
nobody was looking.

**Measured on first run against real history — 3 flags, 2 true positives:**

| Doc | Verdict |
|---|---|
| `API-CONTRACTS.md` | **true** — `migrateIfNeeded` had become a public export and was undocumented |
| `DOCUMENT-SCHEMA.md` | **true** — still described `version` as `= CURRENT_VERSION on new docs`; it is `SCHEMA_VERSION`, plus a stale `migrateIfNeeded` signature and a hand-written `NodeType` |
| `ARCHITECTURE.md` | **false** — its history claims were still accurate |

The `DOCUMENT-SCHEMA` case is the point: `CURRENT_VERSION` still *exists*, so no
identifier check could see it, and it is prose, so the API pin could not either. The
freeze rule had already missed it once. The tripwire caught it only by forcing the
re-read — which is the whole design claim.

**Not in `npm run check`.** It is noisy by construction: every source commit flags its
doc whether or not the doc is wrong, and the flag clears only on a doc commit. Adding it
to the gate is one line in `package.json`; that is a workflow-cost decision, not a
correctness one.

## Regression discipline

When fixing a bug, add a test that **fails on the unfixed code and passes after**. Example
this project follows (R2, the undo/history aliasing bug): the fix in
`hydrateDocument` was temporarily reverted to confirm the new test failed with the exact
corruption signature (`Expected 0, Received 50`), then restored so it passes. A regression
test that was never seen to fail proves nothing.

## Gaps / not yet automated (tracked, not silently ignored)

- **Renderer & tools** have no automated **DOM** tests: the renderer's pure model is
  unit-tested (`RenderModel.test.ts`), but the `emitSVG` backend, the `renderSVG`/
  `renderCanvas`/`renderScene` shims (canvas sizing, DPR, the backend switch), and the DOM
  plumbing of the move/draw tools are validated by browser smoke tests. Tool *logic* that is DOM-free
  is node-tested with fake events — the viewport math (`panBy`/`zoomAt`/`screenToWorld`),
  the `ToolController` pan-mode intercept, its **DOM-free corner-resize AND rotate** (handle
  picked by `handleAtPoint`; resize drives geometry, rotate spins about the AABB centre and
  live-commits a coalesced transform = one undo per continuous drag), the `SelectTool` marquee (drag →
  `nodesInRect`, click-to-select, shift-additive), and **alignment snapping** (`computeSnap`/`snapPoint`/
  `guidesForRect`/`snapTargetsExcludingSubtree`, with the MOVE drag and the corner-RESIZE both folding it in
  for a single top-level node). Adding jsdom-based emitter/tool tests is future work.
- **Electron main/preload** IPC is not unit-tested (thin, and requires an Electron host).
  The Open → edit → Ctrl+S round-trip in particular is only manually verified.
- `applyMutationsToDocument`'s `text` / `src` / `name` branches have no producing Action
  yet, so they are reachable only by constructing a delta directly — currently untested.
- The same-node `TransactionAction` merge path is exercised indirectly but never
  asserted on directly.
- `ComputedState` carries geometry only. Resolved style (M5 tokens) and layout output
  (M2) are not in it yet, so neither has coverage here.

## Conventions

- Test file mirrors the module and tags each `describe` with the requirement/fix id it
  satisfies (e.g. `T2`, `M24`, `R2`).
- Prefer the small factory helpers (`createDocWithRectangle`, `createDocWithParentChild`)
  over ad-hoc fixtures.
- Mock browser globals (e.g. `localStorage`) locally within the `describe` that needs them.
