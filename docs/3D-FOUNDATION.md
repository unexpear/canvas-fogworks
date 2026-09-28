# 3D Foundation — adoption plan

<!-- describes: src/core/document, src/core/runtime, src/core/import, src/runtime, src/renderer -->
<!-- re-read 2026-09-28: runtime test files only widened their shell source pins to include
     FoldersDrawer.tsx. 3D document, import and renderer behavior is unchanged. -->

## Decision

For the longer-term production-engine ambition beyond these bounded foundation slices, see
the [full engine development plan](ENGINE-ROADMAP.md). It preserves both authoring tracks and
defines future subsystem scope, dependencies and acceptance gates without changing the
historical delivery status below.

Canvas Fogworks remains one product for visual/pixel design and game authoring. Three-dimensional
authoring extends the existing document, Action, history, asset and editor contracts; it
does not embed a second editor or make the legacy Rust scene format authoritative.

The preserved Morphic/Hold engine is a reference implementation under
[`../legacy/morphic-engine`](../legacy/morphic-engine/README.md). Its strongest ideas can
graduate into Canvas Fogworks, but its Win32 shell, native editor, `.hsc`/`.hscene` formats and
renderers remain isolated until a measured Canvas Fogworks requirement justifies replacing a
specific subsystem.

## Ownership boundaries

| Concern | Authority | Rule |
|---|---|---|
| Authored project and scene data | Canvas Fogworks `ProjectDocument` | Persisted changes require schema migration, Actions and round-trip tests. |
| Editing and undo/redo | Canvas Fogworks Dispatcher | No 3D tool or native process mutates a document directly. |
| Computed authoring state | Canvas Fogworks geometry pipeline | 2D and 3D projections may differ, but both are pure derivations. |
| Running game state | Runtime world | Transient simulation never enters document history every frame. |
| Rendering | Backend-neutral frame description | Editor chrome and scene submission stay separate from backend implementation. |
| Native acceleration | Narrow optional boundary | Rust is introduced only for a profiled workload with a deterministic fallback or typed failure. |

## Model rules

Schema 77 adds shared clip controllers. The 3D runtime advances their movement/outcome conditions;
composed 2D visuals sample timeline tracks and sprite atlas crops. Schema 78 adds native glTF TRS
animation, bounded four-weight CPU skinning and two-pose blending, detailed in [ANIMATION.md](ANIMATION.md).
Oriented box and sphere contacts are now shared by runtime queries. Setting typed `gravity3d`
or `restitution3d` opts a dynamic body into the bounded substep/contact solver; absent fields keep
the previous movement policy. This does not provide dynamic-body impulse solving, joints,
angular dynamics or a production character controller. See [Production workflows](PRODUCTION-WORK.md).

1. Keep `Transform2D` and `Transform3D` distinct. A 2D field must not acquire
   a new meaning merely because a 3D viewport exists.
2. Do not overload the current deformation `Node.mesh` with imported triangle meshes.
   A 3D renderable references a stable asset id and carries material bindings explicitly.
3. Authoring entities use stable ids. Runtime ECS handles are transient projections and
   never become persisted identity.
4. Cameras, lights, colliders, bodies and renderables are typed components rather than
   conventions in `userData`.
5. Asset source paths are metadata, not identity. Imports produce stable asset records;
   recompilation and relocation preserve references.
6. Every backend advertises capabilities. An unsupported feature is visible and typed,
   never silently rendered as a different feature.
7. A scene saved by the previous release must either preserve its meaning or migrate
   explicitly under the existing schema freeze rule.

## What to reuse from the first engine

Promote the behavior, tests and invariants before considering a direct code port:

| Legacy subsystem | Canvas Fogworks use |
|---|---|
| Compiled-asset envelope | Version, kind, declared lengths, checksum and corruption tests for derived assets. |
| Reload generations | Last-generation-wins asset compilation with stale-result rejection. |
| Reload equivalence harness | Assert hot-reloaded output equals a clean import/load. |
| Determinism recorder | Reproducible runtime input streams and per-step state digests. |
| Backend capability table | Honest 2D/3D feature availability in UI and tests. |
| Editor scene session | Preserve authored identity while rebuilding or patching transient runtime state. |

Do not port the raw Win32 layer, native editor UI, hand-written OpenGL/Vulkan FFI,
software renderer, or duplicate browser scene codec. Canvas Fogworks already owns those boundaries
in a form compatible with its product.

## Delivery sequence

### 3D-0 — contracts and fixtures

**Delivered in schema 74.** The contracts live in `src/core/document/Spatial3D.ts`, their
write paths in `SetSpatial3DAction.ts` and `SetAssets3DAction.ts`, and the owned fixture in
`src/core/tests/fixtures/triangle.gltf`.

- Specify `Transform3D`, camera, light, renderable, material and collider components.
- Specify stable mesh/texture/material asset records and migration behavior.
- Add tiny owned glTF fixtures covering hierarchy, normals, UVs and materials.
- Add document round-trip, Action undo/redo and malformed-input tests before UI work.

### 3D-1 — viewport proof

**Delivered.** The backend-neutral frame, perspective/orthographic projection, camera-view
inversion, hierarchy composition and deterministic reference pixel capture live in
`src/renderer/Scene3D.ts`. `src/renderer/emitWebGL3D.ts` draws indexed triangles with a depth
buffer and maintains an RGBA8/depth framebuffer for object-id picking. The live 3D workspace
loads confined glTF/GLB imports, commits the asset, model and first camera as one undoable
transaction, renders through WebGL and selects nodes through GPU object-id picking. Unit tests pin
camera scaling, hierarchy, front-face winding, depth winner and pick-id encoding; `smoke:3d`
verifies indexed depth rendering and synchronous readback in Electron's real GPU path.

- Render one indexed mesh through the existing GPU backend.
- Add perspective and orthographic cameras, depth buffering and object-id picking.
- Keep selection, hierarchy, inspector and history on existing Canvas Fogworks interfaces.
- Establish pixel captures for camera, depth, winding and lighting correctness.

### 3D-2 — authored scene

**Delivered.** Persisted project-relative mesh sources now rehydrate through confined IPC when a
project is reopened. Missing files are reported per asset without preventing other meshes from
loading, and the Open–Edit–Save Electron smoke waits until a restored mesh reaches the GPU draw
list. Decoded mesh data remains transient and is never serialized into the document. Selected 3D
nodes now expose fixed-screen X/Y/Z translation handles in world or local space; camera-parallel
axes receive a deterministic diagonal handle until orbit controls land. Dragging writes through
`SetSpatial3DAction`, coalesces into undo history, and the Electron smoke verifies serialization.
Color-coded rotation rings compose normalized quaternions in local or world space. Scale handles
operate on local axes and clamp the drag factor above zero, preserving schema validity throughout
the gesture. The live smoke performs and verifies translate, rotate and scale edits.

- Transform gizmos are delivered: translate and rotate support local/world modes; scale is local.
- Import glTF into stable assets and scene entities without flattening hierarchy.
- Material assignment, authored directional/point lights, orbit/pan/dolly camera controls,
  metallic-roughness PBR, base-color/metallic-roughness/normal/emissive texture sampling, two UV
  sets, sampler state, `KHR_texture_transform`, OPAQUE/MASK/BLEND rendering, and authored Radiance
  HDR equirectangular environments are delivered. HDR pixels and their diffuse/GGX prefilters
  remain transient; persisted scene state contains only a texture asset id, project-relative
  source, intensity and rotation.
- Schema 76 explicitly composes a 2D node as a transform-following plane or camera-facing
  billboard with authored pixels-per-unit and lit/unlit behavior.

### 3D-3 — runtime projection

**Baseline delivered.** `core/runtime/World3D.ts` projects authored transforms and box/sphere
colliders into transient bodies, advances them through a bounded 60 Hz accumulator, exposes stable
collision queries, follows the controlled body with the runtime camera, and stamps transforms only
onto a derived render document. Restart, typed-anchor respawn, goal transitions and stable replay
digests have unit coverage and are wired into 3D play mode. Rotated-box SAT and sphere contacts,
bounded CPU skinning and opt-in gravity/restitution are delivered. Destination level meshes,
material textures and HDR environments now stage before runtime publication; failed or late loads
cannot replace the current runtime. Authoring asset libraries remain independent. A pluggable
physics backend, dynamic-body impulses and production character control remain later fidelity work.

Read-only level and asset hydration now lives in `src/runtime`, independent of editor Actions,
with compatibility exports preserving existing editor callers. The subsequent standalone-player
work adds a bounded package export, event/render host and unsigned Windows unpacked executable;
clean-machine acceptance remains open. See [Shared player runtime](PLAYER-RUNTIME.md) and
[Standalone player](STANDALONE-PLAYER.md).

### 3D-4 — production renderer

**Baseline delivered.** Renderer-owned programs, buffers, framebuffers and textures are deleted
eagerly; image uploads are bounded and processed two per frame; context loss is prevented and a
retained frame rebuilds all resources after restoration. Capability reporting exposes float
texture/filtering, index and texture-size support. Source invalidation and clean renderer reload
cover texture/material/shader hot reload; meshes are streamed from the current transient frame and
therefore have clean-load equivalence without a second GPU cache. `smoke:3d` compiles the production
IBL and shadow shaders and exercises recovery/reload in Electron Chromium.
- Profile first; move a workload into Rust only when the result pays for packaging,
  IPC/ABI, debugging and cross-platform complexity.

The authored-HDR path now performs deterministic offline cosine-weighted diffuse convolution and
GGX roughness prefiltering. WebGL 1's guaranteed eight fragment texture units are budgeted as four
material maps, diffuse irradiance, two specular endpoints and one shadow map; roughness interpolates
between the specular endpoints. Unsupported float textures retain the neutral analytic fallback.

## Original implementation gate (completed)

The `3D-0` contract slice established a schema, a minimal fixture, a reversible Action and
round-trip tests without merging the legacy renderer. Continue using those boundaries for later
renderer/runtime work. Current limits and measured priorities are in [PRODUCTION-WORK.md](PRODUCTION-WORK.md).
