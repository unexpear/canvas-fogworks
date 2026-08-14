/**
 * @module Camera
 * @description Which world rectangle a run is looking at — a deadzone follow camera (M18 slice 8).
 *
 * THE CAMERA — which world rectangle a run is looking at.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `World`: a camera is not physics. Nothing in the world
 * may read it, or a level would play differently depending on where you were looking, and the whole
 * point of a fixed step is that it does not. It takes a viewport and gives back a viewport; it
 * cannot reach the bodies at all.
 *
 * A DEADZONE, NOT A LEASH. Pinning the target to the exact screen centre means every footstep moves
 * the entire world, which reads as the SCENERY moving rather than the character — the character is
 * the one thing on screen that never moves. So the camera does nothing at all while the target is
 * inside a centred window, and only pushes when the target reaches its edge. That is what the games
 * this is aimed at actually do: Mario walks across a third of the screen before anything scrolls.
 *
 * SMOOTHING IS PER FIXED STEP, for exactly the reason the physics is. `vp += (want − vp) · k` once
 * per FRAME is a different camera on a 144Hz monitor than on a 60Hz one — the same class of defect
 * as a jump height that depends on frame rate, and less visible because nobody can say what the
 * right answer looked like. Taking the step count and folding `k` that many times, `1 − (1−k)^n`,
 * makes it exact and frame-rate independent: five steps of 0.18 is one step of 0.62926, always.
 *
 * BOUNDS ARE APPLIED LAST, after the smoothing, so the view cannot leave the level even part-way
 * through a glide. Clamping the DESTINATION instead would be right only while the camera is already
 * inside, which is not true on the first frame of a run.
 *
 * WHAT THIS DELIBERATELY IS NOT: it does not zoom (the run keeps whatever zoom the editor was at,
 * which is the only honest answer while there is no authored camera node), it does not look ahead in
 * the direction of travel, and it does not ratchet. A camera that never scrolls back left is a rule
 * of one particular game rather than of cameras, and it belongs to whatever declares the level.
 */

/**
 * The viewport shape this works in — structurally the editor's, deliberately re-declared rather than
 * imported, because `core` may not depend on the editor.
 *
 * The transform throughout is `screen = zoom·world − vp`, the same one `screenToWorld` inverts.
 */
export interface CameraView {
    x: number;
    y: number;
    zoom: number;
}

export interface CameraRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * The fraction of the view the target may wander inside before the camera moves — the middle third.
 *
 * A CHOICE, not a measurement, like the one-way platforms: no document in the corpus declares a
 * camera. Nought would pin the target to the centre exactly; one would never scroll until it fell
 * off the edge.
 */
export const DEADZONE_FRACTION = 0.34;

/** The fraction of the remaining distance closed per FIXED STEP. 1 is a rigid camera. */
export const CAMERA_SMOOTHING = 0.18;

/**
 * Hold `value` within `[lo, hi]` — and CENTRE IT WHEN THE INTERVAL IS INVERTED.
 *
 * That inversion is not a degenerate case to be guarded off; it is half the behaviour, and both
 * callers here rely on it. `lo > hi` means the thing being fitted is BIGGER than the space allowed
 * for it: a target box wider than its deadzone, or a level narrower than the view. In both, the
 * only sensible answer is the middle, and the midpoint of the reversed interval is exactly that.
 */
function clampOrCentre(value: number, lo: number, hi: number): number {
    if (lo > hi) return (lo + hi) / 2;
    return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Where the camera WANTS to be for a target — the nearest viewport that puts `target` back inside
 * the deadzone, which is the current viewport unchanged whenever it is already inside.
 *
 * Split out from `followCamera` because "has the target left the window" is the whole rule, and a
 * rule worth testing on its own is worth naming on its own.
 */
export function cameraDesired(
    view: CameraView,
    size: { width: number; height: number },
    target: CameraRect,
    deadzone: number = DEADZONE_FRACTION
): { x: number; y: number } {
    const z = view.zoom;
    const f = deadzone < 0 ? 0 : deadzone > 1 ? 1 : deadzone;
    // The deadzone in SCREEN pixels, centred. Screen-space rather than world-space because that is
    // what it means to a player: the character stays in the middle of the SCREEN, whatever the zoom.
    const marginX = size.width * (1 - f) / 2;
    const marginY = size.height * (1 - f) / 2;
    // `screen = z·world − vp`, so holding the target's left edge at `marginX` means `vp.x` is at its
    // LARGEST admissible value, and holding its right edge at `size.width − marginX` its smallest.
    return {
        x: clampOrCentre(view.x,
            z * (target.x + target.width) - (size.width - marginX),
            z * target.x - marginX),
        y: clampOrCentre(view.y,
            z * (target.y + target.height) - (size.height - marginY),
            z * target.y - marginY)
    };
}

/**
 * The viewport after `steps` fixed steps of following `target`, held inside `bounds`.
 *
 * Returns the INPUT VIEW UNCHANGED rather than a degenerate one whenever it cannot answer — no
 * steps elapsed, a non-positive zoom (the transform is not invertible), or a target that is not
 * finite. A camera that gives up should leave the picture where it is, not jump it somewhere.
 */
export function followCamera(
    view: CameraView,
    size: { width: number; height: number },
    target: CameraRect,
    bounds: CameraRect | null,
    steps: number,
    smoothing: number = CAMERA_SMOOTHING,
    deadzone: number = DEADZONE_FRACTION
): CameraView {
    if (!(steps > 0) || !(view.zoom > 0)) return view;
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)
        || !Number.isFinite(target.width) || !Number.isFinite(target.height)) return view;

    const want = cameraDesired(view, size, target, deadzone);
    // FOLDED, NOT MULTIPLIED. `n` steps of closing `k` of the gap leaves `(1−k)^n` of it, so the
    // fraction closed is `1 − (1−k)^n` — which is why a frame that ran five steps and a frame that
    // ran one arrive at the same place per unit of TIME rather than per unit of drawing.
    const k = smoothing < 0 ? 0 : smoothing > 1 ? 1 : smoothing;
    const closed = 1 - Math.pow(1 - k, steps);
    let x = view.x + (want.x - view.x) * closed;
    let y = view.y + (want.y - view.y) * closed;

    if (bounds && bounds.width > 0 && bounds.height > 0) {
        const z = view.zoom;
        x = clampOrCentre(x, z * bounds.x, z * (bounds.x + bounds.width) - size.width);
        y = clampOrCentre(y, z * bounds.y, z * (bounds.y + bounds.height) - size.height);
    }
    return { x, y, zoom: view.zoom };
}
