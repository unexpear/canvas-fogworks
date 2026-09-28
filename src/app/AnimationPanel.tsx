/**
 * @module AnimationPanel
 * @description Clip browsing and undoable state/transition authoring shared by both workspaces.
 */
import React, { useEffect, useState } from "react";
import { ReadonlyDocument } from "../core/document/Document";
import { Clip, clipsError } from "../core/document/Clips";
import { AnimationController, ANIMATION_CONDITIONS, AnimationCondition } from "../core/document/AnimationController";

interface Props {
    document: ReadonlyDocument;
    nodeId: string | null;
    selectedClip: string;
    disabled: boolean;
    onSelectClip(name: string): void;
    onClipsChange(clips: Clip[]): boolean;
    onControllerChange(controller: AnimationController | undefined): boolean;
}
export function AnimationPanel({ document: doc, nodeId, selectedClip, disabled, onSelectClip, onClipsChange, onControllerChange }: Props) {
    const [note, setNote] = useState("");
    const [draft, setDraft] = useState<Clip>({ name: "", from: 0, to: 0, loop: true });
    const [stateName, setStateName] = useState("");
    const node = nodeId ? doc.nodes.get(nodeId) : undefined;
    const controller = node?.animation;
    useEffect(() => {
        const clip = doc.clips?.find(c => c.name === selectedClip);
        setDraft(clip ? { ...clip } : { name: "", from: 0, to: (doc.timeline?.frames ?? 1) - 1, loop: true });
        setNote("");
    }, [selectedClip, doc.clips, doc.timeline]);
    const saveController = (next: AnimationController | undefined) => {
        setNote(onControllerChange(next) ? "" : "Controller edit was rejected; check state names and speed.");
    };
    const saveClip = () => {
        const clips = (doc.clips ?? []).map(c => ({ ...c }));
        const index = clips.findIndex(c => c.name === selectedClip);
        if (index >= 0) clips[index] = draft; else clips.push(draft);
        // Renaming a referenced clip is explicit: keep references stable by requiring a new clip.
        if (index >= 0 && draft.name !== selectedClip && [...doc.nodes.values()].some(n => n.animation?.states.some(s => s.clip === selectedClip))) {
            setNote("This clip is used by a controller. Reassign its states before renaming it."); return;
        }
        const error = clipsError(clips, doc.timeline);
        if (error) { setNote(error); return; }
        if (onClipsChange(clips)) { onSelectClip(draft.name); setNote(""); }
        else setNote("Clip edit was rejected.");
    };
    const missing = controller?.states.filter(s => !doc.clips?.some(c => c.name === s.clip)) ?? [];
    return <details data-animation-panel style={{ background: "#20242b", color: "#ddd", padding: "4px 10px", fontSize: 12 }}>
        <summary>Animation clips and states</summary>
        <fieldset disabled={disabled} style={{ border: 0, margin: 0, padding: 6, maxHeight: 260, overflow: "auto" }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label>Preview clip <select aria-label="Preview clip" value={selectedClip} onChange={e => onSelectClip(e.target.value)}>
                    <option value="">Whole timeline / new clip</option>
                    {(doc.clips ?? []).map(c => <option key={c.name} value={c.name}>{c.name} ({c.from}–{c.to})</option>)}
                </select></label>
                <label>Name <input aria-label="Clip name" maxLength={64} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
                <label>From <input aria-label="Clip from" type="number" min={0} value={draft.from} onChange={e => setDraft({ ...draft, from: Number(e.target.value) })} style={{ width: 60 }} /></label>
                <label>To <input aria-label="Clip to" type="number" min={0} value={draft.to} onChange={e => setDraft({ ...draft, to: Number(e.target.value) })} style={{ width: 60 }} /></label>
                <label><input aria-label="Loop clip" type="checkbox" checked={draft.loop !== false} onChange={e => setDraft({ ...draft, loop: e.target.checked })} /> Loop</label>
                <button onClick={saveClip}>{selectedClip ? "Save clip" : "Add clip"}</button>
                <button disabled={!selectedClip} onClick={() => {
                    if ([...doc.nodes.values()].some(n => n.animation?.states.some(s => s.clip === selectedClip))) {
                        setNote("This clip is used by a controller. Reassign or remove its states before deleting it."); return;
                    }
                    if (onClipsChange((doc.clips ?? []).filter(c => c.name !== selectedClip).map(c => ({ ...c })))) onSelectClip("");
                }}>Delete clip</button>
            </div>
            <p>Choose a clip, then use the timeline Play button. One-shot clips hold their final frame.</p>
            {!node ? <p>Select an authored node to configure its runtime animation.</p> : <>
                <div>Controller for {node.name || node.id} (also drives descendants without their own controller)</div>
                {!controller ? <button disabled={!selectedClip} onClick={() => saveController({ initial: "idle", states: [{ name: "idle", clip: selectedClip }], transitions: [] })}>Add controller</button> : <>
                    <label>Initial state <select aria-label="Initial state" value={controller.initial} onChange={e => saveController({ ...controller, initial: e.target.value } as AnimationController)}>
                        {controller.states.map(s => <option key={s.name}>{s.name}</option>)}
                    </select></label>{" "}
                    <label>Driver <select aria-label="Animation driver" value={controller.driver ?? ""} onChange={e => saveController({ ...controller, driver: e.target.value || undefined } as AnimationController)}>
                        <option value="">This node</option>
                        {controller.driver && !doc.nodes.has(controller.driver) && <option value={controller.driver}>Missing: {controller.driver}</option>}
                        {[...doc.nodes.values()].filter(n => n.id !== nodeId).map(n => <option key={n.id} value={n.id}>{n.name || n.id}</option>)}
                    </select></label>{" "}
                    <button onClick={() => saveController(undefined)}>Remove controller</button>
                    {controller.states.map((s, i) => <div key={s.name} style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        <span>{s.name}</span>
                        <select aria-label={`Clip for ${s.name}`} value={s.clip} onChange={e => saveController({ ...controller, states: controller.states.map((v, j) => i === j ? { ...v, clip: e.target.value } : { ...v }) } as AnimationController)}>
                            {!doc.clips?.some(c => c.name === s.clip) && <option value={s.clip}>Missing: {s.clip}</option>}
                            {doc.clips?.map(c => <option key={c.name}>{c.name}</option>)}
                        </select>
                        <label>Speed <input aria-label={`Speed for ${s.name}`} type="number" min={0.01} max={16} step={0.1} value={s.speed ?? 1} style={{ width: 60 }}
                            onChange={e => saveController({ ...controller, states: controller.states.map((v, j) => i === j ? { ...v, speed: Number(e.target.value) } : { ...v }) } as AnimationController)} /></label>
                        <button disabled={controller.states.length === 1} onClick={() => {
                            const states = controller.states.filter(v => v.name !== s.name).map(v => ({ ...v }));
                            saveController({ ...controller, states, initial: controller.initial === s.name ? states[0].name : controller.initial,
                                transitions: controller.transitions.filter(t => t.from !== s.name && t.to !== s.name).map(t => ({ ...t })) });
                        }}>Remove {s.name}</button>
                    </div>)}
                    <input aria-label="New state name" placeholder="New state name" value={stateName} maxLength={64} onChange={e => setStateName(e.target.value)} />
                    <button disabled={!selectedClip || !stateName.trim()} onClick={() => saveController({ ...controller, states: [...controller.states.map(s => ({ ...s })), { name: stateName, clip: selectedClip }] } as AnimationController)}>Add state</button>
                    <p>Transitions run in listed order; the first matching rule wins. Ground/air and contact events currently apply to 2D bodies.</p>
                    {controller.transitions.map((t, i) => <div key={i} style={{ display: "flex", gap: 8, marginTop: 4 }}>
                        {(["from", "to"] as const).map(key => <label key={key}>{key} <select aria-label={`${key} transition ${i + 1}`} value={t[key]}
                            onChange={e => saveController({ ...controller, transitions: controller.transitions.map((v, j) => i === j ? { ...v, [key]: e.target.value } : { ...v }) } as AnimationController)}>
                            {controller.states.map(s => <option key={s.name}>{s.name}</option>)}
                        </select></label>)}
                        <select aria-label={`Condition transition ${i + 1}`} value={t.when} onChange={e => saveController({ ...controller, transitions: controller.transitions.map((v, j) => i === j ? { ...v, when: e.target.value as AnimationCondition } : { ...v }) } as AnimationController)}>
                            {ANIMATION_CONDITIONS.map(condition => <option key={condition}>{condition}</option>)}
                        </select>
                        <label>fade <input aria-label={`Fade transition ${i + 1}`} type="number" min={0.05} max={1} step={0.05} value={t.fade ?? ""} placeholder="sec"
                            onChange={e => {
                                const fade = e.target.value === "" ? undefined : Number(e.target.value);
                                saveController({ ...controller, transitions: controller.transitions.map((v, j) => {
                                    if (i !== j) return { ...v };
                                    const next = { ...v };
                                    if (fade === undefined) delete next.fade; else next.fade = fade;
                                    return next;
                                }) } as AnimationController);
                            }} /></label>
                        <button disabled={i === 0} onClick={() => {
                            const transitions = controller.transitions.map(v => ({ ...v }));
                            [transitions[i - 1], transitions[i]] = [transitions[i], transitions[i - 1]];
                            saveController({ ...controller, transitions } as AnimationController);
                        }}>Move up</button>
                        <button onClick={() => saveController({ ...controller, transitions: controller.transitions.filter((_, j) => i !== j).map(v => ({ ...v })) } as AnimationController)}>Remove transition</button>
                    </div>)}
                    <button onClick={() => saveController({ ...controller, transitions: [...controller.transitions.map(t => ({ ...t })), {
                        from: controller.initial, to: controller.states.find(s => s.name !== controller.initial)?.name ?? controller.initial, when: "finished"
                    }] } as AnimationController)}>Add transition</button>
                </>}
            </>}
            {missing.length > 0 && <p role="alert">Missing clips: {missing.map(s => s.clip).join(", ")}. Affected states cannot play.</p>}
            {controller?.driver && !doc.nodes.has(controller.driver) && <p role="alert">The animation driver is missing. Select a driver to restore movement and event transitions.</p>}
            {note && <p role="alert">{note}</p>}
        </fieldset>
    </details>;
}
