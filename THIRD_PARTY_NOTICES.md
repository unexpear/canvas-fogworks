# Third-party notices

This file records work by others that VDE draws on, and the terms it comes under. It exists so
credit is a standing practice rather than something remembered at release time.

**Nothing listed here has had its source code copied into `src/`.** Everything in this project is
written from measured files and published specifications. The distinction matters: a file format is
not copyrightable and an implementation is, so reading a `.tmx` and writing a reader from what the
bytes say carries no obligation, while pasting someone's parser does.

If that ever changes — if code is taken from any project below — its full copyright notice and
licence text must be reproduced here, verbatim, before the change ships. That is the whole of the
MIT obligation and it is not onerous.

---

## Tiled Map Editor — GPL v2.0

Copyright Thorbjørn Lindeijer and contributors. <https://www.mapeditor.org/>

VDE reads `.tmx` and `.tsx` files. **The reader was written from the file format**, by measuring the
20 maps and 13 tilesets in a real asset pack — which is how the image-collection tilesets, the
single-quoted attributes and the `<tileoffset>` were found at all.

**This one is not permissive.** GPL v2 is share-alike: distributing modified or unmodified Tiled
source obliges the distributor to the same terms. Taking code from Tiled would therefore oblige VDE
to GPL. We have not, and should not without deciding that deliberately.

## Pixelorama — MIT (code)

Copyright Orama Interactive and contributors. <https://github.com/Orama-Interactive/Pixelorama>

Used as a **specification for the pixel-art feature set**, not as a source of code. Its shipped data
was measured to learn three things VDE's brush model lacked: that a brush is an image stamp rather
than a shape, that brushes are not necessarily square, and that a `~` filename prefix denotes random
variants of one brush. Its palette files were measured to learn that a palette carries a grid
layout, not merely a list of colours.

The project states MIT for its code. **No separate licence is stated for its bundled brushes and
palettes**, so those files are treated as unlicensed for redistribution: the FORMAT is the finding,
and none of the data is shipped.

## Material Maker — MIT (code), CC0 (assets)

Copyright RodZilla and contributors. <https://github.com/RodZill4/material-maker>

Its node graphs were read to check VDE's gaussian blur against another implementation. Two design
choices were independently confirmed — separable per-axis passes, and normalising by the accumulated
weight sum rather than an analytic constant.

**One genuinely useful fact came from it**: its blur loops a fixed `-50..50` regardless of sigma,
which is not a shortcut but a GLSL ES 1.00 constraint showing through — a uniform cannot bound a
loop. That constraint was then **verified independently in VDE's own renderer** rather than taken on
trust, and it determined the shape of `BLUR_MAX_TAPS`.

Assets are CC0, i.e. public domain. Attribution is not required for them; it is given anyway.

## Kenney asset packs — CC0

<https://kenney.nl/>

The `freeassets` tree used throughout development as a measurement corpus. Not redistributed with
VDE; it is gitignored. Every reader in `core/import` was verified against it, and most of the faults
found this way — interleaved glTF vertex data, OBJ's three index streams, non-unit normals in 206
files, tilesets declaring no `columns` — were found because real files disagreed with the spec.

## Files vendored into this repository

Everything above describes software *studied*, not copied. This section is the exception, and it
is deliberately small.

`test-fixtures/tiled/` holds **five unmodified Tiled map and tileset files** (about 43 KB of XML)
from packs by **Kenney** (<https://kenney.nl>), each released under **Creative Commons Zero
(CC0 1.0)** — <http://creativecommons.org/publicdomain/zero/1.0/>. Every pack ships its own
`License.txt` stating this, and each was read before the file was copied.

Two further fixtures — `object-only.tmx` and `object-only-tiles.tsx` — are the **sticker-knight**
example that ships with Tiled, by **@ponywolf** and, per its own README, *"released to the public
domain"* (<http://opengameart.org/content/sticker-knight-platformer>). Tiled's other bundled
examples are **not** vendored: `COPYING.txt` licenses Tiled's source directories but says nothing
about the example DATA, and `desert.tsx` draws on The Mana World art, so their status is unclear.
Where one of those was needed, its structure was mirrored in synthetic XML instead.

They are test fixtures, not assets the product uses: the reader is pure text parsing, so the
referenced PNGs are deliberately absent. They exist because a fixture invented to match a reader
proves only that the reader matches the fixture. Provenance per file is in
`test-fixtures/tiled/README.md`.
