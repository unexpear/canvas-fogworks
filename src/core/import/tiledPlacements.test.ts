import { parseTiledMap, parseTiledTileset, TiledTileset } from "./TiledMap";
import { buildPlacements, importNote } from "./tiledPlacements";

/**
 * THESE FIXTURES ARE BUILT BY THE PRODUCER, not hand-assembled: every map here goes through
 * `parseTiledMap` exactly as a real file does. A hand-made `TiledMapResult` is a state nothing
 * emits, and this project has a recorded case of six mutants dying correctly against exactly that.
 *
 * And none of this could be written at all until the conversion left `App.tsx` — that is the whole
 * point of the extraction rather than a side benefit.
 */

const SHEET = "data:image/png;base64,AAAA";

/** A map with `n` tile layers drawing from ONE embedded 4x4-tile sheet. */
const mapXml = (layers: { name: string; csv: string }[], extra = "") => `<?xml version="1.0"?>
<map version="1.10" orientation="orthogonal" renderorder="right-down"
     width="2" height="2" tilewidth="16" tileheight="16" infinite="0">
 <tileset firstgid="1" name="embedded" tilewidth="16" tileheight="16" tilecount="16" columns="4">
  <image source="sheet.png" width="64" height="64"/>
 </tileset>
${layers.map((l, i) => ` <layer id="${i + 1}" name="${l.name}" width="2" height="2">
  <data encoding="csv">${l.csv}</data>
 </layer>`).join("\n")}
${extra}</map>`;

const parse = (xml: string) => {
    const r = parseTiledMap(xml);
    if (!r) throw new Error("fixture did not parse");
    return r;
};
const ids = () => { let n = 0; return () => `ts${++n}`; };

describe("buildPlacements — the half of the importer a folder dialog used to own", () => {
    it("ONE TILESET PER DISTINCT SET, however many layers draw from it", () => {
        // The measured 2.5x duplication collapses here: Tiled's own examples hold 41 tile layers
        // drawing from 12 sets, and every layer used to carry its own copy of the picture.
        const map = parse(mapXml([
            { name: "ground", csv: "1,2,3,4" },
            { name: "detail", csv: "5,6,7,8" },
            { name: "top", csv: "9,10,11,12" }
        ]));
        const sheets = new Map([["sheet.png", SHEET]]);
        const out = buildPlacements(map, map.tilesets, sheets, { newId: ids() });
        expect(out.tilesets).toHaveLength(1);
        expect(out.tilesets[0].id).toBe("ts1");
        expect(out.placements.filter(p => p.kind === "tilemap")).toHaveLength(3);
        // …and every layer names that ONE set.
        const named = out.placements
            .filter((p): p is Extract<typeof p, { kind: "tilemap" }> => p.kind === "tilemap")
            .map(p => p.map.tilesetId);
        expect([...new Set(named)]).toEqual(["ts1"]);
    });

    it("a layer whose sheet did NOT load falls back per cell, and says why", () => {
        const map = parse(mapXml([{ name: "ground", csv: "1,2,3,4" }]));
        // The sheet is deliberately absent, which is what a failed read looks like here.
        const out = buildPlacements(map, map.tilesets, new Map(), { newId: ids() });
        expect(out.placements.filter(p => p.kind === "tilemap")).toHaveLength(0);
        // Four painted cells, none of them placeable without the picture.
        expect(out.unresolved).toBe(4);
        expect(out.problems.length).toBeGreaterThan(0);
        // The tileset is still minted — the SET is known even when its picture is not.
        expect(out.tilesets).toHaveLength(1);
        expect(out.tilesets[0].src).toBeNull();
    });

    it("counts a HOLE where every other unplaceable cell is counted", () => {
        // gid 0 is empty and must NOT count; the same map must report the same number whichever
        // path drew it, which is why the grid path adds `dropped`.
        const solid = buildPlacements(parse(mapXml([{ name: "g", csv: "1,2,3,4" }])),
            parse(mapXml([{ name: "g", csv: "1,2,3,4" }])).tilesets,
            new Map([["sheet.png", SHEET]]), { newId: ids() });
        expect(solid.unresolved).toBe(0);
        const holed = parse(mapXml([{ name: "g", csv: "1,0,3,4" }]));
        const out = buildPlacements(holed, holed.tilesets, new Map([["sheet.png", SHEET]]),
            { newId: ids() });
        expect(out.unresolved).toBe(0);          // an EMPTY cell is not an unplaceable one
        expect(out.placements.filter(p => p.kind === "tilemap")).toHaveLength(1);
    });

    it("AN EMPTY OBJECT LAYER GETS NO FRAME", () => {
        // A map full of templates would otherwise import as a stack of empty rectangles, which
        // reads as a broken import rather than as content this cannot open.
        const withEmpty = parse(mapXml([{ name: "g", csv: "1,2,3,4" }],
            ` <objectgroup id="9" name="nothing"/>\n`));
        const out = buildPlacements(withEmpty, withEmpty.tilesets,
            new Map([["sheet.png", SHEET]]), { newId: ids() });
        expect(out.placements.filter(p => p.kind === "group")).toHaveLength(0);
    });

    it("an object layer with something in it becomes a FRAME then its objects", () => {
        const withObj = parse(mapXml([{ name: "g", csv: "1,2,3,4" }],
            ` <objectgroup id="9" name="things">
   <object id="1" name="spot" type="Location" x="10" y="20" width="30" height="40"/>
  </objectgroup>\n`));
        const out = buildPlacements(withObj, withObj.tilesets,
            new Map([["sheet.png", SHEET]]), { newId: ids() });
        const kinds = out.placements.map(p => p.kind);
        // The frame comes BEFORE its contents, and after the tile layers, so an entity sits above
        // the ground it stands on.
        expect(kinds).toEqual(["tilemap", "group", "object"]);
        const group = out.placements[1] as Extract<typeof out.placements[number], { kind: "group" }>;
        // THE FRAME SPANS THE MAP, not its contents: 2x2 cells of 16px.
        expect([group.width, group.height]).toEqual([32, 32]);
    });

    it("carries the caller's problems in front of its own", () => {
        // The drawer collects file-reading failures before this runs, and they must not be lost.
        const map = parse(mapXml([{ name: "g", csv: "1,2,3,4" }]));
        const out = buildPlacements(map, map.tilesets, new Map(),
            { newId: ids(), problems: ["sheet.png: ENOENT"] });
        expect(out.problems[0]).toBe("sheet.png: ENOENT");
        expect(out.problems.length).toBeGreaterThan(1);
    });

    it("takes its ids from the caller, which is what makes any of this assertable", () => {
        const map = parse(mapXml([{ name: "g", csv: "1,2,3,4" }]));
        const a = buildPlacements(map, map.tilesets, new Map([["sheet.png", SHEET]]),
            { newId: () => "fixed" });
        expect(a.tilesets[0].id).toBe("fixed");
    });
});

describe("importNote — a sentence made of five counts and four plurals", () => {
    const map = parse(mapXml([{ name: "g", csv: "1,2,3,4" }]));
    const base = { placements: [], tilesets: [], unresolved: 0, problems: [] };

    it("singularises one grid and one layer", () => {
        const out = buildPlacements(map, map.tilesets, new Map([["sheet.png", SHEET]]),
            { newId: ids() });
        expect(importNote(map, out)).toBe("1 grid from 1 layer · orthogonal");
    });

    it("pluralises, and appends only what is there", () => {
        expect(importNote(map, { ...base, placements: [], unresolved: 0, problems: [] }))
            .toBe("0 grids from 1 layer · orthogonal");
        expect(importNote(map, { ...base, unresolved: 3 }))
            .toBe("0 grids from 1 layer · orthogonal · 3 unresolved");
        expect(importNote(map, { ...base, problems: ["a layer did not fit"] }))
            .toBe("0 grids from 1 layer · orthogonal · a layer did not fit");
    });
});

describe("a REAL external tileset, resolved the way the drawer resolves it", () => {
    it("parses an external .tsx into the stub and places from it", () => {
        // `parseTiledTileset` is what the drawer calls after reading the file; this proves the two
        // halves still meet now that they live in different modules.
        const xml = `<?xml version="1.0"?>
<map version="1.10" orientation="orthogonal" renderorder="right-down"
     width="2" height="2" tilewidth="18" tileheight="18" infinite="0">
 <tileset firstgid="1" source="tileset-tiles.tsx"/>
 <layer id="1" name="Tiles" width="2" height="2">
  <data encoding="csv">1,2,3,4</data>
 </layer>
</map>`;
        const map = parse(xml);
        expect(map.tilesets[0].source).toBe("tileset-tiles.tsx");
        // The shape Kenney's Pixel Platformer actually ships: 18px tiles, 20 columns, 180 tiles.
        const resolved: TiledTileset = parseTiledTileset(`<?xml version="1.0"?>
<tileset version="1.4" name="tileset-tiles" tilewidth="18" tileheight="18" tilecount="180" columns="20">
 <image source="../Tilemap/tilemap_packed.png" width="360" height="162"/>
</tileset>`, map.tilesets[0]);
        const out = buildPlacements(map, [resolved],
            new Map([["../Tilemap/tilemap_packed.png", SHEET]]), { newId: ids() });
        expect(out.tilesets[0].sheet).toEqual({
            columns: 20, tileWidth: 18, tileHeight: 18, spacing: 0, margin: 0
        });
        expect(out.placements.filter(p => p.kind === "tilemap")).toHaveLength(1);
        expect(out.unresolved).toBe(0);
    });
});
