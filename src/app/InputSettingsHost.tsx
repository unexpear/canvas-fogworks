/** @module InputSettingsHost @description Editor host that persists named-input bindings and notifies Play. */
import React, { useEffect, useRef } from "react";
import { ActionBindings } from "../core/runtime/InputActions";
import { browserInputStorage, readInputSettings, writeInputSettings } from "../core/runtime/InputSettings";
import { mountInputSettings } from "../core/runtime/InputSettingsView";

export function InputSettingsHost({ onChange }: { onChange: (bindings: ActionBindings) => void }) {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const node = host.current;
        if (!node) return undefined;
        const view = mountInputSettings(node, {
            bindings: readInputSettings(browserInputStorage()),
            onChange(next) {
                const storage = browserInputStorage();
                if (!storage) throw new Error("This browser cannot store control settings.");
                writeInputSettings(storage, next);
                onChange(next);
            }
        });
        return () => view.dispose();
    }, [onChange]);
    return <div ref={host} />;
}
