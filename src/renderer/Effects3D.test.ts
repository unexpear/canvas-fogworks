/**
 * @module Effects3DTest
 * @description Schema 91 fog, particle emitter and light string contracts: validation and the 90 -> 91
 * migration, fog math, deterministic emitter simulation, strand geometry and lights, the document
 * to frame path, and the Christmas house demo's snapping.
 */

import { createEmptyDocument, SCHEMA_VERSION } from "../core/document/Document";
import { Node } from "../core/document/Node";
import { deserializeDocument, migrateIfNeeded, serializeDocument } from "../core/document/Serializer";
import { spatial3DError } from "../core/document/Spatial3D";
import { copyEffects3D, defaultFog3D, defaultLightString3D, fog3DError, lightString3DError, PARTICLE_PRESETS_3D,
    particlePreset3D, particles3DError, PARTICLES_PER_EMITTER_MAX, type Fog3D, type ParticleEmitter3D } from "../core/document/Effects3D";
import { applyFog3D, distanceFog3D, fogAmount3D, fogBackground3D, heightFog3D } from "./Fog3D";
import { fogGlowBatch3D, particleCapacity3D, particleSlot3D, sampleParticles3D } from "./Particles3D";
import { buildLightString3D, lightStringWire3D } from "./LightStrings3D";
import { buildFrame3D, captureFrame3D, type Frame3D } from "./Scene3D";
import { meshDraw3D, MeshBuilder3D } from "./MeshBuilder3D";
import { webGL3DParticleShaderSources, webGL3DShaderSources } from "./emitWebGL3D";
import { christmasHouseFrame3D, christmasHouseScene3D, CHRISTMAS_HOUSE_VIEWS_3D, HOUSE_3D, treeRadius3D } from "./ChristmasHouse3D";

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fog = (over: Partial<Fog3D> = {}): Fog3D => ({ ...defaultFog3D(), heightDensity: 0, ...over });

function node(id: string, x = 0, y = 0, z = 0): Node {
    return { id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 1, height: 1 },
        style: { fill: "none", opacity: 1 }, layout: {},
        spatial3d: { transform: { position: { x, y, z }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } } };
}

function effectsDocument() {
    const doc = createEmptyDocument();
    const camera = node("camera", 0, 1, 10);
    camera.spatial3d!.camera = { kind: "perspective", near: 0.1, far: 100, verticalFovDegrees: 50 };
    const haze = node("haze"); haze.spatial3d!.fog = defaultFog3D();
    const snow = node("snow", 0, 6, 0); snow.spatial3d!.particles = particlePreset3D("snowfall");
    const lights = node("lights", 0, 2, 0); lights.spatial3d!.lightString = defaultLightString3D();
    for (const n of [camera, haze, snow, lights]) { doc.nodes.set(n.id, n); doc.rootNodeUuids.push(n.id); }
    return doc;
}

describe("schema 91 effect contracts", () => {
    test("defaults and presets validate; bad values are named", () => {
        expect(fog3DError(defaultFog3D())).toBeNull();
        for (const preset of PARTICLE_PRESETS_3D) expect(particles3DError(particlePreset3D(preset))).toBeNull();
        expect(lightString3DError(defaultLightString3D())).toBeNull();
        expect(fog3DError({ ...defaultFog3D(), start: 10, end: 5 })).toMatch(/end/);
        expect(fog3DError({ ...defaultFog3D(), mode: "fast" })).toMatch(/mode/);
        expect(particles3DError({ ...particlePreset3D("sparkles"), maxParticles: PARTICLES_PER_EMITTER_MAX + 1 })).toMatch(/maxParticles/);
        expect(particles3DError({ ...particlePreset3D("sparkles"), blend: "multiply" })).toMatch(/blend/);
        expect(lightString3DError({ ...defaultLightString3D(), points: [{ x: 0, y: 0, z: 0 }] })).toMatch(/points/);
        expect(lightString3DError({ ...defaultLightString3D(), bulbStyle: "sphere" })).toMatch(/bulbStyle/);
        expect(lightString3DError({ ...defaultLightString3D(), sag: 0.9 })).toMatch(/sag/);
        const spatial = node("n").spatial3d!;
        expect(spatial3DError({ ...spatial, fog: { ...defaultFog3D(), density: -1 } })).toMatch(/fog\.density/);
        expect(spatial3DError({ ...spatial, particles: particlePreset3D("snowfall"), lightString: defaultLightString3D() })).toBeNull();
    });

    test("90 -> 91 is a no-op stamp and the new fields round-trip", () => {
        expect(SCHEMA_VERSION).toBe("91");
        const raw = JSON.parse(serializeDocument(createEmptyDocument()));
        const migrated = migrateIfNeeded({ ...raw, version: "90" });
        expect(migrated.version).toBe("91");
        expect({ ...migrated, version: raw.version }).toEqual(raw);
        const doc = effectsDocument();
        const back = deserializeDocument(serializeDocument(doc));
        for (const id of ["haze", "snow", "lights"]) expect(back.nodes.get(id)!.spatial3d).toEqual(doc.nodes.get(id)!.spatial3d);
        const copy = copyEffects3D(defaultLightString3D());
        copy.points[0].x = 99;
        expect(defaultLightString3D().points[0].x).toBe(-1);
    });
});

describe("fog math", () => {
    test("linear, exp and exp2 distance curves", () => {
        const linear = fog({ mode: "linear", start: 10, end: 30 });
        expect(distanceFog3D(linear, 5)).toBe(0);
        expect(distanceFog3D(linear, 20)).toBeCloseTo(0.5);
        expect(distanceFog3D(linear, 40)).toBe(1);
        expect(distanceFog3D(fog({ mode: "exp", density: 0.1 }), 10)).toBeCloseTo(1 - Math.exp(-1));
        expect(distanceFog3D(fog({ mode: "exp2", density: 0.1 }), 20)).toBeCloseTo(1 - Math.exp(-4));
        expect(distanceFog3D(fog({ mode: "exp2", density: 0.1 }), 5)).toBeLessThan(distanceFog3D(fog({ mode: "exp", density: 0.1 }), 5));
    });

    test("height fog integrates density along the ray and thins upward", () => {
        const h = fog({ density: 0, heightDensity: 0.2, heightBase: 0, heightFalloff: 0.5 });
        expect(heightFog3D(fog(), [0, 0, 0], [10, 0, 0])).toBe(0);
        // Level ray at the base: constant density.
        expect(heightFog3D(h, [0, 0, 0], [10, 0, 0])).toBeCloseTo(1 - Math.exp(-2));
        // Same length, but rising into thinner air.
        const rising = heightFog3D(h, [0, 0, 0], [0, 10, 0]);
        expect(rising).toBeCloseTo(1 - Math.exp(-0.2 * 10 * (1 - Math.exp(-5)) / 5));
        expect(heightFog3D(h, [0, 4, 0], [10, 4, 0])).toBeLessThan(heightFog3D(h, [0, 0, 0], [10, 0, 0]));
        const both = fog({ mode: "exp", density: 0.05, heightDensity: 0.2, heightFalloff: 0.5 });
        const a = distanceFog3D(both, 10), b = heightFog3D(both, [0, 0, 0], [10, 0, 0]);
        expect(fogAmount3D(both, [0, 0, 0], [10, 0, 0])).toBeCloseTo(1 - (1 - a) * (1 - b));
        expect(fogAmount3D(null, [0, 0, 0], [10, 0, 0])).toBe(0);
    });

    test("colors mix toward the fog color, the sky by skyBlend, and both shaders carry the same fog", () => {
        const f = fog({ color: { x: 0, y: 0, z: 1 } });
        expect(applyFog3D([1, 1, 1], f, 0.25)).toEqual([0.75, 0.75, 1]);
        expect(fogBackground3D([0.1, 0.2, 0.3, 1], { ...f, skyBlend: 0 })).toEqual([0.1, 0.2, 0.3, 1]);
        expect(fogBackground3D([0.1, 0.2, 0.3, 1], { ...f, skyBlend: 1 })).toEqual([0, 0, 1, 1]);
        for (const source of [webGL3DShaderSources(true, 16, true).fragment, webGL3DShaderSources(false, 4).fragment,
            webGL3DParticleShaderSources().fragment]) {
            expect(source).toContain("float fogAmount(vec3 worldPosition)");
            expect(source).toContain("clamp(-t, -10.0, 10.0)");
        }
        expect(webGL3DShaderSources(false, 4).fragment).toContain("linearToSrgb(applyFog(base.rgb, v_worldPosition))");
    });

    test("the reference rasterizer fogs distant geometry toward the fog color", () => {
        const quad = new MeshBuilder3D().quad([-50, -50, -40], [50, -50, -40], [50, 50, -40], [-50, 50, -40]).primitive();
        const frame = (fogged: Frame3D["fog"]): Frame3D => ({ view: I, projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.002, -1, 0, 0, -0.2, 0],
            draws: [meshDraw3D("wall", quad, [1, 1, 1, 1], { unlit: true })], lights: [], cameraNodeId: null, cameraPosition: [0, 0, 0],
            worlds: new Map(), environment: null, shadow: null, fog: fogged });
        const clear = captureFrame3D(frame(null), 4, 4).rgba[0];
        const hazy = captureFrame3D(frame(fog({ mode: "exp", density: 0.05, color: { x: 0, y: 0, z: 0 } })), 4, 4).rgba[0];
        expect(clear).toBe(255);
        expect(hazy).toBeLessThan(255 * Math.exp(-0.05 * 40) + 2);
    });
});

describe("particle emitters", () => {
    const plain: ParticleEmitter3D = { ...particlePreset3D("sparkles"), rate: 10, lifetime: 2, boxHalfExtents: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 }, spread: 0, gravity: { x: 0, y: -2, z: 0 }, wind: { x: 0.5, y: 0, z: 0 }, turbulence: 0,
        sizeStart: 1, sizeEnd: 3, colorStart: { x: 1, y: 0, z: 0 }, colorEnd: { x: 0, y: 0, z: 1 }, alphaStart: 1, alphaEnd: 0.5 };

    test("capacity follows rate x lifetime under the caps", () => {
        expect(particleCapacity3D(plain)).toBe(20);
        expect(particleCapacity3D({ ...plain, maxParticles: 5 })).toBe(5);
        expect(particleCapacity3D({ ...plain, rate: 2000, lifetime: 60 })).toBe(PARTICLES_PER_EMITTER_MAX);
    });

    test("closed-form motion: gravity, wind, lifetime, size and color over life", () => {
        const p = particleSlot3D(plain, I, 1.5, 0)!;
        expect(p.age).toBeCloseTo(1.5);
        expect(p.position[0]).toBeCloseTo(0.75);
        expect(p.position[1]).toBeCloseTo(-0.5 * 2 * 1.5 * 1.5);
        expect(p.size / (1 + 2 * 0.75)).toBeGreaterThanOrEqual(0.75);
        expect(p.color[2]).toBeCloseTo(0.75);
        expect(p.color[3]).toBeCloseTo(1 - 0.5 * 0.75);
        for (let t = 0; t < 10; t += 0.37) for (let i = 0; i < 20; i++) {
            const s = particleSlot3D(plain, I, t, i);
            if (s) expect(s.age).toBeLessThan(plain.lifetime);
        }
        // Prewarmed: a slot is already mid-life at t = 0; with spare slots it waits between lives.
        expect(particleSlot3D(plain, I, 0.05, 5)!.age).toBeCloseTo(1.55);
        expect(particleSlot3D({ ...plain, maxParticles: 40 }, I, 2.5, 0)).toBeNull();
    });

    test("deterministic, prewarmed, translated by the node and bounded by the budget", () => {
        const snow = particlePreset3D("snowfall"), at = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 10, 0, 1];
        const a = sampleParticles3D(snow, at, 30, "snow"), b = sampleParticles3D(snow, at, 30, "snow");
        expect(Array.from(a.centers)).toEqual(Array.from(b.centers));
        expect(a.count).toBeGreaterThan(particleCapacity3D(snow) * 0.9);
        for (let i = 0; i < a.count; i++) expect(a.centers[i * 3 + 1]).toBeLessThanOrEqual(10.5 + 0.01);
        expect(sampleParticles3D(snow, at, 30, "snow", 10).count).toBeLessThanOrEqual(10);
        expect(Array.from(sampleParticles3D(snow, at, 31, "snow").centers)).not.toEqual(Array.from(a.centers));
    });

    test("fog glow sprites are one additive sprite per point light, only in fog", () => {
        const lights = [{ kind: "point" as const, color: [1, 0, 0] as const, intensity: 0.1, range: 1, position: [0, 1, 0] as const },
            { kind: "directional" as const, color: [1, 1, 1] as const, intensity: 1, direction: [0, -1, 0] as const }];
        expect(fogGlowBatch3D(lights, null)).toBeNull();
        expect(fogGlowBatch3D(lights, { ...defaultFog3D(), lightGlow: 0 })).toBeNull();
        const glow = fogGlowBatch3D(lights, defaultFog3D())!;
        expect(glow.count).toBe(1);
        expect(glow.blend).toBe("additive");
    });
});

describe("light strings", () => {
    test("the wire sags only between clips, most on level spans and not at all on vertical ones", () => {
        const wire = lightStringWire3D([[0, 0, 0], [2, 0, 0], [2, -2, 0]], 0.1, 0.5);
        expect(wire[0]).toEqual([0, 0, 0]);
        expect(wire).toContainEqual([2, 0, 0]);
        expect(Math.min(...wire.slice(0, 5).map(p => p[1]))).toBeCloseTo(-0.2);
        for (const p of wire.slice(5)) expect(p[0]).toBeCloseTo(2);
    });

    test("bulbs, sockets, clips and one light per bulb, from the node's world transform", () => {
        const strand = { ...defaultLightString3D(), points: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }], sag: 0, bulbSpacing: 0.25 };
        const at = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
        const built = buildLightString3D(strand, at, "s");
        expect(built.bulbs).toHaveLength(12);
        expect(built.lights).toHaveLength(12);
        expect(built.clips).toEqual([[1, 2, 3], [4, 2, 3]]);
        expect(built.draws).toHaveLength(1 + strand.colors.length);
        expect(built.draws.every(d => d.nodeId === "s")).toBe(true);
        expect(built.draws.slice(1).every(d => Math.max(...d.emissive) > 0.5)).toBe(true);
        built.bulbs.forEach((bulb, i) => {
            expect(bulb.color).toBe(i % strand.colors.length);
            expect(bulb.position[0]).toBeCloseTo(1 + 0.125 + i * 0.25, 1);
            // Hanging down from the wire, tilted alternately by the authored angle.
            expect(bulb.position[1]).toBeLessThan(2 - 0.04);
            expect(-bulb.axis[1]).toBeCloseTo(Math.cos(12 * Math.PI / 180));
            expect(Math.sign(bulb.axis[2])).toBe(i % 2 === 0 ? -1 : 1);
        });
        // Teardrop bulbs are lathed, not spheres: taller than wide.
        const glass = built.draws[1].primitive.positions, ys: number[] = [], xs: number[] = [];
        for (let i = 0; i < glass.length; i += 3) if (Math.abs(glass[i] - built.bulbs[0].position[0]) < 0.05) { xs.push(glass[i]); ys.push(glass[i + 1]); }
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1.8 * (Math.max(...xs) - Math.min(...xs)));
        const capped = buildLightString3D(strand, at, "s", 5);
        expect(capped.bulbs).toHaveLength(5);
        expect(capped.truncated).toBe(true);
    });

    test("radial bulbs point away from the node's Y axis", () => {
        const ring = Array.from({ length: 13 }, (_, i) => ({ x: Math.cos(i / 12 * Math.PI * 2), y: 1, z: Math.sin(i / 12 * Math.PI * 2) }));
        const built = buildLightString3D({ ...defaultLightString3D(), points: ring, bulbAim: "radial", tilt: 0, sag: 0 }, I, "tree");
        for (const bulb of built.bulbs) {
            const out = Math.hypot(bulb.position[0], bulb.position[2]);
            expect(out).toBeGreaterThan(Math.hypot(bulb.socket[0], bulb.socket[2]));
            expect(Math.abs(bulb.axis[1])).toBeLessThan(1e-6);
        }
    });

    test("documents carry fog, emitters and strands into the frame", () => {
        const frame = buildFrame3D(effectsDocument(), new Map(), 320, 180, new Map(), 10);
        expect(frame.fog).toEqual(defaultFog3D());
        expect(frame.particles!.map(p => p.nodeId)).toEqual(["snow"]);
        expect(frame.particles![0].count).toBeGreaterThan(1000);
        const strandLights = frame.lights.filter(l => l.kind === "point");
        expect(strandLights.length).toBe(buildLightString3D(defaultLightString3D(), I, "x").bulbs.length);
        expect(frame.draws.filter(d => d.nodeId === "lights").length).toBeGreaterThan(1);
    });
});

describe("Christmas house demo", () => {
    const scene = christmasHouseScene3D();
    const strand = (name: string) => scene.strands.find(s => s.name === name)!;

    test("several hundred string bulbs with lights, fog, three emitters and three views", () => {
        const points = scene.lights.filter(light => light.kind === "point");
        expect(scene.bulbs.length).toBeGreaterThanOrEqual(300);
        expect(points).toHaveLength(scene.bulbs.length + 3);
        expect(scene.strands.map(s => s.name)).toEqual(expect.arrayContaining(["eave-right", "eave-left", "rakes", "ridge",
            "window-left", "window-right", "window-side", "door", "tree"]));
        for (const view of ["front", "corner", "eave"] as const) {
            const frame = christmasHouseFrame3D(scene, CHRISTMAS_HOUSE_VIEWS_3D[view], 16 / 9);
            expect(frame.fog).not.toBeNull();
            expect(frame.shadow).not.toBeNull();
            expect(frame.particles!.map(p => p.nodeId)).toEqual(["snow", "chimney-smoke", "tree-sparkles"]);
            expect(frame.particles!.every(p => p.count > 0)).toBe(true);
        }
    });

    test("eave clips sit on the fascia's bottom outer edge and bulbs hang below it", () => {
        const { eaveX, eaveY, fasciaHeight } = HOUSE_3D;
        for (const name of ["eave-right", "eave-left"]) {
            const built = strand(name).build;
            for (const clip of built.clips) {
                expect(Math.abs(Math.abs(clip[0]) - eaveX)).toBeLessThan(0.01);
                expect(Math.abs(clip[1] - (eaveY - fasciaHeight))).toBeLessThan(0.01);
            }
            for (const bulb of built.bulbs) expect(bulb.position[1]).toBeLessThan(eaveY - fasciaHeight - 0.03);
        }
    });

    test("no bulb or socket is inside the house, and tree bulbs sit on the foliage", () => {
        const { eaveX, eaveY, ridgeY, roofZ } = HOUSE_3D;
        const inside = (p: readonly number[]) => {
            if (Math.abs(p[0]) < 4 && p[1] > 0 && p[1] < 3 && Math.abs(p[2]) < 3) return true;
            const roofY = eaveY + (eaveX - Math.abs(p[0])) * (ridgeY - eaveY) / eaveX;
            return Math.abs(p[0]) < eaveX && Math.abs(p[2]) < roofZ && p[1] > 3 && p[1] < roofY;
        };
        for (const s of scene.strands) for (const bulb of s.build.bulbs) {
            expect(inside(bulb.position)).toBe(false);
            expect(inside(bulb.socket)).toBe(false);
        }
        const tree = strand("tree").build.bulbs;
        const onFoliage = tree.filter(b => {
            const r = Math.hypot(b.socket[0] - HOUSE_3D.tree.x, b.socket[2] - HOUSE_3D.tree.z);
            return Math.abs(r - treeRadius3D(b.socket[1])) < 0.06;
        });
        expect(onFoliage.length).toBeGreaterThan(tree.length * 0.85);
    });
});