/**
 * @module FoldersDrawer
 * @description Directory-backed source scan, asset placement, import and export
 * panel extracted from the top-level shell. Document edits stay in App callbacks.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import "./ElectronAPI";
import { exportCanvasPng } from "./CanvasExport";
import { prepareSequenceImport } from "./AssetImportWorkflow";
// ALIASED: the drawer already has a state variable called `importNote`, and the shadowing is not
// hypothetical — it typechecked as "String has no call signatures" the moment the import landed.
import { buildPlacements, importNote as tiledImportNote } from "../core/import/tiledPlacements";
import { Keyframe } from "../core/document/Timeline";
import { Palette, parsePaletteFile, paletteAt } from "../core/paint/Palette";
import { Rgba } from "../core/paint/PixelBuffer";
import { parseUnityPackage, UnityAsset } from "../core/import/UnityPackage";
import { scanCapabilities, Capability } from "../core/scan/CapabilityScan";
import { exportSVG, TextLines } from "../core/export/ExportSVG";
import { exportTiledMap } from "../core/export/ExportTiled";
import { planSheet, sheetAtlas, sheetTooLarge, drawSheet, SheetPlan } from "../core/export/SpriteSheet";
import { sliceGrid, sliceCells, sliceTrack } from "../core/import/SheetSlice";
import { groupSequences } from "../core/import/Sequence";
import { AsepritePlacement } from "../core/actions/asepriteImport";
import { parseAseprite, asepriteError, asepriteClips, asepriteTimeline, composeFrame } from "../core/import/Aseprite";
import { parseTextureAtlas, atlasError, AtlasEntry } from "../core/import/TextureAtlas";
import { parseSvgDocument, svgDocumentError } from "../core/import/SvgDocument";
import { svgNodeSpecs, SvgNodeSpec } from "../core/import/SvgNodes";
import { parseFontFile, fontFileError, FontInfo } from "../core/import/FontFile";
import { parseTiledMap, parseTiledTileset, tiledMapError, tilesetOverflow, withImageSize,
    TiledTileset } from "../core/import/TiledMap";
import { registerFont, registeredFontPayloads, registeredFonts } from "../renderer/FontCache";
import { generateUUID } from "../core/ids/UUID";
import { naturalSize, surfaceUrl, imageSizeAsync } from "../renderer/ImageCache";
import { SourceRect } from "../core/document/Node";
import { serializeDocument } from "../core/document/Serializer";
import { ReadonlyDocument } from "../core/document/Document";
import { TilePlacement } from "../core/actions/tileImport";
import { Tileset } from "../core/document/Tileset";
import { textLinesFor } from "../renderer/TextRaster";
import { loadAsset3D, loadEnvironment3D, LoadedAsset3D } from "./Asset3DImportWorkflow";
import { HdrEnvironmentImage } from "../renderer/HdrEnvironment";

/**
 * What the drawer hands the shell: everything but where on the canvas it lands.
 * The shell supplies the viewport centre; the drawer supplies the decoded file.
 */
export type AsepritePlacementInput = Omit<AsepritePlacement, "x" | "y">;

/** Same surface tokens as the shell, copied so this panel does not import App. */
const UI = {
    bg: "#0e0e18",
    raised: "#1c1c33",
    line: "#262642",
    text: "#dcdce8",
    textDim: "#8a8aa5",
    accent: "#4da3ff",
    accentSoft: "#22436b"
};

const INSPECTOR_LABEL: React.CSSProperties = { color: "#aaa", display: "block", marginTop: 4 };

/**
 * Paths one SVG import will place.
 *
 * A drawing of a few hundred shapes is ordinary; a map of ten thousand is a document nobody meant
 * to make by pasting into a text box. Refused rather than truncated — half a picture placed quietly
 * is worse than a sentence saying it was too large.
 */
const SVG_PLACE_MAX = 2000;
/**
 * How many NODES one map may place.
 *
 * The largest map measured is 10,618 non-empty cells across five layers, and the whole tree is
 * 22,808. This clears the largest by a wide margin and still refuses a map that would lock the
 * editor up — and it REPORTS rather than truncating, because half a map placed silently looks like
 * a broken importer rather than a refused one.
 *
 * MOSTLY MOOT NOW that a layer arrives as one `core.tilemap`: that same map is five nodes. It still
 * guards the fallback path, which is the one that can produce thousands.
 *
 * AND THERE IS A HARDER LIMIT BEHIND IT, measured rather than reasoned: every node placed cell by
 * cell carries the sheet's whole data URL, so `cloneDocument`'s `JSON.stringify` throws
 * `RangeError: Invalid string length` — V8's cap is ~512MB of string — at the FIRST revision commit.
 * The Roguelike sheet is 61KB of base64, so 10,618 cells is ~650MB and that map could never actually
 * be imported the old way; the transaction rolled back and placed nothing. The corpus's largest
 * fallback layer is 348 cells (~21MB), so nothing here reaches it any more. Fixing it properly means
 * the serializer sharing one copy of a repeated `src`, which is a change to the file format.
 */
const TILE_PLACE_MAX = 20000;

const DRAWER_BUTTON: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", fontSize: 11, padding: "4px 6px", cursor: "pointer",
    background: "transparent", color: "#ccc", border: "1px solid #2a2a4a", borderRadius: 3, marginBottom: 4
};

/**
 * The most frames an asset folder may be imported as ONE animation.
 *
 * NOT A MEMORY BOUND — a guard against the commonest false positive there is. A tileset exported
 * one file per tile (`tile_0000.png` … `tile_9999.png`) is a numbered run by every rule a name
 * reader has, and it is not an animation. Measured in the pack sitting beside this app: 11,846
 * files under one stem. 240 frames is ten seconds at 24fps, which is longer than any sprite cycle
 * and far short of a sheet.
 */
export const SEQUENCE_IMPORT_MAX = 240;

/**
 * The inverse, for a palette swatch: a colour from a FILE going into the colour control.
 *
 * ALPHA IS DROPPED, which is the same asymmetry `hexToRgba` documents from the other side — the
 * control has no alpha channel. A palette's transparent slots are drawn as holes rather than as
 * swatches, so nothing translucent reaches here in the first place.
 */
function rgbaToHex(c: Rgba): string {
    const hex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
}

/**
 * What the pure exporter cannot know, supplied from the DOM side.
 *
 * `ExportSVG` is deliberately pure — it is node-testable and runs where `emitSVG` cannot. That
 * purity is exactly why it cannot measure an image or encode a surface, and why it used to write
 * a tileset's WHOLE sheet in place of one cell and a `raster:` key that loads nowhere. Handing it
 * the two answers is the same injection the text wrapper already uses.
 */
const EXPORT_IMAGES = {
    naturalSize: (href: string) => naturalSize(href),
    surfaceUrl: (href: string, surface: { data: string; width: number; height: number }) =>
        surfaceUrl(href, surface)
};

/**
 * How the EXPORTER breaks text into lines.
 *
 * The exporter is pure and cannot measure; this runs in a browser and can. Handing it
 * `TextRaster.textLinesFor` means an exported file wraps where the Canvas and GPU backends wrap,
 * rather than running every paragraph off the side of its box — one typesetter for the editor and
 * for the artefact you hand somebody. Falls back to hard breaks only where there is no DOM to
 * measure with, which is the answer the exporter gave before this existed.
 */
const exportTextLines: TextLines = shape => textLinesFor(shape) ?? shape.text.split("\n");

/**
 * Draw a planned sheet and write both halves of it.
 *
 * The DOM half of the sprite-sheet export, which is why it lives here rather than in `core`: a
 * plan is arithmetic and belongs in a module a test can reach, but turning it into pixels needs a
 * canvas. `drawSheet` is handed a context and knows nothing about files.
 *
 * TWO FILES, because an engine needs both — the texture, and the description of which rectangle is
 * which frame of which clip. The PNG is written FIRST: the atlas's `image` field names a file, and
 * an atlas pointing at a name nobody wrote is worse than no atlas, because it fails in the engine
 * rather than here.
 */
async function writeSheet(doc: ReadonlyDocument, plan: SheetPlan, folder: string): Promise<string> {
    const api = window.electronAPI;
    if (!api) throw new Error("No file bridge — the sprite sheet has nowhere to go.");
    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context for the sprite sheet.");
    drawSheet(ctx, doc, plan);
    const png = await api.writePngIntoFolder(folder, "sheet.png", canvas.toDataURL("image/png"));
    await api.writeIntoFolder(folder, "sheet.json", JSON.stringify(sheetAtlas(doc, plan, "sheet.png"), null, 2));
    return png;
}

/** What a package holds that this engine can place. The rest is counted, not hidden. */
const UNITY_IMAGE = /\.(png|jpg|jpeg|gif|webp|svg)$/i;

/**
 * The FOLDERS drawer: the two directory-backed workflows.
 *
 *  - SOURCE: point at the codebase you are designing for; `scanCapabilities` lists what it can
 *    already do that nothing reaches, so you know which screens are still missing.
 *  - ASSETS: point at an image folder and click one to place it on the canvas.
 *
 * Both are inert without Electron (the browser build has no `electronAPI`), so the drawer says
 * so rather than showing controls that do nothing.
 */
export function FoldersDrawer({ onPlaceImage, getDocument, selectedImage, onImportTrack, onSetRegion, onImportSvg,
    editContentFont, onImportTiles, paintColour, onPickColour, selectedRasterId, onQuantize,
    onImportSequence, onImportAseprite, onImport3D, onImportEnvironment3D, getProjectPath }: {
    getProjectPath: () => string | null;
    onPlaceImage: (dataUrl: string, name: string) => void;
    /** A numbered run of files as one animated node: its name, frame zero's data URL, its track. */
    onImportSequence: (name: string, first: string, track: Keyframe[]) => void;
    /** An `.aseprite` as one animated node: the file's own clock and its tags, too. */
    onImportAseprite: (p: AsepritePlacementInput) => void;
    onImport3D: (filePath: string, name: string, loaded: LoadedAsset3D) => Promise<void>;
    onImportEnvironment3D: (filePath: string, name: string, image: HdrEnvironmentImage) => Promise<void>;
    getDocument: () => ReadonlyDocument;
    /** The selected node when it is an image with a source — what a SHEET import acts ON. */
    selectedImage: { id: string; src: string } | null;
    onImportTrack: (track: Keyframe[]) => void;
    onSetRegion: (rect: SourceRect) => void;
    onImportSvg: (specs: SvgNodeSpec[]) => void;
    /** Apply a registered family to the selected node — the point of loading one. */
    editContentFont: (family: string) => void;
    onImportTiles: (placements: TilePlacement[], tilesets?: Tileset[], background?: string, screen?: { width: number; height: number }) => void;
    /** The swatch a palette click writes to, and what it currently holds. */
    paintColour: string;
    onPickColour: (hex: string) => void;
    /** Quantising acts on a RASTER's pixels, so the button is dead without one selected. */
    selectedRasterId: string | null;
    onQuantize: (palette: Palette) => void;
}) {
    const [tab, setTab] = useState<"source" | "assets" | "export" | "import">("source");
    /** Grid inputs. Strings, because a half-typed number is a state a number input has to hold. */
    const [cellW, setCellW] = useState("32");
    const [cellH, setCellH] = useState("32");
    const [margin, setMargin] = useState("0");
    const [spacing, setSpacing] = useState("0");
    const [step, setStep] = useState("2");
    const [palettes, setPalettes] = useState<Palette[]>([]);
    const [palette, setPalette] = useState<Palette | null>(null);
    const [atlasText, setAtlasText] = useState("");
    const [atlasEntries, setAtlasEntries] = useState<AtlasEntry[] | null>(null);
    const [svgText, setSvgText] = useState("");
    const [fonts, setFonts] = useState<FontInfo[]>(registeredFonts());
    const [tiledFolder, setTiledFolder] = useState<string | null>(null);
    const [tiledMaps, setTiledMaps] = useState<{ path: string; name: string; relative: string }[]>([]);
    const [unityFolder, setUnityFolder] = useState<string | null>(null);
    const [unityPacks, setUnityPacks] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    /** What the chosen package holds — images are placeable, everything else is counted. */
    const [unityAssets, setUnityAssets] = useState<UnityAsset[]>([]);
    const [aseFolder, setAseFolder] = useState<string | null>(null);
    const [aseFiles, setAseFiles] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    const [modelFolder, setModelFolder] = useState<string | null>(null);
    const [modelFiles, setModelFiles] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    const [environmentFolder, setEnvironmentFolder] = useState<string | null>(null);
    const [environmentFiles, setEnvironmentFiles] = useState<{ path: string; name: string; bytes: number; relative: string }[]>([]);
    const [importNote, setImportNote] = useState<string | null>(null);
    const [exported, setExported] = useState<string | null>(null);
    const [preview, setPreview] = useState<string | null>(null);
    /** The sheet the preview canvas is showing, or null for none. */
    const [sheet, setSheet] = useState<SheetPlan | null>(null);
    const sheetCanvas = useRef<HTMLCanvasElement | null>(null);
    const [sourceFolder, setSourceFolder] = useState<string | null>(null);
    const [assetFolder, setAssetFolder] = useState<string | null>(null);
    const [findings, setFindings] = useState<Capability[] | null>(null);
    const [assets, setAssets] = useState<{ path: string; name: string; relative: string }[]>([]);
    const [busy, setBusy] = useState(false);

    /**
     * The numbered runs in the listed folder — computed from the NAMES the folder read already
     * returned, which is why this costs a picker rather than a new IPC channel.
     *
     * A ONE-FRAME RUN IS NOT AN ANIMATION. `groupSequences` groups by stem and reports singletons
     * faithfully, so a folder of unrelated `icon_1.png`, `logo_2.png` would otherwise offer a row
     * per file that does nothing a click on the file itself does not.
     */
    const sequences = useMemo(
        () => groupSequences(assets.map(a => a.name)).filter(s => s.frames.length > 1),
        [assets]
    );

    // Drawn in an effect rather than in the click handler because the canvas does not exist yet
    // when the plan is computed — React mounts it on the render that follows. Drawing straight
    // from the handler would silently paint nothing on the first click and work on the second,
    // which is the kind of bug that gets blamed on the exporter.
    useEffect(() => {
        const canvas = sheetCanvas.current;
        if (!sheet || !canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawSheet(ctx, getDocument(), sheet);
    }, [sheet, getDocument]);
    const api = window.electronAPI;

    /** Scan a folder. `folder` may come from the native picker OR from the typed path field —
     *  you usually know where the project is, and pasting it beats clicking through a tree. */
    const scan = async (folder: string | null) => {
        if (!api || !folder) return;
        setBusy(true);
        try {
            const files = await api.readSourceFolder(folder);
            setSourceFolder(folder);
            // The analysis is pure and runs HERE, on file contents the main process read —
            // so the same function the tests exercise is the one the user sees.
            setFindings(scanCapabilities(files));
        } finally { setBusy(false); }
    };

    const browseAssets = async () => {
        if (!api) return;
        const folder = await api.pickFolder();
        if (!folder) return;
        setBusy(true);
        try {
            setAssetFolder(folder);
            setAssets(await api.readAssetFolder(folder));
        } finally { setBusy(false); }
    };

    if (!api) {
        return <div style={{ fontSize: 11, color: "#666", padding: 8 }}>Folder access needs the desktop app.</div>;
    }

    return (
        <div style={{ fontSize: 11 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                {(["source", "assets", "import", "export"] as const).map(t => (
                    <button
                        key={t}
                        onClick={() => setTab(t)}
                        style={{
                            flex: 1, fontSize: 11, padding: "3px 6px", cursor: "pointer", borderRadius: 3,
                            background: tab === t ? UI.accentSoft : "transparent",
                            color: tab === t ? UI.text : "#999", border: `1px solid ${UI.line}`
                        }}
                    >{t === "source" ? "Code" : t === "assets" ? "Assets" : t === "import" ? "Import" : "Export"}</button>
                ))}
            </div>

            {tab === "import" ? (
                <>
                    {/* IT ACTS ON THE SELECTED IMAGE NODE rather than opening a picker of its own:
                        the node already carries the `src`, already has a `sourceRect` field to fill
                        in, and is already on the canvas — so the result is visible where it lands. */}
                    {!selectedImage ? (
                        <div style={{ color: "#999", padding: "6px 2px" }}>
                            Select an image node to slice a sheet into it.
                        </div>
                    ) : (
                        <>
                            <label style={INSPECTOR_LABEL}>Slice a grid into an animation</label>
                            <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                                {([["cell w", cellW, setCellW], ["cell h", cellH, setCellH],
                                   ["margin", margin, setMargin], ["gutter", spacing, setSpacing]] as const).map(([label, value, set]) => (
                                    <input
                                        key={label}
                                        type="number"
                                        data-slice={label}
                                        placeholder={label}
                                        value={value}
                                        onChange={e => set(e.target.value)}
                                        style={{ width: "25%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                                            background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                    />
                                ))}
                            </div>
                            <button
                                data-slice-btn="1"
                                onClick={() => {
                                    // THE NATURAL SIZE COMES FROM THE DECODED IMAGE. Slicing against a
                                    // guessed size is wrong everywhere at once, so an image that has not
                                    // loaded is refused rather than divided.
                                    const size = naturalSize(selectedImage.src);
                                    if (!size) { setImportNote("That image has not decoded yet."); return; }
                                    const opts = { cellWidth: Number(cellW), cellHeight: Number(cellH),
                                        margin: Number(margin), spacing: Number(spacing) };
                                    const grid = sliceGrid(size.width, size.height, opts);
                                    // `sliceGrid` returns null when the cell size does not divide the
                                    // sheet — reported as the mismatch it is, rather than rounded away.
                                    if (!grid) {
                                        setImportNote(`${size.width}x${size.height} does not divide into ${opts.cellWidth}x${opts.cellHeight} cells.`);
                                        return;
                                    }
                                    const cells = sliceCells(grid, opts);
                                    onImportTrack(sliceTrack(cells, { step: Number(step) || 1 }));
                                    setImportNote(`${grid.columns}x${grid.rows} = ${cells.length} cells, ${Number(step) || 1} frames apart.`);
                                }}
                                style={DRAWER_BUTTON}
                            >Slice into an animation</button>
                            <div style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 6 }}>
                                <span style={{ color: "#999" }}>frames per cell</span>
                                <input
                                    type="number"
                                    data-slice="step"
                                    value={step}
                                    onChange={e => setStep(e.target.value)}
                                    style={{ width: 50, fontSize: 11, padding: "2px 4px",
                                        background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                />
                            </div>

                            {/* AN ATLAS is the only route for a sheet that is packed irregularly —
                                57% of real ones — because no division recovers a grid that is not there. */}
                            <label style={INSPECTOR_LABEL}>…or paste a TextureAtlas XML</label>
                            <textarea
                                data-atlas-input="1"
                                value={atlasText}
                                onChange={e => setAtlasText(e.target.value)}
                                placeholder="<TextureAtlas imagePath=…"
                                spellCheck={false}
                                style={{ width: "100%", boxSizing: "border-box", height: 60, fontSize: 10,
                                    fontFamily: "monospace", background: UI.raised, color: UI.text,
                                    border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 4 }}
                            />
                            <button
                                data-atlas-btn="1"
                                onClick={() => {
                                    // The SHARED validator, so the panel cannot accept a descriptor the
                                    // reader would refuse — and says which part it refused.
                                    const bad = atlasError(atlasText);
                                    if (bad) { setImportNote(bad); setAtlasEntries(null); return; }
                                    const atlas = parseTextureAtlas(atlasText);
                                    setAtlasEntries(atlas.entries);
                                    const turned = atlas.entries.filter(e => e.rotated).length;
                                    setImportNote(`${atlas.entries.length} sprites in ${atlas.image || "(unnamed image)"}`
                                        + (turned ? `, ${turned} stored turned` : ""));
                                }}
                                style={DRAWER_BUTTON}
                            >Read the atlas</button>
                            {atlasEntries && (
                                <select
                                    data-atlas-pick="1"
                                    onChange={e => {
                                        const entry = atlasEntries[Number(e.target.value)];
                                        if (entry) { onSetRegion(entry.source); setImportNote(`${entry.name} → ${entry.source.width}x${entry.source.height}`); }
                                    }}
                                    style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                        color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                                >
                                    <option value="">Pick a sprite…</option>
                                    {atlasEntries.slice(0, 2000).map((e, i) => (
                                        <option key={e.name + i} value={i}>{e.name || `sprite ${i}`}</option>
                                    ))}
                                </select>
                            )}
                        </>
                    )}
                    {/* SVG NEEDS NO SELECTION, unlike a sheet: it CREATES nodes rather than filling
                        in numbers on one that exists, so it sits outside the guard above. */}
                    <label style={INSPECTOR_LABEL}>Import an SVG as paths</label>
                    <textarea
                        data-svg-input="1"
                        value={svgText}
                        onChange={e => setSvgText(e.target.value)}
                        placeholder="<svg …>"
                        spellCheck={false}
                        style={{ width: "100%", boxSizing: "border-box", height: 60, fontSize: 10,
                            fontFamily: "monospace", background: UI.raised, color: UI.text,
                            border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 4 }}
                    />
                    <button
                        data-svg-btn="1"
                        onClick={() => {
                            // The SHARED validator, so the panel cannot accept what the reader
                            // would refuse — and names the part it refused.
                            const bad = svgDocumentError(svgText);
                            if (bad) { setImportNote(bad); return; }
                            const doc = parseSvgDocument(svgText);
                            const specs = svgNodeSpecs(doc.shapes);
                            if (specs.length > SVG_PLACE_MAX) {
                                // BOUNDED, and refused rather than truncated: half a drawing placed
                                // silently is worse than a sentence saying it was too big.
                                setImportNote(`${specs.length} shapes is more than the ${SVG_PLACE_MAX} this will place at once.`);
                                return;
                            }
                            onImportSvg(specs);
                            // NOTES ARE SHOWN, not swallowed — a flattened gradient is a fact about
                            // the drawing that just landed, and the reader already recorded it.
                            const flattened = doc.notes.length;
                            setImportNote(`placed ${specs.length} paths`
                                + (flattened ? ` · ${flattened} approximation${flattened === 1 ? "" : "s"}: ${doc.notes[0]}` : ""));
                        }}
                        style={DRAWER_BUTTON}
                    >Place the SVG</button>

                    {/* PALETTES. `paint/Palette` and `paint/Quantize` were whole modules the app
                        could not reach — the feature audit's second and third built-but-unreachable
                        entries. This is the door.

                        A GRID, NOT A REFLOWED LIST. The palette's own `width`/`height` are honoured
                        because the layout is part of the artist's meaning: DawnBringer's 32 colours
                        are 8x4 to group ramps into rows, and reflowing them to fit a panel would
                        destroy the grouping while keeping every colour. A slot with no colour is
                        drawn as a HOLE for the same reason — 56 colours do not fill 12x5, and
                        shifting the tail up would move every swatch after the gap. */}
                    <label style={INSPECTOR_LABEL}>Load palettes from a folder</label>
                    <button
                        data-palette-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.readPaletteFolder(folder);
                                const found: Palette[] = [];
                                const problems: string[] = [];
                                for (const f of files) {
                                    let text: string;
                                    try { text = await api.readPaletteFile(folder, f.path); }
                                    catch (err) { problems.push(`${f.name}: ${String(err)}`); continue; }
                                    // JSON.parse THROWING IS HANDLED HERE, not in the parser: it is
                                    // the one failure that carries a useful message about WHERE the
                                    // file is malformed, and the parser takes parsed JSON so that
                                    // message is not swallowed into a flat null.
                                    let json: unknown;
                                    try { json = JSON.parse(text); }
                                    catch (err) { problems.push(`${f.name}: ${String(err)}`); continue; }
                                    const palette = parsePaletteFile(json, f.name);
                                    // NOT EVERY `.json` IS A PALETTE, and there is no palette
                                    // extension to scan for — so the honest report is how many of
                                    // the files found actually described one.
                                    if (palette) found.push(palette);
                                }
                                setPalettes(found);
                                if (found.length > 0) setPalette(found[0]);
                                setImportNote(`${found.length} palette${found.length === 1 ? "" : "s"} `
                                    + `of ${files.length} .json file${files.length === 1 ? "" : "s"}`
                                    + (problems.length > 0 ? ` · ${problems[0]}` : ""));
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find palettes…"}</button>
                    {palettes.length > 1 && (
                        <select
                            data-palette-list="1"
                            value={palette ? palette.name : ""}
                            onChange={e => setPalette(palettes.find(p => p.name === e.target.value) ?? null)}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            {palettes.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                        </select>
                    )}
                    {palette && (
                        <div data-palette-grid="1">
                            <div style={{
                                display: "grid", gap: 1, marginBottom: 4,
                                gridTemplateColumns: `repeat(${palette.width}, 1fr)`
                            }}>
                                {Array.from({ length: palette.width * palette.height }, (_, i) => {
                                    // ADDRESSED BY SLOT, so a hole stays where it is. `paletteAt`
                                    // is the shared accessor rather than an index into `colours`,
                                    // which may be shorter than the grid.
                                    const c = paletteAt(palette, i % palette.width, Math.floor(i / palette.width));
                                    if (!c || c[3] === 0) {
                                        return <div key={i} style={{ aspectRatio: "1", background: "transparent",
                                            border: `1px dashed ${UI.line}` }} />;
                                    }
                                    const hex = rgbaToHex(c);
                                    return (
                                        <button
                                            key={i}
                                            title={hex}
                                            aria-label={`Palette colour ${hex}`}
                                            onClick={() => onPickColour(hex)}
                                            style={{
                                                aspectRatio: "1", background: hex, cursor: "pointer",
                                                border: paintColour.toLowerCase() === hex.toLowerCase()
                                                    ? `2px solid ${UI.accent}` : "1px solid #0006",
                                                padding: 0
                                            }}
                                        />
                                    );
                                })}
                            </div>
                            {/* THE ATTRIBUTION IS SHOWN because a palette is somebody's work, and
                                the file carries the credit as a field. Dropping it on the floor
                                while using the colours would be the wrong call. */}
                            {palette.comment && (
                                <div style={{ color: "#666", fontSize: 10, whiteSpace: "pre-wrap", marginBottom: 4 }}>
                                    {palette.comment}
                                </div>
                            )}
                            <button
                                data-quantize-btn="1"
                                disabled={!selectedRasterId}
                                title={selectedRasterId
                                    ? "Snap every pixel of the selected canvas to its nearest palette colour"
                                    : "Select a canvas first — quantising acts on a raster's pixels"}
                                onClick={() => onQuantize(palette)}
                                style={{ ...DRAWER_BUTTON, opacity: selectedRasterId ? 1 : 0.5 }}
                            >Quantise the selected canvas</button>
                        </div>
                    )}

                    {/* FONTS need no selection either — registering a family makes it available to
                        every backend at once, because all three ask the platform for it by name. */}
                    <label style={INSPECTOR_LABEL}>Load fonts from a folder</label>
                    <button
                        data-font-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.readFontFolder(folder);
                                const problems: string[] = [];
                                let added = 0;
                                for (const f of files) {
                                    const base64 = await api.readFontBytes(f.path);
                                    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                                    // The SHARED validator, so the panel refuses exactly what the
                                    // reader would — and names which file it refused.
                                    const bad = fontFileError(bytes);
                                    if (bad) { problems.push(`${f.name}: ${bad}`); continue; }
                                    // THE FAMILY COMES OUT OF THE FILE. 36 of the 56 fonts measured
                                    // have a filename that differs from the name the platform
                                    // matches on, so a picker built from filenames would offer
                                    // families no document could ever use.
                                    const note = await registerFont(parseFontFile(bytes), bytes);
                                    if (note) problems.push(note); else added++;
                                }
                                setFonts(registeredFonts());
                                setImportNote(`${added} font${added === 1 ? "" : "s"} registered of ${files.length}`
                                    + (problems.length ? ` · ${problems[0]}` : ""));
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Loading…" : "Load fonts…"}</button>
                    {fonts.length > 0 && (
                        <select
                            data-font-list="1"
                            onChange={e => { if (e.target.value) { editContentFont(e.target.value); } }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Apply a family to the selection…</option>
                            {fonts.map(f => (
                                <option key={f.family} value={f.family}>
                                    {f.family}{f.subfamily && f.subfamily !== "Regular" ? ` ${f.subfamily}` : ""}
                                </option>
                            ))}
                        </select>
                    )}
                    {/* TILED MAPS. A tile is a `sourceRect` and a tileset is a grid this already
                        slices, so the import is mostly resolving what the file NAMES: an external
                        `.tsx`, a sheet, and a compressed layer. Each of those crosses the bridge
                        through its own narrow door, and every path is confined to the folder the
                        user picked — a `.tmx` is a plain text file anyone can write, and
                        `<image source="../../../.ssh/id_rsa"/>` is a well-formed one. */}
                    <label style={INSPECTOR_LABEL}>Import a Tiled map</label>
                    <button
                        data-tiled-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const maps = await api.readTiledFolder(folder);
                                setTiledFolder(folder);
                                setTiledMaps(maps);
                                setImportNote(maps.length === 0
                                    ? "No .tmx files in that folder."
                                    : `${maps.length} map${maps.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find maps…"}</button>
                    {tiledMaps.length > 0 && tiledFolder && (
                        <select
                            data-tiled-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const mapPath = e.target.value;
                                if (!mapPath) return;
                                setBusy(true);
                                try {
                                    const xml = await api.readTiledMap(tiledFolder, mapPath);
                                    // The SHARED validator, so the panel refuses exactly what the
                                    // reader would and says the same thing about why.
                                    const bad = tiledMapError(xml);
                                    if (bad) { setImportNote(`Cannot read that map: ${bad}.`); return; }
                                    const map = parseTiledMap(xml, {
                                        inflate: (d: Uint8Array) => {
                                            let bin = "";
                                            for (const b of d) bin += String.fromCharCode(b);
                                            const r = api.inflateSync(btoa(bin));
                                            if (!r.ok || !r.data) throw new Error(r.error ?? "inflate failed");
                                            return Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
                                        }
                                    });

                                    // EXTERNAL tilesets are resolved here rather than in the parser,
                                    // which has no filesystem and is the reason it stays testable.
                                    const sets: TiledTileset[] = [];
                                    const sheets = new Map<string, string>();
                                    const problems = [...map.notes];
                                    for (const stub of map.tilesets) {
                                        let set = stub;
                                        if (stub.source) {
                                            try {
                                                set = parseTiledTileset(
                                                    await api.readTiledTileset(tiledFolder, mapPath, stub.source), stub);
                                            } catch (err) { problems.push(`${stub.source}: ${String(err)}`); }
                                        }
                                        // A sheet-backed set has ONE image; a collection has one
                                        // per tile. Both are cached by path, so a tile referenced
                                        // a thousand times is still decoded once.
                                        const wanted = set.image ? [set.image]
                                            : set.tiles.flatMap(t => t.image === null ? [] : [t.image]);
                                        for (const rel of wanted) {
                                            if (sheets.has(rel)) continue;
                                            try {
                                                sheets.set(rel, await api.readTiledImage(tiledFolder, mapPath, rel));
                                            } catch (err) { problems.push(`${rel}: ${String(err)}`); }
                                        }
                                        // A SET THAT DECLARES NEITHER ITS COLUMN COUNT NOR ITS
                                        // IMAGE'S SIZE can only be sliced by MEASURING the picture,
                                        // and this is the one place that holds both. `deriveGrid`
                                        // already recovers the count from a DECLARED size — 25 of
                                        // the tree's 26 such sets are answered that way, in the
                                        // parser, with no bitmap — so this is the last case rather
                                        // than the common one, and the decode is paid for only by
                                        // the file that needs it. Tiled's own `perspective_walls`
                                        // is that file: 79 painted cells that resolved to nothing.
                                        const sheetPath = set.image;
                                        if (sheetPath && set.columns <= 0 && set.imageWidth === null) {
                                            const url = sheets.get(sheetPath);
                                            const size = url ? await imageSizeAsync(url) : null;
                                            if (size) set = withImageSize(set, size.width, size.height);
                                            // SAID OUT LOUD when it cannot be measured either, or
                                            // the map arrives empty with nothing to act on — which
                                            // is how this one went unnoticed.
                                            else problems.push(`tileset "${set.name}" states neither a column `
                                                + "count nor its image's size, and the image could not be "
                                                + "measured, so none of its tiles could be placed");
                                        }
                                        sets.push(set);
                                        // Reported once RESOLVED, which is the only point an
                                        // external set has an image to be measured against — and
                                        // that is now after the grid is recovered, since a set with
                                        // no columns has no grid to overflow.
                                        if (stub.source) {
                                            const over = tilesetOverflow(set);
                                            if (over) problems.push(over);
                                        }
                                    }

                                    // THE CONVERSION LIVES IN `core/import/tiledPlacements` NOW, and moving
                                    // it there was the point rather than the tidiness. `window.electronAPI`
                                    // is frozen, so this handler cannot be driven from a test or a script —
                                    // which meant the most intricate part of the importer (grid-or-per-cell
                                    // per layer, tileset deduplication, anchoring, object layers) was the
                                    // one part nothing could exercise. Everything ABOVE this line is
                                    // filesystem work that genuinely needs a filesystem; everything below
                                    // it was pure all along and is now reachable.
                                    const built = buildPlacements(map, sets, sheets,
                                        { newId: generateUUID, problems });
                                    const tiles = built.placements;
                                    const newTilesets = built.tilesets;

                                    if (tiles.length > TILE_PLACE_MAX) {
                                        setImportNote(`${tiles.length} nodes is more than the `
                                            + `${TILE_PLACE_MAX} this will place at once.`);
                                        return;
                                    }
                                    onImportTiles(tiles, newTilesets, map.background,
                                        map.width > 0 && map.tileWidth > 0
                                            ? { width: map.width * map.tileWidth,
                                                height: map.height * map.tileHeight }
                                            : undefined);
                                    setImportNote(tiledImportNote(map, built));
                                } catch (err) {
                                    setImportNote(`Cannot read that map: ${String(err)}`);
                                } finally { setBusy(false); }
                            }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Place a map…</option>
                            {tiledMaps.map(m => <option key={m.path} value={m.path}>{m.relative}</option>)}
                        </select>
                    )}

                    <label style={INSPECTOR_LABEL}>Import a 3D model</label>
                    <button
                        data-model-3d-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.read3DFolder(folder);
                                setModelFolder(folder); setModelFiles(files);
                                setImportNote(files.length === 0 ? "No .gltf or .glb files in that folder."
                                    : `${files.length} 3D model${files.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find glTF/GLB models…"}</button>
                    {modelFiles.length > 0 && modelFolder && (
                        <select
                            data-model-3d-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const file = modelFiles.find(f => f.path === e.target.value);
                                if (!file) return;
                                setBusy(true);
                                try {
                                    const loaded = await loadAsset3D(api, modelFolder, file.path);
                                    await onImport3D(file.path, file.name.replace(/\.(gltf|glb)$/i, ""), loaded);
                                    setImportNote(`Imported ${loaded.mesh.instances.length} primitive${loaded.mesh.instances.length === 1 ? "" : "s"}`
                                        + (loaded.notes.length ? ` · ${loaded.notes[0]}` : ""));
                                } catch (err) { setImportNote(String(err instanceof Error ? err.message : err)); }
                                finally { setBusy(false); }
                            }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Import a model…</option>
                            {modelFiles.map(f => <option key={f.path} value={f.path}>{f.relative}</option>)}
                        </select>
                    )}

                    <label style={INSPECTOR_LABEL}>Import an HDR environment</label>
                    <button disabled={busy} onClick={async () => {
                        const folder = await api.pickFolder(); if (!folder) return;
                        setBusy(true);
                        try {
                            const files = await api.readEnvironmentFolder(folder);
                            setEnvironmentFolder(folder); setEnvironmentFiles(files);
                            setImportNote(files.length ? `${files.length} HDR environment${files.length === 1 ? "" : "s"} found`
                                : "No Radiance .hdr files in that folder.");
                        } finally { setBusy(false); }
                    }} style={DRAWER_BUTTON}>{busy ? "Reading…" : "Find Radiance HDR files…"}</button>
                    {environmentFiles.length > 0 && environmentFolder && (
                        <select data-environment-3d-list="1" defaultValue="" onChange={async event => {
                            const file = environmentFiles.find(candidate => candidate.path === event.target.value);
                            if (!file) return;
                            setBusy(true);
                            try {
                                const image = await loadEnvironment3D(api, environmentFolder, file.path);
                                await onImportEnvironment3D(file.path, file.name.replace(/\.hdr$/i, ""), image);
                                setImportNote(`Imported HDR environment ${image.width}×${image.height}`);
                            } catch (error) { setImportNote(String(error instanceof Error ? error.message : error)); }
                            finally { setBusy(false); }
                        }} style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                            color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}>
                            <option value="">Use an environment…</option>
                            {environmentFiles.map(file => <option key={file.path} value={file.path}>{file.relative}</option>)}
                        </select>
                    )}

                    {/* THE FILE THE SHEET WAS EXPORTED FROM. The reader was written months ago,
                        tested, pinned in apiSurface, and had no door — and opening one meant
                        building a frame compositor, a write path for `Document.clips`, and a
                        transaction that can carry two document-level deltas. None was about
                        Aseprite; all three were things this engine could not do. */}
                    <button
                        data-ase-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const files = await api.readAsepriteFolder(folder);
                                setAseFolder(folder);
                                setAseFiles(files);
                                setImportNote(files.length === 0
                                    ? "No .aseprite files in that folder."
                                    : `${files.length} Aseprite file${files.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find Aseprite files…"}</button>
                    {aseFiles.length > 0 && aseFolder && (
                        <select
                            data-ase-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const filePath = e.target.value;
                                if (!filePath) return;
                                setBusy(true);
                                try {
                                    const b64 = await api.readAsepriteBytes(aseFolder, filePath);
                                    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                                    // THE SHARED VALIDATOR, so the panel refuses exactly what the
                                    // reader would and says the same thing about why.
                                    const bad = asepriteError(bytes);
                                    if (bad) { setImportNote(`Cannot read that file: ${bad}.`); return; }
                                    // CEL PIXELS ARE ZLIB, the same compression a `.tmx` layer uses,
                                    // so the channel that already exists serves both.
                                    const file = parseAseprite(bytes, {
                                        inflate: (d: Uint8Array) => {
                                            let bin = "";
                                            for (const b of d) bin += String.fromCharCode(b);
                                            const r = api.inflateSync(btoa(bin));
                                            if (!r.ok || !r.data) throw new Error(r.error ?? "inflate failed");
                                            return Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
                                        }
                                    });
                                    const timeline = asepriteTimeline(file);
                                    // ENCODED HERE because only the renderer has a canvas, and the
                                    // compositor is pure on purpose — it returns pixels, not a PNG.
                                    const canvas = document.createElement("canvas");
                                    canvas.width = file.width;
                                    canvas.height = file.height;
                                    const ctx = canvas.getContext("2d");
                                    if (!ctx) { setImportNote("No 2D context to compose frames with."); return; }
                                    const track: Keyframe[] = [];
                                    const notes = new Set<string>();
                                    for (let f = 0; f < file.frames.length; f++) {
                                        const composed = composeFrame(file, f);
                                        if (!composed) continue;
                                        for (const n of composed.notes) notes.add(n);
                                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                                        ctx.putImageData(new ImageData(
                                            new Uint8ClampedArray(composed.rgba), composed.width, composed.height), 0, 0);
                                        track.push({ frame: f, values: { src: canvas.toDataURL("image/png") } });
                                    }
                                    if (track.length === 0) { setImportNote("That file has no frames to import."); return; }
                                    onImportAseprite({
                                        name: (aseFiles.find(x => x.path === filePath)?.name ?? "aseprite")
                                            .replace(/\.(aseprite|ase)$/i, ""),
                                        first: track[0].values.src as string,
                                        track,
                                        timeline,
                                        clips: asepriteClips(file),
                                        width: file.width,
                                        height: file.height
                                    });
                                    setImportNote(`${track.length} frames at ${timeline.fps}fps, `
                                        + `${file.tags.length} tag${file.tags.length === 1 ? "" : "s"}`
                                        // BLEND MODES THIS CANNOT HONOUR ARE SURFACED rather than
                                        // left in a console nobody reads — the compositor names them.
                                        + (notes.size > 0 ? ` — ${notes.size} layer(s) drawn as normal` : ""));
                                } catch (err) {
                                    setImportNote(`Could not read that file: ${String(err).slice(0, 80)}`);
                                } finally { setBusy(false); }
                            }}
                            style={{ ...DRAWER_BUTTON, marginBottom: 6 }}
                        >
                            <option value="">Import an animation…</option>
                            {aseFiles.map(f => <option key={f.path} value={f.path}>{f.relative}</option>)}
                        </select>
                    )}

                    {/* A `.unitypackage` is a gzipped tar of GUID folders, and nothing here could
                        open one — seven sit in this tree. This is the door: the reader was written
                        first and left deliberately unreachable, which is a state this project
                        treats as a defect rather than a milestone. */}
                    <button
                        data-unity-btn="1"
                        disabled={busy}
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                const packs = await api.readUnityFolder(folder);
                                setUnityFolder(folder);
                                setUnityPacks(packs);
                                setUnityAssets([]);
                                setImportNote(packs.length === 0
                                    ? "No .unitypackage files in that folder."
                                    : `${packs.length} package${packs.length === 1 ? "" : "s"} found`);
                            } finally { setBusy(false); }
                        }}
                        style={DRAWER_BUTTON}
                    >{busy ? "Reading…" : "Find Unity packages…"}</button>
                    {unityPacks.length > 0 && unityFolder && (
                        <select
                            data-unity-list="1"
                            defaultValue=""
                            onChange={async e => {
                                const pkgPath = e.target.value;
                                if (!pkgPath) return;
                                setBusy(true);
                                try {
                                    const b64 = await api.readUnityPackage(unityFolder, pkgPath);
                                    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                                    // THE INJECTION POINT, used at last: the parser takes a gunzip
                                    // it calls during the parse, which is what keeps it pure and
                                    // testable with no decompressor present.
                                    const held = parseUnityPackage(bytes, {
                                        gunzip: d => {
                                            let bin = "";
                                            for (let i = 0; i < d.length; i++) bin += String.fromCharCode(d[i]);
                                            const r = api.gunzipSync(btoa(bin));
                                            if (!r.ok || !r.data) throw new Error(r.error ?? "gunzip failed");
                                            return Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
                                        }
                                    });
                                    setUnityAssets(held.assets);
                                    const images = held.assets.filter(a => UNITY_IMAGE.test(a.path)).length;
                                    setImportNote(`${held.assets.length} files, ${images} placeable`
                                        + (held.notes.length > 0 ? ` — ${held.notes.length} not read` : ""));
                                } catch (err) {
                                    setImportNote(String(err instanceof Error ? err.message : err));
                                } finally { setBusy(false); }
                            }}
                            style={{ width: "100%", fontSize: 11, marginBottom: 6, background: UI.raised,
                                color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3 }}
                        >
                            <option value="">Open a package…</option>
                            {unityPacks.map(u => (
                                <option key={u.path} value={u.path}>
                                    {u.relative} ({Math.round(u.bytes / 1024)}KB)
                                </option>
                            ))}
                        </select>
                    )}
                    {unityAssets.length > 0 && (
                        <div data-unity-assets="1" style={{ maxHeight: 180, overflowY: "auto", marginBottom: 6 }}>
                            {unityAssets.filter(a => UNITY_IMAGE.test(a.path)).map(a => (
                                <button
                                    key={a.guid}
                                    title={a.path}
                                    aria-label={`Place ${a.path}`}
                                    onClick={() => {
                                        // BYTES TO A DATA URL, because that is what a `core.image`
                                        // holds — a package's files never touch the disk, so nothing
                                        // is unpacked anywhere the author did not ask for.
                                        let bin = "";
                                        for (let i = 0; i < a.bytes.length; i++) bin += String.fromCharCode(a.bytes[i]);
                                        const ext = a.path.split(".").pop()!.toLowerCase();
                                        onPlaceImage(`data:image/${ext === "jpg" ? "jpeg" : ext};base64,${btoa(bin)}`,
                                            a.path.split("/").pop() ?? a.path);
                                    }}
                                    style={{ ...DRAWER_BUTTON, textAlign: "left", width: "100%", marginBottom: 2 }}
                                >{a.path.split("/").pop()}</button>
                            ))}
                        </div>
                    )}

                    {importNote && <div style={{ color: "#6a9", wordBreak: "break-all" }}>{importNote}</div>}
                </>
            ) : tab === "export" ? (
                <>
                    <button
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                // The SAME pure exporter the tests exercise; the main process only writes.
                                const written = await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument(), exportTextLines, EXPORT_IMAGES));
                                setExported(written);
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export SVG to a folder…"}</button>
                    <button disabled={busy} style={DRAWER_BUTTON} data-export-png="1" onClick={async () => {
                        setBusy(true);
                        try {
                            const folder = await api.pickFolder();
                            if (folder) setExported(await api.writePngIntoFolder(folder, "design.png", await exportCanvasPng(getDocument())));
                        } catch (error) { setExported(`PNG export failed: ${String(error)}`); }
                        finally { setBusy(false); }
                    }}>Export whole canvas as PNG…</button>
                    <button disabled={busy} style={DRAWER_BUTTON} data-export-game="1" onClick={async () => {
                        setBusy(true);
                        try {
                            const folder = await api.pickFolder();
                            if (folder) setExported(await api.exportGame(folder, serializeDocument(getDocument()), getProjectPath()));
                        } catch (error) { setExported(`Game export failed: ${String(error)}`); }
                        finally { setBusy(false); }
                    }}>Export offline 2D game (HTML)…</button>
                    <button disabled={busy} style={DRAWER_BUTTON} data-export-game-3d="1" onClick={async () => {
                        setBusy(true);
                        try {
                            const folder = await api.pickFolder();
                            if (folder) setExported(await api.exportGame3D(folder, serializeDocument(getDocument()), getProjectPath(), registeredFontPayloads()));
                        } catch (error) { setExported(`3D game export failed: ${String(error)}`); }
                        finally { setBusy(false); }
                    }}>Export offline 3D game (HTML)…</button>
                    <small>3D export includes referenced assets only. Check their redistribution and credit requirements before sharing.</small>

                    {/* A MAP CAN LEAVE AGAIN (2026-08-10). Canvas Fogworks reads a Tiled map, turns each layer
                        into one grid, places its objects and authors terrain — and until now
                        nothing went the other way, which made this tool a one-way door for art.
                        The sheet is named rather than copied: a `.tmx` states a relative path, and
                        only the person choosing the folder knows what is beside it. */}
                    <button
                        data-export-tmx="1"
                        onClick={async () => {
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                // The SAME pure exporter the round-trip test exercises; the main
                                // process only writes.
                                const out = exportTiledMap(getDocument(), "tiles.png");
                                if (out.xml === "") { setExported(out.notes[0] ?? "nothing to export"); return; }
                                const written = await api.writeIntoFolder(folder, "map.tmx", out.xml);
                                // WHAT COULD NOT BE WRITTEN IS SAID, not swallowed: a .tmx holds one
                                // size for every layer, and a map that quietly lost one is the kind
                                // of export somebody discovers a week later.
                                setExported(written + (out.notes.length > 0 ? ` · ${out.notes[0]}` : ""));
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export the tile layers as .tmx…"}</button>
                    <input
                        type="text"
                        placeholder="…or paste a folder path and press Enter"
                        onKeyDown={async e => {
                            if (e.key !== "Enter") return;
                            const folder = (e.target as HTMLInputElement).value.trim();
                            if (!folder) return;
                            setBusy(true);
                            try { setExported(await api.writeIntoFolder(folder, "design.svg", exportSVG(getDocument(), exportTextLines, EXPORT_IMAGES))); }
                            finally { setBusy(false); }
                        }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 6 }}
                    />
                    {exported && <div style={{ color: "#6a9", wordBreak: "break-all" }}>Wrote {exported}</div>}
                    {/* PREVIEW: the same `exportSVG` output, without writing a file. Worth having
                        on its own — you can read what you are about to hand someone — and it is
                        the only way to see the export without a native dialog in the way. */}
                    <button onClick={() => setPreview(exportSVG(getDocument(), exportTextLines, EXPORT_IMAGES))} style={DRAWER_BUTTON}>
                        Preview the SVG
                    </button>
                    {/* SPRITE SHEET — the game-facing export. Two files, because an engine needs
                        both: the texture, and the description of which rectangle is which frame of
                        which clip. The PLAN is computed here and shown before anything is written,
                        so an oversize sheet is a sentence rather than a failed encode. */}
                    <button
                        onClick={async () => {
                            const plan = planSheet(getDocument());
                            if (sheetTooLarge(plan)) {
                                setPreview(`Sheet would be ${plan.width}x${plan.height}px — too large to export.`);
                                return;
                            }
                            const folder = await api.pickFolder();
                            if (!folder) return;
                            setBusy(true);
                            try {
                                setExported(await writeSheet(getDocument(), plan, folder));
                            } finally { setBusy(false); }
                        }}
                        disabled={busy}
                        style={DRAWER_BUTTON}
                    >{busy ? "Writing…" : "Export sprite sheet to a folder…"}</button>
                    {/* The ATLAS without writing anything — the half that can be read and checked. */}
                    <button
                        data-sheet-preview-btn="1"
                        onClick={() => {
                            const plan = planSheet(getDocument());
                            setPreview(JSON.stringify(sheetAtlas(getDocument(), plan, "sheet.png"), null, 2));
                            setSheet(plan);
                        }}
                        style={DRAWER_BUTTON}
                    >
                        Preview the sprite-sheet atlas
                    </button>
                    {/* THE SHEET ITSELF, drawn through the same `drawSheet` the export uses, before
                        any folder is chosen. Worth having for the same reason the SVG preview is:
                        you can see what you are about to hand an engine. It also means the drawing
                        half is reachable without a native dialog standing in front of it. */}
                    {sheet && (
                        <canvas
                            ref={sheetCanvas}
                            data-sheet-canvas="1"
                            width={sheet.width}
                            height={sheet.height}
                            style={{ width: "100%", marginTop: 6, border: `1px solid ${UI.line}`, imageRendering: "pixelated" }}
                        />
                    )}
                    {preview !== null && (
                        <textarea
                            readOnly
                            value={preview}
                            data-svg-preview="1"
                            spellCheck={false}
                            style={{
                                width: "100%", height: 140, boxSizing: "border-box", marginTop: 6,
                                fontSize: 10, fontFamily: "ui-monospace, Consolas, monospace",
                                background: UI.bg, color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 3
                            }}
                        />
                    )}
                    <div style={{ color: "#666", marginTop: 6 }}>
                        The whole document, framed to its own content — no grid, no selection chrome.
                    </div>
                </>
            ) : tab === "source" ? (
                <>
                    <button onClick={async () => scan(await api.pickFolder())} disabled={busy} style={DRAWER_BUTTON}>
                        {busy ? "Scanning…" : "Choose a folder…"}
                    </button>
                    <input
                        type="text"
                        placeholder="…or paste a path and press Enter"
                        onKeyDown={e => { if (e.key === "Enter") scan((e.target as HTMLInputElement).value.trim() || null); }}
                        style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "3px 5px", background: UI.raised, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 3, marginBottom: 6 }}
                    />
                    {sourceFolder && (
                        <div style={{ color: "#666", margin: "6px 0", wordBreak: "break-all" }}>{sourceFolder}</div>
                    )}
                    {findings && findings.length === 0 && (
                        <div style={{ color: "#6a9", padding: "6px 0" }}>Nothing unwired found — every export is referenced somewhere.</div>
                    )}
                    {findings && findings.length > 0 && (
                        <>
                            <div style={{ color: "#888", margin: "6px 0" }}>
                                {findings.length} capabilit{findings.length === 1 ? "y" : "ies"} with no apparent UI
                            </div>
                            {findings.slice(0, 200).map(c => (
                                <div key={`${c.path}:${c.line}:${c.name}`} style={{ borderTop: `1px solid ${UI.line}`, padding: "5px 0" }}>
                                    <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                                        <span style={{
                                            fontSize: 9, padding: "0 4px", borderRadius: 2, color: UI.bg,
                                            background: c.confidence === "high" ? "#6ac48a" : c.confidence === "medium" ? "#d0a85c" : "#5a5a72"
                                        }}>{c.kind}</span>
                                        <span style={{ color: UI.text }}>{c.name}</span>
                                    </div>
                                    <div style={{ color: "#666" }}>{c.path}:{c.line}</div>
                                    <div style={{ color: "#7a7a90" }}>{c.reason}</div>
                                </div>
                            ))}
                            {findings.length > 200 && (
                                <div style={{ color: "#888", paddingTop: 6 }}>…and {findings.length - 200} more (showing the top 200).</div>
                            )}
                        </>
                    )}
                </>
            ) : (
                <>
                    <button onClick={browseAssets} disabled={busy} style={DRAWER_BUTTON}>
                        {busy ? "Reading…" : "Choose an asset folder…"}
                    </button>
                    {assetFolder && <div style={{ color: "#666", margin: "6px 0", wordBreak: "break-all" }}>{assetFolder}</div>}
                    {sequences.length > 0 && (
                        <>
                            <label style={INSPECTOR_LABEL}>Numbered runs in this folder</label>
                            <div style={{ marginBottom: 8 }}>
                                {sequences.map(s => {
                                    const tooMany = s.frames.length > SEQUENCE_IMPORT_MAX;
                                    return (
                                        <button
                                            key={s.name}
                                            data-sequence={s.name}
                                            disabled={busy || tooMany}
                                            title={tooMany
                                                // THE TILESET CASE, which is most of what a real folder holds: a sheet
                                                // exported as `tile_0000.png … tile_9999.png` is a numbered run by every
                                                // rule this reader has, and it is not an animation. Measured here: one
                                                // pack groups to 11,846 frames. Refusing loudly beats reading eleven
                                                // thousand images into data URLs to build an eight-minute "animation".
                                                ? `${s.frames.length} frames — too many to be an animation. This is `
                                                  + `almost certainly a tileset exported one file per tile; slice the `
                                                  + `sheet instead.`
                                                : `Import ${s.frames.length} frames as one animated node`}
                                            onClick={async () => {
                                                setBusy(true);
                                                try {
                                                    const prepared = await prepareSequenceImport(api, assetFolder!, assets, s);
                                                    if (!prepared.ok) { setImportNote(prepared.error); return; }
                                                    onImportSequence(prepared.name, prepared.first, prepared.track);
                                                    setImportNote(prepared.note);
                                                } finally { setBusy(false); }
                                            }}
                                            style={{ ...DRAWER_BUTTON, textAlign: "left", opacity: tooMany ? 0.5 : 1 }}
                                        >{s.name || "(unnamed)"} — {s.frames.length} frames</button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                        {assets.slice(0, 300).map(a => (
                            <button
                                key={a.path}
                                title={`${a.relative} — click to place on the canvas`}
                                onClick={async () => {
                                    setBusy(true);
                                    try {
                                        onPlaceImage(await api.readImageDataUrl(assetFolder!, a.path), a.name);
                                        setImportNote(`Placed ${a.relative}.`);
                                    } catch (err) {
                                        setImportNote(`Could not read ${a.relative}: ${String(err instanceof Error ? err.message : err)}`);
                                    } finally { setBusy(false); }
                                }}
                                style={{ ...DRAWER_BUTTON, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >{a.name}</button>
                        ))}
                    </div>
                    {assetFolder && assets.length === 0 && <div style={{ color: "#666" }}>No images in that folder.</div>}
                </>
            )}
        </div>
    );
}
