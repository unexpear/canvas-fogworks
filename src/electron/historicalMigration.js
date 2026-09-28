/**
 * @module historicalMigration
 * @description Owned 0.0.4 project fixture and the save check for installer migration smokes.
 * The 0.0.4 stamp is the legacy app-version envelope those releases wrote; it is not a
 * synthetic installer and it is not the current schema.
 */
const HISTORICAL_SOURCE_VERSION = "0.0.4";
const HISTORICAL_NODE_ID = "legacy-rect";
const HISTORICAL_GEOMETRY = { x: 5, y: 6, width: 10, height: 10 };

function historicalProjectDocument() {
    return {
        version: HISTORICAL_SOURCE_VERSION,
        document: {
            metadata: { project_name: "Historical release 0.0.4" },
            nodes: {
                [HISTORICAL_NODE_ID]: {
                    id: HISTORICAL_NODE_ID, type: "core.rectangle", parent: null, children: [],
                    geometry: { ...HISTORICAL_GEOMETRY },
                    style: { fill: "#000", opacity: 1 }, layout: {}
                }
            },
            rootNodeUuids: [HISTORICAL_NODE_ID],
            variables: {}
        }
    };
}

function assertMigratedHistoricalProject(content, expectedSchema) {
    if (typeof content !== "string" || !/^\d+$/.test(expectedSchema || "")) {
        throw new Error("Historical migration expectations are incomplete.");
    }
    let saved;
    try { saved = JSON.parse(content); }
    catch { throw new Error("Historical migration save was not JSON."); }
    if (saved.version === HISTORICAL_SOURCE_VERSION || saved.version === "1") {
        throw new Error(`Historical project was not migrated. Version remained ${saved.version}.`);
    }
    if (saved.version !== expectedSchema) {
        throw new Error(`Migrated schema ${saved.version} did not match ${expectedSchema}.`);
    }
    const geometry = saved?.document?.nodes?.[HISTORICAL_NODE_ID]?.geometry;
    for (const key of Object.keys(HISTORICAL_GEOMETRY)) {
        if (!geometry || geometry[key] !== HISTORICAL_GEOMETRY[key]) {
            throw new Error(`Historical rectangle ${key} was not preserved.`);
        }
    }
    return { schema: saved.version, nodeId: HISTORICAL_NODE_ID };
}

module.exports = {
    HISTORICAL_SOURCE_VERSION, HISTORICAL_NODE_ID, HISTORICAL_GEOMETRY,
    historicalProjectDocument, assertMigratedHistoricalProject
};
