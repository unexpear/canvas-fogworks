/** @module BehaviorEvents @description Graph lifecycle vocabulary, distinct from legacy gameplay rules. */
import type {GameplayRule} from "./Gameplay";
export type BehaviorEventKind=GameplayRule["event"]|"spawn"|"update"|"despawn"|"custom";
export const LIFECYCLE_EVENTS = ["spawn","update","despawn","custom"] as const;
export function isLifecycleEvent(event:string):boolean {
    return (LIFECYCLE_EVENTS as readonly string[]).includes(event);
}
export function customEventNameError(name:unknown):string|null {
    return typeof name==="string"&&/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)
        ? null : "Custom event names require 1–64 letters/digits/underscores/hyphens, starting with a letter.";
}
