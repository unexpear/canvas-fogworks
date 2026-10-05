/**
 * @module SaveMigrationsPanel
 * @description Inspector editor for the document's cross-build save-migration list.
 */
import React, { useRef, useState } from "react";
import { DocumentSaveMigration, SAVE_MIGRATION_LIMIT } from "../core/document/SaveMigrations";

const HASH = /^[a-f0-9]{64}$/;
const VERSIONS = [1, 2, 3, 4, 5, 6];

export function SaveMigrationsPanel({ migrations, onChange }: {
    migrations: readonly DocumentSaveMigration[] | undefined;
    onChange: (next: DocumentSaveMigration[] | undefined) => boolean;
}) {
    const rows = migrations ?? [];
    const signature = JSON.stringify(rows);
    const seen = useRef(signature);
    const [drafts, setDrafts] = useState<string[] | null>(null);
    const [error, setError] = useState("");
    if (seen.current !== signature) {
        seen.current = signature;
        if (drafts !== null) setDrafts(null);
        if (error) setError("");
    }
    const shown = drafts ?? rows.map(row => row.fromGameId);
    const commit = (next: DocumentSaveMigration[] | undefined) => {
        setError("");
        if (!onChange(next)) setError("This migration list was refused.");
    };
    const copy = () => rows.map(row => ({ fromGameId: row.fromGameId, versions: [...row.versions] }));
    return <fieldset aria-label="Save migrations" style={{ minWidth: 0, marginTop: 8, padding: 6 }}>
        <legend>Save migrations</legend>
        <p style={{ fontSize: 10, margin: "4px 0" }}>Previous package hashes this document may adopt, at most eight. Only checked progress versions are rewritten onto the current build. Loading a listed save does not write the new slot.</p>
        {rows.map((row, index) => <div key={index} style={{ marginTop: 6 }}>
            <input aria-label={`Save migration build ${index + 1}`} value={shown[index] ?? ""} spellCheck={false}
                onChange={event => {
                    const value = event.target.value;
                    const nextDrafts = shown.slice();
                    nextDrafts[index] = value;
                    setDrafts(nextDrafts);
                    const normalized = value.trim().toLowerCase();
                    if (!HASH.test(normalized)) {
                        setError("Previous build id must be 64 lowercase hex characters.");
                        return;
                    }
                    if (rows.some((other, otherIndex) => otherIndex !== index && other.fromGameId === normalized)) {
                        setError("Duplicate save migration build.");
                        return;
                    }
                    if (normalized === row.fromGameId) { setError(""); return; }
                    const next = copy();
                    next[index] = { fromGameId: normalized, versions: [...row.versions] };
                    commit(next);
                }}
                style={{ width: "100%", boxSizing: "border-box", font: "9px monospace" }} />
            <div>
                {VERSIONS.map(version => <label key={version} style={{ fontSize: 10, marginRight: 4 }}>
                    <input type="checkbox" aria-label={`Save migration ${index + 1} version ${version}`}
                        checked={row.versions.includes(version)}
                        onChange={() => {
                            const versions = row.versions.includes(version)
                                ? row.versions.filter(item => item !== version)
                                : [...row.versions, version].sort((left, right) => left - right);
                            if (!versions.length) { setError("Choose at least one progress version."); return; }
                            const next = copy();
                            next[index] = { fromGameId: row.fromGameId, versions };
                            commit(next);
                        }} /> {version}
                </label>)}
            </div>
            <button type="button" onClick={() => {
                const next = copy().filter((_, rowIndex) => rowIndex !== index);
                commit(next.length ? next : undefined);
            }}>Remove save migration {index + 1}</button>
        </div>)}
        <button type="button" disabled={rows.length >= SAVE_MIGRATION_LIMIT} onClick={() => {
            let hash = "";
            for (let index = 1; index <= SAVE_MIGRATION_LIMIT; index++) {
                const candidate = index.toString(16).padStart(64, "0");
                if (!rows.some(row => row.fromGameId === candidate)) { hash = candidate; break; }
            }
            commit([...copy(), { fromGameId: hash, versions: [...VERSIONS] }]);
        }}>Add save migration</button>
        {error && <p role="alert">{error}</p>}
    </fieldset>;
}
