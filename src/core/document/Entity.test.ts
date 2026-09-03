/** @module Entity.test @description Typed entity validation and legacy migration coverage. */

import { entityError, entityFromUserData, playerEntityId } from "./Entity";

describe("typed entities", () => {
    test("legacy runtime properties convert without guessing invalid values", () => {
        const entity = entityFromUserData({
            bodyType: { value: " Dynamic " },
            friction: { value: "0.5" },
            "vde.deadly": { value: "true" },
            "vde.patrol": { value: "left" }
        });
        expect(entity).toEqual({ body: "dynamic", friction: 0.5, deadly: true });
        expect(entityError(entity)).toBeNull();
    });

    test("typed false overrides are valid and malformed references are refused", () => {
        expect(entityError({ deadly: false, patrol: -20, transitionTo: "level-2.vde" })).toBeNull();
        expect(entityError({ transitionTo: " " })).toMatch(/non-empty/);
        expect(entityError({ body: "kinematic" })).toMatch(/static\/dynamic\/oneway/);
    });

    test("the first explicitly typed player is deterministic", () => {
        expect(playerEntityId([{ id: "decoy" }, { id: "hero", entity: { player: true } },
            { id: "other", entity: { player: true } }])).toBe("hero");
    });
});
