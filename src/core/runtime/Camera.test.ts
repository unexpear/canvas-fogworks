import {
    CAMERA_SMOOTHING, DEADZONE_FRACTION, cameraDesired, followCamera
} from "./Camera";

/**
 * Every number here is hand-computed from the two constants, and the fixtures are deliberately NOT
 * at the world origin — the defect this module's viewport arithmetic was written to fix was exactly
 * zero at {0, 0}, and a camera test at the origin can see nothing proportional to position.
 */

const SIZE = { width: 800, height: 600 };
// The deadzone at 800×600, 0.34: 264px of margin each side, so the window is screen x 264..536.
const MARGIN_X = SIZE.width * (1 - DEADZONE_FRACTION) / 2;
const MARGIN_Y = SIZE.height * (1 - DEADZONE_FRACTION) / 2;

const view = (x: number, y = 0, zoom = 1) => ({ x, y, zoom });
const box = (x: number, y: number, width = 10, height = 10) => ({ x, y, width, height });

/** Where a world box's left/top edge lands on screen — the transform, written out, as the oracle. */
const screenX = (vp: { x: number; zoom: number }, worldX: number) => vp.zoom * worldX - vp.x;
const screenY = (vp: { y: number; zoom: number }, worldY: number) => vp.zoom * worldY - vp.y;

describe("the deadzone is the whole rule", () => {
    it("MARGINS ARE WHAT THIS FILE SAYS THEY ARE", () => {
        expect(MARGIN_X).toBeCloseTo(264, 9);
        expect(MARGIN_Y).toBeCloseTo(198, 9);
    });

    it("does NOTHING while the target is inside the window — exactly, not nearly", () => {
        // Anything from screen 264 to 526 (the far edge less the box's own 10px) is inside.
        for (const tx of [264, 300, 400, 526]) {
            expect(cameraDesired(view(0), SIZE, box(tx, 300))).toEqual({ x: 0, y: 0 });
        }
        // And a camera that wants nothing does not creep: identical after a hundred steps.
        const still = followCamera(view(0), SIZE, box(400, 300), null, 100);
        expect(still.x).toBe(0);
        expect(still.y).toBe(0);
    });

    it("pushes by the MINIMUM that puts the target back on the edge it left", () => {
        // Right: the box's right edge is 610, the window ends at 536, so vp.x is 74.
        expect(cameraDesired(view(0), SIZE, box(600, 300)).x).toBeCloseTo(74, 9);
        // Left: its left edge is 100, the window starts at 264, so vp.x is −164.
        expect(cameraDesired(view(0), SIZE, box(100, 300)).x).toBeCloseTo(-164, 9);
        // Down: bottom edge 610 against a 600-tall view whose window ends at 402.
        expect(cameraDesired(view(0), SIZE, box(400, 500)).y).toBeCloseTo(510 - 402, 9);
    });

    it("CENTRES a target too big for its own deadzone rather than juddering between edges", () => {
        // A 400-wide box cannot fit in a 272-wide window: both edges are violated at once, and the
        // inverted interval resolves to the middle.
        const want = cameraDesired(view(0), SIZE, box(0, 300, 400, 10));
        expect(want.x).toBeCloseTo(-200, 9);
        // Its centre is the screen's centre.
        expect(screenX(view(want.x), 0 + 200)).toBeCloseTo(SIZE.width / 2, 9);
    });
});

describe("THE EFFECT: after following, the target is on screen inside the window", () => {
    /**
     * The assertion the `lerpViewport` defect taught: check what the camera is FOR, at several
     * distances from the origin, not the arithmetic that gets there.
     */
    it.each([0, 1000, 5000, 20000])("holds the target inside the window at x=%p", (far) => {
        for (const dx of [-900, -300, 0, 300, 900]) {
            // Rigid (smoothing 1) so one step is the whole correction.
            const after = followCamera(view(far), SIZE, box(far + dx, 300), null, 1, 1);
            const left = screenX(after, far + dx), right = left + 10;
            expect(left).toBeGreaterThanOrEqual(MARGIN_X - 1e-9);
            expect(right).toBeLessThanOrEqual(SIZE.width - MARGIN_X + 1e-9);
        }
    });

    it("works at a zoom other than 1, where a world offset and a screen offset differ", () => {
        const after = followCamera(view(0, 0, 2), SIZE, box(300, 300), null, 1, 1);
        // 2·310 − 536 = 84.
        expect(after.x).toBeCloseTo(84, 9);
        expect(after.zoom).toBe(2);
        expect(screenX(after, 310)).toBeCloseTo(SIZE.width - MARGIN_X, 9);
    });
});

describe("smoothing is per STEP, which is what makes it frame-rate independent", () => {
    it("closes 1 − (1−k)^n of the gap", () => {
        const start = view(0);
        const target = box(600, 300);                 // wants 74
        const one = followCamera(start, SIZE, target, null, 1);
        expect(one.x).toBeCloseTo(74 * CAMERA_SMOOTHING, 9);
        expect(one.x).toBeCloseTo(13.32, 9);
        const five = followCamera(start, SIZE, target, null, 5);
        expect(five.x).toBeCloseTo(74 * (1 - Math.pow(1 - CAMERA_SMOOTHING, 5)), 9);
        expect(five.x).toBeCloseTo(46.565251603, 8);
    });

    it("ONE FRAME OF FIVE STEPS EQUALS FIVE FRAMES OF ONE — the whole point", () => {
        // A 144Hz machine runs more frames of fewer steps; it must not get a different camera.
        let stepwise = view(0);
        for (let i = 0; i < 5; i++) stepwise = followCamera(stepwise, SIZE, box(600, 300), null, 1);
        const atOnce = followCamera(view(0), SIZE, box(600, 300), null, 5);
        expect(stepwise.x).toBeCloseTo(atOnce.x, 9);
    });

    it("a rigid camera (k=1) arrives in one step and a frozen one (k=0) never moves", () => {
        expect(followCamera(view(0), SIZE, box(600, 300), null, 1, 1).x).toBeCloseTo(74, 9);
        expect(followCamera(view(0), SIZE, box(600, 300), null, 60, 0).x).toBe(0);
    });
});

describe("bounds keep the view inside the level", () => {
    const level = { x: 0, y: 0, width: 1600, height: 1600 };

    it("stops at the level's edge instead of showing the void beyond it", () => {
        // A target at the far right of the level wants to scroll past its end; vp.x may reach 800.
        const after = followCamera(view(800), SIZE, box(1590, 800), level, 1, 1);
        expect(after.x).toBeCloseTo(1600 - SIZE.width, 9);
        // And at the near edge it cannot go below 0.
        expect(followCamera(view(0), SIZE, box(0, 800), level, 1, 1).x).toBe(0);
    });

    it("applies AFTER the smoothing, so a glide cannot leave the level part-way", () => {
        // Starting outside (a run begun with the editor scrolled off the level) it is pulled in on
        // the very first step rather than easing back over a second.
        expect(followCamera(view(5000), SIZE, box(1590, 800), level, 1).x).toBeCloseTo(800, 9);
    });

    it("CENTRES a level smaller than the view rather than pinning it to a corner", () => {
        const small = { x: 0, y: 0, width: 400, height: 300 };
        const after = followCamera(view(0), SIZE, box(200, 150), small, 1, 1);
        expect(after.x).toBeCloseTo(-200, 9);
        expect(after.y).toBeCloseTo(-150, 9);
        // The level's centre sits at the screen's centre.
        expect(screenX(after, 200)).toBeCloseTo(400, 9);
        expect(screenY(after, 150)).toBeCloseTo(300, 9);
    });

    it("ignores a degenerate bounds rather than dividing the world by it", () => {
        const flat = { x: 0, y: 0, width: 0, height: 0 };
        expect(followCamera(view(0), SIZE, box(600, 300), flat, 1, 1).x).toBeCloseTo(74, 9);
    });
});

describe("it gives back the view it was given rather than a degenerate one", () => {
    /**
     * THE FIXTURE IS OUTSIDE THE BOUNDS ON PURPOSE, and that is the whole reason these tests can
     * see anything. With `bounds` null, every one of these cases returns the start position through
     * the ORDINARY path too — a zero smoothing fraction, a `want` that resolves to the current
     * viewport — so deleting the guard outright changed nothing and the test passed either way. At
     * x=5000 outside a 1600-wide level, taking the guard away pins the view to 800 instead.
     */
    const level = { x: 0, y: 0, width: 1600, height: 1600 };
    it.each([
        ["no steps elapsed", () => followCamera(view(5000), SIZE, box(9000, 9000), level, 0)],
        ["a non-positive zoom", () => followCamera({ x: 5000, y: 0, zoom: 0 }, SIZE, box(9000, 0), level, 5)],
        ["a target that is not finite", () => followCamera(view(5000), SIZE, box(NaN, 0), level, 5)],
        ["a target with no finite width", () => followCamera(view(5000), SIZE, box(0, 0, Infinity, 10), level, 5)]
    ])("%s leaves the picture where it is", (_label, run) => {
        expect(run().x).toBe(5000);
    });
});
