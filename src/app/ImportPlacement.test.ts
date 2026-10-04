/**
 * @module ImportPlacement.test
 * @description SHELL-001 coverage for canvas placement of prepared imports.
 */

import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { SetBackgroundAction } from "../core/actions/SetBackgroundAction";
import { SetScreenAction } from "../core/actions/SetScreenAction";
import { createEmptyDocument } from "../core/document/Document";
import { Keyframe } from "../core/document/Timeline";
import { Tileset } from "../core/document/Tileset";
import { SvgNodeSpec } from "../core/import/SvgNodes";
import {
    bindImportPlacement, PLACED_IMAGE_SIZE, PlacementView, UNMEASURED_CANVAS, viewCentre
} from "./ImportPlacement";

const sheet = { columns: 4, tileWidth: 16, tileHeight: 16, spacing: 0, margin: 0 };
const tileset: Tileset = {
    id: "a", name: "Ground", src: "g.png", sheet, tiles: [], offsetX: 0, offsetY: 0
};

function view(over: Partial<PlacementView> = {}): PlacementView {
    return {
        viewport: { x: 0, y: 0, zoom: 1 },
        clientWidth: 800,
        clientHeight: 600,
        ...over
    };
}

function placed(viewState: PlacementView = view()) {
    const dispatcher = new ActionDispatcher(createEmptyDocument());
    const selected: string[][] = [];
    const warnings: string[] = [];
    let refreshes = 0;
    const bound = bindImportPlacement({
        getView: () => viewState,
        getDocument: () => dispatcher.getDocument(),
        dispatch: action => dispatcher.dispatchAction(action),
        select: ids => { selected.push(ids); },
        refresh: () => { refreshes += 1; },
        warn: message => { warnings.push(message); }
    });
    return { dispatcher, selected, warnings, refreshes: () => refreshes, ...bound };
}

const track: Keyframe[] = [
    { frame: 0, values: { src: "data:image/png;base64,aa" } },
    { frame: 1, values: { src: "data:image/png;base64,bb" } }
];

describe("SHELL-001 import placement", () => {
    test("the view centre follows the viewport, and an unmeasured canvas uses 800×600", () => {
        expect(viewCentre(view({ viewport: { x: 100, y: 50, zoom: 2 } }))).toEqual({ x: 250, y: 175 });
        expect(viewCentre(view({ clientWidth: null, clientHeight: null }))).toEqual({
            x: UNMEASURED_CANVAS.width / 2,
            y: UNMEASURED_CANVAS.height / 2
        });
        // A measured zero is not "missing". Substituting 800 here would place the import off-canvas.
        expect(viewCentre(view({ clientWidth: 0, clientHeight: 0 }))).toEqual({ x: 0, y: 0 });
    });

    test("a numbered sequence lands centred in a fixed box, selects the node, and is one undo", () => {
        const host = placed(view({ viewport: { x: 100, y: 50, zoom: 2 } }));
        host.importSequence("run", track[0].values.src as string, track);

        const id = host.selected[0][0];
        const node = host.dispatcher.getDocument().nodes.get(id)!;
        expect(node.type).toBe("core.image");
        expect(node.name).toBe("run");
        expect(node.geometry).toEqual({
            x: 250 - PLACED_IMAGE_SIZE.width / 2,
            y: 175 - PLACED_IMAGE_SIZE.height / 2,
            width: PLACED_IMAGE_SIZE.width,
            height: PLACED_IMAGE_SIZE.height
        });
        expect(host.refreshes()).toBe(1);
        expect(host.dispatcher.undo()).not.toBeNull();
        expect(host.dispatcher.getDocument().nodes.has(id)).toBe(false);
        expect(host.dispatcher.getDocument().timeline).toBeUndefined();
    });

    test("an empty sequence is not placed and does not refresh", () => {
        const host = placed();
        host.importSequence("run", "data:image/png;base64,aa", []);
        expect(host.dispatcher.getDocument().nodes.size).toBe(0);
        expect(host.selected).toEqual([]);
        expect(host.refreshes()).toBe(0);
    });

    test("an Aseprite file uses its own size, and a tag past the timeline is reported", () => {
        const host = placed(view({ viewport: { x: 100, y: 50, zoom: 2 } }));
        host.importAseprite({
            name: "creature", first: "f0", track,
            timeline: { frames: 6, fps: 10 },
            clips: [
                { name: "good", from: 0, to: 1, loop: true },
                { name: "past the end", from: 4, to: 99, loop: true }
            ],
            width: 32, height: 48
        });
        const node = host.dispatcher.getDocument().nodes.get(host.selected[0][0])!;
        expect(node.geometry.width).toBe(32);
        expect(node.geometry.height).toBe(48);
        expect(node.geometry.x).toBe(250 - 16);
        expect(node.geometry.y).toBe(175 - 24);
        expect(host.warnings).toEqual([
            "1 tag(s) named frames outside the file's own timeline and were dropped."
        ]);
        expect(host.dispatcher.getDocument().clips!.map(clip => clip.name)).toEqual(["good"]);
    });

    test("SVG paths share one transaction and the first shape is selected", () => {
        const host = placed();
        const specs: SvgNodeSpec[] = [
            { geometry: { x: 4, y: 6, width: 10, height: 12 }, style: { fill: "#ff0000", opacity: 1 },
                path: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 10, y: 12 }] },
            { geometry: { x: 20, y: 0, width: 8, height: 8 }, style: { fill: "#00ff00", opacity: 1 },
                path: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 8, y: 8 }, { c: "Z" }] }
        ];
        host.importSvg(specs);
        const doc = host.dispatcher.getDocument();
        expect(doc.nodes.size).toBe(2);
        expect(host.selected[0]).toHaveLength(1);
        const first = doc.nodes.get(host.selected[0][0])!;
        expect(first.type).toBe("core.path");
        expect(first.geometry).toEqual(specs[0].geometry);
        expect(first.path).toEqual(specs[0].path);
        expect(host.dispatcher.undo()).not.toBeNull();
        expect(host.dispatcher.getDocument().nodes.size).toBe(0);

        host.importSvg([]);
        expect(host.dispatcher.getDocument().nodes.size).toBe(0);
        expect(host.refreshes()).toBe(1);
    });

    test("a map's tilesets, sky and screen arrive together, and a second map does not replace them", () => {
        const host = placed();
        const map = { cols: 1, rows: 1, tileWidth: 16, tileHeight: 16, tilesetId: "a", tiles: [0] };
        host.importTiles(
            [{ kind: "tilemap", x: 3, y: 4, width: 16, height: 16, map, name: "Ground", opacity: 1, hidden: false }],
            [tileset], "#88ccff", { width: 320, height: 180 }
        );
        const doc = host.dispatcher.getDocument();
        expect(doc.tilesets).toEqual([tileset]);
        expect(doc.background).toBe("#88ccff");
        expect(doc.screen).toEqual({ width: 320, height: 180 });
        expect(doc.nodes.get(host.selected[0][0])!.type).toBe("core.tilemap");
        expect(host.dispatcher.undo()).not.toBeNull();
        expect(host.dispatcher.getDocument().tilesets).toBeUndefined();
        expect(host.dispatcher.getDocument().background).toBeUndefined();
        expect(host.dispatcher.getDocument().screen).toBeUndefined();
        expect(host.dispatcher.getDocument().nodes.size).toBe(0);

        const kept = placed();
        expect(kept.dispatcher.dispatchAction(new SetBackgroundAction(kept.dispatcher.getDocument(), "#111111")).success).toBe(true);
        expect(kept.dispatcher.dispatchAction(new SetScreenAction(kept.dispatcher.getDocument(), { width: 64, height: 64 })).success).toBe(true);
        kept.importTiles(
            [{ kind: "tilemap", x: 0, y: 0, width: 16, height: 16, map, name: "Second", opacity: 1, hidden: false }],
            [tileset], "#ffffff", { width: 800, height: 600 }
        );
        expect(kept.dispatcher.getDocument().background).toBe("#111111");
        expect(kept.dispatcher.getDocument().screen).toEqual({ width: 64, height: 64 });
        expect(kept.dispatcher.getDocument().tilesets).toHaveLength(1);

        kept.importTiles([]);
        expect(kept.dispatcher.getDocument().nodes.size).toBe(1);
    });

    test("a folder image is centred, named, and selected", () => {
        const host = placed(view({ clientWidth: null, clientHeight: null }));
        host.placeAsset("data:image/png;base64,aa", "hero.png");
        const id = host.selected[0][0];
        const node = host.dispatcher.getDocument().nodes.get(id)!;
        expect(node.type).toBe("core.image");
        expect(node.src).toBe("data:image/png;base64,aa");
        expect(node.name).toBe("hero.png");
        expect(node.geometry).toEqual({
            x: UNMEASURED_CANVAS.width / 2 - PLACED_IMAGE_SIZE.width / 2,
            y: UNMEASURED_CANVAS.height / 2 - PLACED_IMAGE_SIZE.height / 2,
            width: PLACED_IMAGE_SIZE.width,
            height: PLACED_IMAGE_SIZE.height
        });
        expect(host.refreshes()).toBe(1);
    });
});
