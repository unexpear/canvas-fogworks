/**
 * @module GameplayPanel
 * @description Reachable typed event/command authoring and interactions; sound remains 2D-only, all edits return through the entity Action.
 */
import React, { useEffect, useRef, useState } from "react";
import { Entity } from "../core/document/Entity";
import { GameplayAction, GameplayRule, gameplayRulesError } from "../core/document/Gameplay";
import {GameplayVariablesPanel} from "./GameplayVariablesPanel";
import {GameplayVariable} from "../core/document/GameplayData";
import {BehaviorFunction} from "../core/document/BehaviorFunctions";
import {BehaviorFunctionsPanel} from "./BehaviorFunctionsPanel";
import { BehaviorGraphPanel, BehaviorAssetProps } from "./BehaviorGraphPanel";

export function GameplayPanel({ entity, onChange, assets, onAssetsChange, variables=[],onVariablesChange,functions=[],onFunctionsChange }: { entity: Entity; onChange: (entity: Entity) => void } & BehaviorAssetProps & {onVariablesChange?:(variables:GameplayVariable[])=>boolean;onFunctionsChange?:(functions:BehaviorFunction[])=>boolean}) {
    const [error, setError] = useState("");
    const rules = entity.rules ?? [];
    const currentRules = useRef(rules); currentRules.current = rules;
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const save = (next: readonly GameplayRule[]) => {
        const error = gameplayRulesError(next); setError(error ?? "");
        if (!error) onChange({ ...entity, rules: next });
    };
    const replace = (index: number, patch: Partial<GameplayRule>) => save(rules.map((r, i) => i === index ? { ...r, ...patch } : r));
    return <fieldset style={{ marginTop: 8, padding: 6, minWidth: 0 }}><legend>Gameplay rules</legend>
        {entity.player && <label>Rule policy <select aria-label="Gameplay policy" value={entity.rulePolicy ?? "platformer"}
            onChange={e => onChange({ ...entity, rulePolicy: e.target.value as Entity["rulePolicy"] })}>
            <option value="platformer">Platformer + authored rules</option><option value="authored">Authored rules only</option>
        </select></label>}
        {rules.map((rule, index) => <div key={index} style={{ borderTop: "1px solid #777", marginTop: 6 }}>
            <select aria-label={`Rule ${index + 1} event`} value={rule.event} onChange={e => {
                const event = e.target.value as GameplayRule["event"];
                replace(index, { event, ...(event === "start" ? { other: "any", target: "self" } : {}) });
            }}>{["start", "enter", "leave", "contact", "separate", "interact"].map(v => <option key={v}>{v}</option>)}</select>
            {rule.event === "interact" && <input type="number" min="0.01" max="10000" aria-label={`Rule ${index + 1} interaction range`}
                placeholder="Default: 96 (2D), 2 (3D)" value={rule.range ?? ""} onChange={e => replace(index, { range: e.target.value === "" ? undefined : Number(e.target.value) })} />}
            <select aria-label={`Rule ${index + 1} condition`} disabled={rule.event === "start"} value={rule.other}
                onChange={e => replace(index, { other: e.target.value as GameplayRule["other"] })}>
                <option value="any">Any actor</option><option value="player">Player only</option></select>
            <select aria-label={`Rule ${index + 1} target`} disabled={rule.event === "start"} value={rule.target}
                onChange={e => replace(index, { target: e.target.value as GameplayRule["target"] })}>
                <option>self</option><option>other</option></select>
            <select aria-label={`Rule ${index + 1} action`} value={rule.action.kind} onChange={e => {
                const kind = e.target.value as GameplayAction["kind"];
                if (kind === "sound") { setError("Choose an audio file with the Sound file control below."); return; }
                replace(index, { action: kind === "velocity" ? { kind, x: 0, y: 0 } : kind === "score" ? { kind, key: "score" } : kind === "spawn" ? { kind, templateId: "template" } : { kind } });
            }}>{["win", "lose", "despawn", "velocity", "score", "sound", "spawn", "checkpoint"].map(v => <option key={v}>{v}</option>)}</select>
            {rule.action.kind === "spawn" && <input aria-label={`Rule ${index + 1} template ID`} value={rule.action.templateId}
                onChange={e => replace(index, { action: { kind: "spawn", templateId: e.target.value } })} />}
            {rule.action.kind === "velocity" && (["x", "y"] as const).map(axis => <input key={axis} type="number"
                aria-label={`Rule ${index + 1} velocity ${axis}`} value={rule.action.kind === "velocity" ? rule.action[axis] : 0}
                onChange={e => replace(index, { action: { ...rule.action, [axis]: Number(e.target.value) } as GameplayAction })} />)}
            {rule.action.kind === "score" && <input aria-label={`Rule ${index + 1} score key`} value={rule.action.key}
                onChange={e => replace(index, { action: { kind: "score", key: e.target.value } })} />}
            <label>Sound file <input type="file" accept=".wav,.ogg,.mp3" aria-label={`Rule ${index + 1} sound file`} onChange={async e => {
                const file = e.target.files?.[0]; if (!file) return;
                if (file.size > 6 * 1024 * 1024) { setError("Sound file exceeds 6MB."); return; }
                const extension = file.name.split(".").pop()?.toLowerCase();
                const mime = extension === "mp3" ? "mpeg" : extension;
                try {
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    if (!alive.current) return;
                    if (currentRules.current !== rules) { setError("Rules changed while audio was loading. Choose the file again."); return; }
                    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
                    replace(index, { action: { kind: "sound", source: `data:audio/${mime};base64,${btoa(binary)}`, volume: 1 } });
                } catch (error) { setError(String(error)); }
            }} /></label>
            {rule.action.kind === "sound" && <input aria-label={`Rule ${index + 1} volume`} type="number" min="0" max="1" step="0.1" value={rule.action.volume}
                onChange={e => replace(index, { action: { ...rule.action, volume: Number(e.target.value) } as GameplayAction })} />}
            <button onClick={() => save(rules.filter((_, i) => i !== index))}>Remove rule {index + 1}</button>
        </div>)}
        <button disabled={rules.length >= 32} onClick={() => save([...rules, { event: "enter", other: "player", target: "self", action: { kind: "win" } }])}>Add gameplay rule</button>
        <p>F interacts with the nearest target in range. Spawn copies one leaf template at the selected target (256 per run). Checkpoints record the player position. Sound playback is currently 2D-only.</p>
        {error && <p role="alert">{error}</p>}
        {onVariablesChange&&<GameplayVariablesPanel variables={variables} onChange={onVariablesChange}/>}
        {onFunctionsChange&&<BehaviorFunctionsPanel functions={functions} variables={variables} onChange={onFunctionsChange}/>}
        <BehaviorGraphPanel functions={functions} variables={variables} entity={entity} onChange={onChange} assets={assets} onAssetsChange={onAssetsChange}/>
    </fieldset>;
}
