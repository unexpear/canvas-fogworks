/**
 * @module NodeInspectorSections
 * @description States, slots, variants and metadata for the selected node.
 * Dispatch stays on the shared action dispatcher. Geometry, paint and layout
 * remain in the shell inspector.
 */

import React, { useState } from "react";
import { ActionDispatcher } from "../core/actions/ActionDispatcher";
import { SetBehaviorAssetsAction } from "../core/actions/SetBehaviorAssetsAction";
import { SetBehaviorFunctionsAction } from "../core/actions/SetBehaviorFunctionsAction";
import { SetGameplayVariablesAction } from "../core/actions/SetGameplayVariablesAction";
import { SetSlotAction, SetSlotContentAction } from "../core/actions/SlotActions";
import { SetNodeStateAction } from "../core/actions/StateActions";
import { UpdateNodeContentAction } from "../core/actions/UpdateNodeContentAction";
import { SetInstanceVariantAction, SetVariantAction } from "../core/actions/VariantActions";
import { masterSubtreeIds, resolveVariantMaster, variantProperties } from "../core/document/Components";
import { Entity } from "../core/document/Entity";
import { Node, StateDefinition, UserData, VariantKey, slotError, variantError, variantNameError } from "../core/document/Node";
import { ActorPlacementPanel } from "./ActorPlacementPanel";
import { GameplayPanel } from "./GameplayPanel";

const UI = {
    bg: "#0e0e18",
    line: "#262642",
    text: "#dcdce8",
    textDim: "#8a8aa5",
    textFaint: "#5f5f7a",
    accent: "#4da3ff"
};

const SELECT_STYLE: React.CSSProperties = {
    fontSize: 11, padding: "2px 4px", background: "#12121f", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, boxSizing: "border-box"
};

const INSPECTOR_LABEL: React.CSSProperties = { color: "#aaa", display: "block", marginTop: 4 };

const ADJUST_BUTTON: React.CSSProperties = {
    fontSize: 10, padding: "2px 6px", background: "transparent", color: "#ccc",
    border: "1px solid #2a2a4a", borderRadius: 3, cursor: "pointer"
};

/** A titled group of controls. Sections are what turn a list of fields into a panel you can scan. */
function InspectorSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ borderTop: "1px solid #23233d", marginTop: 10, paddingTop: 6 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#777", letterSpacing: 0.4, textTransform: "uppercase" }}>{title}</div>
            {children}
        </div>
    );
}

/** Free text, committed on every keystroke (edits coalesce into one undo, like the sliders). */
function TextInput({ value, placeholder, onChange }: { value: string; placeholder?: string; onChange: (v: string) => void }) {
    return (
        <input
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={e => onChange(e.target.value)}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        />
    );
}

/** A plain dropdown for an enum field — the schema's own union, so the options cannot drift. */
function SelectInput({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (v: string) => void }) {
    return (
        <select
            value={value}
            onChange={e => onChange(e.target.value)}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        >
            {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
    );
}

function NumInput({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
    return (
        <input
            type="number"
            value={value}
            disabled={disabled}
            // Skip non-numeric input rather than substituting 0: `|| 0` turned a
            // half-typed value (or "-") into a real edit that snapped the node to 0.
            onChange={e => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) onChange(v);
            }}
            style={{
                width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                background: UI.bg, color: UI.text, border: "1px solid #2a2a4a", borderRadius: 2, marginBottom: 4
            }}
        />
    );
}

/**
 * The VARIANTS section — both halves, because either alone is useless.
 *
 * On any node: tag it into a set and give it property values, which is what MAKES a variant set
 * (there is no set object to create — a set is the nodes that name it). On an instance whose
 * master belongs to a set: one dropdown per property the set defines, and choosing swaps which
 * master is drawn while the instance, its position and its overrides stay put.
 */

/**
 * The SLOTS section — again both halves, because either alone is useless.
 *
 * On any node: name it as a slot, which makes it a hole in whatever master contains it. On an
 * instance: one picker per slot the master defines, choosing which node to draw there. The
 * slot keeps supplying the box; its own children are the default whenever nothing fills it.
 */

/**
 * Everything a captured state records: the node's LOOK, not just its paint.
 *
 * Style alone was the original capture, and it made most of the transition machinery
 * unreachable: `blendStates` interpolates geometry and transform, so a prototype could change
 * colour but could never move, grow or turn anything — the animation existed and nothing could
 * author an input for it. A state now pins where the node is and how it is transformed as well
 * as how it is painted, which is what "this node's current look" already claimed to mean.
 *
 * `transform` is included only when the node HAS one, so a state on an untransformed node does
 * not pin an identity transform onto it — an absent transform and an identity one are the same
 * picture, but only the absent one leaves a later rotate free to take effect from the base.
 */
function captureLook(node: Node): StateDefinition {
    return {
        style: { ...node.style },
        geometry: { ...node.geometry },
        ...(node.transform ? { transform: { ...node.transform } } : {})
    };
}

/**
 * The STATES section — what a node looks like in a named context.
 *
 * Defining one CAPTURES the node's current appearance under a name: you style the node the way
 * you want it to look while hovered, press "Capture", and that becomes the hover state. That is
 * the only authoring gesture that does not need a second inspector — the node in front of you
 * IS the editor for the state.
 */
function StatesSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const [newState, setNewState] = useState("");
    const doc = dispatcher.getDocument();
    const states = node.states ?? {};
    const active = doc.activeState;

    return (
        <>
            <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 4 }}>
                {active
                    ? `Showing “${active}”. Capture stores this node's current look under a name.`
                    : "Capture stores this node's current look under a name; the toolbar switches between them."}
            </div>

            {Object.keys(states).sort().map(name => (
                <div key={name} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4 }}>
                    <span style={{ flex: 1, color: name === active ? UI.accent : UI.text, fontSize: 11 }}>{name}</span>
                    <button
                        title={`Re-capture this node's current look as "${name}"`}
                        onClick={() => {
                            dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), node.id, name, captureLook(node)));
                            refresh();
                        }}
                        style={{ fontSize: 10, padding: "1px 5px", background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                    >⟳</button>
                    <button
                        title={`Remove the "${name}" state from this node`}
                        onClick={() => {
                            dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), node.id, name, null));
                            refresh();
                        }}
                        style={{ fontSize: 10, padding: "1px 5px", background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                    >✕</button>
                </div>
            ))}

            <input
                type="text"
                value={newState}
                placeholder="capture as… (e.g. hover)"
                onChange={e => setNewState(e.target.value)}
                onKeyDown={e => {
                    if (e.key !== "Enter") return;
                    const name = newState.trim();
                    if (!name) return;
                    // The shared name rule is the authority; the field only explains a refusal.
                    const err = variantNameError("state name", name, true);
                    if (err) { window.alert(`That state can't be used: ${err}.`); return; }
                    dispatcher.dispatchAction(new SetNodeStateAction(dispatcher.getDocument(), node.id, name, captureLook(node)));
                    setNewState("");
                    refresh();
                }}
                style={{
                    width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                    background: UI.bg, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 2
                }}
            />
        </>
    );
}

function SlotSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const doc = dispatcher.getDocument();

    // Which slots does this instance's master expose? Walk exactly what expansion walks.
    const masterId = node.type === "core.instance" ? resolveVariantMaster(doc, node) : null;
    const slots = masterId
        ? masterSubtreeIds(doc, masterId)
            .map(id => doc.nodes.get(id)!.slot)
            .filter((s): s is string => typeof s === "string")
        : [];
    const uniqueSlots = [...new Set(slots)].sort();

    // Anything top-level can fill a slot — except this instance itself, which would be a cycle
    // the expansion would have to stop, drawing nothing and looking broken.
    const candidates = doc.rootNodeUuids
        .filter(id => id !== node.id)
        .map(id => ({ id, label: doc.nodes.get(id)?.name ?? doc.nodes.get(id)?.type ?? id }));

    return (
        <>
            {uniqueSlots.length > 0 && (
                <>
                    <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 4 }}>
                        This component exposes {uniqueSlots.length === 1 ? "a slot" : `${uniqueSlots.length} slots`}.
                        An empty one draws its own default content.
                    </div>
                    {uniqueSlots.map(name => (
                        <div key={name}>
                            <label style={INSPECTOR_LABEL}>{name}</label>
                            <SelectInput
                                value={node.slotContent?.[name] ?? ""}
                                options={["", ...candidates.map(c => c.id)]}
                                onChange={v => {
                                    dispatcher.dispatchAction(new SetSlotContentAction(dispatcher.getDocument(), node.id, name, v || null));
                                    refresh();
                                }}
                            />
                        </div>
                    ))}
                </>
            )}

            {/* The MASTER half: make this node a slot. */}
            <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6, marginTop: uniqueSlots.length ? 8 : 0 }}>
                <input
                    type="checkbox"
                    checked={node.slot !== undefined}
                    onChange={e => {
                        dispatcher.dispatchAction(new SetSlotAction(dispatcher.getDocument(), node.id, e.target.checked ? "content" : null));
                        refresh();
                    }}
                />
                Is a slot
            </label>
            {node.slot !== undefined && (
                <>
                    <label style={INSPECTOR_LABEL}>Slot name</label>
                    <TextInput
                        value={node.slot}
                        placeholder="content"
                        onChange={v => {
                            // `slotError` is the authority; an empty name is simply not committed.
                            if (slotError(v) !== null) return;
                            dispatcher.dispatchAction(new SetSlotAction(dispatcher.getDocument(), node.id, v));
                            refresh();
                        }}
                    />
                </>
            )}
        </>
    );
}

/**
 * The author's own kind for a node, and its custom properties (schema 64).
 *
 * WHAT THE ENGINE CARRIES WITHOUT READING, which is exactly why it needs a panel: nothing else in
 * the app would ever show it, so a property imported from a map would live in the file, survive
 * every save, and be invisible to the person who owns it.
 *
 * THE TYPE IS A FREE TEXT FIELD rather than a dropdown, and that is deliberate. The document stores
 * whatever the file declared so that a map written by a newer editor round-trips untouched; a
 * closed list here would make those types uneditable — visible, unchangeable, and silently replaced
 * the moment anyone touched the row. The common ones are offered as a datalist instead.
 */
function MetadataSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const [newName, setNewName] = useState("");
    const data = node.userData ?? {};
    const names = Object.keys(data).sort();

    const write = (patch: { className?: string | null; userData?: UserData | null; entity?: Entity | null }) => {
        dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(), node.id, patch));
        refresh();
    };
    const setEntity = <K extends keyof Entity>(key: K, value: Entity[K] | undefined) => {
        const next: Entity = { ...(node.entity ?? {}) };
        if (value === undefined) delete next[key]; else next[key] = value;
        write({ entity: Object.keys(next).length ? next : null });
    };
    /** One property replaced, or removed when `next` is null — the whole map travels, as the delta wants. */
    const setProp = (name: string, next: { type: string; propertyType?: string; value: string } | null) => {
        const copy: UserData = { ...data };
        if (next === null) delete copy[name];
        else copy[name] = next;
        write({ userData: copy });
    };

    return (
        <>
            <label style={INSPECTOR_LABEL}>Class</label>
            <TextInput
                value={node.className ?? ""}
                placeholder="none"
                onChange={v => write({ className: v.trim() === "" ? null : v.trim() })}
            />
            <div style={{ color: UI.textDim, fontSize: 10, marginTop: 10, marginBottom: 4 }}>Runtime entity</div>
            <label style={INSPECTOR_LABEL}>Body</label>
            <SelectInput value={node.entity?.body ?? ""} options={["", "static", "dynamic", "oneway"]}
                onChange={v => setEntity("body", v === "" ? undefined : v as Entity["body"])} />
            <label style={{ ...INSPECTOR_LABEL, display: "flex", gap: 6 }}>
                <input type="checkbox" checked={node.entity?.player === true}
                    onChange={e => setEntity("player", e.target.checked || undefined)} /> Player
            </label>
            <label style={INSPECTOR_LABEL}>Respawn anchor node id</label>
            <TextInput value={node.entity?.respawnAt ?? ""} placeholder="optional node id"
                onChange={v => setEntity("respawnAt", v.trim() || undefined)} />
            <label style={INSPECTOR_LABEL}>Next level project</label>
            <TextInput value={node.entity?.transitionTo ?? ""} placeholder="level-2.vde"
                onChange={v => setEntity("transitionTo", v.trim() || undefined)} />
            <label style={INSPECTOR_LABEL}>Warp destination node id</label>
            <TextInput value={node.entity?.warpsTo ?? ""} placeholder="optional node id"
                onChange={v => setEntity("warpsTo", v.trim() || undefined)} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, marginTop: 6 }}>
                {(["stompable", "deadly", "goal", "collectible"] as const).map(key => (
                    <label key={key} style={{ ...INSPECTOR_LABEL, display: "flex", gap: 5 }}>
                        <input type="checkbox" checked={node.entity?.[key] === true}
                            onChange={e => setEntity(key, e.target.checked || undefined)} /> {key}
                    </label>
                ))}
            </div>
            {(["friction", "patrol", "powers", "stars", "bounces"] as const).map(key => (
                <div key={key}>
                    <label style={INSPECTOR_LABEL}>{key}</label>
                    <NumInput value={node.entity?.[key] ?? 0}
                        onChange={v => setEntity(key, Number.isFinite(v) ? v : undefined)} />
                </div>
            ))}
            <ActorPlacementPanel key={`actor-${node.id}`} nodeId={node.id} dispatcher={dispatcher} onPlaced={refresh}/>
            <GameplayPanel key={node.id} entity={node.entity ?? {}} onChange={entity => write({ entity })}
                assets={dispatcher.getDocument().behaviorAssets}
                variables={dispatcher.getDocument().gameplayVariables}
                functions={dispatcher.getDocument().behaviorFunctions}
                onFunctionsChange={functions=>{const result=dispatcher.dispatchAction(new SetBehaviorFunctionsAction(dispatcher.getDocument(),functions));refresh();return result.success;}}
                onVariablesChange={variables=>{const result=dispatcher.dispatchAction(new SetGameplayVariablesAction(dispatcher.getDocument(),variables));refresh();return result.success;}}
                onAssetsChange={(assets,entity)=>{dispatcher.dispatchAction(new SetBehaviorAssetsAction(dispatcher.getDocument(),assets,entity?{nodeId:node.id,entity}:undefined));refresh();}} />
            {node.spatial3d && <>
                <label style={INSPECTOR_LABEL}>3D gravity (enables contact solver)</label>
                <NumInput value={node.entity?.gravity3d ?? 0} onChange={v => setEntity("gravity3d", Math.max(0, Math.min(1000, v)))} />
                <label style={INSPECTOR_LABEL}>3D restitution</label>
                <NumInput value={node.entity?.restitution3d ?? 0} onChange={v => setEntity("restitution3d", Math.max(0, Math.min(1, v)))} />
            </>}
            <datalist id="vde-prop-types">
                {["string", "int", "float", "bool", "color", "file", "object"].map(t => <option key={t} value={t} />)}
            </datalist>
            <div style={{ color: UI.textFaint, fontSize: 10, marginTop: 8, marginBottom: 4 }}>
                {names.length === 0
                    ? "No imported/custom properties. Runtime behavior uses the typed fields above."
                    : `${names.length} imported/custom propert${names.length === 1 ? "y" : "ies"}; preserved for round trips.`}
            </div>
            {names.map(name => {
                const p = data[name];
                return (
                    <div key={name} style={{ display: "grid", gridTemplateColumns: "1fr 64px 20px", gap: 4, marginBottom: 3 }}>
                        <TextInput value={p.value} onChange={v => setProp(name, { ...p, value: v })} />
                        <input
                            list="vde-prop-types"
                            value={p.type}
                            title={`Type of "${name}"${p.propertyType ? ` (${p.propertyType})` : ""}`}
                            onChange={e => {
                                // AN EMPTY TYPE IS NOT A TYPE — `userDataError` refuses it, and the
                                // action would silently do nothing. Mid-edit it reads as "string".
                                const t = e.target.value.trim();
                                setProp(name, { ...p, type: t === "" ? "string" : t });
                            }}
                            style={{ ...SELECT_STYLE, minWidth: 0 }}
                        />
                        <button
                            onClick={() => setProp(name, null)}
                            title={`Remove "${name}"`}
                            aria-label={`Remove property ${name}`}
                            style={{ ...ADJUST_BUTTON, padding: "0 4px" }}
                        >×</button>
                        <div style={{ gridColumn: "1 / -1", color: UI.textFaint, fontSize: 9, marginTop: -2 }}>{name}</div>
                    </div>
                );
            })}
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                <TextInput value={newName} placeholder="new property name" onChange={setNewName} />
                <button
                    disabled={newName.trim() === "" || Object.prototype.hasOwnProperty.call(data, newName.trim())}
                    onClick={() => {
                        const n = newName.trim();
                        if (n === "") return;
                        // `string` IS THE FORMAT'S DEFAULT, so a new property starts as one rather
                        // than as a type the author has to correct before it means anything.
                        setProp(n, { type: "string", value: "" });
                        setNewName("");
                    }}
                    aria-label="Add property"
                    style={ADJUST_BUTTON}
                >Add</button>
            </div>
        </>
    );
}

function VariantSection({ node, dispatcher, refresh }: { node: Node; dispatcher: ActionDispatcher; refresh: () => void }) {
    const [newProp, setNewProp] = useState("");
    const doc = dispatcher.getDocument();
    const variant = node.variant;

    const setVariant = (v: VariantKey | null) => {
        dispatcher.dispatchAction(new SetVariantAction(dispatcher.getDocument(), node.id, v));
        refresh();
    };

    // An instance shows the PICKER for the set its master belongs to.
    const masterId = node.type === "core.instance" ? node.componentId : undefined;
    const masterSet = masterId ? doc.nodes.get(masterId)?.variant?.set : undefined;
    const props = masterSet ? variantProperties(doc, masterSet) : null;
    const resolvedId = node.type === "core.instance" ? resolveVariantMaster(doc, node) : null;
    const resolved = resolvedId ? doc.nodes.get(resolvedId) : null;

    return (
        <>
            {props && masterSet && (
                <>
                    <div style={{ color: UI.textFaint, fontSize: 10, marginBottom: 4 }}>
                        Set “{masterSet}” — switching redraws this instance from another master.
                    </div>
                    {Object.keys(props).length === 0 && (
                        <div style={{ color: UI.textFaint }}>This set has no properties yet.</div>
                    )}
                    {Object.entries(props).map(([prop, values]) => {
                        // What this instance SHOWS: its own choice, else the master's own value.
                        const current = node.variants?.[prop] ?? resolved?.variant?.values[prop] ?? "";
                        return (
                            <div key={prop}>
                                <label style={INSPECTOR_LABEL}>{prop}</label>
                                <SelectInput
                                    value={current}
                                    options={values}
                                    onChange={v => {
                                        dispatcher.dispatchAction(new SetInstanceVariantAction(dispatcher.getDocument(), node.id, prop, v));
                                        refresh();
                                    }}
                                />
                            </div>
                        );
                    })}
                    {resolvedId && resolvedId !== masterId && (
                        <div style={{ color: UI.accent, fontSize: 10, marginBottom: 6 }}>
                            Drawing “{resolved?.name ?? resolvedId}”.
                        </div>
                    )}
                </>
            )}

            {/* The MASTER half: tag this node into a set. */}
            <label style={{ ...INSPECTOR_LABEL, display: "flex", alignItems: "center", gap: 6, marginTop: props ? 8 : 0 }}>
                <input
                    type="checkbox"
                    checked={!!variant}
                    onChange={e => setVariant(e.target.checked ? { set: "Set", values: {} } : null)}
                />
                In a variant set
            </label>
            {variant && (
                <>
                    <label style={INSPECTOR_LABEL}>Set name</label>
                    <TextInput
                        value={variant.set}
                        placeholder="Button"
                        onChange={v => { if (v.length > 0) setVariant({ ...variant, set: v }); }}
                    />
                    {Object.entries(variant.values).map(([k, v]) => (
                        <div key={k} style={{ display: "flex", gap: 4, alignItems: "flex-end", marginBottom: 4 }}>
                            <div style={{ flex: 1 }}>
                                <label style={INSPECTOR_LABEL}>{k}</label>
                                <TextInput
                                    value={v}
                                    onChange={nv => { if (nv.length > 0) setVariant({ ...variant, values: { ...variant.values, [k]: nv } }); }}
                                />
                            </div>
                            <button
                                title={`Remove the "${k}" property`}
                                onClick={() => {
                                    const values = { ...variant.values };
                                    delete values[k];
                                    setVariant({ ...variant, values });
                                }}
                                style={{ fontSize: 10, padding: "2px 5px", marginBottom: 4, background: "transparent", color: UI.textDim, border: `1px solid ${UI.line}`, borderRadius: 2, cursor: "pointer" }}
                            >✕</button>
                        </div>
                    ))}
                    <input
                        type="text"
                        value={newProp}
                        placeholder="add property (e.g. size)"
                        onChange={e => setNewProp(e.target.value)}
                        onKeyDown={e => {
                            if (e.key !== "Enter") return;
                            const key = newProp.trim();
                            if (!key) return;
                            // `variantError` is the authority; the field only explains a refusal.
                            const candidate: VariantKey = { ...variant, values: { ...variant.values, [key]: "default" } };
                            const err = variantError(candidate);
                            if (err) { window.alert(`That property can't be used: ${err}.`); return; }
                            setVariant(candidate);
                            setNewProp("");
                        }}
                        style={{
                            width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
                            background: UI.bg, color: UI.text, border: `1px solid ${UI.line}`, borderRadius: 2
                        }}
                    />
                </>
            )}
        </>
    );
}

export interface NodeInspectorSectionsProps {
    node: Node;
    dispatcher: ActionDispatcher;
    refresh: () => void;
}

/** States, slots, variants and metadata. The remaining inspector sections stay in the shell. */
export function NodeInspectorSections({ node, dispatcher, refresh }: NodeInspectorSectionsProps) {
    return (
        <>
            {/* Authored metadata (schema 64): the author's own kind for this node,
                and properties this engine carries without reading. The reason it is
                here rather than nowhere is that 41 of them were being parsed out of
                every imported map and dropped for want of a field — and a field with
                no way to edit it would be the same gap one layer down. */}
            <InspectorSection title="Metadata">
                <MetadataSection node={node} dispatcher={dispatcher} refresh={refresh} />
            </InspectorSection>

            {/* Variants (schema 27): tag a master into a set, or switch an
                instance between the masters of the set its own master joins. */}
            <InspectorSection title="Variants">
                <VariantSection node={node} dispatcher={dispatcher} refresh={refresh} />
            </InspectorSection>

            {/* Slots (schema 29): a named hole in a master, and what an
                instance puts in it. */}
            <InspectorSection title="Slots">
                <SlotSection node={node} dispatcher={dispatcher} refresh={refresh} />
            </InspectorSection>

            {/* States (M7): what this node looks like in a named context. */}
            <InspectorSection title="States">
                <StatesSection node={node} dispatcher={dispatcher} refresh={refresh} />
            </InspectorSection>
        </>
    );
}
