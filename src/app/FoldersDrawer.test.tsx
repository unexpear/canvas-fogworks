/**
 * @jest-environment jsdom
 * @module FoldersDrawer.test
 * @description SHELL-001 DOM coverage for the extracted folders drawer.
 */

import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { createEmptyDocument } from "../core/document/Document";
import { Keyframe } from "../core/document/Timeline";
import { SourceRect } from "../core/document/Node";
import { SvgNodeSpec } from "../core/import/SvgNodes";
import { Palette } from "../core/paint/Palette";
import { ElectronAPI } from "./ElectronAPI";
import { FoldersDrawer, SEQUENCE_IMPORT_MAX } from "./FoldersDrawer";

jest.mock("../renderer/ImageCache", () => ({
    naturalSize: (href: string) => href === "sheet:hero" ? { width: 64, height: 32 } : null,
    imageSizeAsync: async () => null,
    surfaceUrl: () => "data:image/png;base64,surface"
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ATLAS = `<TextureAtlas imagePath="hero.png">
  <SubTexture name="idle" x="1" y="2" width="16" height="16"/>
</TextureAtlas>`;
const PALETTE_FILE = JSON.stringify({
    width: 1, height: 1, comment: "test ramp",
    colors: [{ index: 0, color: "(1, 0, 0, 1)" }]
});

function setValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const proto = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonNamed(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find(item => item.textContent === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found as HTMLButtonElement;
}

/** Folder reads resolve on later turns; flush them before asserting the note they set. */
async function click(el: HTMLElement) {
    await act(async () => {
        el.click();
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

describe("SHELL-001 extracted folders drawer", () => {
    let host: HTMLDivElement;
    let root: Root;
    const tracks: Keyframe[][] = [];
    const regions: SourceRect[] = [];
    const svgs: SvgNodeSpec[][] = [];
    const colours: string[] = [];
    const palettes: Palette[] = [];
    const placed: { src: string; name: string }[] = [];
    const sequences: { name: string; first: string; frames: number }[] = [];

    const base = {
        getProjectPath: () => null as string | null,
        onPlaceImage: (src: string, name: string) => placed.push({ src, name }),
        getDocument: () => createEmptyDocument(),
        selectedImage: null as { id: string; src: string } | null,
        onImportTrack: (track: Keyframe[]) => tracks.push(track),
        onImportSequence: (name: string, first: string, track: Keyframe[]) =>
            sequences.push({ name, first, frames: track.length }),
        onImportAseprite: () => undefined,
        onImport3D: async () => undefined,
        onImportEnvironment3D: async () => undefined,
        onSetRegion: (rect: SourceRect) => regions.push(rect),
        onImportSvg: (specs: SvgNodeSpec[]) => svgs.push(specs),
        editContentFont: () => undefined,
        onImportTiles: () => undefined,
        paintColour: "#000000",
        onPickColour: (hex: string) => colours.push(hex),
        selectedRasterId: null as string | null,
        onQuantize: (palette: Palette) => palettes.push(palette)
    };

    function install(api: Partial<ElectronAPI> | null) {
        if (api) window.electronAPI = api as ElectronAPI;
        else delete window.electronAPI;
    }

    async function render(props: Partial<typeof base> = {}, api: Partial<ElectronAPI> | null = {}) {
        install(api);
        await act(async () => root.render(<FoldersDrawer {...base} {...props} />));
    }

    beforeEach(() => {
        // jsdom throws from getContext; the drawer treats a missing context as "nothing to draw".
        HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
        tracks.length = 0;
        regions.length = 0;
        svgs.length = 0;
        colours.length = 0;
        palettes.length = 0;
        placed.length = 0;
        sequences.length = 0;
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
        delete window.electronAPI;
    });

    it("says when the desktop bridge is absent and otherwise switches workflow tabs", async () => {
        await render({}, null);
        expect(host.textContent).toContain("Folder access needs the desktop app.");
        expect(host.querySelector("button")).toBeNull();

        await render();
        expect(host.textContent).toContain("Choose a folder");
        await click(buttonNamed(host, "Import"));
        expect(host.textContent).toContain("Select an image node to slice a sheet into it.");
        await click(buttonNamed(host, "Export"));
        expect(host.textContent).toContain("Preview the SVG");
        await click(buttonNamed(host, "Assets"));
        expect(host.textContent).toContain("Choose an asset folder");
    });

    it("slices a decoded sheet, refuses a grid that does not divide, and applies an atlas region", async () => {
        await render({ selectedImage: { id: "hero", src: "sheet:hero" } });
        await click(buttonNamed(host, "Import"));
        await click(host.querySelector<HTMLButtonElement>('[data-slice-btn="1"]')!);
        expect(tracks).toHaveLength(1);
        expect(tracks[0].map(frame => frame.frame)).toEqual([0, 2]);
        expect(tracks[0][0].values.sourceRect).toEqual({ x: 0, y: 0, width: 32, height: 32 });
        expect(host.textContent).toContain("2x1 = 2 cells, 2 frames apart.");

        const width = host.querySelector<HTMLInputElement>('[data-slice="cell w"]')!;
        await act(async () => setValue(width, "30"));
        await click(host.querySelector<HTMLButtonElement>('[data-slice-btn="1"]')!);
        expect(tracks).toHaveLength(1);
        expect(host.textContent).toContain("does not divide");

        await render({ selectedImage: { id: "hero", src: "not-decoded" } });
        await click(buttonNamed(host, "Import"));
        await click(host.querySelector<HTMLButtonElement>('[data-slice-btn="1"]')!);
        expect(tracks).toHaveLength(1);
        expect(host.textContent).toContain("That image has not decoded yet.");

        await render({ selectedImage: { id: "hero", src: "sheet:hero" } });
        await click(buttonNamed(host, "Import"));
        const atlas = host.querySelector<HTMLTextAreaElement>('[data-atlas-input="1"]')!;
        await act(async () => setValue(atlas, "not an atlas"));
        await click(host.querySelector<HTMLButtonElement>('[data-atlas-btn="1"]')!);
        expect(host.textContent).toContain("not a TextureAtlas");
        expect(host.querySelector("[data-atlas-pick]")).toBeNull();

        await act(async () => setValue(atlas, ATLAS));
        await click(host.querySelector<HTMLButtonElement>('[data-atlas-btn="1"]')!);
        const pick = host.querySelector<HTMLSelectElement>('[data-atlas-pick="1"]')!;
        await act(async () => {
            pick.value = "0";
            pick.dispatchEvent(new Event("change", { bubbles: true }));
        });
        expect(regions).toEqual([{ x: 1, y: 2, width: 16, height: 16 }]);
        expect(host.textContent).toContain("idle");
    });

    it("places a valid SVG and reports a document the reader refuses", async () => {
        await render();
        await click(buttonNamed(host, "Import"));
        const svg = host.querySelector<HTMLTextAreaElement>('[data-svg-input="1"]')!;
        await act(async () => setValue(svg, '<svg><path d="M0 0 L10 0 L10 10 Z" fill="#fff"/></svg>'));
        await click(host.querySelector<HTMLButtonElement>('[data-svg-btn="1"]')!);
        expect(svgs).toHaveLength(1);
        expect(svgs[0].length).toBeGreaterThan(0);
        expect(host.textContent).toContain("placed");

        await act(async () => setValue(svg, "<html></html>"));
        await click(host.querySelector<HTMLButtonElement>('[data-svg-btn="1"]')!);
        expect(svgs).toHaveLength(1);
        expect(host.textContent).toContain("not an SVG document");
    });

    it("paints from a loaded palette and quantises only a selected raster", async () => {
        await render({}, {
            pickFolder: async () => "C:/palettes",
            readPaletteFolder: async () => [{ path: "dawn.json", name: "Dawn.json", relative: "Dawn.json" }],
            readPaletteFile: async () => PALETTE_FILE
        });
        await click(buttonNamed(host, "Import"));
        await click(host.querySelector<HTMLButtonElement>('[data-palette-btn="1"]')!);
        expect(host.textContent).toContain("1 palette of 1 .json file");
        expect(host.textContent).toContain("test ramp");
        const quantize = host.querySelector<HTMLButtonElement>('[data-quantize-btn="1"]')!;
        expect(quantize.disabled).toBe(true);

        await render({
            selectedRasterId: "raster-1",
            paintColour: "#ff0000"
        }, {
            pickFolder: async () => "C:/palettes",
            readPaletteFolder: async () => [{ path: "dawn.json", name: "Dawn.json", relative: "Dawn.json" }],
            readPaletteFile: async () => PALETTE_FILE
        });
        await click(buttonNamed(host, "Import"));
        await click(host.querySelector<HTMLButtonElement>('[data-palette-btn="1"]')!);
        await click(host.querySelector<HTMLButtonElement>('[aria-label="Palette colour #ff0000"]')!);
        expect(colours).toEqual(["#ff0000"]);
        const enabled = host.querySelector<HTMLButtonElement>('[data-quantize-btn="1"]')!;
        expect(enabled.disabled).toBe(false);
        await click(enabled);
        expect(palettes.map(palette => palette.name)).toEqual(["Dawn.json"]);
    });

    it("imports a numbered run, refuses an unreadable frame, and will not treat a tileset as animation", async () => {
        await render({}, {
            pickFolder: async () => "C:/art",
            readAssetFolder: async () => [
                { path: "a", name: "run_1.png", relative: "run_1.png" },
                { path: "b", name: "run_2.png", relative: "run_2.png" },
                { path: "c", name: "icon_1.png", relative: "icon_1.png" }
            ],
            readImageDataUrl: async (_folder, filePath) => `data:image/png;base64,${filePath}`
        });
        await click(buttonNamed(host, "Assets"));
        await click(buttonNamed(host, "Choose an asset folder…"));
        expect(host.querySelector("[data-sequence='icon']")).toBeNull();
        await click(host.querySelector<HTMLButtonElement>("[data-sequence='run']")!);
        expect(sequences).toEqual([{
            name: "run", first: "data:image/png;base64,a", frames: 2
        }]);
        await click(buttonNamed(host, "Import"));
        expect(host.textContent).toContain("run: 2 frames.");

        await render({}, {
            pickFolder: async () => "C:/art",
            readAssetFolder: async () => [
                { path: "a", name: "run_1.png", relative: "run_1.png" },
                { path: "b", name: "run_2.png", relative: "run_2.png" }
            ],
            readImageDataUrl: async () => { throw new Error("denied"); }
        });
        await click(buttonNamed(host, "Assets"));
        await click(buttonNamed(host, "Choose an asset folder…"));
        await click(host.querySelector<HTMLButtonElement>("[data-sequence='run']")!);
        expect(sequences).toHaveLength(1);
        await click(buttonNamed(host, "Import"));
        expect(host.textContent).toContain("Could not read frame run_1.png: denied");

        const tiles = Array.from({ length: SEQUENCE_IMPORT_MAX + 1 }, (_, index) => ({
            path: String(index),
            name: `tile_${String(index).padStart(4, "0")}.png`,
            relative: `tile_${String(index).padStart(4, "0")}.png`
        }));
        await render({}, {
            pickFolder: async () => "C:/tiles",
            readAssetFolder: async () => tiles
        });
        await click(buttonNamed(host, "Assets"));
        await click(buttonNamed(host, "Choose an asset folder…"));
        const tileRun = host.querySelector<HTMLButtonElement>("[data-sequence='tile']")!;
        expect(tileRun.disabled).toBe(true);
        expect(tileRun.title).toContain("too many to be an animation");
    });

    it("places one asset and previews exports without writing a file", async () => {
        const writes: string[] = [];
        await render({}, {
            pickFolder: async () => "C:/art",
            readAssetFolder: async () => [{ path: "icon.png", name: "icon.png", relative: "art/icon.png" }],
            readImageDataUrl: async () => "data:image/png;base64,icon",
            readSourceFolder: async () => [],
            writeIntoFolder: async (_folder, name) => {
                writes.push(name);
                return `C:/out/${name}`;
            }
        });
        await click(buttonNamed(host, "Assets"));
        await click(buttonNamed(host, "Choose an asset folder…"));
        await click(buttonNamed(host, "icon.png"));
        expect(placed).toEqual([{ src: "data:image/png;base64,icon", name: "icon.png" }]);
        await click(buttonNamed(host, "Import"));
        expect(host.textContent).toContain("Placed art/icon.png.");

        await click(buttonNamed(host, "Code"));
        const path = host.querySelector<HTMLInputElement>('input[placeholder^="…or paste a path"]')!;
        await act(async () => {
            setValue(path, "C:/src");
            path.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(host.textContent).toContain("Nothing unwired found");

        await click(buttonNamed(host, "Export"));
        await click(buttonNamed(host, "Preview the SVG"));
        expect(host.querySelector<HTMLTextAreaElement>('[data-svg-preview="1"]')!.value).toContain("<svg");
        expect(writes).toEqual([]);

        await click(host.querySelector<HTMLButtonElement>('[data-sheet-preview-btn="1"]')!);
        expect(host.querySelector<HTMLTextAreaElement>('[data-svg-preview="1"]')!.value).toContain("sheet.png");
        expect(host.querySelector("[data-sheet-canvas]")).not.toBeNull();

        await click(host.querySelector<HTMLButtonElement>('[data-export-tmx="1"]')!);
        expect(host.textContent).toContain("there is no tilemap node to export");
        expect(writes).toEqual([]);
    });
});
