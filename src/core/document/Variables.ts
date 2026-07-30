/**
 * @module Variables
 * @description Design tokens (Milestone 5) — the `VariableStore` persisted on the document,
 * its validation, and the pure token RESOLUTION the renderer consumes.
 *
 * A variable is `{ type, value, modes? }`: a base value plus optional per-theme overrides
 * (`light`/`dark`). Any value — base or override — may instead be an ALIAS `"$other/key"`
 * referencing another variable (token inheritance); chains resolve with a seen-set, so a
 * cycle or a dangling target resolves to null (the renderer falls back to the debug magenta,
 * never throws). Style fields reference tokens with the same syntax (`Style.fill:
 * "$color/primary"`, reserved since M0); the document STORES the reference and the renderer
 * resolves it against `doc.activeTheme` each frame — switching themes repaints everything
 * that references a token without touching any node.
 *
 * Validation (`variableStoreError`) is SHARED by the load path (`Integrity`) and the edit
 * path (the variable actions) so the two cannot drift — the same round-trip closure
 * discipline `styleError`/`layoutError` use. Type coherence is enforced at rest (a concrete
 * `color`/`font` value must be a string, a `spacing` value a finite number; aliases are
 * allowed anywhere) and re-checked at resolution (an alias landing on the wrong type
 * resolves to null, exactly like a dangling one).
 */

/** The built-in theme axis (Milestone 5 scope: light/dark). More modes = a schema bump. */
export type ThemeMode = "light" | "dark";
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark"];

export type VariableType = "color" | "spacing" | "font";
const VARIABLE_TYPES = new Set<string>(["color", "spacing", "font"]);

/** A concrete value (string for color/font, number for spacing) OR an alias `"$key"`. */
export type VariableValue = string | number;

export interface Variable {
    type: VariableType;
    /** Base value, used when the active theme has no override. */
    value: VariableValue;
    /** Optional per-theme overrides (same value rules as `value`). */
    modes?: Partial<Record<ThemeMode, VariableValue>>;
}

/** Design tokens, keyed by token id (e.g. "color/primary" — referenced as "$color/primary"). */
export interface VariableStore {
    [key: string]: Variable;
}

/** OOM guard on a hand-editable unbounded map — the `GRID_MAX_TRACKS` discipline. */
export const VARIABLES_MAX = 10_000;
/** Key length cap (keys are user-authored ids, not prose). */
export const VARIABLE_KEY_MAX = 200;

/** Rendered when a color token cannot be resolved (missing/cycle/wrong type) — the same
 *  debug magenta family as the unknown-node-type fallback, so a broken reference is VISIBLE. */
export const VARIABLE_FALLBACK_COLOR = "#ff006e";

/** True for an alias/token reference: `"$"` + a non-empty key. */
export function isTokenRef(v: unknown): v is string {
    return typeof v === "string" && v.length > 1 && v.charCodeAt(0) === 36; // "$"
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/** One value slot (base or override): an alias, or a concrete value matching `type`. */
function valueError(type: VariableType, v: unknown): string | null {
    if (isTokenRef(v)) return null; // alias — target type is checked at resolution
    if (v === "$") return "alias must name a target (bare \"$\")";
    if (type === "spacing") {
        if (typeof v !== "number" || !Number.isFinite(v)) return "spacing value must be a finite number or an alias";
        return null;
    }
    if (typeof v !== "string" || v.length === 0) return `${type} value must be a non-empty string or an alias`;
    return null;
}

/** Validity of ONE variable definition (key-agnostic) — shared by the store validator and
 *  the 18→19 migration sanitizer. Returns an error string, or null. */
export function variableError(def: unknown): string | null {
    if (!isPlainObject(def)) return "variable must be an object";
    const type = def.type;
    if (typeof type !== "string" || !VARIABLE_TYPES.has(type)) return 'variable type must be "color", "spacing" or "font"';
    const ve = valueError(type as VariableType, def.value);
    if (ve) return ve;
    if (def.modes !== undefined) {
        if (!isPlainObject(def.modes)) return "variable modes must be an object";
        for (const [mode, mv] of Object.entries(def.modes)) {
            if (!(THEME_MODES as readonly string[]).includes(mode)) return `unknown theme mode "${mode}"`;
            const me = valueError(type as VariableType, mv);
            if (me) return `mode "${mode}": ${me}`;
        }
    }
    return null;
}

/**
 * Validity of the whole store — SHARED by the load path (`Integrity`) and the edit path
 * (variable actions) so they cannot drift. Keys: non-empty, capped length, and must not
 * begin with "$" (a key "$x" would make its own token "$$x" — ambiguous with an alias).
 * Aliases are NOT required to resolve (deleting a variable must not corrupt a document
 * that still references it; a dangling alias resolves to the visible fallback instead).
 */
export function variableStoreError(store: unknown): string | null {
    if (!isPlainObject(store)) return "variables must be an object";
    const entries = Object.entries(store);
    if (entries.length > VARIABLES_MAX) return `variables must have at most ${VARIABLES_MAX} entries`;
    for (const [key, def] of entries) {
        if (key.length === 0) return "variable key must be non-empty";
        if (key.length > VARIABLE_KEY_MAX) return `variable key must be at most ${VARIABLE_KEY_MAX} characters`;
        if (key.charCodeAt(0) === 36) return `variable key "${key}" must not start with "$"`;
        const e = variableError(def);
        if (e) return `variable "${key}": ${e}`;
    }
    return null;
}

/**
 * Resolve a variable to its CONCRETE value for a theme, following alias chains. Pure and
 * never throws. Returns null when the key is missing, a chain contains a cycle, or a slot
 * is malformed — callers map null to their fallback. The per-theme override wins; absent
 * override falls back to the base `value`.
 */
export function resolveVariable(
    store: VariableStore,
    key: string,
    theme: ThemeMode,
    seen: Set<string> = new Set()
): string | number | null {
    if (seen.has(key)) return null; // alias cycle
    seen.add(key);
    const v = store[key];
    if (!v || typeof v !== "object") return null;
    const raw = v.modes?.[theme] ?? v.value;
    if (isTokenRef(raw)) return resolveVariable(store, raw.slice(1), theme, seen);
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    return raw;
}

/**
 * Resolve a COLOR slot: a non-token string passes through untouched; a token resolves via
 * the store and must land on a string (a spacing number in a color slot is a broken
 * reference). Missing/cycle/wrong-type → the visible `VARIABLE_FALLBACK_COLOR`, so a broken
 * token renders loudly instead of vanishing. This is the renderer's entry point.
 */
export function resolveColor(store: VariableStore, raw: string, theme: ThemeMode): string {
    if (!isTokenRef(raw)) return raw;
    const r = resolveVariable(store, raw.slice(1), theme);
    return typeof r === "string" ? r : VARIABLE_FALLBACK_COLOR;
}

/**
 * Resolve a NUMBER slot (spacing tokens — defined and resolvable now; consumed by layout in
 * a later milestone): a plain number passes through; a token must land on a number. Null =
 * unresolvable (missing/cycle/wrong type) — the caller decides its fallback.
 */
export function resolveNumber(store: VariableStore, raw: number | string, theme: ThemeMode): number | null {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    if (!isTokenRef(raw)) return null;
    const r = resolveVariable(store, raw.slice(1), theme);
    return typeof r === "number" ? r : null;
}
