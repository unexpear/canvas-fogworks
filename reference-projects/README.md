# Original reference projects

These geometric examples and the numerical triangle rig were authored for Canvas Fogworks. They contain no third-party artwork or reference-pack assets.

- `visual.vde`: open and export the whole canvas as PNG.
- `game.vde`: Run; move right to the green gate. The player's Authored rules policy and the goal's enter/win rule are editable in Runtime Entity. Export an offline 2D game from the export drawer.
- `animated-3d.vde`: open, switch to the 3D workspace, select the triangle and choose its Right/Up clips and blend in the inspector. Run, or enable timeline preview and scrub. Keep `triangle.gltf` and `triangle.bin` beside the project.

Regenerate fresh copies with `npm run examples:create -- <new-folder>`. The command refuses existing folders, so editing an example never makes a subsequent regeneration overwrite your work. Maintained source fixtures live in `src/core/examples/`.
