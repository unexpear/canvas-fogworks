/**
 * @jest-environment jsdom
 * @module TimelineTransport.test
 * @description SHELL-001 DOM coverage for the extracted timeline transport strip.
 */

import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TimelineKeyframeMode, TimelineTransport, TimelineTransportProps } from "./TimelineTransport";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setInput(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonText(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found as HTMLButtonElement;
}

describe("SHELL-001 extracted timeline transport", () => {
    let host: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        host = document.createElement("div");
        document.body.appendChild(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        host.remove();
    });

    async function render(overrides: Partial<TimelineTransportProps> = {}) {
        const calls = {
            play: 0,
            scrub: [] as number[],
            key: 0,
            hold: 0,
            remove: 0,
            onion: 0
        };
        const props: TimelineTransportProps = {
            frames: 24,
            fps: 12,
            frame: 3,
            rangeFrom: 0,
            rangeTo: 23,
            playing: false,
            playingTimeline: false,
            onion: false,
            keyframe: "none",
            easingControl: <select data-easing="1" />,
            onTogglePlay: () => { calls.play += 1; },
            onScrub: frame => calls.scrub.push(frame),
            onKey: () => { calls.key += 1; },
            onHold: () => { calls.hold += 1; },
            onRemoveKey: () => { calls.remove += 1; },
            onToggleOnion: () => { calls.onion += 1; },
            ...overrides
        };
        await act(async () => root.render(<TimelineTransport {...props} />));
        return calls;
    }

    it("plays, scrubs and authors from the strip without offering easing off a keyframe", async () => {
        const calls = await render();
        expect(host.textContent).toContain("3 / 23 · 12fps");
        expect(buttonText(host, "▶").disabled).toBe(false);
        expect(host.querySelector("[data-easing]")).toBeNull();
        expect(host.textContent).not.toContain("held");

        await act(async () => buttonText(host, "▶").click());
        await act(async () => buttonText(host, "◆ Key").click());
        await act(async () => buttonText(host, "◼ Hold").click());
        await act(async () => buttonText(host, "✕").click());
        await act(async () => buttonText(host, "◐ Onion").click());
        const range = host.querySelector("input[type=range]") as HTMLInputElement;
        expect(range.min).toBe("0");
        expect(range.max).toBe("23");
        expect(range.disabled).toBe(false);
        await act(async () => setInput(range, "9"));

        expect(calls).toEqual({ play: 1, scrub: [9], key: 1, hold: 1, remove: 1, onion: 1 });
    });

    it("disables transport while a prototype runs, and shows hold or easing only on a keyframe", async () => {
        await render({ playing: true, playingTimeline: true, onion: true, keyframe: "held" as TimelineKeyframeMode });
        expect(buttonText(host, "⏸").disabled).toBe(true);
        expect((host.querySelector("input[type=range]") as HTMLInputElement).disabled).toBe(true);
        expect(buttonText(host, "◆ Key").disabled).toBe(false);
        expect(host.textContent).toContain("held");
        expect(host.querySelector("[data-easing]")).toBeNull();
        expect(buttonText(host, "◐ Onion").style.color).toBe("rgb(77, 163, 255)");

        await render({ keyframe: "tween", rangeFrom: 4, rangeTo: 11, frame: 4 });
        expect(host.querySelector("[data-easing]")).not.toBeNull();
        expect(host.textContent).not.toContain("held");
        const range = host.querySelector("input[type=range]") as HTMLInputElement;
        expect(range.min).toBe("4");
        expect(range.max).toBe("11");
        expect(buttonText(host, "▶").title).toContain("Play the selected clip");
        expect(range.title).toContain("Scrubbing is not an edit");
    });
});
