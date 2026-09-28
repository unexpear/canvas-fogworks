const { deserializeDocument, serializeDocument } = require("../core/document/Serializer");
const { SCHEMA_VERSION } = require("../core/document/Document");
const { historicalProjectDocument, assertMigratedHistoricalProject } = require("./historicalMigration") as {
    historicalProjectDocument: () => { version: string };
    assertMigratedHistoricalProject: (content: string, expectedSchema: string) => { schema: string; nodeId: string };
};

describe("historical release migration", () => {
    test("a 0.0.4 app-version project migrates to the current schema and keeps its rectangle", () => {
        const raw = historicalProjectDocument();
        expect(raw.version).toBe("0.0.4");
        const doc = deserializeDocument(JSON.stringify(raw));
        expect(doc.version).toBe(SCHEMA_VERSION);
        expect(doc.nodes.get("legacy-rect")?.geometry).toMatchObject({ x: 5, y: 6, width: 10, height: 10 });
        expect(assertMigratedHistoricalProject(serializeDocument(doc), SCHEMA_VERSION)).toEqual({
            schema: SCHEMA_VERSION, nodeId: "legacy-rect"
        });
    });
});
