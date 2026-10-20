/**
 * @module ThreeDInspector
 * @description Focused inspector controls for authored 3D materials, lights,
 * environments, 2D surfaces, fog, particles and light strings. Document mutation remains owned by App.
 */

import React from "react";
import { Node } from "../core/document/Node";
import { Asset3D, Light3D, Spatial3D } from "../core/document/Spatial3D";
import { copySpatial3D } from "../renderer/Gizmo3D";
import { MeshAsset3D } from "../renderer/Scene3D";
import {BlockoutPanel} from "./BlockoutPanel";
import {SolidTreePanel} from "./SolidTreePanel";
import {solidLeaf3D} from "../core/geometry/SolidTree3D";
import { Effects3DInspector } from "./Effects3DInspector";

const colors = {
    bg: "#0e0e18",
    raised: "#1c1c33",
    line: "#262642",
    text: "#dcdce8",
    textFaint: "#5f5f7a"
};
const labelStyle: React.CSSProperties = { color: "#aaa", display: "block", marginTop: 4 };
const gridStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };
const selectStyle: React.CSSProperties = { width: "100%", fontSize: 11, marginBottom: 6,
    background: colors.raised, color: colors.text, border: `1px solid ${colors.line}`, borderRadius: 3 };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return <div style={{ borderTop: `1px solid ${colors.line}`, paddingTop: 7, marginTop: 7 }}>
        <div style={{ color: "#bbb", fontSize: 10, fontWeight: 700, textTransform: "uppercase",
            letterSpacing: 0.4, marginBottom: 4 }}>{title}</div>
        {children}
    </div>;
}

function NumberInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
    return <input type="number" value={value} onChange={event => {
        const next = Number.parseFloat(event.target.value);
        if (Number.isFinite(next)) onChange(next);
    }} style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px",
        background: colors.bg, color: colors.text, border: "1px solid #2a2a4a",
        borderRadius: 2, marginBottom: 4 }} />;
}

export interface ThreeDInspectorProps {
    node: Node;
    assets: readonly Asset3D[];
    meshes: ReadonlyMap<string, MeshAsset3D>;
    onChange: (spatial: Spatial3D, coalesce?: boolean) => void;
}

export function ThreeDInspector({ node, assets, meshes, onChange }: ThreeDInspectorProps) {
    const spatial = node.spatial3d;
    if (!spatial) return null;

    const updateLight = (patch: Partial<Light3D>) => {
        if (!spatial.light) return;
        const next = copySpatial3D(spatial);
        next.light = { ...next.light!, ...patch } as Light3D;
        onChange(next, true);
    };
    const materialAssets = assets.filter(asset => asset.kind === "material");

    return <>
        {spatial.blockout&&<button type="button" onClick={()=>{
            const next=copySpatial3D(spatial);next.solidTree=solidLeaf3D("base",next.blockout!);delete next.blockout;onChange(next);
        }}>Edit solid operations</button>}
        {spatial.solidTree&&<>
            <label><input aria-label="Blockout solid collision" type="checkbox" checked={spatial.blockoutCollision===true}
                onChange={e=>{const next=copySpatial3D(spatial);next.blockoutCollision=e.target.checked;onChange(next);}}/>Solid collision</label>
            <SolidTreePanel tree={spatial.solidTree} onChange={solidTree=>{const next=copySpatial3D(spatial);next.solidTree=solidTree;onChange(next);}}/>
        </>}
        {spatial.blockout&&<BlockoutPanel shape={spatial.blockout} solid={spatial.blockoutCollision===true}
            onSolidChange={solid=>{const next=copySpatial3D(spatial);next.blockoutCollision=solid;onChange(next);}} onChange={blockout=>{
            const next=copySpatial3D(spatial);next.blockout=blockout;onChange(next);
        }}/>}
        {spatial.renderable && (() => {
            const clips = meshes.get(spatial.renderable!.meshAssetId)?.motion?.clips ?? [];
            if (!clips.length) return null;
            const change = (animation: Spatial3D["animation"]) => {
                const next = copySpatial3D(spatial); next.animation = animation; onChange(next);
            };
            return <Section title="3D animation">
                <label style={labelStyle}>Clip (Run to play; timeline to preview)</label>
                <select aria-label="3D animation clip" value={spatial.animation?.clip ?? ""} onChange={e => change(e.target.value === "" ? undefined : { clip: Number(e.target.value), speed: 1, loop: true })}>
                    <option value="">Bind pose</option>{clips.map((clip, i) => <option key={i} value={i}>{clip.name}</option>)}
                </select>
                {spatial.animation && <>
                    <label style={labelStyle}>Blend with</label>
                    <select aria-label="3D secondary animation" value={spatial.animation.secondaryClip ?? ""} onChange={e => change({ ...spatial.animation!, secondaryClip: e.target.value === "" ? undefined : Number(e.target.value) })}>
                        <option value="">None</option>{clips.map((clip, i) => <option key={i} value={i}>{clip.name}</option>)}
                    </select>
                    <label style={labelStyle}>Blend weight</label>
                    <NumberInput value={spatial.animation.blend ?? 0} onChange={blend => change({ ...spatial.animation!, blend: Math.max(0, Math.min(1, blend)) })} />
                    <label style={labelStyle}>Playback speed</label>
                    <NumberInput value={spatial.animation.speed ?? 1} onChange={speed => change({ ...spatial.animation!, speed: Math.max(.01, Math.min(10, speed)) })} />
                    <label><input type="checkbox" checked={spatial.animation.loop !== false} onChange={e => change({ ...spatial.animation!, loop: e.target.checked })} /> Loop</label>
                    <label style={labelStyle}>Crossfade seconds (0 = off)</label>
                    <NumberInput value={spatial.animation.fade ?? 0} onChange={fade => {
                        const next = { ...spatial.animation! };
                        if (fade > 0) next.fade = Math.max(0.05, Math.min(1, fade)); else delete next.fade;
                        change(next);
                    }} />
                </>}
            </Section>;
        })()}
        {spatial.renderable && (() => {
            const renderable = spatial.renderable!;
            const mesh = meshes.get(renderable.meshAssetId);
            const primitiveSlots = mesh?.instances.reduce((max, instance) => {
                const material = instance.primitive.material;
                return typeof material === "number" ? Math.max(max, material + 1) : max;
            }, 0) ?? 0;
            const slotCount = Math.max(primitiveSlots, mesh?.materialColors?.length ?? 0,
                renderable.materialAssetIds?.length ?? 0);
            if (slotCount === 0 || materialAssets.length === 0) return null;
            return <Section title="3D materials">
                {Array.from({ length: slotCount }, (_, slot) => {
                    const assignedId = renderable.materialAssetIds?.[slot];
                    const assigned = materialAssets.find(asset => asset.id === assignedId);
                    const match = assigned?.source.match(/^(.*)#material-(\d+)$/);
                    const sourceMesh = match && assets.find(asset =>
                        asset.kind === "mesh" && asset.source === match[1]);
                    const material = sourceMesh && match
                        ? meshes.get(sourceMesh.id)?.materials?.[Number(match[2])]
                        : null;
                    return <div key={slot}>
                        <label style={labelStyle}>Slot {slot + 1}</label>
                        <select data-material-slot={slot} value={assignedId ?? ""} onChange={event => {
                            const materialId = event.target.value;
                            if (!materialId) return;
                            const next = copySpatial3D(spatial);
                            const ids = [...(next.renderable!.materialAssetIds ?? [])];
                            const meshAsset = assets.find(asset =>
                                asset.id === next.renderable!.meshAssetId && asset.kind === "mesh");
                            while (ids.length < slot) {
                                const source = meshAsset ? `${meshAsset.source}#material-${ids.length}` : "";
                                const imported = assets.find(asset => asset.kind === "material" && asset.source === source);
                                if (!imported) return;
                                ids.push(imported.id);
                            }
                            if (ids.length === slot) ids.push(materialId);
                            ids[slot] = materialId;
                            next.renderable!.materialAssetIds = ids;
                            onChange(next);
                        }} style={selectStyle}>
                            <option value="" disabled>Choose material…</option>
                            {materialAssets.map(asset => <option key={asset.id} value={asset.id}>
                                {asset.name ?? asset.id}
                            </option>)}
                        </select>
                        {material && <div style={{ color: colors.textFaint, fontSize: 9, margin: "-3px 0 6px" }}>
                            Metal {material.metallic.toFixed(2)} · Rough {material.roughness.toFixed(2)}
                            {material.baseColorTexture ? " · Base texture" : ""}
                            {material.metallicRoughnessTexture ? " · M/R texture" : ""}
                            {material.normalTexture ? " · Normal texture" : ""}
                            {material.emissiveTexture ? " · Emissive texture" : ""}
                            {material.alphaMode && material.alphaMode !== "OPAQUE" ? ` · ${material.alphaMode}` : ""}
                            {material.unlit ? " · Unlit" : ""}
                        </div>}
                    </div>;
                })}
            </Section>;
        })()}

        {spatial.light && <Section title="3D light">
            <label style={labelStyle}>Kind</label>
            <select data-light-kind-3d value={spatial.light.kind} onChange={event => {
                const kind = event.target.value as "directional" | "point";
                const light = spatial.light!;
                updateLight(kind === "directional"
                    ? { kind, color: light.color, intensity: light.intensity }
                    : { kind, color: light.color, intensity: light.intensity, range: 10 });
            }} style={selectStyle}>
                <option value="directional">Directional</option>
                <option value="point">Point</option>
            </select>
            <div style={gridStyle}>
                {(["x", "y", "z"] as const).map((channel, index) => <div key={channel}>
                    <label style={labelStyle}>{["Red", "Green", "Blue"][index]}</label>
                    <NumberInput value={spatial.light!.color[channel]} onChange={value => updateLight({
                        color: { ...spatial.light!.color, [channel]: Math.max(0, value) }
                    })} />
                </div>)}
            </div>
            <label style={labelStyle}>Intensity</label>
            <NumberInput value={spatial.light.intensity}
                onChange={value => updateLight({ intensity: Math.max(0, value) })} />
            {spatial.light.kind === "point" && <>
                <label style={labelStyle}>Range</label>
                <NumberInput value={spatial.light.range}
                    onChange={value => updateLight({ range: Math.max(0.001, value) })} />
            </>}
        </Section>}

        {spatial.environment && <Section title="HDR environment">
            <div style={{ color: colors.textFaint, marginBottom: 6 }}>
                {assets.find(asset => asset.id === spatial.environment!.textureAssetId)?.name
                    ?? assets.find(asset => asset.id === spatial.environment!.textureAssetId)?.source}
            </div>
            <label style={labelStyle}>Intensity</label>
            <NumberInput value={spatial.environment.intensity} onChange={value => {
                const next = copySpatial3D(spatial);
                next.environment = { ...next.environment!, intensity: Math.max(0, value) };
                onChange(next, true);
            }} />
            <label style={labelStyle}>Rotation°</label>
            <NumberInput value={spatial.environment.rotationDegrees} onChange={rotationDegrees => {
                const next = copySpatial3D(spatial);
                next.environment = { ...next.environment!, rotationDegrees };
                onChange(next, true);
            }} />
        </Section>}

        {spatial.composition2d && <Section title="2D in 3D">
            <label style={labelStyle}>Facing</label>
            <select data-composition-2d-mode value={spatial.composition2d.mode} onChange={event => {
                const next = copySpatial3D(spatial);
                next.composition2d = { ...next.composition2d!,
                    mode: event.target.value as "plane" | "billboard" };
                onChange(next, true);
            }} style={selectStyle}>
                <option value="plane">Plane — follows rotation</option>
                <option value="billboard">Billboard — faces camera</option>
            </select>
            <label style={labelStyle}>Pixels per unit</label>
            <NumberInput value={spatial.composition2d.pixelsPerUnit} onChange={pixelsPerUnit => {
                const next = copySpatial3D(spatial);
                next.composition2d = { ...next.composition2d!, pixelsPerUnit: Math.max(0.001, pixelsPerUnit) };
                onChange(next, true);
            }} />
            <label style={{ ...labelStyle, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={spatial.composition2d.lit} onChange={event => {
                    const next = copySpatial3D(spatial);
                    next.composition2d = { ...next.composition2d!, lit: event.target.checked };
                    onChange(next, true);
                }} /> Lit surface
            </label>
        </Section>}

        <Effects3DInspector spatial={spatial} onChange={onChange} />
    </>;
}
