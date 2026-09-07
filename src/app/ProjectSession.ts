/**
 * @module ProjectSession
 * @description Project savepoints, write acknowledgement and bounded recovery snapshots, separate from editor history.
 */

export interface RecoverySnapshot { content: string; filePath: string | null; savedContent: string; }
export interface ProjectSessionOptions {
    serialize: () => string;
    path: { current: string | null };
    write: (path: string, content: string, source: string | null) => Promise<boolean>;
    recover: (snapshot: RecoverySnapshot | null) => Promise<void>;
    status: (message: string) => void;
}

export class ProjectSession {
    private savedContent: string;
    private saving = false;
    private epoch = 0;
    private recoveryContent: string | null = null;
    private recoveryQueue = Promise.resolve();

    constructor(private readonly options: ProjectSessionOptions) {
        this.savedContent = options.serialize();
    }

    get busy(): boolean { return this.saving; }
    get dirty(): boolean { return this.options.serialize() !== this.savedContent; }

    /** Called only after a successful Open/New/explicit recovery. */
    adopt(savedContent = this.options.serialize()): void {
        this.epoch++;
        this.savedContent = savedContent;
        this.recoveryContent = null;
    }

    async save(path: string): Promise<boolean> {
        if (this.saving) { this.options.status("A save is already in progress."); return false; }
        this.saving = true;
        const epoch = this.epoch;
        try {
            const content = this.options.serialize();
            this.options.status("Saving…");
            if (!await this.options.write(path, content, this.options.path.current)) throw new Error("The file was not written.");
            // An asynchronous write must not adopt its path into another document.
            if (this.epoch !== epoch) return true;
            this.options.path.current = path;
            this.savedContent = content;
            this.options.status(this.dirty ? "Saved; newer edits remain unsaved." : "Saved.");
            await this.checkpoint();
            return true;
        } catch (cause) {
            this.options.status(`Save failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            return false;
        } finally { this.saving = false; }
    }

    /** Serialized recovery writes cannot resurrect an older snapshot after a clear. */
    checkpoint(): Promise<void> {
        try {
            const content = this.options.serialize();
            const snapshot = content === this.savedContent ? null : {
                content, filePath: this.options.path.current, savedContent: this.savedContent
            };
            const key = JSON.stringify(snapshot);
            if (key === this.recoveryContent) return this.recoveryQueue;
            this.recoveryContent = key;
            this.recoveryQueue = this.recoveryQueue.then(() => this.options.recover(snapshot)).catch(cause => {
                this.recoveryContent = null;
                this.options.status(`Recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            });
            return this.recoveryQueue;
        } catch (cause) {
            this.options.status(`Recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            return Promise.resolve();
        }
    }
}
