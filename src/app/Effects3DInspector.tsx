/**
 * @module Effects3DInspector
 * @description Inspector controls for schema 91 scene fog, particle emitters and light strings on
 * the selected 3D node. Every edit is clamped to the validated range and returned as a whole new
 * Spatial3D, so ThreeDInspector's owner commits it through SetSpatial3DAction like any 3D edit.
 */

import React from "react";
import type { Spatial3D, Vec3 } from "../core/document/Spatial3D";
import { copySpatial3D } from "../renderer/Gizmo3D";
import { defaultFog3D, defaultLightString3D, LIGHT_STRING_POINTS_MAX, PARTICLE_PRESETS_3D, particlePreset3D,
    PARTICLES_PER_EMITTER_MAX, type Fog3D, type LightString3D, type ParticleEmitter3D, type ParticlePreset3D } from "../core/document/Effects3D";

const label: React.CSSProperties = { color: "#aaa", display: "block", marginTop: 4, fontSize: 11 };
const field: React.CSSProperties = { width: "100%", boxSizing: "border-box", fontSize: 11, padding: "2px 4px", marginBottom: 4,
    background: "#0e0e18", color: "#dcdce8", border: "1px solid #2a2a4a", borderRadius: 2 };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 };
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return <div style={{ borderTop: "1px solid #262642", paddingTop: 7, marginTop: 7 }}>
        <div style={{ color: "#bbb", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{title}</div>
        {children}
    </div>;
}

function Num({ name, value, min, max, onChange }: { name: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
    return <label style={label}>{name}
        <input type="number" aria-label={name} value={value} step="any" style={field} onChange={event => {
            const next = Number.parseFloat(event.target.value);
            if (Number.isFinite(next)) onChange(clamp(next, min, max));
        }} />
    </label>;
}

function Color({ name, value, onChange }: { name: string; value: Vec3; onChange: (v: Vec3) => void }) {
    return <><span style={label}>{name} (linear RGB)</span><div style={grid}>
        {(["x", "y", "z"] as const).map(axis => <input key={axis} type="number" step="any" aria-label={`${name} ${axis}`} value={value[axis]}
            style={field} onChange={event => {
                const next = Number.parseFloat(event.target.value);
                if (Number.isFinite(next)) onChange({ ...value, [axis]: clamp(next, 0, 100) });
            }} />)}
    </div></>;
}

function Choice<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
    return <label style={label}>{name}
        <select aria-label={name} value={value} style={field} onChange={event => onChange(event.target.value as T)}>
            {options.map(option => <option key={option} value={option}>{option}</option>)}
        </select>
    </label>;
}

function Toggle({ name, checked, onChange }: { name: string; checked: boolean; onChange: (v: boolean) => void }) {
    return <label style={{ ...label, display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" aria-label={name} checked={checked} onChange={event => onChange(event.target.checked)} /> {name}
    </label>;
}

/** "x y z; x y z" text for strand points; null when it does not parse to 2..LIGHT_STRING_POINTS_MAX points. */
export function parseStrandPoints3D(text: string): Vec3[] | null {
    const points = text.split(";").map(s => s.trim()).filter(Boolean).map(s => s.split(/[\s,]+/).map(Number));
    if (points.length < 2 || points.length > LIGHT_STRING_POINTS_MAX || points.some(p => p.length !== 3 || !p.every(Number.isFinite))) return null;
    return points.map(([x, y, z]) => ({ x, y, z }));
}
export const formatStrandPoints3D = (points: readonly Vec3[]): string => points.map(p => `${p.x} ${p.y} ${p.z}`).join("; ");

export function Effects3DInspector({ spatial, onChange }: { spatial: Spatial3D; onChange: (spatial: Spatial3D, coalesce?: boolean) => void }) {
    const set = <K extends "fog" | "particles" | "lightString">(key: K, value: Spatial3D[K] | undefined, coalesce = true) => {
        const next = copySpatial3D(spatial);
        if (value === undefined) delete next[key]; else next[key] = value;
        onChange(next, coalesce);
    };
    const fog = spatial.fog, emitter = spatial.particles, strand = spatial.lightString;
    const fogPatch = (patch: Partial<Fog3D>) => set("fog", { ...fog!, ...patch });
    const emitterPatch = (patch: Partial<ParticleEmitter3D>) => set("particles", { ...emitter!, ...patch });
    const strandPatch = (patch: Partial<LightString3D>) => set("lightString", { ...strand!, ...patch });
    const [pointsText, setPointsText] = React.useState(strand ? formatStrandPoints3D(strand.points) : "");
    React.useEffect(() => { if (strand) setPointsText(formatStrandPoints3D(strand.points)); }, [strand?.points]);
    return <>
        <Section title="Fog">
            <Toggle name="Scene fog" checked={!!fog} onChange={on => set("fog", on ? defaultFog3D() : undefined, false)} />
            {fog && <>
                <Choice name="Fog mode" value={fog.mode} options={["linear", "exp", "exp2"] as const} onChange={mode => fogPatch({ mode })} />
                <Color name="Fog color" value={fog.color} onChange={color => fogPatch({ color })} />
                {fog.mode === "linear"
                    ? <><Num name="Fog start" value={fog.start} min={0} max={Math.max(0, fog.end - 0.01)} onChange={start => fogPatch({ start })} />
                        <Num name="Fog end" value={fog.end} min={fog.start + 0.01} max={1e6} onChange={end => fogPatch({ end })} /></>
                    : <Num name="Fog density" value={fog.density} min={0} max={10} onChange={density => fogPatch({ density })} />}
                <Num name="Height fog density" value={fog.heightDensity} min={0} max={10} onChange={heightDensity => fogPatch({ heightDensity })} />
                <Num name="Height fog base" value={fog.heightBase} min={-1e6} max={1e6} onChange={heightBase => fogPatch({ heightBase })} />
                <Num name="Height fog falloff" value={fog.heightFalloff} min={0.001} max={100} onChange={heightFalloff => fogPatch({ heightFalloff })} />
                <Num name="Sky blend" value={fog.skyBlend} min={0} max={1} onChange={skyBlend => fogPatch({ skyBlend })} />
                <Num name="Light glow (fake halos)" value={fog.lightGlow} min={0} max={4} onChange={lightGlow => fogPatch({ lightGlow })} />
            </>}
        </Section>
        <Section title="Particles">
            <Choice name="Particle preset" value={(emitter ? "keep" : "none") as string}
                options={["none", ...(emitter ? ["keep"] : []), ...PARTICLE_PRESETS_3D]}
                onChange={preset => preset !== "keep" && set("particles", preset === "none" ? undefined : particlePreset3D(preset as ParticlePreset3D), false)} />
            {emitter && <>
                <Num name="Rate per second" value={emitter.rate} min={0.001} max={2000} onChange={rate => emitterPatch({ rate })} />
                <Num name="Lifetime seconds" value={emitter.lifetime} min={0.05} max={60} onChange={lifetime => emitterPatch({ lifetime })} />
                <Num name="Max particles" value={emitter.maxParticles ?? Math.min(PARTICLES_PER_EMITTER_MAX, Math.ceil(emitter.rate * emitter.lifetime))}
                    min={1} max={PARTICLES_PER_EMITTER_MAX} onChange={max => emitterPatch({ maxParticles: Math.round(max) })} />
                <Num name="Spread" value={emitter.spread} min={0} max={1000} onChange={spread => emitterPatch({ spread })} />
                <Num name="Turbulence" value={emitter.turbulence} min={0} max={100} onChange={turbulence => emitterPatch({ turbulence })} />
                <Color name="Velocity" value={emitter.velocity} onChange={velocity => emitterPatch({ velocity })} />
                <Num name="Gravity Y" value={emitter.gravity.y} min={-1e6} max={1e6} onChange={y => emitterPatch({ gravity: { ...emitter.gravity, y } })} />
                <Num name="Wind X" value={emitter.wind.x} min={-1e6} max={1e6} onChange={x => emitterPatch({ wind: { ...emitter.wind, x } })} />
                <Num name="Size start" value={emitter.sizeStart} min={0.0001} max={1000} onChange={sizeStart => emitterPatch({ sizeStart })} />
                <Num name="Size end" value={emitter.sizeEnd} min={0.0001} max={1000} onChange={sizeEnd => emitterPatch({ sizeEnd })} />
                <Color name="Color start" value={emitter.colorStart} onChange={colorStart => emitterPatch({ colorStart })} />
                <Color name="Color end" value={emitter.colorEnd} onChange={colorEnd => emitterPatch({ colorEnd })} />
                <Num name="Alpha start" value={emitter.alphaStart} min={0} max={1} onChange={alphaStart => emitterPatch({ alphaStart })} />
                <Num name="Alpha end" value={emitter.alphaEnd} min={0} max={1} onChange={alphaEnd => emitterPatch({ alphaEnd })} />
                <Choice name="Blending" value={emitter.blend} options={["alpha", "additive"] as const} onChange={blend => emitterPatch({ blend })} />
                <Choice name="Sprite" value={emitter.shape} options={["soft", "sparkle"] as const} onChange={shape => emitterPatch({ shape })} />
            </>}
        </Section>
        <Section title="Light string">
            <Toggle name="Light string" checked={!!strand} onChange={on => set("lightString", on ? defaultLightString3D() : undefined, false)} />
            {strand && <>
                <label style={label}>Clip points (local x y z; ...)
                    <textarea aria-label="Clip points" value={pointsText} rows={3} style={field} onChange={event => {
                        setPointsText(event.target.value);
                        const points = parseStrandPoints3D(event.target.value);
                        if (points) strandPatch({ points });
                    }} />
                </label>
                <Toggle name="Closed loop" checked={!!strand.closed} onChange={closed => strandPatch({ closed })} />
                <Choice name="Bulb style" value={strand.bulbStyle} options={["c9", "c7", "mini"] as const} onChange={bulbStyle => strandPatch({ bulbStyle })} />
                <Choice name="Bulb aim" value={strand.bulbAim} options={["down", "up", "out", "radial"] as const} onChange={bulbAim => strandPatch({ bulbAim })} />
                <Num name="Bulb spacing" value={strand.bulbSpacing} min={0.02} max={100} onChange={bulbSpacing => strandPatch({ bulbSpacing })} />
                <Num name="Sag" value={strand.sag} min={0} max={0.5} onChange={sag => strandPatch({ sag })} />
                <Num name="Tilt degrees" value={strand.tilt} min={0} max={45} onChange={tilt => strandPatch({ tilt })} />
                <Num name="Bulb intensity" value={strand.intensity} min={0} max={1e6} onChange={intensity => strandPatch({ intensity })} />
                <Num name="Bulb range" value={strand.range} min={0.001} max={1e6} onChange={range => strandPatch({ range })} />
                <Color name="Wire color" value={strand.wireColor} onChange={wireColor => strandPatch({ wireColor })} />
                <span style={label}>{strand.colors.length}-color pattern, cycled bulb by bulb.</span>
            </>}
        </Section>
    </>;
}