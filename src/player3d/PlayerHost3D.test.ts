/** @jest-environment jsdom */
/** @module PlayerHost3D.test @description Browser player controls, key state, failure latching and disposal. */
import { mountPlayer3D, playerInput3D } from "./PlayerHost3D";
import { PlayerSession3D } from "../runtime/PlayerSession3D";
import { disposeWebGL3D, emitWebGL3D } from "../renderer/emitWebGL3D";
jest.mock("../renderer/emitWebGL3D", () => ({ emitWebGL3D: jest.fn(() => true), disposeWebGL3D: jest.fn(), lastWebGL3DFailure: () => "GPU unavailable" }));
let session: any, tick: FrameRequestCallback, dispose: () => void;
beforeEach(() => {
    jest.clearAllMocks(); (emitWebGL3D as jest.Mock).mockReturnValue(true);
    document.body.innerHTML = '<button id="start"></button><button id="pause"></button><button id="stop"></button><button id="retry"></button><p id="status"></p><canvas id="scene"></canvas>';
    window.requestAnimationFrame = jest.fn(callback => { tick = callback; return 1; }); window.cancelAnimationFrame = jest.fn();
    session = { status: "running", filePath: "entry", error: null, world: { outcome: "running" },
        advance: jest.fn(), frame: jest.fn(() => ({})), start: jest.fn(async () => true), restart: jest.fn(async () => true),
        pause: jest.fn(() => { session.status = "paused"; }), resume: jest.fn(() => { session.status = "running"; }),
        stop: jest.fn(() => { session.status = "stopped"; }), followTransition: jest.fn(async () => true) };
    dispose = mountPlayer3D(session as PlayerSession3D);
});
afterEach(() => dispose());
const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();
const key = (type: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { code }));

test("opposing keys cancel and duplicate aliases never exceed axis bounds", () => {
    expect(playerInput3D(new Set(["KeyD", "ArrowRight", "KeyW", "ShiftLeft"]))).toEqual({ x: 1, y: 0, z: -1, speed: 7 });
    expect(playerInput3D(new Set(["KeyA", "KeyD", "KeyQ", "KeyE"]))).toEqual({ x: 0, y: 0, z: 0, speed: 4 });
});
test("blur clears held keys and only an explicit Resume continues", () => {
    key("keydown", "KeyD"); tick(1); expect(session.advance.mock.calls.at(-1)[1].x).toBe(1);
    window.dispatchEvent(new Event("blur")); expect(session.pause).toHaveBeenCalled();
    window.dispatchEvent(new Event("focus")); expect(session.resume).not.toHaveBeenCalled();
    click("pause"); tick(2); expect(session.advance.mock.calls.at(-1)[1].x).toBe(0); expect(session.resume).toHaveBeenCalled();
});
test("pause, restart and stop clear input and release rendering resources", () => {
    key("keydown", "KeyW"); click("pause"); click("pause"); tick(1); expect(session.advance.mock.calls.at(-1)[1].z).toBe(0);
    click("start"); expect(session.restart).toHaveBeenCalled(); click("stop"); expect(session.stop).toHaveBeenCalled();
    expect(disposeWebGL3D).toHaveBeenCalled();
});
test("GPU failure latches a visible paused error until Restart", () => {
    (emitWebGL3D as jest.Mock).mockReturnValue(false); tick(1); tick(2);
    expect(emitWebGL3D).toHaveBeenCalledTimes(1); expect(session.pause).toHaveBeenCalled();
    expect(document.getElementById("status")!.textContent).toContain("GPU unavailable");
    (emitWebGL3D as jest.Mock).mockReturnValue(true); click("start"); tick(3); expect(emitWebGL3D).toHaveBeenCalledTimes(2);
});
test("failed transitions are not retried on every frame", async () => {
    session.world.transitionTo = "next.vde";
    session.followTransition.mockImplementation(async () => { session.error = new Error("Missing level"); session.status = "paused"; throw session.error; });
    tick(1); await Promise.resolve(); tick(2); tick(3);
    expect(session.followTransition).toHaveBeenCalledTimes(1);
    expect((document.getElementById("retry") as HTMLButtonElement).hidden).toBe(false);
    click("retry"); expect(session.followTransition).toHaveBeenCalledTimes(2);
});
test("pagehide disposes once, cancels frames and removes event listeners", () => {
    window.dispatchEvent(new Event("pagehide")); dispose();
    expect(session.stop).toHaveBeenCalledTimes(1); expect(window.cancelAnimationFrame).toHaveBeenCalled();
    click("start"); expect(session.restart).not.toHaveBeenCalled();
});

test("F is edge-triggered across repeated keydown events", () => {
    session.interact=jest.fn();key("keydown","KeyF");key("keydown","KeyF");expect(session.interact).toHaveBeenCalledTimes(1);
    key("keyup","KeyF");key("keydown","KeyF");expect(session.interact).toHaveBeenCalledTimes(2);
});
test("late storage reads cannot restore after Stop, and write failures are visible", async () => {
    dispose();
    document.body.insertAdjacentHTML("beforeend",'<button id="load-progress"></button><button id="save-progress"></button><span id="progress-note"></span>');
    let resolve!: (text:string)=>void;
    const store={read:jest.fn(()=>new Promise<string>(done=>{resolve=done;})),write:jest.fn(async()=>{throw new Error("disk full");})};
    session.restoreProgress=jest.fn();session.saveProgress=jest.fn(()=>"snapshot");session.status="running";
    dispose=mountPlayer3D(session,store);
    click("load-progress");click("stop");resolve("late");await Promise.resolve();await Promise.resolve();
    expect(session.restoreProgress).not.toHaveBeenCalled();
    click("save-progress");await Promise.resolve();await Promise.resolve();
    expect(document.getElementById("progress-note")!.textContent).toContain("disk full");
});
