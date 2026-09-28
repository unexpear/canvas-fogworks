# 3D level-authoring delivery

Requested 2026-09-23: implement all four recommendations from the Chisel research, in
Canvas Fogworks rather than integrating or replacing the engine with either Chisel project.
Explicitly added to the same delivery goal on 2026-09-23; see part 6 of
[the goal plan](GAMEPLAY-FIVE-PART-GOAL.md). All requirements here are completion gates,
not optional follow-up work. They do not cancel or replace the five gameplay foundations.

## Scope and acceptance

1. Editable blockout: rooms, walls, ramps and stairs, numeric editing and snapping, selection,
   undo/redo, save/reopen and exported player rendering. Generated buffers are derived data;
   authored parameters remain editable. Start with a tested geometry generator.
2. Non-destructive solid operations: add/subtract/intersect, including doors/windows, editable
   operation trees, stable material surfaces, bounded evaluation and clear failure reporting.
   Collision must agree with openings and slopes; a bounding box is not sufficient.
3. Building prefabs: use the actor-prefab system, including hierarchy, materials, collision and
   behavior. Support place/spawn, instance editing/detach, undo and persistence. Do not build
   a separate competing prefab system.
4. Large-level optimization and lighting: capture representative frame/collision workloads,
   implement measured visibility/spatial-query improvements and static-lighting improvements,
   test visual equivalence, editor invalidation and exported builds. Do not infer performance
   from object count or hide incorrect geometry to obtain a faster benchmark.

## Constraints and research

Existing `Spatial3D`, `Scene3D`, `World3D`, asset imports and Actions remain authoritative.
The current collider union only supports boxes/spheres. Convex/compound collision and traversal
tests are required before rooms with cutouts or ramps can be called playable.
Keep 2D design and game authoring intact; no external engine code, assets or licenses adopted.

- [Chisel Engine author explanation](https://www.reddit.com/r/gameenginedevs/comments/1pa0f7v/showcasing_progress_on_my_3d_engine_chisel/): design inspiration, not a Source fork.
- [Chisel CSG](https://github.com/RadicalCSG/com.chisel): editable generators and solid operations;
  Unity-dependent and explicitly not production-ready.
- [glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html): right-handed,
  Y-up geometry, triangle winding and normal conventions for compatibility with imported meshes.
- [CGAL polygon mesh concepts](https://doc.cgal.org/latest/Polygon_mesh_processing/index.html):
  closed, oriented topology alone does not establish geometric validity; planarity, convexity,
  degeneracy and the supported result representation require separate checks. Reference only;
  no CGAL code or library is incorporated.
- [CGAL regularized set operations](https://doc.cgal.org/latest/Nef_3/index.html#title4):
  solid operations discard lower-dimensional-only results; a touching plane is not a solid volume.

## Status

In progress. Schema 88 adds saved editable solid-operation trees, numeric inspector controls,
Action history and shared renderer/collision evaluation. Existing blockouts retain their previous
representation and collision opt-in. Material assignment, full traversal/export acceptance,
building prefabs and performance/lighting remain open; no acceptance group is declared complete.
The gameplay checkpoint remains in `GAMEPLAY-FIVE-PART-GOAL.md`.

### Schema-88 saved solid authoring

Select a blockout and use Edit solid operations to convert it without changing its dimensions,
world transform or collision opt-in. Each branch supports add/subtract/intersect, swapping operands,
or keeping either operand when removing an operation. Shape leaves expose shape/dimensions and
position, rotation and scale triples. Rotations apply X then Y then Z in degrees; reflected scales
retain outward face winding. Operations can be nested on either branch. Invalid edits report the
evaluation error and retain the preceding solid. All writes use the existing spatial Action, and
gizmo copies preserve independent tree data. Optional `solidTree` is schema 88; old scenes do not
acquire operations or collision automatically.

Trees have at most 31 nodes/depth 8 with unique stable operand IDs. Structural validation and bounded
Boolean/surface evaluation run before document adoption, including GPU precision checks. A bounded
16-entry value cache supplies the same derived convex cells/exterior mesh to world projection and
rendering. Shape changes invalidate by value. Save files contain no generated buffers. Spawn and
progress reconstruction reuse the existing geometry projection, including solid trees. The shared
collision flag also applies to trees; no box/sphere approximation is used for openings.

The real blockout smoke now authors the wall, subtraction and dimensions through the production
inspector, reopens schema 88, checks cut undo/redo, GPU opening/jamb/header picks and movement through
the opening versus refusal beside it. This supersedes the earlier code-seeded cutout smoke evidence.
Surface IDs are retained internally, but material assignment controls are not yet implemented.

Verification: 2,426 tests across 71 suites pass, with typecheck, module headers, production build,
tracked whitespace checks, authored-blockout desktop smoke, existing 3D WebGL smoke and standalone
gameplay save/new-window restoration smoke all passing. The dedicated standalone blockout test now
exports the schema-88 room-minus-door tree (112 exterior room triangles), removes source access,
verifies side-wall blocking before/after save/reopen at x=1.8, then restarts and walks through the
doorway beyond z=3. This supersedes the earlier uncut-room-only export proof. DOM coverage also
creates nested operations, edits cutter offsets, refuses invalid dimensions without changing the
document, and verifies undo/redo and keeping a branch. Documentation checks retain only known
commit-history warnings. No installer or final proving-game release is claimed by these smokes.

### Earlier solid-operation geometry foundation

`SolidBoolean3D.ts` evaluates add/subtract/intersect over bounded generated convex cells in a
common local coordinate space. Repeated halfspace clipping produces closed caps and disjoint
convex volumes; source face identities survive fragmentation so subsequent surface-material
authoring can distinguish original walls from cutter faces. Inputs are copied, not edited.
Both operand sets are normalized to prevent overlapping input pieces from double-counting volume.
Touching-only intersections are empty. Validation rejects open/inconsistently wound, nonplanar,
nonconvex, degenerate and oversized inputs. Evaluation limits are 256 cells per operand/result,
512 vertices/faces per cell and a one-million-unit work budget. Failure throws without returning
or adopting a partial result. Coordinates are bounded to ±1,000,000 in local space with a 1e-8
distance tolerance; this is not an exact-arithmetic arbitrary-mesh Boolean implementation.

Tests independently verify cube volume identities, empty/disjoint/touching/contained operands,
closed outward faces, a doorway with clear sphere traversal samples and solid jamb/header
contacts, a window with four retained cutter surfaces, rotated cuts against analytic point
membership, deterministic isolated outputs and fragmentation-budget refusal. The resulting
collision cells still contain shared internal faces. Exterior extraction is implemented in the
follow-up below. At this earlier checkpoint, stored editable operation trees, material assignment,
Actions/undo, inspector controls, renderer/runtime wiring and exported cutout acceptance remained
required. That pure geometry slice changed no document schema or existing authoring behavior;
the schema-88 integration above supersedes its editor/runtime limitations.

Verification: all 2,416 tests across 69 suites pass, plus typecheck, module headers and tracked
whitespace checks. Eight new solid-operation tests include independent volume/membership and
existing sphere/convex collision oracles. Documentation checks report only the established
commit-history flags. No new production build or desktop smoke was run for this pure helper;
those become meaningful for cutouts after renderer/editor/runtime integration.

### Earlier exterior-surface generation

`SolidSurface3D.ts` validates/normalizes the convex-cell solid, subtracts neighbor coverage from
each outward face, and produces an exterior-only `MeshPrimitive`. Partial coplanar coverage is
clipped rather than dropping an entire face. Polygons retain operand face identities, and each
triangle receives the corresponding surface ID for later material assignment. Planar UVs use a
shared coordinate basis so fragmented coplanar faces do not independently restart their texture
coordinates. Extraction has a one-million-unit work budget and a 16,384-polygon output/fragment
limit; results are not adopted partially. Triangles that collapse or reverse during Float32 GPU
conversion are rejected rather than rendered differently from the collision solid.

The mesh is drawable triangle data, not a welded manifold export: positional T-junction welding
and topology-sensitive mesh export are still separate concerns. The collision cells retain their
closed internal caps; only the visible boundary drops those shared surfaces. No saved operation
tree or inspector changes are implied by this geometry integration slice.

Tests verify exposed areas for touching/overlapping cubes, partial shared faces, doors/windows
and rotated cut solids, ray visibility through openings, retained face identities, empty results,
isolated deterministic buffers and GPU precision refusal. The real `smoke:blockout` now also
sends a generated doorway through production WebGL rendering and picking: its opening returns
no hit while jamb/header samples hit the wall (32 exterior triangles). This smoke still seeds
the cut geometry in code; it does not prove operation authoring, saving or standalone cutout export.
Verification: 2,421 tests across 70 suites pass, together with typecheck, module headers,
tracked whitespace checks and the extended real Electron blockout smoke. Documentation semantic
checks retain only existing commit-history flags. No installer or final playable game was rebuilt
for this helper; the smoke bundles the current source directly.

### Schema-87 runtime integration

The inspector's Solid collision checkbox is Action-backed and survives undo/redo, gizmo copying
and reopening. Missing/false preserves visual-only behavior; malformed values are rejected.
Fresh runs, template spawning, checkpoint reconstruction and progress restoration derive local
convex parts from the same generator as rendering. Saved progress contains no hull buffers.
Contact queries and gameplay contact events resolve those parts using current ancestor transforms,
including reflection/nonuniform scale. Box operands use transformed hulls; spheres remain spherical
with a conservative product-of-maximum-scales radius under parent transforms (not an ellipsoid).
Primitive-only pairs retain their pre-existing local-space behavior; general hierarchy parity for
those pairs is not claimed by this slice.

Gravity/restitution movement converts world contact corrections and velocity responses back through
the moving body's parent. Solid movement uses bounded substeps; ordinary non-gravity movement
still rejects blocked axes and does not automatically climb steps. The existing bounded contact
passes and last-safe-position fallback remain. Cutouts, character stair traversal, moving-platform
carry, optimized broadphase, and final exported-level acceptance are not yet delivered.

Verification: 2,407 tests across 68 suites pass, with typecheck, module headers, production build,
the blockout Electron smoke and the existing 3D WebGL smoke passing. Runtime tests cover hollow
interiors, wall movement refusal, actual ramp response, reflected/scaled parents, live parent
changes, thin-wall high-speed movement, parent-space correction, spawning and progress restoration.
The desktop smoke enables Solid collision through the production inspector, checks undo/redo and
schema-87 reopening, then verifies room rendering/picking (240 hits, 60 triangles) and movement
stopping at x=3.8 for a radius-0.2 player in an eight-unit room. Its floating-point assertion allows
1e-9 tolerance; this is not a collision-behavior relaxation. `smoke:blockout` now joins the CI chain.
Documentation semantic checks pass; existing commit-history-only warnings remain. An exported
blockout level and cutout/stair traversal are still required, not proven by this smoke.
The existing standalone-player smoke also passes after this change: export, WebGL, input,
level transitions, behavior spawning and checkpoint/new-window continuation restoration remain
working. That existing fixture does not exercise the new blockout solid feature.

### Exported blockout acceptance

`npm run smoke:player-blockout` now packages an asset-free authored box player, hollow room,
ramp and stairs into the real standalone HTML/desktop host. It moves its disposable source
directory out of reach before launching. The player presents all four generated meshes (12,
60, 8 and 48 triangles), accepts keyboard movement, and stops the 0.4-unit-wide player at
x=1.8 against the room's interior x=2 wall. Movement remains held for 12 additional frames;
the smoke then saves, closes the window, reopens, restores, repeats the wall check and restarts.
The restored wall position matches and the save contains no generated hull buffers. Editor/Node
authority remains unavailable. The test joins CI as a distinct exported-player acceptance check.

The hidden Windows run delivered about nine frames in ten seconds during initial verification;
the frame-count wait therefore has a bounded 20-second allowance and the complete harness a
75-second deadline. The collision/position assertions are unchanged. This is functional export
evidence, not a performance benchmark. Ramps/stairs are verified as exported rendered geometry
here; full slope/stair traversal, cutouts, building prefabs and the original multi-level proving
game remain required. All generated test packages/profiles are disposable, not the final game.
Verification for this export slice: the real smoke passes at x=1.7999999999999998 before and after
reopen; all 14 package-export tests, typecheck, module headers and tracked whitespace checks pass.
The added package regression independently checks zero file dependencies, retained solid settings,
generated rendering and collision reconstruction under a valid SHA-256 game identity. The full
suite was not rerun for these test-only changes; the preceding 2,407-test baseline remains the
last full-suite evidence. Documentation checks retain only the known commit-history flags.

Implemented `Blockout3D.ts`: box/wall, wedge ramp, 1–256 stairs and hollow room with optional
ceiling. Rooms use interior dimensions and outward wall thickness. Generated parts are convex,
closed and outward-wound, with unit normals and face-local UVs. Parts share boundaries but
retain internal faces until solid union is implemented. No runtime collider is inferred from
a mesh's bounding box. Inputs are bounded before generation; buffers are independently owned.

Verification on 2026-09-23: all 2,384 tests in 64 suites pass, plus typecheck, module headers
and tracked whitespace checks. Tests cover volumes, convex face planes, closed edge incidence,
triangle/normal agreement, deterministic isolated buffers and invalid parameter rejection.
No production build or desktop smoke was run for this unconnected geometry slice.

### Schema-86 editor integration

The 3D toolbar's Add blockout control creates box/wall/room/ramp/stairs through one transaction.
The inspector edits dimensions and room ceilings through `SetSpatial3DAction`. Reopening validates
the same bounded parameters; old schema-85 documents migrate without invented geometry. Gizmo
copies preserve parameters. Generated meshes use the shared renderer and picking path with a
bounded 32-entry value cache; no project mesh file is required. Imported meshes and 2D composition
are mutually exclusive with blockout, as are misleading explicit box/sphere collider approximations.
Materials currently use the viewport default; richer authored surface assignment remains open.

Verification: 2,389 tests / 65 suites pass, typecheck and production build pass. The new real
Electron `smoke:blockout` edits width through the production inspector, verifies undo/redo and
schema-86 reopening, and picks the 60-triangle room through WebGL (240 sampled pixels).
This is not yet proof of standalone exported blockout play, toolbar automation or physical traversal.

Next: convex/compound runtime collision, solid operation trees and actor-prefab integration,
followed by complete authoring/export acceptance and measured performance/lighting improvements.
Preserve all four delivery areas rather than treating these tests as completed level authoring.

### Convex-contact foundation

`ConvexContact3D.ts` derives world-space convex hulls from generator parts using affine matrices
(including reflection, nonuniform scale and parent shear). Convex/convex contact checks both face
normals and edge-cross-product axes. Sphere/convex contact includes face, segment and vertex
features. Containment uses exit distances rather than the overlap interval's length. Touching
within the existing 1e-9 contact tolerance is not penetration.
Transforms with normalized absolute determinant below 1e-12 are refused as numerically singular,
and transformed coordinate overflow is refused. This avoids accepting flattened solids merely
because floating-point normalization leaves a tiny nonzero determinant.

Research: [SAT and containment](https://dyn4j.org/2010/01/sat/) and
[Edyn's collision design](https://github.com/xissburg/edyn/blob/master/docs/Design.md).
These are algorithm references, not dependencies or imported third-party source code.
Seven focused tests cover hollow rooms, sloped ramps, edge/corner misses, contained objects,
affine transforms and agreement with the existing solver across 32 box and 150 sphere cases.
No runtime collision activation or schema interpretation change is included in this slice.
Remaining integration: compound contact consumption by movement, hierarchy transforms,
spawn/respawn/restore projection and explicit saved collision semantics before changing the
visual-only UI warning. Those remain required, not deferred out of the goal.
Verification: typecheck, module headers and all 2,396 tests / 66 suites pass after the
near-singular-transform regression fix. No new production build or Electron smoke was run for
this unconnected contact helper; the prior schema-86 smoke evidence remains the editor baseline.

### Compound contact dispatch

The existing `contact3D` entry point now accepts optional transient world-space convex parts.
`CompoundContact3D.ts` dispatches compound/compound, compound/box and compound/sphere pairs,
preserving the existing box/sphere path when parts are absent. An explicitly empty part list means
no solid volume, not fallback to an enclosing primitive. Per-part bounds prune separated pairs;
at most 256 parts are accepted per operand. The deepest individual contact is returned, not a
claimed separating vector for an entire concave union; movement must re-query after corrections
and retain bounded iterations and its last-safe-position fallback.

Focused tests exercise all pair directions, empty interiors, ramp clearance, floor separation,
immutable inputs and excessive-part refusal. This is connected to the collision interface, not
yet to authored blockout projection in `World3D`. Runtime movement and spawn/restore preparation
must rebuild world-space parts at the correct times before the visual-only label is removed.
No persisted schema or existing blockout collision semantics changed in this slice.
Verification: all 2,400 tests / 67 suites, typecheck, headers, production build and the existing
blockout/3D Electron smokes pass. Those smokes protect authoring/rendering; compound movement
and restored runtime collision still require their own integration evidence.
