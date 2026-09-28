# Original reference projects

These geometric examples and the numerical triangle rig were authored for Canvas Fogworks. They contain no third-party artwork or reference-pack assets.

For larger authoring exercises, start with [the Signal Garden workshop and three-level Signal Relay](authoring-v1/README.md).

- `behavior-graph.vde`: an original 3D interaction graph example using the same triangle assets.
  Select the lever to edit its graph. In Play, F twice spawns collectibles and checkpoints;
  the third interaction wins. See [Behavior graphs](../docs/BEHAVIOR-GRAPHS.md).
  This separately maintained example is not generator output.

- `behavior-timers.vde`: an original schema-81 follow-up. In 3D Play, press F near the lever
  to spawn three collectibles one second apart using a reusable graph, then checkpoint.
  Open the Behavior debugger to watch `timedSpawns`, pause, or break on the `spawn` node.
  Keep the same adjacent triangle assets. Export and save during a delay to resume its remaining
  iterations after reopening. This example is separately maintained, not generator output.

- `visual.vde`: open and export the whole canvas as PNG.
- `game.vde`: Run; move right to the green gate. The player's Authored rules policy and the goal's enter/win rule are editable in Runtime Entity. Export an offline 2D game from the export drawer.
- `animated-3d.vde`: open, switch to the 3D workspace, select the triangle and choose its Right/Up clips and blend in the inspector. Run, or enable timeline preview and scrub. Keep `triangle.gltf` and `triangle.bin` beside the project.
- `gameplay-foundation.vde`: a separately maintained technical 3D example using the same original
  triangle assets. In 3D Play, F near the second triangle spawns a collectible and sets a checkpoint;
  entering the collectible removes it and increments a counter. Export for progress controls.
  See [gameplay foundations](../docs/GAMEPLAY-FOUNDATIONS.md). This example is not generator output.

Regenerate the original baseline and authoring-v1 copies with `npm run examples:create -- <new-folder>`. The command refuses existing folders, so editing an example never makes a subsequent regeneration overwrite your work. Generator source fixtures live in `src/core/examples/`.
