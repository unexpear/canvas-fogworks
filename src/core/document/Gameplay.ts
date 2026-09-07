/**
 * @module Gameplay
 * @description Validated event-condition-command rules stored on authored entities; execution state never enters document history.
 */
export type GameplayAction =
    | { kind: "win" | "lose" | "despawn" }
    | { kind: "velocity"; x: number; y: number }
    | { kind: "score"; key: string }
    | { kind: "sound"; source: string; volume: number };
export interface GameplayRule {
    event: "start" | "enter" | "leave" | "contact" | "separate";
    other: "any" | "player";
    target: "self" | "other";
    action: GameplayAction;
}
export function gameplayRulesError(value: unknown): string | null {
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length > 32) return "gameplay rules must be an array of at most 32 entries";
    for (const rule of value) {
        if (!rule || !["start", "enter", "leave", "contact", "separate"].includes(rule.event)
            || !["any", "player"].includes(rule.other) || !["self", "other"].includes(rule.target)) return "invalid gameplay event, condition or target";
        if (rule.event === "start" && (rule.target !== "self" || rule.other !== "any")) return "start rules must target self with condition any";
        const a = rule.action;
        if (!a || !["win", "lose", "despawn", "velocity", "score", "sound"].includes(a.kind)) return "invalid gameplay command";
        if (a.kind === "velocity" && (!Number.isFinite(a.x) || !Number.isFinite(a.y)
            || Math.abs(a.x) > 100000 || Math.abs(a.y) > 100000)) return "gameplay velocity must be finite and bounded";
        if (a.kind === "score" && (typeof a.key !== "string" || !a.key.trim() || a.key.length > 64)) return "gameplay score key must contain 1–64 characters";
        if (a.kind === "sound" && (typeof a.source !== "string" || a.source.length > 8 * 1024 * 1024
            || !/^data:audio\/(wav|x-wav|ogg|mpeg|mp3);base64,[A-Za-z0-9+/]+=*$/.test(a.source)
            || !Number.isFinite(a.volume) || a.volume < 0 || a.volume > 1)) return "gameplay sound needs embedded WAV/OGG/MP3 audio (at most 8MB) and volume 0–1";
    }
    return null;
}
