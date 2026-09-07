/** @module LevelTransitionWorkflow.test @description All-or-nothing level project loading coverage. */

import { createEmptyDocument } from "../core/document/Document";
import { serializeDocument } from "../core/document/Serializer";
import { loadLevelTransition, RuntimeProject } from "./LevelTransitionWorkflow";

test("a level is deserialized before adoption and reports its resolved path", async () => {
    const content = serializeDocument(createEmptyDocument());
    const readLevelFile = jest.fn(async () => ({ filePath: "C:/game/level-2.vde", content }));
    const loaded = await loadLevelTransition({ readLevelFile }, "C:/game/level-1.vde", "level-2.vde");
    expect(readLevelFile).toHaveBeenCalledWith("C:/game/level-1.vde", "level-2.vde");
    expect(loaded.filePath).toBe("C:/game/level-2.vde");
});

test("unsaved projects and malformed destinations fail without a partial document", async () => {
    const readLevelFile = jest.fn();
    await expect(loadLevelTransition({ readLevelFile }, null, "level-2.vde")).rejects.toThrow(/Save this project/);
    expect(readLevelFile).not.toHaveBeenCalled();
    await expect(loadLevelTransition({ readLevelFile: async () => ({ filePath: "x", content: "{" }) },
        "C:/game/level-1.vde", "level-2.vde")).rejects.toThrow(/Invalid JSON/);
});

test("runtime transitions use their own path and discard late reads after Stop", async () => {
    const session = new RuntimeProject();
    const content = serializeDocument(createEmptyDocument());
    const readLevelFile = jest.fn(async () => ({ filePath: "C:/game/sub/second.vde", content }));
    expect(await session.transition({ readLevelFile }, "C:/game/first.vde", "sub/second.vde")).toBe(true);
    await session.transition({ readLevelFile }, "C:/game/first.vde", "third.vde");
    expect(readLevelFile).toHaveBeenLastCalledWith("C:/game/sub/second.vde", "third.vde");
    let resolve!: (value: { filePath: string; content: string }) => void;
    const pending = session.transition({ readLevelFile: () => new Promise(done => { resolve = done; }) }, null, "last.vde");
    session.reset(); resolve({ filePath: "late.vde", content });
    expect(await pending).toBe(false);
    expect(session.document).toBeNull(); expect(session.filePath).toBeNull();
});
