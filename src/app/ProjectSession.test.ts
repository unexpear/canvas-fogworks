/**
 * @module ProjectSession.test
 * @description Covers failed writes, save races, savepoint identity and ordered recovery without filesystem or UI dependencies.
 */
import { ProjectSession, RecoverySnapshot } from "./ProjectSession";

function setup() {
    let content = "original";
    const path = { current: "old.vde" as string | null };
    const write = jest.fn(async () => true);
    const recover = jest.fn(async (_snapshot: RecoverySnapshot | null) => {});
    const status = jest.fn();
    const session = new ProjectSession({ serialize: () => content, path, write, recover, status });
    return { session, path, write, recover, status, edit: (value: string) => { content = value; } };
}

test("only successful writes adopt Save As and establish a savepoint", async () => {
    const t = setup(); t.edit("edit");
    t.write.mockRejectedValueOnce(new Error("disk full"));
    expect(await t.session.save("new.vde")).toBe(false);
    expect(t.path.current).toBe("old.vde"); expect(t.session.dirty).toBe(true);
    expect(t.status).toHaveBeenLastCalledWith("Save failed: disk full");
    expect(await t.session.save("new.vde")).toBe(true);
    expect(t.path.current).toBe("new.vde"); expect(t.session.dirty).toBe(false);
    expect(t.write).toHaveBeenLastCalledWith("new.vde", "edit", "old.vde");
});

test("false acknowledgements are failures and undo back to the savepoint is clean", async () => {
    const t = setup(); t.edit("edit"); t.write.mockResolvedValueOnce(false);
    expect(await t.session.save("new.vde")).toBe(false);
    t.edit("original"); expect(t.session.dirty).toBe(false);
});

test("edits made during a write remain dirty and are recoverable", async () => {
    const t = setup(); t.edit("first");
    let finish!: (ok: boolean) => void;
    t.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = t.session.save("new.vde");
    expect(await t.session.save("another.vde")).toBe(false);
    t.edit("newer"); finish(true); await pending;
    expect(t.session.dirty).toBe(true);
    expect(t.recover).toHaveBeenLastCalledWith({ content: "newer", savedContent: "first", filePath: "new.vde" });
});

test("an old completion cannot replace the path/savepoint of a newly opened document", async () => {
    const t = setup(); t.edit("old edit");
    let finish!: (ok: boolean) => void;
    t.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = t.session.save("old-save.vde");
    t.edit("opened"); t.path.current = "opened.vde"; t.session.adopt();
    finish(true); await pending;
    expect(t.path.current).toBe("opened.vde"); expect(t.session.dirty).toBe(false);
});

test("recovery is deduplicated and errors are visible and retryable", async () => {
    const t = setup(); t.edit("edit");
    t.recover.mockRejectedValueOnce(new Error("quota"));
    await t.session.checkpoint(); expect(t.status).toHaveBeenLastCalledWith("Recovery failed: quota");
    await t.session.checkpoint(); await t.session.checkpoint();
    expect(t.recover).toHaveBeenCalledTimes(2);
    t.edit("original"); await t.session.checkpoint();
    expect(t.recover).toHaveBeenLastCalledWith(null);
});
