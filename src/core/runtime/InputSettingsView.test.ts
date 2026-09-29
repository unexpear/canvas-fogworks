/** @jest-environment jsdom */
/** @module InputSettingsView.test @description Rebind capture, cancellation and failed persistence stay on the previous keys. */
import { defaultInputBindings } from "./InputSettings";
import { mountInputSettings } from "./InputSettingsView";

function press(code: string, init: KeyboardEventInit = {}) {
    window.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init }));
}

test("capture adds a key, escape and blur cancel, and the last key stays", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: string[][] = [];
    const view = mountInputSettings(host, { bindings: defaultInputBindings(), onChange: next => { seen.push([...next.right]); } });
    try {
        expect(host.textContent).toContain("Up is used by Move forward and Jump");
        host.querySelector<HTMLButtonElement>('[aria-label="Add a key for Move right"]')!.click();
        expect(document.body.dataset.inputCapturing).toBe("1");
        press("Escape");
        expect(seen).toHaveLength(0);
        expect(document.body.dataset.inputCapturing).toBeUndefined();
        host.querySelector<HTMLButtonElement>('[aria-label="Add a key for Move right"]')!.click();
        press("KeyL", { ctrlKey: true });
        expect(host.querySelector('[role="alert"]')!.textContent).toContain("without Ctrl");
        expect(seen).toHaveLength(0);
        press("KeyL");
        expect(seen[seen.length - 1]).toEqual(["KeyD", "ArrowRight", "KeyL"]);
        expect(document.body.dataset.inputCapturing).toBeUndefined();
        host.querySelector<HTMLButtonElement>('[aria-label="Remove D from Move right"]')!.click();
        host.querySelector<HTMLButtonElement>('[aria-label="Remove Right from Move right"]')!.click();
        expect(host.querySelector('[aria-label="Remove L from Move right"]')).toBeNull();
        expect(host.textContent).toContain("L");
        host.querySelector<HTMLButtonElement>('[aria-label="Add a key for Move up"]')!.click();
        window.dispatchEvent(new Event("blur"));
        expect(document.body.dataset.inputCapturing).toBeUndefined();
        expect(host.querySelector('[aria-label="Add a key for Move up"]')!.getAttribute("aria-pressed")).toBe("false");
    } finally { view.dispose(); host.remove(); }
});

test("a storage failure keeps the previous binding and reset restores defaults", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let fail = true;
    const view = mountInputSettings(host, {
        bindings: defaultInputBindings(),
        onChange() { if (fail) throw new Error("storage full"); }
    });
    try {
        host.querySelector<HTMLButtonElement>('[aria-label="Add a key for Interact"]')!.click();
        press("KeyG");
        expect(host.querySelector('[role="alert"]')!.textContent).toContain("storage full");
        expect(host.textContent).not.toContain("G");
        fail = false;
        host.querySelector<HTMLButtonElement>('[aria-label="Reset controls to defaults"]')!.click();
        expect((host.querySelector('[role="alert"]') as HTMLElement).hidden).toBe(true);
        expect(host.textContent).toContain("Interact");
    } finally { view.dispose(); host.remove(); }
});
