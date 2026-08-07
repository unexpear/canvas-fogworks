# Real Tiled files, kept as test fixtures

These are **unmodified files written by Tiled**, not hand-authored XML. They exist because a
fixture invented to match a reader proves only that the reader matches the fixture — see
`docs/TESTING.md` § *Fixture design*, item 0.

They live **outside `src/`** for a boring but load-bearing reason: `.tsx` is TypeScript's JSX
extension, and `tsconfig.test.json` includes `src/**/*`. A tileset stored under `src/` is compiled
as source and fails with `TS1109: Expression expected`. The extension is what Tiled writes, so the
file moved rather than the name.

| File | Why this one |
|---|---|
| `isometric-sample.tmx` + `.tsx` | **The only real isometric map in the tree with any painted cells** (60×32, 256×128 tiles, 3 layers, 51 cells). Every other isometric map ships blank, so until this arrived the isometric placement branch had never met real data. Found *inside* `Tiled Sample.zip` — the asset sweep had never looked in archives. |
| `layer-offset.tmx` | The only file anywhere that sets a layer `offsety` (`-30`), and it sets `offsetx="0"` — so it also pins that an absent axis is 0 rather than undefined. |
| `zlib-embedded.tmx` | base64 + **zlib** data with an **embedded** tileset, 10,618 painted cells. The compressed path and the embedded-tileset path in one file. |
| `object-only.tmx` + `object-only-tiles.tsx` | Tiled's own **sticker-knight** sandbox: 79×45 with **eleven object layers and not one `<layer>`**. It used to parse "successfully" into zero layers and zero cells with nothing said — indistinguishable from a blank map. Nothing in the asset tree is shaped like this; it came from running the reader over the examples Tiled ships. Also carries `parallaxx` and flipped object gids (`2147483655`). |
| `collection.tsx` | An **image-collection** tileset: 244 tiles that are separate files, no sheet to cut. It also declares `tilecount="3"`, which is **wrong in the shipped asset** — a real reminder that the number a file states is not a number to decide with. |

## Provenance and licence

Five of the seven are from packs by **Kenney** (<https://kenney.nl>), released under
**Creative Commons Zero (CC0 1.0)** — <http://creativecommons.org/publicdomain/zero/1.0/>.
Each pack ships its own `License.txt` stating this; they were checked individually before copying.

| File | Pack |
|---|---|
| `isometric-sample.tmx`, `isometric-sample.tsx` | Isometric Miniature Bases (1.0) |
| `layer-offset.tmx` | Scribble Dungeons (1.0) |
| `zlib-embedded.tmx` | Roguelike Base Pack |
| `collection.tsx` | Sketch Desert (1.0) |

`object-only.tmx` and `object-only-tiles.tsx` are **not** Kenney: they are the sticker-knight
example bundled with Tiled, by **@ponywolf**, *"released to the public domain"* per its own README
(<http://opengameart.org/content/sticker-knight-platformer>). Tiled's other bundled examples are
deliberately **not** vendored — `COPYING.txt` licenses Tiled's source directories and says nothing
about the example data, and `desert.tsx` draws on The Mana World art. Where one of those was
needed (the hexagonal map), its structure was mirrored in synthetic XML instead.

The referenced **images are deliberately absent**. The reader is pure text parsing and resolves no
paths — that is the caller's job — so the maps are complete inputs without them, and the repo does
not carry megabytes of PNG to test a parser.
