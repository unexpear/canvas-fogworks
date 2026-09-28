# Signal Garden and Signal Relay

Original geometric/pixel artwork generated for Canvas Fogworks; no third-party packs, images, audio or fonts are included. Existing examples elsewhere in the repository are unchanged.

- **pixel-workshop.vde**: a 1280×800 design board with a directly editable 256×256 raster atlas, six-color palette, a three-node component master and 15 overridden instances. Paint the atlas; change the master or individual signals; test undo, Save As, reopen and whole-canvas PNG export.
- **relay-1.vde** through **relay-3.vde**: three 960×540 game levels, each with 68 nodes, eight collectible signals, an optional upper-platform route, a respawn anchor and a gate. Open relay-1 and Run. Use arrows/A,D, Space and Shift. The first two gates load the next project; the third wins. Restart returns to the entry level. Save As to an empty folder or export offline HTML to exercise graph portability.
- **visual.vde**, **game.vde**, **animated-3d.vde**, **triangle.gltf**, **triangle.bin**: small companion regression examples retained by the generator.

Gate volumes have an explicit `level-gate` class and the player uses the Platformer policy: typed goal/transition handling belongs to that policy. Collectibles use authored enter/score/despawn rules. The Authored-only policy intentionally disables compatibility goal handling.

Regenerate into a **new** folder with `npm run examples:create -- <new-folder>`. Existing folders are refused to protect edited projects. Tests compare these project files against the generator and complete all three game stages without changing authored data.
