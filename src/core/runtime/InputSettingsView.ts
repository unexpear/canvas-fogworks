/** @module InputSettingsView @description DOM controls for rebinding named inputs without leaving a key held. */
import { ActionBindings } from "./InputActions";
import { NAMED_INPUTS, addInputCode, defaultInputBindings, eventCode, inputCodeLabel, inputLabel, removeInputCode, sharedInputWarnings } from "./InputSettings";

export interface InputSettingsController { dispose(): void }

/** `onChange` may throw; the previous bindings stay on screen and the error is shown. */
export function mountInputSettings(container: HTMLElement, options: {
    bindings: ActionBindings;
    onChange: (bindings: ActionBindings) => void;
}): InputSettingsController {
    let bindings = options.bindings, capturing: string | null = null, error = "";
    const onKey = (event: KeyboardEvent) => {
        if (!capturing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (event.key === "Escape" || event.code === "Escape") { capturing = null; render(); return; }
        if (event.ctrlKey || event.altKey || event.metaKey) { error = "Bind one key, without Ctrl, Alt or Command."; render(); return; }
        const code = eventCode(event);
        if (!code) { error = "That key cannot be bound."; render(); return; }
        const action = capturing;
        const edited = addInputCode(bindings, action, code);
        if (edited.error) { error = edited.error; render(); return; }
        commit(edited.bindings);
    };
    const cancelCapture = () => { if (!capturing) return; capturing = null; render(); };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancelCapture);
    render();
    return { dispose() {
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", cancelCapture);
        delete document.body.dataset.inputCapturing;
        container.replaceChildren();
    } };

    function commit(next: ActionBindings) {
        try { options.onChange(next); bindings = next; error = ""; capturing = null; }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        render();
    }
    function render() {
        if (capturing) document.body.dataset.inputCapturing = "1";
        else delete document.body.dataset.inputCapturing;
        const field = document.createElement("fieldset");
        field.setAttribute("aria-label", "Input settings");
        const legend = document.createElement("legend");
        legend.textContent = "Controls";
        field.append(legend);
        const note = document.createElement("p");
        note.setAttribute("role", "status");
        note.textContent = capturing ? `Press a key for ${inputLabel(capturing)}. Escape cancels.` : "Saved for editor Play and players that share this browser storage.";
        field.append(note);
        for (const item of NAMED_INPUTS) {
            const row = document.createElement("div");
            const title = document.createElement("span");
            title.textContent = item.label;
            row.append(title);
            for (const code of bindings[item.name] ?? []) {
                if ((bindings[item.name] ?? []).length < 2) continue;
                const remove = document.createElement("button");
                remove.type = "button";
                remove.textContent = inputCodeLabel(code);
                remove.setAttribute("aria-label", `Remove ${inputCodeLabel(code)} from ${item.label}`);
                remove.addEventListener("click", () => {
                    const edited = removeInputCode(bindings, item.name, code);
                    if (edited.error) { error = edited.error; render(); return; }
                    commit(edited.bindings);
                });
                row.append(remove);
            }
            if ((bindings[item.name] ?? []).length < 2) {
                const only = document.createElement("span");
                only.textContent = (bindings[item.name] ?? []).map(inputCodeLabel).join(", ");
                row.append(only);
            }
            const add = document.createElement("button");
            add.type = "button";
            add.textContent = capturing === item.name ? "Press a key" : "Add key";
            add.setAttribute("aria-pressed", capturing === item.name ? "true" : "false");
            add.setAttribute("aria-label", `Add a key for ${item.label}`);
            add.addEventListener("click", () => { capturing = capturing === item.name ? null : item.name; error = ""; render(); });
            row.append(add);
            field.append(row);
        }
        const shared = document.createElement("p");
        shared.setAttribute("role", "status");
        shared.textContent = sharedInputWarnings(bindings).join(" ");
        field.append(shared);
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "Reset to defaults";
        reset.setAttribute("aria-label", "Reset controls to defaults");
        reset.addEventListener("click", () => commit(defaultInputBindings()));
        field.append(reset);
        const alert = document.createElement("p");
        alert.setAttribute("role", "alert");
        alert.hidden = error === "";
        alert.textContent = error;
        field.append(alert);
        container.replaceChildren(field);
    }
}
