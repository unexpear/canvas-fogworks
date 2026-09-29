/** @module InputSettings @description Versioned named-input bindings, validation and player/editor mappings. */
import { ActionBindings, InputActions, PLAYER_ACTIONS } from "./InputActions";

/** The actions both players already read. Order is the settings record order. */
export const NAMED_INPUTS = [
    { name: "left", label: "Move left" },
    { name: "right", label: "Move right" },
    { name: "forward", label: "Move forward" },
    { name: "back", label: "Move back" },
    { name: "up", label: "Move up" },
    { name: "down", label: "Move down" },
    { name: "jump", label: "Jump" },
    { name: "run", label: "Run" },
    { name: "interact", label: "Interact" }
] as const;

export const INPUT_SETTINGS_STORAGE_KEY = "canvas-fogworks.input-settings.v1";
const MAX_CODES = 4;
const MAX_STORED = 8192;
const CODE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const UNBINDABLE = /^(Escape|Tab|ControlLeft|ControlRight|AltLeft|AltRight|MetaLeft|MetaRight|OSLeft|OSRight|ContextMenu)$/;
const KEY_CODES: Record<string, string> = {
    " ": "Space", Shift: "ShiftLeft", Enter: "Enter", Backspace: "Backspace",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    Escape: "Escape", Tab: "Tab"
};

export interface InputSettingsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface InputEdit { bindings: ActionBindings; error: string | null }

export function inputLabel(action: string): string {
    return NAMED_INPUTS.find(item => item.name === action)?.label ?? action;
}

export function defaultInputBindings(): ActionBindings {
    return Object.fromEntries(NAMED_INPUTS.map(item => [item.name, [...PLAYER_ACTIONS[item.name]]]));
}

export function inputCodeLabel(code: string): string {
    const named: Record<string, string> = {
        Space: "Space", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
        ShiftLeft: "Left Shift", ShiftRight: "Right Shift", Enter: "Enter", Backspace: "Backspace"
    };
    if (named[code]) return named[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
    return code;
}

/** Physical `KeyboardEvent.code`, with a layout fallback when the host omits it. */
export function eventCode(event: { code?: string; key?: string }): string {
    const code = event.code ?? "";
    if (CODE.test(code)) return code;
    const key = event.key ?? "";
    if (KEY_CODES[key]) return KEY_CODES[key];
    if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
    if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
    return "";
}

export function inputBindingsInclude(bindings: ActionBindings, code: string): boolean {
    return Object.values(bindings).some(codes => codes.includes(code));
}

export function inputSettingsError(bindings: ActionBindings): string | null {
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return "Input settings are not a record.";
    const expected = NAMED_INPUTS.map(item => item.name);
    if (Object.keys(bindings).length !== expected.length || expected.some(name => !Object.prototype.hasOwnProperty.call(bindings, name))) {
        return "Input settings must list every named action.";
    }
    for (const name of expected) {
        const codes = bindings[name];
        if (!Array.isArray(codes) || codes.length < 1 || codes.length > MAX_CODES) return `${inputLabel(name)} needs 1 to ${MAX_CODES} keys.`;
        if (codes.some(code => typeof code !== "string" || !CODE.test(code) || UNBINDABLE.test(code))) return `${inputLabel(name)} has a key that cannot be bound.`;
        if (new Set(codes).size !== codes.length) return `${inputLabel(name)} lists the same key twice.`;
    }
    try { new InputActions(cloneBindings(bindings)); return null; }
    catch { return "Input settings were rejected."; }
}

export function sharedInputWarnings(bindings: ActionBindings): string[] {
    const owners = new Map<string, string[]>();
    for (const item of NAMED_INPUTS) for (const code of bindings[item.name] ?? []) {
        owners.set(code, [...(owners.get(code) ?? []), item.label]);
    }
    return [...owners].filter(([, labels]) => labels.length > 1)
        .map(([code, labels]) => `${inputCodeLabel(code)} is used by ${labels.join(" and ")}.`);
}

export function addInputCode(bindings: ActionBindings, action: string, code: string): InputEdit {
    if (!NAMED_INPUTS.some(item => item.name === action)) return { bindings, error: "Unknown input action." };
    if (!CODE.test(code) || UNBINDABLE.test(code)) return { bindings, error: "That key cannot be bound." };
    const current = bindings[action] ?? [];
    if (current.includes(code)) return { bindings, error: null };
    if (current.length >= MAX_CODES) return { bindings, error: `${inputLabel(action)} already has ${MAX_CODES} keys.` };
    return accept({ ...cloneBindings(bindings), [action]: [...current, code] }, bindings);
}

export function removeInputCode(bindings: ActionBindings, action: string, code: string): InputEdit {
    const current = bindings[action] ?? [];
    if (!current.includes(code)) return { bindings, error: null };
    if (current.length <= 1) return { bindings, error: `${inputLabel(action)} needs at least one key.` };
    return accept({ ...cloneBindings(bindings), [action]: current.filter(item => item !== code) }, bindings);
}

export function inputSettingsSummary(bindings: ActionBindings): string {
    return NAMED_INPUTS.map(item => `${item.label}: ${(bindings[item.name] ?? []).map(inputCodeLabel).join("/")}`).join(" · ");
}

export function platformerInput(actions: InputActions) {
    return {
        left: actions.held("left"), right: actions.held("right"), jump: actions.held("jump"),
        down: actions.held("back"), run: actions.held("run")
    };
}

export function spatialInput(actions: InputActions) {
    return {
        x: actions.axis("left", "right"), y: actions.axis("down", "up"),
        z: actions.axis("forward", "back"), speed: actions.held("run") ? 7 : 4
    };
}

export function serializeInputSettings(bindings: ActionBindings): string {
    const error = inputSettingsError(bindings);
    if (error) throw new Error(error);
    const ordered = Object.fromEntries(NAMED_INPUTS.map(item => [item.name, [...bindings[item.name]]]));
    return JSON.stringify({ version: 1, bindings: ordered });
}

/** Null means the payload is unusable. Callers keep the built-in bindings. */
export function parseInputSettings(raw: string): ActionBindings | null {
    try {
        if (typeof raw !== "string" || raw.length > MAX_STORED) return null;
        const value = JSON.parse(raw) as { version?: unknown; bindings?: unknown };
        if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
            || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) return null;
        const copy: Record<string, string[]> = {};
        for (const [name, codes] of Object.entries(value.bindings as Record<string, unknown>)) {
            if (!Array.isArray(codes) || codes.some(code => typeof code !== "string")) return null;
            copy[name] = [...codes as string[]];
        }
        return inputSettingsError(copy) ? null : copy;
    } catch { return null; }
}

export function readInputSettings(storage: InputSettingsStorage | null): ActionBindings {
    try {
        const raw = storage?.getItem(INPUT_SETTINGS_STORAGE_KEY);
        return raw ? parseInputSettings(raw) ?? defaultInputBindings() : defaultInputBindings();
    } catch { return defaultInputBindings(); }
}

export function writeInputSettings(storage: InputSettingsStorage, bindings: ActionBindings): void {
    storage.setItem(INPUT_SETTINGS_STORAGE_KEY, serializeInputSettings(bindings));
}

export function browserInputStorage(): InputSettingsStorage | null {
    try { return typeof localStorage === "undefined" ? null : localStorage; }
    catch { return null; }
}

function cloneBindings(bindings: ActionBindings): ActionBindings {
    return Object.fromEntries(Object.entries(bindings).map(([name, codes]) => [name, [...codes]]));
}

function accept(next: ActionBindings, previous: ActionBindings): InputEdit {
    const error = inputSettingsError(next);
    return error ? { bindings: previous, error } : { bindings: next, error: null };
}
