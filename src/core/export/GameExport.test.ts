/**
 * @module GameExport.test
 * @description Owned game fixture runs to completion, and offline export refuses missing dependencies and safely embeds authored text.
 */
import { gameReference } from "../examples/ReferenceProjects";
import { serializeDocument } from "../document/Serializer";
import { gameDocumentTargets, gameHtml } from "./GameExport";
import { stepGameplay } from "../runtime/GameplaySession";
import { worldFrom, NO_INPUT } from "../runtime/World";

test("owned reference is playable to victory through the shared gameplay session", () => {
    const doc = gameReference(), before = serializeDocument(doc);
    let world = worldFrom(doc);
    for (let i = 0; i < 300 && world.outcome === "running"; i++) world = stepGameplay(doc, world,
        { controlled: "player", input: { ...NO_INPUT, right: true } }).world;
    expect(world.outcome).toBe("won"); expect(serializeDocument(doc)).toBe(before);
});
test("HTML uses a self-contained player and escapes closing-script injection", () => {
    const doc = gameReference(); doc.metadata.project_name = "</script><script>alert(1)</script>";
    const content = serializeDocument(doc);
    expect(gameDocumentTargets(content)).toEqual([]);
    const html = gameHtml({ entry: "first", levels: { first: { content, links: {} } } }, "AA==");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("data:text/javascript;base64,AA==");
    expect(html).toContain('id="input-settings"');
    expect(html).toContain('id="input-summary"');
    expect(html).toContain("connect-src 'none'");
});
test("unpackaged transitions and nonportable image URLs block export", () => {
    const doc = gameReference(); doc.nodes.get("goal")!.entity!.transitionTo = "next.vde";
    expect(() => gameHtml({ entry: "first", levels: { first: { content: serializeDocument(doc), links: {} } } }, "AA==")).toThrow("Unpackaged");
    doc.nodes.get("player")!.src = "https://example.com/image.png";
    doc.nodes.get("player")!.type = "core.image";
    expect(() => gameDocumentTargets(serializeDocument(doc))).toThrow("Embed image assets");
});
