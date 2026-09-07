/**
 * @module GameplaySession.test
 * @description Authored gameplay conditions, deterministic start events and sound requests never mutate the authored document.
 */
import { createEmptyDocument } from "../document/Document";
import { ActionDispatcher } from "../actions/ActionDispatcher";
import { AddNodeAction } from "../actions/AddNodeAction";
import { UpdateNodeContentAction } from "../actions/UpdateNodeContentAction";
import { serializeDocument, deserializeDocument } from "../document/Serializer";
import { gameplayRulesError, GameplayRule } from "../document/Gameplay";
import { authoredCommands, stepGameplay } from "./GameplaySession";
import { worldFrom, NO_INPUT } from "./World";

function fixture(rules: GameplayRule[]) {
    const d = new ActionDispatcher(createEmptyDocument());
    d.dispatchAction(new AddNodeAction(d.getDocument(), "core.rectangle", 0, 0, 20, 20, "red", "actor"));
    d.dispatchAction(new UpdateNodeContentAction(d.getDocument(), "actor", { entity: { player: true, body: "dynamic", rulePolicy: "authored", rules } }));
    return d;
}
test("start commands execute once per run, persist through reload and never touch undo history", () => {
    const d = fixture([{ event: "start", other: "any", target: "self", action: { kind: "score", key: "visits" } }]);
    const before = serializeDocument(d.getDocument()), doc = deserializeDocument(before);
    const first = stepGameplay(doc, worldFrom(doc), { controlled: "actor", input: NO_INPUT });
    const second = stepGameplay(doc, first.world, { controlled: "actor", input: NO_INPUT });
    expect(first.world.tallies.get("visits")).toBe(1); expect(second.world.tallies.get("visits")).toBe(1);
    expect(serializeDocument(d.getDocument())).toBe(before);
    expect(d.undo()?.nodes.get("actor")?.entity).toBeUndefined();
});
test("player condition and event owner route commands and audio deterministically", () => {
    const sound = "data:audio/wav;base64,AA==";
    const d = fixture([{ event: "enter", other: "player", target: "other", action: { kind: "velocity", x: 20, y: -30 } },
        { event: "enter", other: "player", target: "self", action: { kind: "sound", source: sound, volume: .5 } }]);
    const world = { ...worldFrom(d.getDocument()), events: [{ kind: "enter" as const, bodyId: "visitor", nodeId: "actor", className: "" }] };
    expect(authoredCommands(d.getDocument(), world, "different", false)).toEqual({ commands: [], sounds: [] });
    expect(authoredCommands(d.getDocument(), world, "visitor", false)).toEqual({
        commands: [{ kind: "setVelocity", bodyId: "visitor", vx: 20, vy: -30 }], sounds: [{ source: sound, volume: .5 }] });
});
test("invalid rules, nonfinite commands and external audio never enter persisted state", () => {
    expect(gameplayRulesError([{ event: "eval", action: { kind: "win" } }])).not.toBeNull();
    expect(gameplayRulesError([{ event: "start", other: "any", target: "self", action: { kind: "velocity", x: NaN, y: 1 } }])).not.toBeNull();
    expect(gameplayRulesError([{ event: "start", other: "any", target: "self", action: { kind: "sound", source: "https://example.com/audio.wav", volume: 1 } }])).not.toBeNull();
});
