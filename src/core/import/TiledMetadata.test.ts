/** @module TiledMetadata.test @description Rich TMX tileset metadata import coverage. */

import { parseTiledMap } from "./TiledMap";
import { createEmptyDocument } from "../document/Document";
import { exportTiledMap } from "../export/ExportTiled";
import { applyTileAnimations, tileSolidsNear } from "../runtime/World";

test("tile properties, class, collision, animation, and wangsets are preserved", () => {
    const xml = `<?xml version="1.0"?><map width="1" height="1" tilewidth="16" tileheight="16">
      <tileset firstgid="1" name="Terrain" tilewidth="16" tileheight="16" columns="2" tilecount="2">
        <image source="tiles.png" width="32" height="16"/>
        <tile id="0" class="Hazard" probability="0.25">
          <properties><property name="bodyType" value="static"/><property name="damage" type="int" value="2"/></properties>
          <objectgroup><object id="1" x="2" y="3" width="12" height="10"/></objectgroup>
          <animation><frame tileid="0" duration="100"/><frame tileid="1" duration="120"/></animation>
        </tile>
        <wangsets><wangset name="Ground" tile="0"><wangcolor name="Dirt" color="#aabbcc" tile="0" probability="1"/><wangtile tileid="0" wangid="1,0,1,0,1,0,1,0"/></wangset></wangsets>
      </tileset><layer width="1" height="1"><data encoding="csv">1</data></layer></map>`;
    const set = parseTiledMap(xml).tilesets[0];
    expect(set.tiles[0]).toMatchObject({ id: 0, className: "Hazard", probability: 0.25,
        userData: { bodyType: { type: "string", value: "static" }, damage: { type: "int", value: "2" } },
        collision: [{ x: 2, y: 3, width: 12, height: 10, rotation: 0, kind: "rectangle" }],
        animation: [{ tileId: 0, duration: 100 }, { tileId: 1, duration: 120 }] });
    expect(set.wangsets?.[0]).toMatchObject({ name: "Ground", tile: 0,
        colors: [{ name: "Dirt", color: "#aabbcc", tile: 0, probability: 1 }],
        tiles: [{ tileId: 0, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }] });
});

test("rich tile metadata exports and custom collision reaches the runtime", () => {
    const doc = createEmptyDocument();
    doc.tilesets = [{ id: "set", name: "Terrain", src: "tiles.png",
        sheet: { columns: 2, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 },
        offsetX: 0, offsetY: 0,
        tiles: [{ id: 0, entity: { body: "static", friction: 0.25 },
            className: "Ground", userData: { hp: { type: "int", value: "3" } },
            collision: [{ x: 2, y: 4, width: 12, height: 8, rotation: 0, kind: "rectangle" }],
            animation: [{ tileId: 0, duration: 90 }, { tileId: 1, duration: 110 }] }],
        wangsets: [{ name: "Ground", tile: 0, colors: [],
            tiles: [{ tileId: 0, wangId: [1, 0, 1, 0, 1, 0, 1, 0] }] }] }];
    doc.nodes.set("map", { id: "map", type: "core.tilemap", parent: null, children: [],
        geometry: { x: 10, y: 20, width: 16, height: 16 }, style: { fill: "none", opacity: 1 }, layout: {},
        tilemap: { cols: 1, rows: 1, tileWidth: 16, tileHeight: 16, tilesetId: "set", tiles: [0] } });
    doc.rootNodeUuids.push("map");
    const exported = exportTiledMap(doc, "tiles.png");
    expect(exported.xml).toContain('<tile id="0" class="Ground">');
    expect(exported.xml).toContain('<frame tileid="1" duration="110"/>');
    expect(exported.xml).toContain('<wangtile tileid="0" wangid="1,0,1,0,1,0,1,0"/>');
    expect(tileSolidsNear(doc, { x: 10, y: 20, width: 16, height: 16 })).toEqual([
        { x: 12, y: 24, width: 12, height: 8, friction: 0.25, oneWay: false,
          nodeId: "map", cell: { col: 0, row: 0 } }
    ]);
    expect(applyTileAnimations(doc, 0.095).nodes.get("map")?.tilemap?.tiles).toEqual([1]);
    expect(doc.nodes.get("map")?.tilemap?.tiles).toEqual([0]);
});
