/**
 * @module RecoveryRestore.test
 * @description Browser and desktop recovery decisions, including newer explicit saves and scripted relaunch choices.
 */
import { createEmptyDocument } from "../core/document/Document";
import { deserializeDocument, serializeDocument } from "../core/document/Serializer";
import {
    BROWSER_DOCUMENT_KEY, BROWSER_RECOVERY_KEY, decideRecovery, parseRecoverySnapshot,
    readDesktopRecovery, recoveryChoiceFromDialog, restoreBrowserRecovery, scriptedRecoveryChoice
} from "./RecoveryRestore";
import type { RecoverySnapshot } from "./RecoveryRestore";

function snapshot(content: string, savedContent: string, filePath: string | null = "project.vde"): RecoverySnapshot {
    return { content, savedContent, filePath };
}

function host(store: Record<string, string>) {
    const calls = { apply: 0, adopt: [] as string[], status: [] as string[], marks: [] as string[], confirms: [] as string[] };
    const api = {
        calls,
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value; },
        confirm: (message: string) => { calls.confirms.push(message); return true; },
        apply: () => { calls.apply++; return true; },
        adopt: (saved: string) => { calls.adopt.push(saved); },
        status: (message: string) => { calls.status.push(message); },
        mark: (outcome: string) => { calls.marks.push(outcome); }
    };
    return api;
}

test("dialog restore is the second button and a smoke decision requires the relaunch flag", () => {
    expect(recoveryChoiceFromDialog(1)).toBe(true);
    expect(recoveryChoiceFromDialog(0)).toBe(false);
    expect(scriptedRecoveryChoice({ decision: "restore" })).toBeNull();
    expect(scriptedRecoveryChoice({ smoke: "restore", decision: "restore" })).toBe(true);
    expect(scriptedRecoveryChoice({ smoke: "discard", decision: "discard" })).toBe(false);
    expect(scriptedRecoveryChoice({ smoke: "edit" })).toBeNull();
});

test("a recovery snapshot round-trips and rejects an oversized or partial record", () => {
    const saved = snapshot("{\"document\":{}}", "{\"document\":{}}", null);
    expect(parseRecoverySnapshot(JSON.stringify(saved))).toEqual(saved);
    expect(parseRecoverySnapshot("null")).toBeNull();
    expect(() => parseRecoverySnapshot("{\"content\":1,\"savedContent\":\"{}\",\"filePath\":null}")).toThrow(/Invalid/);
});

test("restore follows the savepoint, clears an already-saved edit, and keeps a newer explicit save", () => {
    const base = createEmptyDocument();
    base.metadata.project_name = "Saved";
    const saved = serializeDocument(base);
    const editedDoc = deserializeDocument(saved);
    editedDoc.metadata.project_name = "Edited";
    const edited = serializeDocument(editedDoc);
    const newerDoc = deserializeDocument(saved);
    newerDoc.metadata.project_name = "Newer";
    const newer = serializeDocument(newerDoc);
    expect(decideRecovery(null, saved).action).toBe("none");
    expect(decideRecovery(snapshot(edited, saved), null).action).toBe("restore");
    expect(decideRecovery(snapshot(edited, saved), saved).action).toBe("restore");
    expect(decideRecovery(snapshot(edited, saved), edited)).toEqual({ action: "clear", reason: "already-saved" });
    expect(decideRecovery(snapshot(edited, saved), newer)).toEqual({
        action: "preserve", reason: "explicit-save-differs"
    });
    expect(decideRecovery(snapshot(edited, saved), "not-a-document")).toEqual({
        action: "preserve", reason: "explicit-save-differs"
    });
});

test("whitespace differences in the same document still count as the savepoint", () => {
    const doc = createEmptyDocument();
    doc.metadata.project_name = "Round trip";
    const saved = serializeDocument(doc);
    const pretty = JSON.stringify(JSON.parse(saved));
    expect(pretty).not.toBe(saved);
    expect(decideRecovery(snapshot(saved, saved), pretty).action).toBe("restore");
    const edited = deserializeDocument(saved);
    edited.metadata.project_name = "Recovered";
    const content = serializeDocument(edited);
    expect(decideRecovery(snapshot(content, saved), pretty).action).toBe("restore");
    expect(decideRecovery(snapshot(content, saved), content)).toEqual({ action: "clear", reason: "already-saved" });
});

test("desktop restore approves the project path and does not clear a declined or newer snapshot", async () => {
    const base = createEmptyDocument();
    base.metadata.project_name = "Saved";
    const saved = serializeDocument(base);
    const editedDoc = deserializeDocument(saved);
    editedDoc.metadata.project_name = "Edited";
    const edited = serializeDocument(editedDoc);
    const newerDoc = deserializeDocument(saved);
    newerDoc.metadata.project_name = "Newer";
    const newer = serializeDocument(newerDoc);
    const approved: string[] = [];
    const cleared: string[] = [];
    const restore = await readDesktopRecovery({
        readRecovery: async () => JSON.stringify(snapshot(edited, saved, "/tmp/project.vde")),
        readExplicit: async () => saved,
        clearRecovery: async () => { cleared.push("cleared"); },
        confirm: () => true,
        approve: filePath => approved.push(filePath)
    });
    expect(restore).toMatchObject({ content: edited, savedContent: saved });
    expect(approved).toEqual(["/tmp/project.vde"]);
    const declined = await readDesktopRecovery({
        readRecovery: async () => JSON.stringify(snapshot(edited, saved, "/tmp/project.vde")),
        readExplicit: async () => saved,
        clearRecovery: async () => { cleared.push("cleared"); },
        confirm: () => false,
        approve: () => { throw new Error("declined recovery must not approve a path"); }
    });
    expect(declined).toEqual({ declined: true });
    const preserved = await readDesktopRecovery({
        readRecovery: async () => JSON.stringify(snapshot(edited, saved, "/tmp/project.vde")),
        readExplicit: async () => newer,
        clearRecovery: async () => { cleared.push("cleared"); },
        confirm: () => { throw new Error("a newer save must not prompt"); },
        approve: () => { throw new Error("a newer save must not be approved for overwrite"); }
    });
    expect(preserved).toEqual({ preserved: true });
    expect(cleared).toEqual([]);
    const already = await readDesktopRecovery({
        readRecovery: async () => JSON.stringify(snapshot(edited, saved)),
        readExplicit: async () => edited,
        clearRecovery: async () => { cleared.push("cleared"); },
        confirm: () => { throw new Error("an already-saved recovery must not prompt"); },
        approve: () => undefined
    });
    expect(already).toBeNull();
    expect(cleared).toEqual(["cleared"]);
});

test("browser restore adopts the savepoint and leaves a declined or newer snapshot stored", () => {
    const base = createEmptyDocument();
    base.metadata.project_name = "Saved";
    const saved = serializeDocument(base);
    const editedDoc = deserializeDocument(saved);
    editedDoc.metadata.project_name = "Edited";
    const edited = serializeDocument(editedDoc);
    const newerDoc = deserializeDocument(saved);
    newerDoc.metadata.project_name = "Newer";
    const newer = serializeDocument(newerDoc);
    const store: Record<string, string> = {
        [BROWSER_DOCUMENT_KEY]: saved,
        [BROWSER_RECOVERY_KEY]: JSON.stringify(snapshot(edited, saved, null))
    };
    const accepting = host(store);
    expect(restoreBrowserRecovery(accepting)).toEqual({ ready: true, holdCleanCheckpoint: false });
    expect(accepting.calls.apply).toBe(1);
    expect(accepting.calls.adopt).toEqual([saved]);
    expect(accepting.calls.marks).toEqual(["restored"]);
    expect(accepting.calls.status[0]).toMatch(/Save to keep them/);

    const declining = host({ ...store });
    declining.confirm = () => false;
    expect(restoreBrowserRecovery(declining).ready).toBe(true);
    expect(declining.calls.marks).toEqual(["declined"]);
    expect(declining.calls.apply).toBe(0);
    expect(store[BROWSER_RECOVERY_KEY]).toContain("Edited");

    const newerHost = host({
        [BROWSER_DOCUMENT_KEY]: newer,
        [BROWSER_RECOVERY_KEY]: JSON.stringify(snapshot(edited, saved, null))
    });
    const held = restoreBrowserRecovery(newerHost);
    expect(held).toEqual({ ready: true, holdCleanCheckpoint: true });
    expect(newerHost.calls.apply).toBe(0);
    expect(newerHost.calls.marks).toEqual(["preserved"]);
    expect(newerHost.getItem(BROWSER_RECOVERY_KEY)).toContain("Edited");
});

test("a browser recovery that is already saved is cleared, and a corrupt record is preserved", () => {
    const base = createEmptyDocument();
    base.metadata.project_name = "Saved";
    const saved = serializeDocument(base);
    const editedDoc = deserializeDocument(saved);
    editedDoc.metadata.project_name = "Edited";
    const edited = serializeDocument(editedDoc);
    const store: Record<string, string> = {
        [BROWSER_DOCUMENT_KEY]: edited,
        [BROWSER_RECOVERY_KEY]: JSON.stringify(snapshot(edited, saved, null))
    };
    const cleared = host(store);
    expect(restoreBrowserRecovery(cleared).ready).toBe(true);
    expect(store[BROWSER_RECOVERY_KEY]).toBe("null");
    expect(cleared.calls.apply).toBe(0);
    expect(cleared.calls.marks).toEqual(["cleared"]);

    const corrupt = host({ [BROWSER_RECOVERY_KEY]: "{\"content\":" });
    const failed = restoreBrowserRecovery(corrupt);
    expect(failed).toEqual({ ready: false, holdCleanCheckpoint: false });
    expect(corrupt.calls.marks).toEqual(["error"]);
    expect(corrupt.getItem(BROWSER_RECOVERY_KEY)).toBe("{\"content\":");
});
