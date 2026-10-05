# Inline game package v1 — manifest and read-only resolver

<!-- describes: src/runtime/GamePackage.ts, src/runtime/PackageProfile.ts, src/runtime/GamePackage.test.ts, src/runtime/RuntimeBoundary.test.ts, src/runtime/WorldPartition.ts, src/runtime/worldPartitionTable.js, scripts/smoke-level-transition.js -->
<!-- re-read 2026-10-04: optional worldPartition names streamed cells. Package version stays 1.
     A missing cell table is not world-partition streaming. The 32 MiB payload budget is unchanged. -->
<!-- re-read 2026-10-02: optional saveMigrations names previous content hashes. Package version stays 1.
     buffer, image and HDR files may be streamed by hash; models and fonts stay inline. -->

Implemented 2026-09-12 as the bounded Q03 format/resolver slice of the
[engine roadmap](ENGINE-ROADMAP.md). This is a new runtime package format, separate from
the document schema (78 at introduction, now 80) and the existing offline 2D HTML package.
The format itself does not change saved projects or existing exports. The follow-up adds a separate editor export endpoint, package writer, standalone
player UI, embedded-payload checksum and unsigned Windows unpacked build. See
[Standalone player](STANDALONE-PLAYER.md) for commands, verification and remaining release gates.

## API and ownership

`createPackageReader(serialized)` validates JSON and returns a frozen read-only host plus
`entryKey`, suitable for `new PlayerSession3D(reader, reader.entryKey)`. It retains private Maps
and strings, exposes no parsed manifest or mutable file buffers, and performs no filesystem,
network, shell or IPC operations. It is synchronous and bounded; a production host should perform
large-package validation away from latency-sensitive interaction and report errors before play.

The writer must assemble serialized levels and explicit resources; the resolver does not scan
directories, copy asset packs, repair references, download URLs or infer redistribution rights.
The original level smoke assembles only its original relocated fixtures. The follow-up standalone
smoke exercises the real writer/export command with original fixtures instead.

## Required manifest fields

Unknown fields are refused in the v1 envelope and its level/link/resource/file records.

| Field | Contract |
|---|---|
| `format` | Exactly `canvas-fogworks-game` |
| `version` | Numeric `1`; unsupported versions are refused |
| `entry` | ID of the sole allowed initial entry level |
| `requiredCapabilities` | Exactly `["spatial3d-v1"]` in this implementation |
| `levels` | Array of `{ id, content, links, resources }` |
| `files` | Inline `{ id, kind, bytes, data }` or, for `buffer`/`image`/`hdr` only, streamed `{ id, kind, bytes, sha256 }` |
| `fonts` | Optional array of `{ family, weight, italic, file }`. Absent means no custom faces |
| `saveMigrations` | Optional array of `{ fromGameId, versions }`, at most eight. `fromGameId` is a previous package-content SHA-256. `versions` lists progress format versions 1–6 that this build may adopt from that hash. Absent or empty means no cross-build adoption. Package version stays 1. Older readers that refuse unknown fields reject a package that includes this array |
| `worldPartition` | Optional `{ anchor, loadRadius, unloadRadius, cells }`. Each cell is `{ id, min, max, file }` and `file` must be a streamed `buffer`, `image` or `hdr` payload. `anchor` names one cell that stays the playable core. `unloadRadius` is at least `loadRadius`. Absent means the package is not world-partition streamed. Models and fonts stay inline. Older readers that refuse unknown fields reject a package that includes this object |

IDs contain lowercase ASCII letters, digits, `_` and `-`, start with a letter/digit and are at
most 64 characters. Reserved prototype names are refused. Duplicate level/file IDs are errors.
IDs are package keys, not filesystem paths. Authored asset IDs remain unchanged within documents.

Each level contains:

- `content`: a serialized project string accepted by the current document deserializer, with
  at least one 3D camera. A dynamic Player is not mandatory for an animation-only scene.
- `links`: `{ target, level }` records mapping authored relative transition targets to level IDs.
  Every typed node transition must be mapped; dangling, extra and duplicate/aliased links fail.
- `resources`: `{ path, file }` records mapping level-relative model/environment/sidecar names
  to file IDs. Different levels and source names can share the same payload file ID.

Each file contains:

- `kind`: `gltf`, `glb`, `hdr`, `buffer`, `image` or `font`.
- `bytes`: exact nonnegative decoded-byte count, within the per-file limit.
- `data`: canonical padded standard base64 for an inline file. Whitespace, URL-safe variants,
  missing padding, invalid characters and nonzero unused padding bits are refused.
- `sha256`: lowercase hex digest of the raw bytes, used instead of `data` when a `buffer`,
  `image` or `hdr` payload is streamed. glTF/GLB JSON and font files cannot use this form.
  A streamed package requires a host stream source; the reader does not open files or the network
  itself, and it does not keep the decoded chunk after the read returns.

All declared levels must be reachable from the entry; cycles, including return links, are allowed.
All declared resources and payload files must be used by the validated asset/dependency graph.
This prevents accidentally including unrelated content. It is not a license/provenance assessment.

## Namespace and allowed reads

Paths are resolved only within a virtual per-level namespace:

- `/` separates segments. Unicode NFC normalization and lowercase comparison define this
  format's alias behavior on every platform; they are not a filesystem identity algorithm.
- `.` is collapsed; `..` may move within the level namespace but cannot escape its root.
- Empty segments, absolute paths, backslashes, drive/scheme separators, query/fragment
  characters, controls, trailing spaces/dots and common Windows device names are refused.
- glTF sidecar URIs are percent-decoded exactly once, relative to the model's parent directory.
  A remaining `%` is refused. Declared resource names are plain paths, not URI-encoded paths.
- Duplicate resource/link paths after normalization are refused, including case aliases.
  References using a different capitalization resolve to the single declared entry.

The resulting host permits:

| Read | Authority |
|---|---|
| `readEntryFile` | Only the configured entry ID |
| `readProgressLevel` | Only a known level ID in the validated package; used for progress restore |
| `readLevelFile` | A known current level and one of its declared target mappings |
| `readProject3DFile` | A model payload mapped by that level, with glTF/GLB kind |
| `readProjectEnvironmentFile` | An HDR payload mapped by that level |
| `readProject3DSidecar` | A declared model and a level-local resource of image/buffer kind |

Sidecar authority is level-scoped, not private to each individual model: a model can request
an allowed image/buffer resource of that same level. No request falls through to disk or network.
There is no assumption that knowing a resource name grants access outside this manifest.

## Dependency and image validation

The reader deserializes every level and checks typed mesh/material/environment asset IDs.
Model asset sources must be `.gltf` or `.glb`; material sources must use the existing
`#material-N` convention; texture asset records must refer to `.hdr` environments.
Named sources must map to resources of the correct kind.

glTF JSON and the existing GLB parser expose buffer/image URI dependencies. External sidecars
must be declared resources. Embedded model buffers accept base64 octet-stream/gltf-buffer data;
embedded model images accept PNG/JPEG/WebP. Sources using network URLs or unsupported embedded
types fail at package validation. Existing mesh/motion/HDR validation and renderer capability
limits still apply during hydration and frame construction.

Ordinary scene image `src` fields, including nested node/tileset fields, must already contain
embedded PNG/JPEG/WebP/GIF base64. Relative/network images are not silently fetched. `userData`
is treated as metadata, not a dependency instruction. Image embedding remains the writer's job.
Custom font families used by packaged text are embedded as `font` files when the exporter is given a font directory or the editor's registered faces. Generic CSS families need no file. A missing, conflicting or unused face fails the package by name. SVG image payloads and unsupported required glTF extensions also fail by name. Embedded sound cues play in the packaged player. Screen-space 2D text is drawn over the 3D view. Morph targets, non-triangle primitives and text that carries a 3D transform (it is not projected as glyphs) remain warnings on the reader, not silent omissions.

The `spatial3d-v1` marker identifies this bounded reader/player profile. It is not a claim of
full glTF support, complete game-rule/audio support, render parity on every GPU or general engine
feature compatibility. Future profile extensions must define their own compatibility gates.

## Limits

| Resource | Bound |
|---|---:|
| Serialized package | 64 MiB UTF-8 |
| Serialized level | 20,000,000 UTF-8 bytes |
| Payload file | 16 MiB decoded |
| Sum of unique payload files | 32 MiB decoded |
| Levels | 32 |
| Files | 4,096 |
| Resource mappings across all levels | 4,096 |
| Transition mappings per level | 32 |
| Model buffer/image table | 4,096 entries each |
| Namespace path / ID | 4,096 / 64 characters |
| Scene image field traversal | 1,000,000 visited properties per level |

Text sizes use UTF-8 bytes, not JavaScript character counts. Nested embedded data is additionally
bounded by its enclosing serialized level/model and the inline decode limit. The 32 MiB payload
sum is not a bound on total decoded scene images, GPU residency or JavaScript heap. JSON parsing,
base64 validation, temporary byte arrays, hydrated geometry and repeated per-level uses add memory.
Declared stream sizes count toward the same 16 MiB file and 32 MiB sum limits. Moving those bytes
out of the JSON does not raise the limits, and it is not music streaming. A `worldPartition` block
is separate: it names cells whose streamed payloads a caller can load and release around a focus.
The anchor stays resident when a neighbor fails or is cancelled. Residency cannot exceed the same
32 MiB sum. The packaged player validates the block and does not move the focus from the camera.

Byte counts and strict encoding catch malformed/truncated payloads but are **not cryptographic
integrity or authenticity**. A same-length malicious edit can still be structurally valid.
The standalone HTML writer adds a SHA-256 digest over the entire embedded manifest, checked
before play; that digest detects accidental damage and does not provide authenticity. The exporter
also writes an unsigned provenance record (`game.provenance.json`, and the same object inside the
HTML) listing the app version, optional source revision, manifest hash, per-file hashes, whether
each file is `inline` or `stream`, packaged faces and profile warnings. It contains no host paths
and is not a signature. Anonymous unsigned distribution is retained. Trusted updates remain separate work.

## Verification and remaining work

[Package tests](../src/runtime/GamePackage.test.ts) cover glTF and GLB player integration,
entry/return cycles, parent/encoded sidecars, unsafe paths, aliases, wrong kinds, missing/unused
dependencies, malformed base64, unsupported versions/capabilities and text/file/aggregate bounds.
The browser bundle check refuses editor, Action, React, Electron and external dependencies.
The real Electron level smoke loads the package reader with mesh/binary/PNG/HDR payloads and
drives the player through frame submission, pause, restart and Stop. It reports `packageReader: true`.

Verification on 2026-09-12: all 2,240 Jest tests across 44 suites, typecheck, module headers,
build and rebuilt Open–Edit–Save/level/authoring Electron smokes passed. Package-specific tests
account for 49 cases. Documentation links, backlog JSON and whitespace checks passed. The
history-based doc gate still reports uncommitted ENGINE-ROADMAP/GAME-PACKAGE/PLAYER-RUNTIME
and the existing FEATURE-AUDIT/PLANNED-FIXES history flags. No commit, push, installer rebuild
or clean-machine standalone-game certification was performed.

Follow-up delivery: the explicit package writer/export path, dedicated event/render host and
unsigned executable packaging are implemented; see [Standalone player](STANDALONE-PLAYER.md).
`npm run smoke:player-acceptance` is the clean-profile gate: it deletes the source project and font
directory before launching the packaged HTML, then checks WebGL, the packaged face, drawn overlay
text and one played embedded cue. Package tests also drive a level transition that reads a streamed
chunk and keep the current level when that chunk's hash does not match. `npm run check:player-exe-evidence`
scores a clean-machine unpacked EXE record and writes an operator plan; with no file it exits 2,
and that exit is not a pass. No clean-machine result is recorded here. `check:package-signature`
accepts a detached signature only when a certificate, publisher, signature and matching trust
anchor are all supplied. A missing certificate or publisher exits 2 and is not a pass. The exporter
still writes `publisher`, `signature` and `certificate` as null. `check:world-partition` exits 2
when the package has no cell table; that exit is not a pass. No release certificate or publisher
identity is recorded here. The complete F1 gate remains open. Do not mark F1 complete on this
smoke alone.

Encoding behavior was checked against [TextEncoder](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder/encode)
and [base64 byte conversion](https://developer.mozilla.org/en-US/docs/Web/API/Window/btoa).
The existing glTF reader and owned GLB test follow the
[Khronos glTF/GLB specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
