# Behavior graphs

Active five-part follow-up (2026-09-19): schema **88**, graph v5 and player-progress v5 are now
under development. Lifecycle/custom events, typed entity/game values, assignment/comparison nodes,
inspector declarations and debugger watches extend the earlier baseline below. Reusable function
libraries persist and execute through both runtimes, including nested saved calls and debugger
frames. Root calls and reusable function definitions are editable in the inspector. Cross-level
shared state remains pending.
See [the active delivery goal](GAMEPLAY-FIVE-PART-GOAL.md) for current progress
and remaining verification; the five-part goal is not complete.

<!-- describes: src/core/document/BehaviorGraph.ts, src/core/document/Entity.ts, src/core/runtime/BehaviorRunner.ts, src/core/runtime/BehaviorRuntime.ts, src/core/runtime/BehaviorProgress.ts, src/core/document/BehaviorAssets.ts, src/core/actions/SetBehaviorAssetsAction.ts, src/app/BehaviorDebugPanel.tsx, src/runtime/PlayerProgress.ts, src/core/runtime/GameplaySession.ts, src/core/runtime/Gameplay3D.ts, src/core/runtime/Interaction.ts, src/core/runtime/World.ts, src/app/BehaviorGraphPanel.tsx, src/app/GameplayPanel.tsx, scripts/smoke-behavior.js -->

Delivered 2026-09-16: the first event-driven visual logic system for both 2D and 3D gameplay.
Updated 2026-09-19: simulation-time delays, bounded repeats, reusable project graph assets and an editor debugger are implemented; verification is recorded below.
The earlier baseline below used app 0.0.5 and schema **81**. This is a bounded subset of ENG-04/Q06.

## Typed gameplay data (active schema-83 addition)

In the Runtime Entity inspector, use **Project gameplay variables** to declare a name, scope,
type and default. Entity scope gives each actor its own value; game scope shares one value among
actors in the current level. Neither scope changes design tokens or authored defaults during play.
Game values do not yet carry between levels. Names begin with a letter and use up to 64 letters,
digits, underscores or hyphens. There are at most 256 declarations; the same name may exist in
both scopes. Defaults and assignments must match the declared number, boolean or string type.

Add an assignment node to set a literal or copy another declared value. Numeric fields additionally
support add/subtract/multiply/divide. Add a comparison node to route equal/not-equal values, or
ordered numeric comparisons, to separate paths. Link the nodes into an event path as usual.
Changing an operand's type resets the opposite operand to a compatible default; it does not
silently convert values. The inspector refuses declaration changes that invalidate existing graphs.
Edits participate in undo/redo and project save/reopen.

Runtime numbers are finite and bounded to ±1,000,000,000; strings are at most 4,096 characters.
Division by zero or overflow cancels that graph execution with a diagnostic, preserving earlier
successful assignments and allowing other jobs to continue. The debugger shows declared values
and defaults. Pause freezes execution; single-step executes one node without changing the previous
runtime snapshot. Player-progress v4 saves values alongside timers/repeats; older saves use defaults.
Removed actors retain their typed values for pending cleanup callbacks and saved continuation.
Restart creates a fresh run.

## Function calls (active schema-85 addition)

Projects with an existing `behaviorFunctions` library expose **Add call node** in the graph
inspector. Select the function, edit typed literal/variable inputs and choose a matching gameplay
field for each output. Each output needs a distinct destination. Inputs are captured when the call
starts; outputs are adopted together when it returns. Actor instances and nested invocations have
independent locals.

Open **Reusable functions** in the Gameplay inspector and choose **New function**. Add typed
inputs, outputs and locals, select nodes in the visual preview, and edit their parameters and
connections. Set the entry node and provide return sources for each output. The editor supports
local/gameplay assignments, comparisons, counter/player branches, delays, repeats, actions,
custom sends and nested calls. Nested outputs can target caller locals or gameplay fields.

Definition edits remain drafts until **Apply function draft** succeeds. Apply validates the whole
library and all graph callers, then records one undoable Action. **Discard function draft** reloads
the saved version. Invalid cycles, signatures, missing references and external-edit conflicts
leave the saved project unchanged. Apply or discard before switching functions. Incompatible
signature edits require first removing or repairing dependent calls; they are never rewritten
silently. Function IDs are stable, while their display names are editable. Apply drafts before
changing selected actors or closing the project: unapplied editor drafts are not project data.

Calls use the same 1,024-instruction dispatch and 10,000-instruction job limits as other graphs,
with at most 16 nested calls and 8 nested repeats per call. Recursion is refused by validation.
Waits use simulation time; pause freezes them and single-step advances one ready instruction.
The debugger offers `functionId/nodeId` breakpoints, qualified traces and input/local frame watches.
Changing the function library cancels pending calls. Removed-actor functions cannot execute
body-targeting commands. Saves store only bounded typed frames, not executable definitions;
restoration checks signatures and call sites against the project. See the delivery goal for
remaining cross-level and final-game work.

## Use it

Select an entity, open its Runtime Entity inspector, and choose **Add behavior graph** under
Gameplay rules. The starter increments the `uses` counter on interaction, then chooses a
checkpoint or victory depending on whether the counter has reached three.

Select a node in the visual preview. Edit its event, condition or action, then connect its
**next**, **true** or **false** output using the destination selector. **End** leaves the output
unconnected. Add event, branch, action, delay and repeat nodes as needed. Connections point toward the next
node; true branches are green and false branches orange. Invalid connections show an error
and retain the last valid graph. Removing a node clears incoming links in the same undo step.
Enable/disable and remove-graph controls also use the existing entity Action and undo history.
The preview uses automatic vertical placement; dragging wires/nodes and a separate graph canvas
are not implemented in this slice.

The owned [behavior-graph.vde example](../reference-projects/behavior-graph.vde) uses the existing
`triangle.gltf` and `triangle.bin` beside it. Open it in 3D, select the lever to inspect its graph,
then Play. Press and release F near the second triangle: the first two interactions spawn a
collectible and checkpoint; the third wins. Export the project to exercise the same graph in
the standalone player. The earlier gameplay example remains available.

## Nodes and execution

| Node | Behavior |
|---|---|
| Event | start, enter, leave, contact, separate or interact; any actor or Player; optional interaction range |
| Branch | Other actor is Player, or a named counter is at least an integer threshold |
| Action | checkpoint, score, spawn, despawn, velocity, win or lose; self/other targets where applicable |
| Delay | Wait 1/60–3600 simulation seconds, then follow next |
| Repeat | Execute body 1–100 times; each End in the body returns to the repeat; next runs after all iterations |

An event follows one connected path. An action emits a request and continues to its next node;
a branch follows only the selected output. Multiple matching event entries run in authored array
order. Shared downstream nodes can run once for each matching entry. Unconnected nodes remain
editable but never execute. A start event has no other actor, so body-targeting `other` actions
have no target on that event.

The resumable scheduler returns existing gameplay requests and transient continuations. It has no
host, network, filesystem, wall-clock timer or script-evaluation interface. The older pure runner
remains a v1 synchronous preview and explicitly refuses delay/repeat nodes.
The 2D and 3D adapters use their existing command paths. Existing rule requests precede graph
requests; their semantics and the player's platformer/authored policy are retained.

Legacy commands are applied before each graph dispatch. Conditions see those committed counters;
score requests earlier in the scheduler dispatch also update its private counter view. Other pending
commands are not simulated as queries. Existing jobs precede newly queued events; event entries
retain authored array order. Physics-event generation/order remains specific to each engine.
3D's existing 256-counter-key limit also applies to its graph counter view.

Graph-only interact entries participate in nearest-target selection. Graph-only 2D enter/leave
entries register trigger regions, and 3D graph owners participate in overlap-event detection.
Hidden graph owners do not interact; hidden 2D owners do not execute graphs. The existing 3D
world projection excludes hidden subtrees. Contact/overlap semantics, dynamic-body requirements,
spawn limits and active-camera protection remain those of the underlying runtime.

Start entries run once at level start. Restored progress suppresses replay of start effects and
restores counters used by subsequent branches. Player-progress v2 saves pending cursors, remaining
delay durations and repeat stacks, but never graph code, traces, pause state or breakpoints. V1 saves
still load with an empty queue. Invalid continuations or references fail before world adoption.
Package-content hashes still separate saves
from different exported content. Spawned actors do not gain a separate start lifecycle in this slice.

## Stored contract and limits

`Entity.behavior` is optional and contains `{version: 1 | 2, enabled: boolean, nodes: [...]}`.
Delay/repeat nodes require graph version 2; adding them upgrades the graph. Alternatively an entity
stores `behaviorAssetId`, referencing the document's optional `behaviorAssets` table (max 128 named
entries). Inline graph and asset reference are mutually exclusive; missing references are refused.
Node IDs are unique, 1–64 characters, beginning with a letter and containing only letters,
digits, underscores and hyphens. Links contain a node ID or explicit `null`.

Graphs allow at most 64 nodes and 16 event entries. All destinations must exist; links cannot
enter event nodes. Cycles are rejected even in disconnected/disabled graph portions. Commands,
conditions and numeric bounds are validated on load and through the entity Action. Unknown
graph/node/action fields are refused. Invalid runtime graphs emit no graph commands and return
a diagnostic. The debugger displays the last 8 errors. Execution allows 256 pending jobs,
1,024 instructions per dispatch (excess work yields), 10,000 instructions per job (then cancellation),
and 8 nested repeat frames. Input events are capped at 4,096 per dispatch. Traces retain the last
128 instructions; breakpoints are capped at 64. This is not a whole-scene performance guarantee.

Migration 79→80 introduced graphs; 80→81 preserves old graphs without injecting assets or timers.
Existing documents retain their rules. Older readers reject schema 81.
No changes to document history occur during gameplay; transient commands update the runtime world.

## Reuse, timing and debugging

Try [behavior-timers.vde](../reference-projects/behavior-timers.vde): interact with its lever in
3D Play to spawn three collectibles, one second apart, then checkpoint. Its reusable graph is
editable in the inspector; `timedSpawns` appears in debugger watches. Existing examples remain intact.

Use **Save as reusable graph** to promote an inline graph and bind its entity in one undoable edit.
Other entities choose it from **Reusable graph**. Editing a bound graph updates every reference;
**Detach local copy** makes an independent graph. Asset names can be edited. Table edits and bindings
round-trip in project saves and exports; referenced assets cannot be deleted through the Action.
These are project assets, not callable subgraphs or a cross-project library manager.

Delays advance only with fixed simulation ticks, never wall-clock catch-up. A repeat body may include
delays and nested repeats; arbitrary cyclic wires remain invalid. Interaction range is tested when
the event starts, not again after a delay. Restart/Stop/level replacement discard pending work.
Checkpoint respawn preserves continuations for surviving actors; missing/hidden/despawned owners
or actors cancel pending jobs on dispatch. Changed/disabled graphs also cancel their pending work.
Spawned actors still have no separate start event. Ended runs do not resume timers.

During Play, open **Behavior debugger** above the status bar. Enable recording to inspect node traces,
counter watches and pending jobs. Select an entity and node to toggle a breakpoint. A breakpoint
stops before its instruction and pauses simulation. **Step instruction** executes one ready node
without advancing physics/time; if all jobs are waiting, use **Continue behaviors** to advance time.
Continue skips the exact breakpoint just stopped at once. Pause is runtime-only: it adds no undo entry.
Debugging state is neither saved in documents nor restored from player progress.

## Verification and remaining work

2026-09-19 verification: **2,326 Jest tests across 52 suites** pass, together with typecheck,
module-header lint and the production build. Real Electron checks pass for graph editing
(delay/repeat nodes and shared-asset promotion/detach), Open–Edit–Save, 2D authoring/export,
and exported 3D shared timers/repeats saved during a delay and resumed in a fresh player window.
The 3D continuation smoke waits for rendered simulation frames rather than wall-clock sleeps;
saving intentionally pauses the player. Schema stamps and semantic documentation checks agree
with schema 81. The remaining documentation-gate failures are commit-history baseline flags.
No commit, push, history rewrite, installer replacement or asset deletion is part of this slice.

On 2026-09-16, typecheck, module-header lint, build, **2,310 Jest tests across 50 suites**, and
Open–Edit–Save, authoring, standalone-player and graph-authoring Electron smokes passed.
Tests cover malformed graphs, cycles, missing links, bounds, both branch outcomes, score ordering,
graph-only triggers/interactions in 2D/3D, authoring immutability, save migration/restore and undo.
The real graph-authoring smoke checks visual connections, cycle refusal and serialized reload;
the panel screenshot was inspected. The existing player smokes now use graph-driven 2D victory
and 3D interaction/spawn/checkpoint paths, while the three-level 2D relay retains legacy-rule coverage.

Run `npm run smoke:behavior` for the graph editor check. Optional `FOGWORKS_GRAPH_SCREENSHOT`
names a PNG output path. CI includes this check alongside the player and authoring smokes.
The history-based documentation gate still requires a committed documentation baseline; this
implementation does not bypass it or create a commit.

The unsigned Windows example at `release/behavior-graph-20260916/desktop/win-unpacked/` also
passes the actual executable startup smoke. Distribute that entire folder together; the EXE
depends on its adjacent runtime files. Existing builds remain available.

Current follow-up tests cover delay/repeat parity in both runtimes, v1/v2 progress, continuation
validation, breakpoint/step/pause semantics, cancellation, bounded queues/execution and asset undo.
The graph-authoring smoke also exercises delay/repeat authoring and shared-asset promotion/detach.

Further ENG-04/Q06 work: recurring update and spawned-entity lifecycle events,
variables beyond shared counters, callable graph functions and cross-project asset management,
script/graph equivalence and a freeform wiring canvas. General NPC behavior trees, full prefabs,
cross-level state, save migrations and crash/relaunch acceptance remain separate work.

Implementation references: [React immutable array updates](https://react.dev/learn/updating-arrays-in-state),
[React useId](https://react.dev/reference/react/useId),
[TypeScript discriminated unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions),
and [Electron webContents](https://www.electronjs.org/docs/latest/api/web-contents).
