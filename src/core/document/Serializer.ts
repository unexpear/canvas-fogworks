/**
 * @module Serializer
 * @description Handles serialization and deserialization of ProjectDocuments.
 * Owns versioning: every saved file carries a SCHEMA_VERSION envelope (NOT the app
 * version). migrateIfNeeded refuses newer schemas, normalises legacy app-version
 * stamps, then runs the migration chain; unknown versions throw.
 */

import { ProjectDocument, ReadonlyDocument, createEmptyDocument, SCHEMA_VERSION, SerializedMetadata } from "./Document";
import { Node, isNodeType } from "./Node";
import { validateDocumentIntegrity } from "./Integrity";

/** Structural check for a persisted node — guards against malformed input. */
function isPlainObject(v: any): boolean {
    return !!v && typeof v === "object" && !Array.isArray(v);
}
function isOptionalString(v: any): boolean {
    return v === undefined || typeof v === "string";
}

function isValidNode(n: any): n is Node {
    return !!n && typeof n === "object" &&
        typeof n.id === "string" &&
        // Membership, not just "is a string": an unknown type would render as a
        // fallback box and silently misrepresent the document.
        isNodeType(n.type) &&
        Array.isArray(n.children) && n.children.every((c: any) => typeof c === "string") &&
        (n.parent === undefined || n.parent === null || typeof n.parent === "string") &&
        isPlainObject(n.geometry) &&
        typeof n.geometry.x === "number" && typeof n.geometry.y === "number" &&
        typeof n.geometry.width === "number" && typeof n.geometry.height === "number" &&
        isPlainObject(n.style) &&
        typeof n.style.fill === "string" && typeof n.style.opacity === "number" &&
        isOptionalString(n.style.stroke) &&
        (n.style.radius === undefined || typeof n.style.radius === "number") &&
        (n.style.fontSize === undefined || typeof n.style.fontSize === "number") &&
        isPlainObject(n.layout) &&
        (n.layout.container === undefined || isPlainObject(n.layout.container)) &&
        isOptionalString(n.text) && isOptionalString(n.src) && isOptionalString(n.name) &&
        (n.states === undefined || isPlainObject(n.states)) &&
        (n.transform === undefined || (isPlainObject(n.transform) &&
            (n.transform.rotation === undefined || typeof n.transform.rotation === "number") &&
            (n.transform.scaleX === undefined || typeof n.transform.scaleX === "number") &&
            (n.transform.scaleY === undefined || typeof n.transform.scaleY === "number") &&
            (n.transform.origin === undefined || (isPlainObject(n.transform.origin) &&
                typeof n.transform.origin.x === "number" && typeof n.transform.origin.y === "number"))));
}

/** The envelope wrapping a serialized document (JSON-accurate: date is a string). */
export interface SerializedDocument {
    version: string;
    document: {
        metadata: SerializedMetadata;
        nodes: Record<string, Node>;
        rootNodeUuids: string[];
        variables: ProjectDocument["variables"];
    };
}

/**
 * Serializes a ProjectDocument to a JSON-safe string.
 * Converts Map<string, Node> to a plain object for JSON compatibility.
 */
export function serializeDocument(doc: ReadonlyDocument): string {
    const envelope: SerializedDocument = {
        version: doc.version,
        document: {
            metadata: {
                project_name: doc.metadata.project_name,
                created_by: doc.metadata.created_by,
                date: doc.metadata.date instanceof Date
                    ? doc.metadata.date.toISOString()
                    : String(doc.metadata.date)
            },
            // Serialization COPIES out of the read-only view into the mutable wire
            // shape; the casts are the boundary, not a hole in the invariant.
            nodes: Object.fromEntries(doc.nodes) as Record<string, Node>,
            rootNodeUuids: [...doc.rootNodeUuids],
            variables: doc.variables as ProjectDocument["variables"]
        }
    };

    return JSON.stringify(envelope, null, 2);
}

/**
 * Deserializes a JSON string into a ProjectDocument.
 * Handles version checking and migration if needed.
 */
export function deserializeDocument(json: string): ProjectDocument {
    let raw: any;
    try {
        raw = JSON.parse(json);
    } catch {
        throw new Error("Invalid JSON: could not parse document.");
    }

    if (!raw || typeof raw !== 'object') {
        throw new Error("Invalid document: root is not an object.");
    }

    if (typeof raw.version !== 'string') {
        throw new Error("Invalid document: missing or invalid 'version' field.");
    }
    if (!raw.document || typeof raw.document !== 'object') {
        throw new Error("Invalid document: missing 'document' envelope.");
    }
    if (!raw.document.nodes || typeof raw.document.nodes !== 'object') {
        throw new Error("Invalid document: missing 'nodes' field.");
    }

    // Version check and migration
    const migrated = migrateIfNeeded(raw);

    // Reconstruct the runtime document. Start from safe defaults and only
    // overwrite fields the file actually provides (a malformed file must not
    // replace a valid default with `undefined`).
    const doc = createEmptyDocument();
    doc.version = migrated.version;

    const md = migrated.document.metadata;
    if (isPlainObject(md)) {
        // Validate, don't just default: a non-string name or an unparseable date
        // would otherwise flow straight into the live document (and `Invalid Date`
        // survives serialization as null, quietly losing the field).
        const parsedDate = md.date !== undefined ? new Date(md.date) : null;
        doc.metadata = {
            project_name: typeof md.project_name === "string" ? md.project_name : doc.metadata.project_name,
            created_by: typeof md.created_by === "string" ? md.created_by : doc.metadata.created_by,
            date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : doc.metadata.date
        };
    }

    if (Array.isArray(migrated.document.rootNodeUuids)) {
        doc.rootNodeUuids = migrated.document.rootNodeUuids;
    }
    if (migrated.document.variables && typeof migrated.document.variables === "object") {
        doc.variables = migrated.document.variables;
    }

    // Reconstruct the Map, validating each node's shape and key/id agreement.
    const nodesObj = migrated.document.nodes;
    for (const [key, value] of Object.entries(nodesObj)) {
        if (!isValidNode(value)) {
            throw new Error(`Invalid document: node "${key}" is malformed.`);
        }
        if (value.id !== key) {
            throw new Error(`Invalid document: node key "${key}" does not match node.id "${value.id}".`);
        }
        doc.nodes.set(key, value);
    }

    // Structural + range validation: reject documents the edit path could never
    // have produced (dangling parents, ghost roots, opacity: 5, negative sizes).
    validateDocumentIntegrity(doc);

    return doc;
}

/**
 * App versions that shipped BEFORE the schema/app version split and stamped their
 * own release version into the envelope. All of them wrote schema-1 shaped data.
 *
 * Deliberately an explicit closed set, not an open `/^\d+\.\d+\.\d+$/` regex: a
 * regex would also swallow the version of some *future* build whose shape we know
 * nothing about, and silently treat it as schema 1.
 */
const LEGACY_APP_VERSIONS = new Set(["0.0.1", "0.0.2", "0.0.3", "0.0.4", "0.0.5"]);
/** The schema those legacy files actually contain. */
const LEGACY_SCHEMA = "1";

/**
 * Schema gate, keyed on SCHEMA_VERSION (NOT the app version — shipping a new
 * build must never orphan saved documents).
 *
 * - Current schema           → pass through.
 * - Legacy semver-stamped    → same shape as schema 1; re-stamp and accept.
 * - Older known schema       → run the migration chain (none needed yet).
 * - Newer/unknown schema     → throw; we cannot safely read the future.
 */
export function migrateIfNeeded(raw: any, currentSchema: string = SCHEMA_VERSION): SerializedDocument {
    let version: string = raw.version;

    // 1. Refuse the future FIRST — before any normalisation can mislabel it.
    const fileNum = Number(version);
    const currentNum = Number(currentSchema);
    if (Number.isFinite(fileNum) && Number.isFinite(currentNum) && fileNum > currentNum) {
        throw new Error(
            `Document schema "${version}" is newer than this build supports ` +
            `(schema "${currentSchema}"). Update the application to open it.`
        );
    }

    // 2. Normalise legacy app-version stamps to the schema they ACTUALLY contain,
    //    then fall through to the chain below. Re-stamping straight to
    //    SCHEMA_VERSION and returning here would mark a legacy file "fully
    //    migrated" and skip every migration step added later.
    if (LEGACY_APP_VERSIONS.has(version)) {
        raw = { ...raw, version: LEGACY_SCHEMA };
        version = LEGACY_SCHEMA;
    }

    // 3. Migration chain, oldest first. Each step upgrades one schema and lets the
    //    next step run — do NOT return early from inside the chain.
    if (version === "1") { raw = migrate_1_to_2(raw); version = "2"; }
    if (version === "2") { raw = migrate_2_to_3(raw); version = "3"; }
    if (version === "3") { raw = migrate_3_to_4(raw); version = "4"; }
    if (version === "4") { raw = migrate_4_to_5(raw); version = "5"; }
    if (version === "5") { raw = migrate_5_to_6(raw); version = "6"; }

    // 4. Fully migrated?
    if (version === currentSchema) {
        return raw as SerializedDocument;
    }

    throw new Error(
        `Migration not implemented for document schema "${version}". ` +
        `Current schema: "${currentSchema}".`
    );
}

/**
 * Schema 1 → 2: adds the optional `Node.transform`.
 *
 * A pass-through by content: every schema-1 document is already a valid schema-2
 * document with the field absent, and absent means identity. The step exists (rather
 * than the gate simply accepting "1") so the chain stays explicit and the NEXT
 * migration has something to follow — and because a schema-1 *build* must still
 * refuse a schema-2 file, which is what the bump buys.
 */
function migrate_1_to_2(raw: any): any {
    return { ...raw, version: "2" };
}

/** Schema 2 → 3: adds the optional `Layout.container`. Pass-through by content. */
function migrate_2_to_3(raw: any): any {
    return { ...raw, version: "3" };
}

/** Schema 3 → 4: adds optional `LayoutContainer.hugWidth`/`hugHeight`. Pass-through by content. */
function migrate_3_to_4(raw: any): any {
    return { ...raw, version: "4" };
}

/** Schema 4 → 5: adds optional `Layout.grow`. Pass-through by content. */
function migrate_4_to_5(raw: any): any {
    return { ...raw, version: "5" };
}

/** Schema 5 → 6: adds optional `Layout.grid`. Pass-through by content. */
function migrate_5_to_6(raw: any): any {
    return { ...raw, version: "6" };
}

/**
 * Deep equality comparison for two ProjectDocuments.
 * Useful for testing serialization round-trips.
 */
export function compareDocuments(a: ReadonlyDocument, b: ReadonlyDocument): boolean {
    const dateMs = (d: any): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

    if (a.version !== b.version) return false;
    if (a.metadata.project_name !== b.metadata.project_name) return false;
    if (a.metadata.created_by !== b.metadata.created_by) return false;
    if (dateMs(a.metadata.date) !== dateMs(b.metadata.date)) return false;
    if (a.rootNodeUuids.length !== b.rootNodeUuids.length) return false;
    for (let i = 0; i < a.rootNodeUuids.length; i++) {
        if (a.rootNodeUuids[i] !== b.rootNodeUuids[i]) return false;
    }

    if (a.nodes.size !== b.nodes.size) return false;

    for (const [key, nodeA] of a.nodes) {
        const nodeB = b.nodes.get(key);
        if (!nodeB) return false;
        if (JSON.stringify(nodeA) !== JSON.stringify(nodeB)) return false;
    }

    if (JSON.stringify(a.variables) !== JSON.stringify(b.variables)) return false;

    return true;
}

const STORAGE_KEY = "vde-document";
export const CORRUPT_BACKUP_KEY = "vde-document.corrupt-backup";

/** Distinguishes "nothing saved" from "saved but unreadable" for the caller. */
export type SaveResult =
    | { status: "saved" }
    | { status: "failed"; error: Error };

export type LoadResult =
    | { status: "empty"; document: null }
    | { status: "loaded"; document: ProjectDocument }
    | { status: "corrupt"; document: null; error: Error };

/**
 * Convenience namespace for save/load operations using localStorage.
 */
export const Serializer = {
    /** Rich load result: empty (no file) vs corrupt (present but unreadable) vs loaded. */
    loadResult(): LoadResult {
        let raw: string | null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch (e) {
            return { status: "corrupt", document: null, error: e as Error };
        }
        if (raw === null) return { status: "empty", document: null };
        try {
            return { status: "loaded", document: deserializeDocument(raw) };
        } catch (e) {
            // Preserve the unreadable data instead of silently discarding it.
            try { localStorage.setItem(CORRUPT_BACKUP_KEY, raw); } catch { /* ignore */ }
            console.error(
                `Saved document is corrupt; starting fresh. A backup was kept at "${CORRUPT_BACKUP_KEY}".`,
                e
            );
            return { status: "corrupt", document: null, error: e as Error };
        }
    },

    /** Backwards-compatible: the document if readable, otherwise null (empty or corrupt). */
    load(): ProjectDocument | null {
        return this.loadResult().document;
    },

    /**
     * The write path mirrors the read path: a failure (quota exceeded, storage
     * disabled) is a value, not a silent no-op. "Saved" must never be a lie.
     */
    save(doc: ReadonlyDocument): SaveResult {
        try {
            localStorage.setItem(STORAGE_KEY, serializeDocument(doc));
            return { status: "saved" };
        } catch (e) {
            console.error("Failed to save document:", e);
            return { status: "failed", error: e as Error };
        }
    }
};
