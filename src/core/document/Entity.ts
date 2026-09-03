/**
 * @module Entity
 * @description Validated, engine-owned gameplay fields for a node (schema 73).
 *
 * Imported custom properties remain in `userData` for lossless round trips.  These fields are the
 * typed authoring surface the runtime reads first; legacy `bodyType`, `friction`, and `vde.*`
 * properties remain readable so existing projects do not change when opened by schema 73.
 */

export const ENTITY_BODY_TYPES = ["static", "dynamic", "oneway"] as const;
export type EntityBodyType = typeof ENTITY_BODY_TYPES[number];

export interface Entity {
    body?: EntityBodyType;
    friction?: number;
    player?: boolean;
    respawnAt?: string;
    transitionTo?: string;
    stompable?: boolean;
    patrol?: number;
    deadly?: boolean;
    goal?: boolean;
    collectible?: boolean;
    powers?: number;
    stars?: number;
    bounces?: number;
    warpsTo?: string;
}

const FLAGS = ["player", "stompable", "deadly", "goal", "collectible"] as const;
const NUMBERS = ["friction", "patrol", "powers", "stars", "bounces"] as const;
const REFERENCES = ["respawnAt", "transitionTo", "warpsTo"] as const;

export function entityError(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "entity must be an object";
    const e = value as Partial<Entity>;
    if (e.body !== undefined && !(ENTITY_BODY_TYPES as readonly unknown[]).includes(e.body)) {
        return `entity.body must be one of ${ENTITY_BODY_TYPES.join("/")}`;
    }
    for (const key of FLAGS) {
        if (e[key] !== undefined && typeof e[key] !== "boolean") return `entity.${key} must be a boolean`;
    }
    for (const key of NUMBERS) {
        if (e[key] !== undefined && (typeof e[key] !== "number" || !Number.isFinite(e[key]))) {
            return `entity.${key} must be a finite number`;
        }
    }
    if (e.friction !== undefined && e.friction < 0) return "entity.friction must be >= 0";
    if (e.powers !== undefined && e.powers < 0) return "entity.powers must be >= 0";
    if (e.stars !== undefined && e.stars < 0) return "entity.stars must be >= 0";
    if (e.bounces !== undefined && e.bounces < 0) return "entity.bounces must be >= 0";
    for (const key of REFERENCES) {
        const v = e[key];
        if (v !== undefined && (typeof v !== "string" || v.trim() === "" || v.length > 4096)) {
            return `entity.${key} must be a non-empty string of at most 4096 characters`;
        }
    }
    return null;
}

/** Convert the legacy runtime vocabulary without deleting it (it may belong to an imported file). */
export function entityFromUserData(data: Readonly<Record<string, { value: string }>> | undefined): Entity | undefined {
    if (!data) return undefined;
    const raw = (key: string) => data[key]?.value;
    const text = (key: string) => { const v = raw(key)?.trim(); return v ? v : undefined; };
    const number = (key: string) => { const v = text(key); const n = v === undefined ? NaN : Number(v); return Number.isFinite(n) ? n : undefined; };
    const flag = (key: string) => { const v = text(key)?.toLowerCase(); return v === undefined ? undefined : !["false", "0", "no"].includes(v); };
    const bodyRaw = text("bodyType")?.toLowerCase();
    const body = (ENTITY_BODY_TYPES as readonly string[]).includes(bodyRaw ?? "") ? bodyRaw as EntityBodyType : undefined;
    const friction = number("friction");
    const entity: Entity = {
        ...(body ? { body } : {}), ...(friction !== undefined && friction >= 0 ? { friction } : {}),
        ...(flag("vde.stompable") !== undefined ? { stompable: flag("vde.stompable") } : {}),
        ...(number("vde.patrol") !== undefined ? { patrol: number("vde.patrol") } : {}),
        ...(flag("vde.deadly") !== undefined ? { deadly: flag("vde.deadly") } : {}),
        ...(flag("vde.goal") !== undefined ? { goal: flag("vde.goal") } : {}),
        ...(flag("vde.collect") !== undefined ? { collectible: flag("vde.collect") } : {}),
        ...(number("vde.powers") !== undefined ? { powers: Math.max(0, number("vde.powers")!) } : {}),
        ...(number("vde.stars") !== undefined ? { stars: Math.max(0, number("vde.stars")!) } : {}),
        ...(number("vde.bounces") !== undefined ? { bounces: Math.max(0, number("vde.bounces")!) } : {}),
        ...(text("vde.warpsTo") ? { warpsTo: text("vde.warpsTo") } : {})
    };
    return Object.keys(entity).length > 0 ? entity : undefined;
}

/** The first explicitly-authored player, or null. File order is stable through the node map. */
export function playerEntityId(nodes: Iterable<{ id: string; entity?: Entity }>): string | null {
    for (const node of nodes) if (node.entity?.player) return node.id;
    return null;
}
