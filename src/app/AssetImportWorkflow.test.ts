/**
 * @module AssetImportWorkflow.test
 * @description Covers confined frame reads, order preservation and incomplete sequence handling.
 */

import { prepareSequenceImport } from "./AssetImportWorkflow";

test("a numbered run is read in sequence order and becomes data-URL keyframes", async () => {
    const readImageDataUrl = jest.fn(async (_folder: string, filePath: string) => `data:image/png;base64,${filePath}`);
    const result = await prepareSequenceImport({ readImageDataUrl }, "C:\\art", [
        { path: "p10", name: "run_10.png", relative: "run_10.png" },
        { path: "p2", name: "run_2.png", relative: "run_2.png" }
    ], { name: "run", frames: [
        { file: "run_2.png", index: 2 }, { file: "run_10.png", index: 10 }
    ] });

    expect(readImageDataUrl.mock.calls).toEqual([["C:\\art", "p2"], ["C:\\art", "p10"]]);
    expect(result).toEqual({
        ok: true,
        name: "run",
        first: "data:image/png;base64,p2",
        track: [
            { frame: 0, values: { src: "data:image/png;base64,p2" } },
            { frame: 1, values: { src: "data:image/png;base64,p10" } }
        ],
        note: "run: 2 frames."
    });
});

test("a missing first frame refuses the import instead of choosing a later frame", async () => {
    const readImageDataUrl = jest.fn(async (_folder: string, filePath: string) => `data:image/png;base64,${filePath}`);
    const result = await prepareSequenceImport({ readImageDataUrl }, "C:\\art", [
        { path: "p2", name: "run_2.png", relative: "run_2.png" }
    ], { name: "run", frames: [
        { file: "run_1.png", index: 1 }, { file: "run_2.png", index: 2 }
    ] });
    expect(result).toEqual({ ok: false, error: "Missing frame: run_1.png." });
});

test("one unread middle frame refuses the whole sequence instead of leaving a file path in its track", async () => {
    const readImageDataUrl = jest.fn(async (_folder: string, filePath: string) => {
        if (filePath === "p2") throw new Error("access denied");
        return `data:image/png;base64,${filePath}`;
    });
    const result = await prepareSequenceImport({ readImageDataUrl }, "C:\\art", [
        { path: "p1", name: "run_1.png", relative: "run_1.png" },
        { path: "p2", name: "run_2.png", relative: "run_2.png" }
    ], { name: "run", frames: [
        { file: "run_1.png", index: 1 }, { file: "run_2.png", index: 2 }
    ] });
    expect(result).toEqual({ ok: false, error: "Could not read frame run_2.png: access denied" });
});

test("duplicate basenames in subfolders are refused rather than importing an arbitrary one", async () => {
    const readImageDataUrl = jest.fn(async () => "data:image/png;base64,x");
    const result = await prepareSequenceImport({ readImageDataUrl }, "C:\\art", [
        { path: "a\\run_1.png", name: "run_1.png", relative: "a/run_1.png" },
        { path: "b\\run_1.png", name: "run_1.png", relative: "b/run_1.png" }
    ], { name: "run", frames: [{ file: "run_1.png", index: 1 }] });
    expect(result).toEqual({ ok: false, error: "Frame name is ambiguous in subfolders: run_1.png." });
    expect(readImageDataUrl).not.toHaveBeenCalled();
});
