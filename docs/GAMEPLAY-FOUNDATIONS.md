# Reusable gameplay foundations

Schema 80 follow-up (2026-09-16): [Behavior graphs](BEHAVIOR-GRAPHS.md) now author event/condition/
action paths through the same 2D/3D commands. Schema 81 adds delays/repeats, reusable graph assets
and debugging; general behavior lifecycle remains open. Player-progress v2 retains pending graph
continuations and accepts v1 saves without them.

<!-- describes: src/core/document/Gameplay.ts, src/core/runtime/InputActions.ts, src/core/runtime/Interaction.ts, src/core/runtime/GameplaySession.ts, src/core/runtime/Gameplay3D.ts, src/core/runtime/World3D.ts, src/runtime/PlayerProgress.ts, src/runtime/CampaignProgress.ts, src/runtime/PlayerSession3D.ts, src/player3d, src/player, src/app/GameplayPanel.tsx -->
<!-- re-read 2026-10-04: schema 90 stores the migration list on the document. Player-progress formats are unchanged. Full prefabs remain open. -->
<!-- re-read 2026-10-02: explicit save-build maps and progress-writer kill checks are described above. Schema 89 and progress v1–v6 records are unchanged. -->

Implemented 2026-09-12 as the first bounded Q06 slice. These features serve both 2D and 3D;
they do not replace the physics solver or constitute a general scripting/component framework.
App version remains 0.0.5. Document schema **79** adds optional `interact` events, interaction
`range`, template `spawn` and `checkpoint` actions. Migration 78→79 does not inject rules or
change existing entity values. Older readers reject new schema files instead of misreading them.

## Author and try it

The existing Entity gameplay panel now exposes:

- **interact** events: press F near the nearest eligible target in editor Play or either player.
  Range defaults to 96 document units in 2D or 2 world units in 3D; set it per rule when needed.
  Equal-distance targets use stable node-ID order. Hidden/despawned targets do not interact.
- **spawn**: name a template node ID. A copy appears at the rule's self/other target position.
  Use a leaf node; groups/subtrees are not prefab instances in this foundation. 3D camera/light/
  environment templates are refused. Authored spawning is bounded to 256 instances per level run.
  IDs are deterministic and cannot replace authored nodes. Hidden 3D templates neither render
  nor enter initial physics; their spawned instances become visible and receive runtime bodies.
- **despawn**: removes a runtime actor without changing the project. The active 3D camera is
  protected; a despawned 3D subtree loses its runtime bodies and presentation.
- **checkpoint**: records the controlled player's position. Respawn returns there, clears motion
  and terminal/transition state, and keeps that level's counters, spawns and removals. Existing
  authored respawn anchors remain the fallback when no checkpoint has been set.

The [original demo](../reference-projects/gameplay-foundation.vde) uses the existing owned
`triangle.gltf` and `triangle.bin` beside it. Open it, enter 3D Play, press F near the second
triangle to spawn a collectible and set a checkpoint, then move into the collectible to despawn
it and increment its counter. Export it to use the dedicated progress controls. The hidden template
remains editable in the project. This is a technical example, not a completed game.

3D now executes the existing start/contact/enter/leave/separate rules, with win/lose, counters,
despawn and X/Y velocity commands alongside the new actions. Contacts mean collider overlap,
not a complete rigid-body collision-event API. Interaction does not require a collider or line
of sight. The 3D audio action remains unsupported and is reported in runtime diagnostics.
Spawned actors do not receive a separate start-event lifecycle yet.

## Named input actions

`InputActions` maps host key codes to named actions and exposes held, consume-once pressed/released
edges, opposing-key axes, clear and validated rebind operations. Aliased keys count as one action;
repeated keydown does not trigger another interaction. Clearing or rebinding drops held keys and
pending edges. Both standalone players and editor Play read it. Editor shortcuts still win when
the key is not bound, a text field is focused, or Ctrl, Alt or Command is held.

The default actions include movement, jump, run and interact. Editor Play and both standalone
players share a Controls panel that lists those actions, captures the next physical key, and
refuses to remove an action's last key. Version 1 bindings are stored in the host's
`localStorage` under `canvas-fogworks.input-settings.v1`, outside the document schema. Malformed
or newer payloads are ignored and the built-in bindings stay in effect. Rebinding and focus loss
clear held keys. ArrowUp remains on both Move forward and Jump; the panel names that overlap
instead of silently splitting it. Editor Play uses these same named actions, so W is Move forward
in 3D and is not an extra 2D jump key. Gamepads, touch and per-game action assets remain later work.
Physical `KeyboardEvent.code` bindings follow key position, not the printed character on every
keyboard layout; see [browser key-code behavior](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code).

## Checkpoint progress, not editor saves

Exported players provide **Set checkpoint**, **Respawn**, **Save progress**, and **Load progress**.
Saves retain the current level key, player checkpoint (or current position if none is set), template
instances and their positions, despawned IDs and counters. 2D also retains player power and changed
tile cells. A fresh simulation is constructed on restore; velocities, contacts, animation clocks,
temporary invincibility and other actors' arbitrary mid-frame state reset. Start rules do not replay
and duplicate previously saved effects. Player-progress v6 also retains other visited levels and
game-scoped values. Leaving a level stores that level's actors, entity values, counters and waiting
graphs, and lifts game-scoped values into one campaign table. Entering a level already visited
restores that snapshot instead of replaying start events; a new level starts fresh but can read the
carried game values when it declares the same name and type. A declaration that is missing or a
different type on one level does not erase the campaign value. Restart and a new editor Play clear
the campaign. A run that never leaves its level still saves as v5. At most 32 levels are remembered,
matching the linked-level package cap. Entity-local values stay on their level. Prefab instances
are not part of this snapshot.

The save format has its own version and profile (`2d`/`3d`), and is tied to the package-content
SHA-256 hash. Changed package content gets a different slot. A later build adopts an older slot
only when that build names the previous hash and the save's progress version in an explicit list
of at most eight entries. Progress v1–v6 still load for the same hash; accepting an older format
does not accept a different build. The adopted record is rewritten to the current hash in memory.
The previous slot file is left in place, and the current slot is written when the player saves,
not when the older slot is loaded. A current slot that exists is used even if a predecessor also
exists. A corrupt current slot is not replaced by an older build. This hash is not an executable
signature or a compatibility promise across engine changes.
Malformed, oversized, wrong-game/profile, duplicate-ID, missing-template, unknown-level and invalid
position/reference data are refused before adoption. Save size is capped at 2MiB; instance, counter,
despawn and cell tables are bounded. Saves contain IDs/primitive state, not serialized project nodes,
scripts, filesystem paths or arbitrary resource requests.

The 3D session stages saved-level assets and world construction before replacing the current world.
Failed restore retains the prior state; Stop/Restart invalidate pending restores. Restore leaves
the 3D player paused for explicit Resume. Progress errors are visible in a separate status area.
2D restore similarly validates a fresh world before replacing the active level and then resumes.

Desktop players have a new, narrow preload with only `playerProgress.read()` and `.write(content)`.
The main process verifies the owning main frame and game URL, and selects a hash-named save slot
under the app's user-data `player-progress` directory. The renderer cannot choose a path, game ID
or IPC channel. Writes use the existing flushed-temporary-file/atomic-rename helper, which also flushes the
parent directory when the platform allows it. Failed writes do not deliberately truncate the
previous slot. This is not a power-loss durability guarantee.
The sandbox, context isolation, navigation/network denial and absence of editor APIs remain.
This follows [Electron's per-operation bridge guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation#security-considerations).

Browser HTML exports use a namespaced localStorage slot and report quota/permission errors.
Persistence for `file:` URLs is browser-dependent, and private browsing/clearing site data can
remove it; it is **not** the desktop save-file guarantee. See [localStorage limitations](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage).
Portable save-file import/export, multiple slots, backups and cloud saves remain future work.

## Verification and boundaries

Unit tests cover input edges/rebinding, rule validation/migration and Action-backed DOM authoring,
interaction ranges, template IDs/caps, despawn/respawn, hidden 3D presentation, save encoding/bounds,
references, staged restore cancellation and fresh native-slot reads/write refusal.
`smoke:player` now exercises real IPC-backed saving, closes and reopens the player window, restores
the second level with its spawned mesh, and refuses a corrupted save without losing the active level.
Existing 2D export and editor lifecycle smokes remain regression gates.

Verification on 2026-09-12: **2,287 Jest tests across 48 suites**, typecheck, module headers,
build and file-workflow/level/authoring/player smokes pass. A new unsigned Windows build of the
owned demo at `release/gameplay-foundation-20260912/desktop/win-unpacked/` also passes the
actual executable startup smoke. These are host-machine results, not clean-machine certification.

Embedded 3D sound cues now play through the same bounded Web Audio path as 2D. Streaming, buses and
reusable audio assets remain [AUDIO-001](BACKLOG.json). Explicit cross-build adoption is covered by
`SaveMigration` tests. `npm run test:progress-crash` kills the progress writer and reads the last
committed slot in a fresh process; it is not a power-loss proof or a GUI renderer crash.
The inspector authors the migration list on the document (schema 90). Still open in Q06/F2: full prefab instances, richer
character/physics semantics and portable/browser save UX. The progress record did not gain fields.
The 3D package keeps version 1 and its optional `saveMigrations` field, following the same optional-field rule as `fonts`.
F1 clean-machine certification is also still open. Existing installers/assets are retained.
