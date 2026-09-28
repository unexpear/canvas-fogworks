/** @module ProgressStore @description Narrow save-slot capability; browser storage failures are reported, never silently replaced with an in-memory save. */
import { PROGRESS_MAX_BYTES } from "./PlayerProgress";
export interface ProgressStore { read(): Promise<string | null>; write(content: string): Promise<void> }
export function browserProgressStore(gameId: string): ProgressStore {
    if (!/^[a-f0-9]{64}$/.test(gameId)) throw new Error("Invalid progress namespace.");
    const key = `canvas-fogworks:progress:v1:${gameId}`;
    return {
        async read() { const text = window.localStorage.getItem(key); checkSize(text); return text; },
        async write(content) { checkSize(content); window.localStorage.setItem(key, content); }
    };
}
function checkSize(content: string | null) {
    if (content !== null && (typeof content !== "string" || content.length > PROGRESS_MAX_BYTES || new TextEncoder().encode(content).length > PROGRESS_MAX_BYTES)) throw new Error("Player save exceeds 2MiB.");
}
