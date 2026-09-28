/**
 * @module RecoveryRestore
 * @description Decides whether a recovery snapshot may replace the editor, for the browser and the desktop host.
 */
import { deserializeDocument, serializeDocument } from "../core/document/Serializer";
import type { RecoverySnapshot } from "./ProjectSession";

export type { RecoverySnapshot };

/** Browser explicit-save key. Matches the serializer's local document slot. */
export const BROWSER_DOCUMENT_KEY = "vde-document";
export const BROWSER_RECOVERY_KEY = "vde-recovery";
export const RECOVERY_PROMPT = "An unsaved recovery snapshot is available. Restore it?";
const MAX_RECOVERY_CHARS = 64 * 1024 * 1024;

export interface PreservedRecovery { preserved: true; }
export interface DeclinedRecovery { declined: true; }
export type DesktopRecoveryRead = RecoverySnapshot | PreservedRecovery | DeclinedRecovery | null;

export type RecoveryDecision =
    | { action: "restore"; snapshot: RecoverySnapshot }
    | { action: "clear"; reason: "already-saved" }
    | { action: "preserve"; reason: "explicit-save-differs" }
    | { action: "none" };

export function isRecoverySnapshot(value: DesktopRecoveryRead): value is RecoverySnapshot {
    return !!value && typeof value === "object" && "content" in value
        && typeof value.content === "string" && typeof value.savedContent === "string";
}

export function isPreservedRecovery(value: DesktopRecoveryRead): value is PreservedRecovery {
    return !!value && typeof value === "object" && "preserved" in value && value.preserved === true;
}

export function isDeclinedRecovery(value: DesktopRecoveryRead): value is DeclinedRecovery {
    return !!value && typeof value === "object" && "declined" in value && value.declined === true;
}

/** Restore is the second dialog button. Cancel and the window close button are not. */
export function recoveryChoiceFromDialog(response: number): boolean {
    return response === 1;
}

/**
 * Unattended relaunch supplies the dialog's button. A decision without the crash-relaunch
 * smoke flag is ignored, so a stray environment variable cannot restore or discard a real session.
 */
export function scriptedRecoveryChoice(env: { smoke?: string; decision?: string }): boolean | null {
    if (!env.smoke) return null;
    if (env.decision === "restore") return true;
    if (env.decision === "discard") return false;
    return null;
}

export function parseRecoverySnapshot(raw: string): RecoverySnapshot | null {
    const snapshot = JSON.parse(raw);
    if (snapshot === null) return null;
    if (!snapshot || typeof snapshot.content !== "string" || typeof snapshot.savedContent !== "string"
        || snapshot.content.length > MAX_RECOVERY_CHARS || snapshot.savedContent.length > MAX_RECOVERY_CHARS
        || !(snapshot.filePath === null || typeof snapshot.filePath === "string")) {
        throw new Error("Invalid or oversized recovery snapshot.");
    }
    JSON.parse(snapshot.content);
    JSON.parse(snapshot.savedContent);
    return { content: snapshot.content, filePath: snapshot.filePath, savedContent: snapshot.savedContent };
}

function canonicalDocument(raw: string): string {
    return serializeDocument(deserializeDocument(raw));
}

/**
 * Restore only when the explicit save is missing or still the snapshot's savepoint.
 * A save that already contains the recovered edits is cleared. Any other explicit save is left
 * untouched and the snapshot is kept.
 */
export function decideRecovery(snapshot: RecoverySnapshot | null, explicitSave: string | null): RecoveryDecision {
    if (!snapshot) return { action: "none" };
    if (explicitSave === null) return { action: "restore", snapshot };
    if (explicitSave === snapshot.savedContent) return { action: "restore", snapshot };
    if (explicitSave === snapshot.content) return { action: "clear", reason: "already-saved" };
    let savedCanon: string, contentCanon: string;
    try {
        savedCanon = canonicalDocument(snapshot.savedContent);
        contentCanon = canonicalDocument(snapshot.content);
    } catch {
        throw new Error("Invalid recovery snapshot.");
    }
    let explicitCanon: string;
    try { explicitCanon = canonicalDocument(explicitSave); }
    catch { return { action: "preserve", reason: "explicit-save-differs" }; }
    if (explicitCanon === savedCanon) return { action: "restore", snapshot };
    if (explicitCanon === contentCanon) return { action: "clear", reason: "already-saved" };
    return { action: "preserve", reason: "explicit-save-differs" };
}

export interface DesktopRecoveryIO {
    readRecovery: () => Promise<string | null>;
    readExplicit: (filePath: string) => Promise<string | null>;
    clearRecovery: () => Promise<void>;
    confirm: () => boolean;
    approve: (filePath: string) => void;
}

export async function readDesktopRecovery(io: DesktopRecoveryIO): Promise<DesktopRecoveryRead> {
    const raw = await io.readRecovery();
    if (raw === null) return null;
    const snapshot = parseRecoverySnapshot(raw);
    if (!snapshot) return null;
    const explicit = snapshot.filePath ? await io.readExplicit(snapshot.filePath) : null;
    const decision = decideRecovery(snapshot, explicit);
    if (decision.action === "none") return null;
    if (decision.action === "clear") {
        await io.clearRecovery();
        return null;
    }
    if (decision.action === "preserve") return { preserved: true };
    if (!io.confirm()) return { declined: true };
    if (snapshot.filePath) io.approve(snapshot.filePath);
    return snapshot;
}

export interface BrowserRecoveryHost {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    confirm: (message: string) => boolean;
    apply: (snapshot: RecoverySnapshot) => boolean;
    adopt: (savedContent: string) => void;
    status: (message: string) => void;
    mark: (outcome: string) => void;
}

export function markRecovery(outcome: string): void {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.vdeRecovery = outcome;
}

/** Browser startup restore. A corrupt record is left in storage and is not checkpointed over. */
export function restoreBrowserRecovery(host: BrowserRecoveryHost): { ready: boolean; holdCleanCheckpoint: boolean } {
    try {
        const raw = host.getItem(BROWSER_RECOVERY_KEY);
        const snapshot = raw === null ? null : parseRecoverySnapshot(raw);
        const decision = decideRecovery(snapshot, host.getItem(BROWSER_DOCUMENT_KEY));
        if (decision.action === "restore") {
            if (!host.confirm(RECOVERY_PROMPT)) {
                host.mark("declined");
                return { ready: true, holdCleanCheckpoint: false };
            }
            if (!host.apply(decision.snapshot)) {
                host.mark("error");
                return { ready: true, holdCleanCheckpoint: true };
            }
            host.adopt(decision.snapshot.savedContent);
            host.status("Recovered unsaved changes. Save to keep them.");
            host.mark("restored");
            return { ready: true, holdCleanCheckpoint: false };
        }
        if (decision.action === "clear") {
            host.setItem(BROWSER_RECOVERY_KEY, "null");
            host.mark("cleared");
            return { ready: true, holdCleanCheckpoint: false };
        }
        if (decision.action === "preserve") {
            host.status("Saved project differs from this recovery snapshot, so it was left unchanged.");
            host.mark("preserved");
            return { ready: true, holdCleanCheckpoint: true };
        }
        host.mark("empty");
        return { ready: true, holdCleanCheckpoint: false };
    } catch (error) {
        host.status(`Recovery could not be read; preserved in this browser: ${error instanceof Error ? error.message : String(error)}`);
        host.mark("error");
        return { ready: false, holdCleanCheckpoint: false };
    }
}
