/**
 * @module Serializer
 * @description Handles serialization and deserialization of ProjectDocuments.
 * Owns versioning: every saved file carries a SCHEMA_VERSION envelope (NOT the app
 * version). migrateIfNeeded refuses newer schemas, normalises legacy app-version
 * stamps, then runs the migration chain; unknown versions throw.
 */

import { statesError } from "./Components";
import { ProjectDocument, ReadonlyDocument, ThemeMode, createEmptyDocument, SCHEMA_VERSION, SerializedMetadata } from "./Document";
import { Clip } from "./Clips";
import { Node, isNodeType, srcError, srcValueError } from "./Node";
import { variableError, variableKeyError, VARIABLES_MAX } from "./Variables";
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
        // radius/fontSize: number OR string (a "$token", schema 20) — the shallow gate; the
        // token-or-range semantic lives once in `styleError` (Integrity), like the effects.
        (n.style.radius === undefined || typeof n.style.radius === "number" || typeof n.style.radius === "string") &&
        (n.style.fontSize === undefined || typeof n.style.fontSize === "number" || typeof n.style.fontSize === "string") &&
        (n.style.strokeWidth === undefined || typeof n.style.strokeWidth === "number" || typeof n.style.strokeWidth === "string") &&
        // Shallow structural gate for the schema-18 effects; the semantic rules (finite, >=0)
        // live once in `styleError` (Integrity), like the transform gate.
        (n.style.blur === undefined || typeof n.style.blur === "number") &&
        (n.style.shadow === undefined || (isPlainObject(n.style.shadow) &&
            typeof n.style.shadow.dx === "number" && typeof n.style.shadow.dy === "number" &&
            typeof n.style.shadow.blur === "number" && typeof n.style.shadow.color === "string")) &&
        isPlainObject(n.layout) &&
        (n.layout.container === undefined || isPlainObject(n.layout.container)) &&
        isOptionalString(n.text) && isOptionalString(n.src) && isOptionalString(n.name) &&
        // Shallow structural gate only (array of command objects); the semantic rules
        // (first M, finite coords, command cap) live once in `pathError` (Integrity).
        (n.path === undefined || (Array.isArray(n.path) && n.path.every((c: any) => c !== null && typeof c === "object" && !Array.isArray(c)))) &&
        // Shallow gate for the M6 instance reference; the semantic rule (only an instance may
        // carry it, non-empty) lives once in `componentError` (Integrity), like the effects.
        isOptionalString(n.componentId) &&
        // Shallow gate for the schema-33 boolean operation; the semantic rule (only a
        // `core.boolean`, and one of the four names) lives once in `booleanOpError`.
        isOptionalString(n.booleanOp) &&
        // Shallow gate for the schema-35 interactions array; the semantic rules live once in
        // `interactionsError`, like the path commands and the boolean op.
        (n.interactions === undefined || Array.isArray(n.interactions)) &&
        // Shallow gate for the schema-22 overrides map; the semantic rules live once in
        // `overridesError` (Integrity), like the effects and the path commands.
        (n.overrides === undefined || isPlainObject(n.overrides)) &&
        // Shallow gates for the schema-27 variant maps; the semantic rules live once in
        // `variantError` / `variantSelectionError` (Integrity).
        (n.variant === undefined || isPlainObject(n.variant)) &&
        (n.variants === undefined || isPlainObject(n.variants)) &&
        // Shallow gates for the schema-29 slot fields; semantics live in `slotError` /
        // `slotContentError` (Integrity).
        isOptionalString(n.slot) &&
        // Layer flags (schema 31) — plain booleans, so the shallow gate IS the whole rule.
        (n.hidden === undefined || typeof n.hidden === "boolean") &&
        (n.locked === undefined || typeof n.locked === "boolean") &&
        (n.slotContent === undefined || isPlainObject(n.slotContent)) &&
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
        /** Theme mode for token resolution (schema 19). Absent on old/hand-edited files = "light". */
        activeTheme?: ThemeMode;
        /** The named STATE every node resolves against (M7, schema 30). Absent = the base. */
        activeState?: string;
        /** The document's clock and where it is on it (schema 39). Absent = not animated. */
        timeline?: { frames: number; fps: number };
        clips?: readonly Clip[];
        frame?: number;
        /** The scene's lighting (schema 42). Absent = unlit. */
        lights?: readonly import("./Light").Light[];
        ambient?: number;
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
            variables: doc.variables as ProjectDocument["variables"],
            activeTheme: doc.activeTheme,
            // Omitted when absent, so a document with no state selection serializes exactly as
            // it did before M7 — `compareDocuments` would otherwise see `undefined` vs missing.
            ...(doc.activeState !== undefined ? { activeState: doc.activeState } : {}),
            // Omitted when absent for the same reason: a document nobody animated must serialize
            // byte-for-byte as it did before the timeline existed.
            ...(doc.timeline !== undefined ? { timeline: doc.timeline } : {}),
            ...(doc.clips !== undefined ? { clips: doc.clips } : {}),
            ...(doc.frame !== undefined ? { frame: doc.frame } : {}),
            ...(doc.lights !== undefined ? { lights: doc.lights } : {}),
            ...(doc.ambient !== undefined ? { ambient: doc.ambient } : {})
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
    // Copy the theme WHENEVER the key is present (even malformed) so Integrity can reject a
    // bad value — a silent default here would hide "activeTheme": "banana". Absent = "light".
    if ("activeTheme" in migrated.document) {
        doc.activeTheme = migrated.document.activeTheme as ThemeMode;
    }
    // Same rule for the active state: copy it through whenever present, even malformed, so
    // Integrity is the one place that judges it.
    if ("activeState" in migrated.document) {
        doc.activeState = migrated.document.activeState as string;
    }
    // And the clock: copied through whenever present, malformed included, so `Integrity` remains
    // the single judge of it.
    if ("timeline" in migrated.document) {
        doc.timeline = migrated.document.timeline as { frames: number; fps: number };
    }
    if ("frame" in migrated.document) {
        doc.frame = migrated.document.frame as number;
    }
    // Clips ride through the same way — malformed included, so `Integrity` stays the single judge.
    if ("clips" in migrated.document) {
        doc.clips = migrated.document.clips as Clip[];
    }
    // Copied through even when malformed, so `Integrity` stays the single judge.
    if ("lights" in migrated.document) {
        doc.lights = migrated.document.lights as ProjectDocument["lights"];
    }
    if ("ambient" in migrated.document) {
        doc.ambient = migrated.document.ambient as number;
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
    if (version === "6") { raw = migrate_6_to_7(raw); version = "7"; }
    if (version === "7") { raw = migrate_7_to_8(raw); version = "8"; }
    if (version === "8") { raw = migrate_8_to_9(raw); version = "9"; }
    if (version === "9") { raw = migrate_9_to_10(raw); version = "10"; }
    if (version === "10") { raw = migrate_10_to_11(raw); version = "11"; }
    if (version === "11") { raw = migrate_11_to_12(raw); version = "12"; }
    if (version === "12") { raw = migrate_12_to_13(raw); version = "13"; }
    if (version === "13") { raw = migrate_13_to_14(raw); version = "14"; }
    if (version === "14") { raw = migrate_14_to_15(raw); version = "15"; }
    if (version === "15") { raw = migrate_15_to_16(raw); version = "16"; }
    if (version === "16") { raw = migrate_16_to_17(raw); version = "17"; }
    if (version === "17") { raw = migrate_17_to_18(raw); version = "18"; }
    if (version === "18") { raw = migrate_18_to_19(raw); version = "19"; }
    if (version === "19") { raw = migrate_19_to_20(raw); version = "20"; }
    if (version === "20") { raw = migrate_20_to_21(raw); version = "21"; }
    if (version === "21") { raw = migrate_21_to_22(raw); version = "22"; }
    if (version === "22") { raw = migrate_22_to_23(raw); version = "23"; }
    if (version === "23") { raw = migrate_23_to_24(raw); version = "24"; }
    if (version === "24") { raw = migrate_24_to_25(raw); version = "25"; }

    if (version === "25") { raw = migrate_25_to_26(raw); version = "26"; }
    if (version === "26") { raw = migrate_26_to_27(raw); version = "27"; }
    if (version === "27") { raw = migrate_27_to_28(raw); version = "28"; }
    if (version === "28") { raw = migrate_28_to_29(raw); version = "29"; }
    if (version === "29") { raw = migrate_29_to_30(raw); version = "30"; }
    if (version === "30") { raw = migrate_30_to_31(raw); version = "31"; }
    if (version === "31") { raw = migrate_31_to_32(raw); version = "32"; }
    if (version === "32") { raw = migrate_32_to_33(raw); version = "33"; }
    if (version === "33") { raw = migrate_33_to_34(raw); version = "34"; }
    if (version === "34") { raw = migrate_34_to_35(raw); version = "35"; }
    if (version === "35") { raw = migrate_35_to_36(raw); version = "36"; }
    if (version === "36") { raw = migrate_36_to_37(raw); version = "37"; }
    if (version === "37") { raw = migrate_37_to_38(raw); version = "38"; }
    if (version === "38") { raw = migrate_38_to_39(raw); version = "39"; }
    if (version === "39") { raw = migrate_39_to_40(raw); version = "40"; }
    if (version === "40") { raw = migrate_40_to_41(raw); version = "41"; }
    if (version === "41") { raw = migrate_41_to_42(raw); version = "42"; }
    if (version === "42") { raw = migrate_42_to_43(raw); version = "43"; }
    if (version === "43") { raw = migrate_43_to_44(raw); version = "44"; }
    if (version === "44") { raw = migrate_44_to_45(raw); version = "45"; }
    if (version === "45") { raw = migrate_45_to_46(raw); version = "46"; }

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

/** Schema 6 → 7: adds optional `Layout.constraints`/`constraintRef`. Pass-through by content. */
function migrate_6_to_7(raw: any): any {
    return { ...raw, version: "7" };
}

/** Schema 7 → 8: adds optional `Layout.position`/`Layout.margin`. Pass-through by content. */
function migrate_7_to_8(raw: any): any {
    return { ...raw, version: "8" };
}

/** Schema 8 → 9: adds optional `Layout.shrink`. Pass-through by content. */
function migrate_8_to_9(raw: any): any {
    return { ...raw, version: "9" };
}

/** Schema 9 → 10: adds optional `LayoutGrid.rows` (explicit per-row tracks). Pass-through by content. */
function migrate_9_to_10(raw: any): any {
    return { ...raw, version: "10" };
}

/** Schema 10 → 11: adds the `auto` TrackSize + `LayoutGrid.hugWidth/hugHeight`. Pass-through by content. */
function migrate_10_to_11(raw: any): any {
    return { ...raw, version: "11" };
}

/** Schema 11 → 12: adds `LayoutContainer.wrap` (flex-wrap). Pass-through by content. */
function migrate_11_to_12(raw: any): any {
    return { ...raw, version: "12" };
}

/** Schema 12 → 13: adds `Layout.colSpan`/`rowSpan` (grid item spans). Pass-through by content. */
function migrate_12_to_13(raw: any): any {
    return { ...raw, version: "13" };
}

/** Schema 13 → 14: widens `Layout.margin` to `number | Margins` + grid-cell margins. Pass-through by content. */
function migrate_13_to_14(raw: any): any {
    return { ...raw, version: "14" };
}

/** Schema 14 → 15: M2 close-out — alignContent/wrapReverse + grid autoFlow + gridColumn/gridRow. Pass-through by content. */
function migrate_14_to_15(raw: any): any {
    return { ...raw, version: "15" };
}

/** Schema 15 → 16: adds the `core.ellipse` and `core.line` node types. Pass-through by content. */
function migrate_15_to_16(raw: any): any {
    return { ...raw, version: "16" };
}

/** Schema 16 → 17: adds the `core.path` node type + `Node.path` commands. Pass-through by content. */
function migrate_16_to_17(raw: any): any {
    return { ...raw, version: "17" };
}

/** Schema 17 → 18: adds `Style.shadow` + `Style.blur` (drop shadow + gaussian blur). Pass-through by content. */
function migrate_17_to_18(raw: any): any {
    return { ...raw, version: "18" };
}

/**
 * One legacy variable entry → its schema-19 form, or null to drop it. The old reserved
 * store was NEVER validated (`value` was typed `string` for every type), so this is a
 * normalizer, not a pass-through: a `spacing` variable's numeric-string value ("8") is
 * coerced to the number schema 19 requires (base and per-mode alike, aliases untouched),
 * and anything that still fails the shared `variableError` is dropped — a previously-
 * loadable file must stay loadable, junk and all.
 */
function normalizeLegacyVariable(def: any): any | null {
    if (!def || typeof def !== "object" || Array.isArray(def)) return null;
    let d = def;
    if (d.type === "spacing") {
        const coerce = (v: any) =>
            (typeof v === "string" && !v.startsWith("$") && v.trim() !== "" && Number.isFinite(Number(v)))
                ? Number(v) : v;
        d = { ...d, value: coerce(d.value) };
        if (d.modes && typeof d.modes === "object" && !Array.isArray(d.modes)) {
            d.modes = Object.fromEntries(Object.entries(d.modes).map(([k, v]) => [k, coerce(v)]));
        }
    }
    return variableError(d) === null ? d : null;
}

/**
 * Schema 18 → 19: design tokens go LIVE (Milestone 5). NOT a pass-through — the first
 * migration with content: stamps `activeTheme` ("light" unless a valid mode is already
 * present) and sanitizes the never-before-validated `variables` store (coercing legacy
 * string-spacing, dropping unvalidatable entries) so schema 19's strict load validation
 * cannot reject a file schema 18 accepted.
 */
function migrate_18_to_19(raw: any): any {
    const d = (raw && typeof raw.document === "object" && raw.document) ? raw.document : {};
    const src = (d.variables && typeof d.variables === "object" && !Array.isArray(d.variables)) ? d.variables : {};
    const variables: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, def] of Object.entries(src)) {
        // Schema 19 caps the store at VARIABLES_MAX; the legacy store had no cap, so an
        // over-cap file must be TRUNCATED here (keep the first entries, in file order) or the
        // sanitized output would fail the very validation this migration exists to satisfy.
        if (kept >= VARIABLES_MAX) break;
        if (variableKeyError(key) !== null) continue; // unkeyable (empty/long/"$"/reserved) → drop
        const fixed = normalizeLegacyVariable(def);
        if (fixed !== null) { variables[key] = fixed; kept++; }
    }
    const activeTheme = d.activeTheme === "dark" ? "dark" : "light";
    return { ...raw, version: "19", document: { ...d, variables, activeTheme } };
}

/** Schema 19 → 20: widens `Style.radius`/`fontSize` to `number | string` (number tokens,
 *  resolved at render time). Pass-through by content — existing files carry only numbers. */
function migrate_19_to_20(raw: any): any {
    return { ...raw, version: "20" };
}

/**
 * Schema 20 → 21: adds the `core.instance` node type + `Node.componentId` (M6 components) and
 * RESERVES `::` in stored node ids (the virtual-id separator). The type/field are pass-through
 * by content, but the id rule is RETROACTIVE — a schema-20 file whose node id contains `::`
 * loaded fine and would now be permanently unreadable. So this step RENAMES those ids (`::` →
 * `__`, de-duplicated) and rewrites every reference to them: the node map keys, `id`, `parent`,
 * `children`, `rootNodeUuids`, and `componentId`. Previously-loadable files stay loadable —
 * the same obligation the 18→19 store sanitizer carries.
 */
function migrate_20_to_21(raw: any): any {
    const d = (raw && typeof raw.document === "object" && raw.document) ? raw.document : {};
    const src = (d.nodes && typeof d.nodes === "object" && !Array.isArray(d.nodes)) ? d.nodes : {};
    const ids = Object.keys(src);
    const offending = ids.filter(id => id.includes("::"));
    if (offending.length === 0) return { ...raw, version: "21" };

    const taken = new Set(ids);
    const rename = new Map<string, string>();
    for (const id of offending) {
        let next = id.split("::").join("__");
        while (taken.has(next) || rename.has(next)) next = `${next}_`; // keep ids unique
        taken.add(next);
        rename.set(id, next);
    }
    const map = (v: unknown): unknown => (typeof v === "string" && rename.has(v)) ? rename.get(v) : v;

    const nodes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
        const n = (value && typeof value === "object" && !Array.isArray(value)) ? { ...(value as Record<string, unknown>) } : value;
        if (n && typeof n === "object") {
            const node = n as Record<string, unknown>;
            node.id = map(node.id);
            node.parent = map(node.parent);
            if (Array.isArray(node.children)) node.children = node.children.map(map);
            if (node.componentId !== undefined) node.componentId = map(node.componentId);
        }
        nodes[String(map(key))] = n;
    }
    const rootNodeUuids = Array.isArray(d.rootNodeUuids) ? d.rootNodeUuids.map(map) : d.rootNodeUuids;
    return { ...raw, version: "21", document: { ...d, nodes, rootNodeUuids } };
}

/** Schema 21 → 22: adds `Node.overrides` (per-instance property overrides, M6 slice 2).
 *  Pass-through by content — existing documents carry none, and an absent map means
 *  "this instance mirrors its master exactly", which is what schema 21 already meant. */
function migrate_21_to_22(raw: any): any {
    return { ...raw, version: "22" };
}

/**
 * 22 → 23: `Node.src` gained a shared validator (`srcError`) — a CONSTRAINT, not a field, so
 * documents that were loadable before could become unloadable. A `src` that the new rule
 * rejects (wrong node type, non-string, over `IMAGE_SRC_MAX`, or a scheme no renderer can
 * draw) is DROPPED rather than failing the load: the image then draws nothing, exactly as an
 * image with no source always has. Same obligation the 18→19 store sanitizer and the 20→21
 * id renamer carry — when a bump adds a rule, ask what previously-valid document it rejects.
 */
/**
 * 23 → 24: the image-source rule now reaches a per-instance OVERRIDE too (`overridesError` +
 * `overrideAgainstMasterError`). Schema 23 validated an override `src` as merely "a string",
 * so a document could carry one that no stored node may hold — and a DETACH would bake it into
 * a stored node, producing a file the loader then refuses. Another CONSTRAINT, so again the
 * offending entry is DROPPED rather than failing the load: the copy simply shows the master's
 * source. The type-aware half (only a core.image master may take a src override) is sanitized
 * here too, since the migration can resolve the master.
 */
/**
 * 24 -> 25: Style.strokeWidth. A NEW optional field, not a constraint — a document without it
 * is still valid and still renders exactly as before (an absent width means the hairline every
 * stroke has always been), so nothing needs sanitizing and this is a pass-through. The bump is
 * still required: an OLD BUILD reading a file that HAS the field is the hazard a version guards.
 */
/**
 * 25 -> 26: `InstanceOverride` gained `layout` and `transform`.
 *
 * Both are OPTIONAL additions to a per-instance override, so every schema-25 document is
 * already a valid schema-26 one and nothing needs sanitizing. The bump is still required for
 * the usual reason: an OLD BUILD reading a file that HAS them would ignore the override and
 * lay the copy out — or leave it unrotated — exactly as the master, silently drawing a
 * different picture from the one that was saved.
 */
/**
 * 26 -> 27: variants — `Node.variant` on a master, `Node.variants` on an instance.
 *
 * Two new optional fields, so every schema-26 document is already a valid schema-27 one.
 * The bump is required because an OLD BUILD reading a file that HAS them would ignore the
 * selection and draw whichever master `componentId` names — a different picture, silently.
 */
/**
 * 27 -> 28: an override KEY became a PATH of master node ids.
 *
 * Every schema-27 key is a single segment, which is still exactly what a one-element path
 * means, so no stored key changes and this is a pass-through. The bump is required in the
 * other direction: a schema-27 build REJECTS a key containing `::` outright (its rule was
 * "must not contain the virtual-id separator"), so a file using nested overrides would fail
 * to load rather than merely lose them.
 */
/**
 * 28 -> 29: SLOTS — `Node.slot` on a master node, `Node.slotContent` on an instance.
 *
 * Two new optional fields, so every schema-28 document is already a valid schema-29 one.
 * The bump is required because an OLD BUILD would ignore `slotContent` and draw the slot's
 * DEFAULT children instead of what the instance put there — a different picture, silently.
 */
/**
 * 29 -> 30: `Node.states` became a REAL type (M7), and the document gained `activeState`.
 *
 * The first sanitizing migration since 18->19, and for the same reason: `states` was declared
 * as `{ [key: string]: any }` and validated by nothing, so any shape at all could be sitting
 * in an existing file. Validating it now without sanitizing would make those files
 * UNLOADABLE — a field nobody could read suddenly bricking documents that used it.
 *
 * So each entry is checked against the real rules and DROPPED if it fails, and a node left
 * with no valid states loses the field entirely. Dropping beats repairing: there is no
 * meaningful way to guess what an arbitrary blob was supposed to mean, and a state nobody
 * can render is exactly as useful gone.
 */
/**
 * 30 -> 31: layer flags — `Node.hidden` and `Node.locked`.
 *
 * Two new optional booleans, absent meaning visible and unlocked, so every schema-30 document
 * is already a valid schema-31 one. The bump is required because an OLD BUILD would ignore
 * `hidden` and DRAW a node the file says to hide — a different picture, silently.
 */
/**
 * 31 -> 32: opacity INHERITS — a node now draws at its own opacity times every ancestor's.
 *
 * Nothing stored changes, which is exactly why the bump matters: this is an INTERPRETATION
 * change, the other half of the rule. The same file draws differently on either side — an old
 * build renders the children of a 50%% group fully opaque — so a version guard is the only
 * thing that stops the two from silently disagreeing about the same document.
 */
/**
 * 32 -> 33: `core.boolean` — a node whose CHILDREN combine, resolved at the display seam.
 *
 * Nothing in an existing document changes: the type is new, `booleanOp` is new and optional, and
 * every schema-32 file is already a valid 33 one. The bump is required because an OLD BUILD
 * reading a 33 document would not know the type at all — it would draw the operands separately
 * (or fall back to a placeholder box) instead of the combined shape, which is a different picture
 * from the same file. That is exactly the disagreement a version guard exists to prevent.
 */
/**
 * 33 -> 34: TYPOGRAPHY — fontFamily, fontWeight, textAlign, lineHeight, letterSpacing.
 *
 * Five new optional style fields, each absent meaning the value already being drawn, so every
 * schema-33 document is a valid 34 one and looks the same. The bump is required for a smaller
 * reason that is easy to miss: an OLD BUILD reading a 34 file would IGNORE them and draw the
 * text left-aligned at weight 400 in the default family, which is a different picture from the
 * same file. It also carries one INTERPRETATION change — an explicit newline is now a hard line
 * break in both backends (the SVG one sets `white-space: pre-wrap`) where it used to collapse to
 * a space, so text that was authored as one paragraph draws as several.
 */
/**
 * 34 -> 35: prototype INTERACTIONS — `Node.interactions` (trigger, target state, transition).
 *
 * One new optional array; absent means the node is not interactive, so every schema-34 document
 * is already a valid 35 one and looks identical AT REST. The bump matters for what happens when
 * it is not at rest: an old build ignores the field, so a prototype that responds to a click in
 * one build is inert in the other — the same file, two different documents to use.
 */
/**
 * 35 -> 36: an interaction may NAVIGATE — `Interaction.target`, a node the viewport moves to fit.
 *
 * One new optional field on a field that is itself new; absent means the interaction only changes
 * state, exactly as before. The bump is required for the same reason 34->35 was: an old build
 * ignores it, so a prototype that changes screen in one build stays put in the other.
 */
/**
 * 36 -> 37: stroke JOIN, CAP and MITER LIMIT — `Style.strokeJoin`, `strokeCap`, `strokeMiterLimit`.
 *
 * Additive, and every absent value is the one all three backends already used ("miter", "butt",
 * 4), so a schema-36 document draws identically and needs no rewriting. The bump is required for
 * the same reason 34->35 was: an OLD build ignores the fields, so a shape whose corners are
 * rounded in one build is mitred in the other — the same file, two different drawings.
 */
/**
 * 37 -> 38: the FILL RULE — `Style.fillRule`, "nonzero" or "evenodd".
 *
 * Additive, and absent is the rule every backend already applied, so a schema-37 document draws
 * identically. The bump is required for the stronger of the two reasons a bump can have: it is an
 * INTERPRETATION change. An old build ignores the field and fills a self-crossing path solid where
 * the author asked for a hole — the same file, two different drawings, which is precisely what
 * 31->32 (inherited opacity) was for.
 */
/**
 * 38 -> 39: ANIMATION — `Document.timeline`, `Document.frame`, and `Node.track`.
 *
 * Additive: absent means the document is not animated, which every schema-38 document is, so it
 * loads and draws identically. The bump is required for the interpretation reason rather than the
 * shape one — an OLD build ignores the fields and shows every frame of an animation as its
 * authored pose, which is a different drawing of the same file.
 */
/**
 * 39 -> 40: DEPTH — `Node.depth`, how far back a node sits.
 *
 * Additive, and absent means 0, the plane of the page, which is where every schema-39 node
 * already was — so the document draws identically. The bump is the interpretation kind: an old
 * build ignores the field and draws a background layer in front of the thing it is behind.
 */
/**
 * 40 -> 41: MESHES — `Node.mesh`, a grid of control points that bends a node's outline.
 *
 * Additive: absent means rigid, which every schema-40 node was, so the document draws identically.
 * The bump is the interpretation kind — an old build ignores the field and draws the UNBENT shape,
 * which is the same file showing a different picture.
 */
/**
 * 41 -> 42: LIGHTING — `Document.lights`, `Document.ambient`, and `z` on a mesh control point.
 *
 * Additive, and every absent value means unlit and flat, which every schema-41 document was — so
 * it draws identically. The bump is the interpretation kind: an old build ignores the fields and
 * shows a lit scene flat, which is the same file drawn differently.
 */
/**
 * 42 → 43: mesh control points become FRACTIONS of the node's box instead of local units.
 *
 * A CONTENT migration, and one of the few here that has to read a sibling field: each point is
 * divided by the geometry the mesh was authored against, which is the node's own box. The shape
 * therefore draws identically after the migration — that is the test — while gaining the property
 * absolute units could not have, which is surviving a resize.
 *
 * The bump is the INTERPRETATION kind at its purest. Nothing about the file's shape changes; the
 * same three numbers mean something different. An old build reading a schema-43 document would
 * see every control point at a fraction of a unit and collapse the shape into its top-left corner
 * — which is exactly why `SCHEMA_VERSION` gates loading rather than merely labelling.
 *
 * A ZERO-sized box has no fraction to divide into, so its mesh is DROPPED rather than turned into
 * `Infinity` or `NaN`. That is a mesh on a shape with no area, which drew nothing before and draws
 * nothing after; keeping it would produce a document the loader's own `meshError` rejects.
 */
/**
 * 43 → 44: `easing` may be a CUBIC BÉZIER as well as one of the four names.
 *
 * Additive, and every schema-43 document used a name, so it draws identically. The bump is the
 * INTERPRETATION kind for the direction that matters: an old build reading a schema-44 file would
 * find an object where it expects a string, fail its own `includes` check and reject the document
 * — which is the loader working, and exactly what `SCHEMA_VERSION` gates for.
 */
/**
 * 44 → 45: a keyframe may carry PER-PROPERTY easing curves (`easings`).
 *
 * Additive — every schema-44 keyframe eased all its properties together, and absent `easings`
 * still does. The bump is the interpretation kind in the usual direction: an old build reading a
 * schema-45 file would ignore the map and tween the ball's horizontal motion on gravity's curve,
 * which is the bug this field exists to remove.
 */
/**
 * 45 -> 46: `Document.clips` — named frame ranges over the timeline.
 *
 * Additive. A schema-45 document has one animation, which is exactly what "no clips" means, so it
 * plays identically. The bump is the usual interpretation direction: an old build reading a
 * schema-46 file would ignore the clip list and play the whole strip as one animation — a
 * character running its idle, walk and death back to back.
 */
function migrate_45_to_46(raw: any): any {
    return { ...raw, version: "46" };
}

function migrate_44_to_45(raw: any): any {
    return { ...raw, version: "45" };
}

function migrate_43_to_44(raw: any): any {
    return { ...raw, version: "44" };
}

function migrate_42_to_43(raw: any): any {
    const nodes = raw?.document?.nodes;
    if (!nodes || typeof nodes !== "object") return { ...raw, version: "43" };
    const out: any = {};
    for (const [id, n] of Object.entries<any>(nodes)) {
        const mesh = n?.mesh;
        const w = n?.geometry?.width, h = n?.geometry?.height;
        if (!mesh || !Array.isArray(mesh.points)) { out[id] = n; continue; }
        if (!Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0) {
            const { mesh: _dropped, ...rest } = n;
            out[id] = rest;
            continue;
        }
        out[id] = { ...n, mesh: { ...mesh, points: mesh.points.map((p: any) => ({
            ...p,
            x: (Number(p?.x) || 0) / w,
            y: (Number(p?.y) || 0) / h
        })) } };
    }
    return { ...raw, version: "43", document: { ...raw.document, nodes: out } };
}

function migrate_41_to_42(raw: any): any {
    return { ...raw, version: "42" };
}

function migrate_40_to_41(raw: any): any {
    return { ...raw, version: "41" };
}

function migrate_39_to_40(raw: any): any {
    return { ...raw, version: "40" };
}

function migrate_38_to_39(raw: any): any {
    return { ...raw, version: "39" };
}

function migrate_37_to_38(raw: any): any {
    return { ...raw, version: "38" };
}

function migrate_36_to_37(raw: any): any {
    return { ...raw, version: "37" };
}

function migrate_35_to_36(raw: any): any {
    return { ...raw, version: "36" };
}

function migrate_34_to_35(raw: any): any {
    return { ...raw, version: "35" };
}

function migrate_33_to_34(raw: any): any {
    return { ...raw, version: "34" };
}

function migrate_32_to_33(raw: any): any {
    return { ...raw, version: "33" };
}

function migrate_31_to_32(raw: any): any {
    return { ...raw, version: "32" };
}

function migrate_30_to_31(raw: any): any {
    return { ...raw, version: "31" };
}

function migrate_29_to_30(raw: any): any {
    const nodes = raw?.document?.nodes;
    if (nodes && typeof nodes === "object") {
        for (const node of Object.values<any>(nodes)) {
            const states = node?.states;
            if (!states || typeof states !== "object" || Array.isArray(states)) {
                if (states !== undefined) delete node.states;   // not even a map — nothing to keep
                continue;
            }
            for (const [name, def] of Object.entries(states)) {
                if (statesError({ [name]: def }) !== null) delete states[name];
            }
            if (Object.keys(states).length === 0) delete node.states;
        }
    }
    return { ...raw, version: "30" };
}

function migrate_28_to_29(raw: any): any {
    return { ...raw, version: "29" };
}

function migrate_27_to_28(raw: any): any {
    return { ...raw, version: "28" };
}

function migrate_26_to_27(raw: any): any {
    return { ...raw, version: "27" };
}

function migrate_25_to_26(raw: any): any {
    return { ...raw, version: "26" };
}

function migrate_24_to_25(raw: any): any {
    return { ...raw, version: "25" };
}

function migrate_23_to_24(raw: any): any {
    const nodes = raw?.document?.nodes;
    if (nodes && typeof nodes === "object") {
        for (const node of Object.values<any>(nodes)) {
            const overrides = node?.overrides;
            if (!overrides || typeof overrides !== "object") continue;
            for (const [key, o] of Object.entries<any>(overrides)) {
                if (!o || o.src === undefined) continue;
                const master = nodes[key];
                if (srcValueError(o.src) !== null || (master && master.type !== "core.image")) {
                    delete o.src;
                }
            }
        }
    }
    return { ...raw, version: "24" };
}

function migrate_22_to_23(raw: any): any {
    const nodes = raw?.document?.nodes;
    if (nodes && typeof nodes === "object") {
        for (const node of Object.values<any>(nodes)) {
            if (node && node.src !== undefined && srcError(node.type, node.src) !== null) {
                delete node.src;
            }
        }
    }
    return { ...raw, version: "23" };
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
    if (a.activeTheme !== b.activeTheme) return false;

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
