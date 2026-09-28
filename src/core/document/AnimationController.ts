/**
 * @module AnimationController
 * @description Persisted per-node clip states and ordered transition rules (schema 77).
 */
export const ANIMATION_CONDITIONS = ["moving", "idle", "rising", "falling", "grounded", "airborne",
    "enter", "leave", "contact", "separate", "bump", "won", "lost", "finished"] as const;
export type AnimationCondition = typeof ANIMATION_CONDITIONS[number];
export interface AnimationState { name: string; clip: string; speed?: number }
export interface AnimationTransition {
    from: string; to: string; when: AnimationCondition;
    /** Seconds to blend from the outgoing clip. Absent switches immediately, as schema 77 did. */
    fade?: number;
}
export interface AnimationController {
    initial: string;
    /** Optional body providing movement/events; absent uses this node. */
    driver?: string;
    states: AnimationState[];
    /** First matching rule wins; at most one transition per simulation step. */
    transitions: AnimationTransition[];
}
export function animationControllerError(value: unknown): string | null {
    if (value === undefined) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "animation must be an object";
    const c = value as AnimationController;
    const name = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 64;
    if (!name(c.initial)) return "animation.initial needs a state name";
    if (c.driver !== undefined && (typeof c.driver !== "string" || !c.driver.trim() || c.driver.length > 4096)) return "animation.driver needs a node id";
    if (!Array.isArray(c.states) || c.states.length < 1 || c.states.length > 64) return "animation needs 1–64 states";
    const names = new Set<string>();
    for (const s of c.states) {
        if (!s || typeof s !== "object" || Array.isArray(s) || !name(s.name) || !name(s.clip)) return "animation state needs name and clip";
        if (names.has(s.name)) return "animation state names must be unique";
        names.add(s.name);
        if (s.speed !== undefined && (typeof s.speed !== "number" || !Number.isFinite(s.speed) || s.speed <= 0 || s.speed > 16)) return "animation speed must be greater than 0 and at most 16";
    }
    if (!names.has(c.initial)) return "animation.initial must name a state";
    if (!Array.isArray(c.transitions) || c.transitions.length > 256) return "animation allows at most 256 transitions";
    for (const t of c.transitions) {
        if (!t || typeof t !== "object" || Array.isArray(t) || !names.has(t.from) || !names.has(t.to)
            || !(ANIMATION_CONDITIONS as readonly unknown[]).includes(t.when)) return "animation transition has an invalid state or condition";
        if (t.fade !== undefined && (typeof t.fade !== "number" || !Number.isFinite(t.fade) || t.fade <= 0 || t.fade > 1)) return "animation fade must be greater than 0 and at most 1 second";
    }
    return null;
}
