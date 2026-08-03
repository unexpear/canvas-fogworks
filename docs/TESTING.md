# Testing Strategy

<!-- describes: src/core/tests, src/renderer/RenderModel.test.ts, src/renderer/emitCanvas.test.ts, jest.config.js, scripts/check-module-headers.js -->

> 🔒 Frozen contract · schema v42 (app v0.0.5) · current through Milestone 2 (layout: flex, hug, grow, shrink, wrap+align, grid (+rows/auto/hug/spans/flow/placement), constraints, absolute + per-side margins) + M3 render-model extraction + viewport culling + ellipse/line/path node types + Canvas backend + effects + M4 pan/zoom + box-select + DOM-free handle picking + rotate + live Canvas backend + snapping/guides (move + resize) + rulers + canvas images + group snapping/rotate. Suites: `src/core/tests/document.test.ts` (1013) + `src/renderer/RenderModel.test.ts` (69) + `src/renderer/emitCanvas.test.ts` (33) = 1115 tests.

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
npm test                                   # jest (ts-jest), 1115 tests
npx tsc --noEmit                           # typecheck the app
npx tsc --noEmit -p tsconfig.test.json     # typecheck the tests too
npm run lint                               # module-header rule (no ESLint dependency)
npm run check                              # typecheck + lint + test + build (the gate)
```

- Runner: **Jest** via **ts-jest**, `testEnvironment: node` (`jest.config.js`).
- `tsconfig.json` excludes `*.test.ts` from the app build; `tsconfig.test.json` type-checks
  them. Both must be clean.

## What is covered (1115 tests)

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
| **Per-fragment normals** | a triangle's three RAW normals, averaged and normalised, match the surface's own normal to **12 digits**, where the same done with unit normals is off by degrees — the faceting, measured rather than asserted; the raw length does not depend on **where in the box** it was sampled (the rim's step is half the inland one); a COLLAPSED cell never reaches the GPU as a zero normal, because normalising zero in a shader is NaN |

## The API-surface pin

`src/core/tests/apiSurface.ts` is never executed. It imports every symbol documented
in [API-CONTRACTS.md](API-CONTRACTS.md) and asserts its shape, so `tsc` fails if a
documented export is renamed, removed, or changes signature.

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
