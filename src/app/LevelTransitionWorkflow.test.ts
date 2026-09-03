/** @module LevelTransitionWorkflow.test @description All-or-nothing level project loading coverage. */

import { createEmptyDocument } from "../core/document/Document";
import { serializeDocument } from "../core/document/Serializer";
import { loadLevelTransition } from "./LevelTransitionWorkflow";

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
