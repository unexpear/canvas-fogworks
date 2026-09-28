/** @module InputActions @description Host-independent named input bindings with held/pressed/released edges and focus-reset semantics. */
export type ActionBindings = Readonly<Record<string, readonly string[]>>;
export class InputActions {
    private bindings: ActionBindings;
    private keys = new Set<string>();
    private presses = new Set<string>();
    private releases = new Set<string>();
    constructor(bindings: ActionBindings) { this.bindings = {}; this.rebind(bindings); }
    rebind(bindings: ActionBindings): void {
        const entries = Object.entries(bindings);
        if (entries.length > 64 || entries.some(([name, codes]) => !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(name)
            || !Array.isArray(codes) || codes.length > 8 || codes.some(code => !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(code)))) throw new Error("Invalid input action bindings.");
        this.bindings = Object.fromEntries(entries.map(([name, codes]) => [name, [...codes]])); this.clear();
    }
    setKey(code: string, down: boolean): boolean {
        const matched = Object.entries(this.bindings).filter(([, codes]) => codes.includes(code));
        if (!matched.length) return false;
        const before = new Map(matched.map(([name]) => [name, this.held(name)]));
        if (down) this.keys.add(code); else this.keys.delete(code);
        for (const [name] of matched) {
            if (!before.get(name) && this.held(name)) this.presses.add(name);
            if (before.get(name) && !this.held(name)) this.releases.add(name);
        }
        return true;
    }
    held(name: string): boolean { return (this.bindings[name] ?? []).some(code => this.keys.has(code)); }
    pressed(name: string): boolean { const value = this.presses.has(name); this.presses.delete(name); return value; }
    released(name: string): boolean { const value = this.releases.has(name); this.releases.delete(name); return value; }
    axis(negative: string, positive: string): number { return Number(this.held(positive)) - Number(this.held(negative)); }
    clear(): void { this.keys.clear(); this.presses.clear(); this.releases.clear(); }
}
export const PLAYER_ACTIONS: ActionBindings = Object.freeze({ left: ["KeyA", "ArrowLeft"], right: ["KeyD", "ArrowRight"],
    forward: ["KeyW", "ArrowUp"], back: ["KeyS", "ArrowDown"], up: ["KeyE"], down: ["KeyQ"],
    jump: ["Space", "ArrowUp"], run: ["ShiftLeft", "ShiftRight"], interact: ["KeyF"] });
