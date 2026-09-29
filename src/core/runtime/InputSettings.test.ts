/** @module InputSettings.test @description Named-input validation, persistence and player mappings. */
import { InputActions, PLAYER_ACTIONS } from "./InputActions";
import { NAMED_INPUTS, addInputCode, defaultInputBindings, eventCode, inputSettingsError, inputSettingsSummary, parseInputSettings, platformerInput, readInputSettings, removeInputCode, serializeInputSettings, sharedInputWarnings, spatialInput, writeInputSettings, INPUT_SETTINGS_STORAGE_KEY } from "./InputSettings";

test("defaults cover every player action and round-trip through version 1", () => {
    const bindings = defaultInputBindings();
    expect(Object.keys(bindings).sort()).toEqual(NAMED_INPUTS.map(item => item.name).sort());
    expect(bindings.jump).toEqual([...PLAYER_ACTIONS.jump]);
    expect(inputSettingsError(bindings)).toBeNull();
    expect(parseInputSettings(serializeInputSettings(bindings))).toEqual(bindings);
    expect(sharedInputWarnings(bindings).join(" ")).toContain("Up is used by Move forward and Jump");
});

test("edits refuse the last key, duplicates, chords and unknown actions", () => {
    const bindings = defaultInputBindings();
    expect(removeInputCode(bindings, "up", "KeyE").error).toContain("at least one");
    expect(addInputCode(bindings, "left", "KeyA").bindings.left).toEqual(bindings.left);
    expect(addInputCode(bindings, "jump", "Escape").error).toContain("cannot be bound");
    expect(addInputCode(bindings, "nope", "KeyL").error).toContain("Unknown");
    const filled = { ...bindings, jump: ["Space", "ArrowUp", "KeyW", "KeyZ"] };
    expect(addInputCode(filled, "jump", "KeyL").error).toContain("already has 4");
    const added = addInputCode(bindings, "right", "KeyL");
    expect(added.error).toBeNull();
    expect(added.bindings.right).toEqual(["KeyD", "ArrowRight", "KeyL"]);
    expect(removeInputCode(added.bindings, "right", "KeyD").bindings.right).toEqual(["ArrowRight", "KeyL"]);
});

test("malformed, future and partial settings fall back without throwing", () => {
    const storage = new Map<string, string>();
    const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
    expect(readInputSettings(store)).toEqual(defaultInputBindings());
    expect(parseInputSettings("{")).toBeNull();
    expect(parseInputSettings(JSON.stringify({ version: 2, bindings: defaultInputBindings() }))).toBeNull();
    expect(parseInputSettings(JSON.stringify({ version: 1, bindings: { left: ["KeyA"] } }))).toBeNull();
    expect(parseInputSettings(JSON.stringify({ version: 1, bindings: { ...defaultInputBindings(), left: "KeyA" } }))).toBeNull();
    storage.set(INPUT_SETTINGS_STORAGE_KEY, "{");
    expect(readInputSettings(store).interact).toEqual(["KeyF"]);
    const custom = addInputCode(defaultInputBindings(), "interact", "KeyG").bindings;
    writeInputSettings(store, custom);
    expect(readInputSettings(store).interact).toEqual(["KeyF", "KeyG"]);
    expect(() => writeInputSettings(store, { left: ["KeyA"] })).toThrow(/named action/);
});

test("rebinding clears held movement and keeps 2D and 3D mappings inside axis bounds", () => {
    const actions = new InputActions(defaultInputBindings());
    actions.setKey("KeyD", true);
    expect(platformerInput(actions).right).toBe(true);
    expect(spatialInput(actions)).toEqual({ x: 1, y: 0, z: 0, speed: 4 });
    actions.rebind(addInputCode(removeInputCode(removeInputCode(defaultInputBindings(), "right", "KeyD").bindings, "right", "ArrowRight").bindings, "right", "KeyL").bindings);
    expect(actions.held("right")).toBe(false);
    actions.setKey("KeyD", true);
    expect(platformerInput(actions).right).toBe(false);
    actions.setKey("KeyL", true); actions.setKey("ShiftLeft", true);
    expect(spatialInput(actions)).toEqual({ x: 1, y: 0, z: 0, speed: 7 });
    expect(eventCode({ key: "f" })).toBe("KeyF");
    expect(eventCode({ code: "ArrowUp" })).toBe("ArrowUp");
    expect(inputSettingsSummary(defaultInputBindings())).toContain("Interact: F");
});
