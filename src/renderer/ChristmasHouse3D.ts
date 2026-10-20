/**
 * @module ChristmasHouse3D
 * @description Procedural night demo for the many-light, fog and particle renderer: a stylized
 * house (walls, gables, roof with fascia, rake and ridge boards, chimney, trimmed windows, door,
 * porch), a tiered tree, snowy ground, a moon and stars, falling snow, chimney smoke, tree
 * sparkles and a light exp2 + height night haze.
 *
 * The Christmas lights are LightString3D strands built by LightStrings3D, the same generator the
 * document and player use: each is clipped to a real surface (fascia bottom edge, rake board
 * underside, ridge cap top, window and door trim faces, the tree's cone surface) with a few
 * millimetres of offset, sags only between clips, and gives every bulb a real point light.
 *
 * In-fog glow around bulbs and windows is FAKE: additive sprites from the renderer's fog glow
 * pass (fog.lightGlow), not volumetric scattering or bloom.
 */

import type { Draw3D, Frame3D, FrameLight3D, Mat4 } from "./Scene3D";
import { directionalShadowFrame3D, invertMat4, projectionMatrix3D } from "./Scene3D";
import type { Fog3D, LightString3D, ParticleEmitter3D } from "../core/document/Effects3D";
import { CLASSIC_BULB_COLORS_3D, particlePreset3D, SCENE_PARTICLES_MAX } from "../core/document/Effects3D";
import { add3, cross3, meshDraw3D as draw, MeshBuilder3D as MeshBuilder, norm3 as norm, scale3 as scale, sub3 as sub, type V3 } from "./MeshBuilder3D";
import { buildLightString3D, type LightStringBuild3D } from "./LightStrings3D";
import { sampleParticles3D, type ParticleBatch3D } from "./Particles3D";

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Local +z faces world +x (the right wall); local (x, y, z) maps to world (z, y, -x). */
const FACING_RIGHT: Mat4 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
const v = (p: V3) => ({ x: p[0], y: p[1], z: p[2] });

/** Linear RGB pattern, shared with the document's classic strand colors. */
export const BULB_COLORS_3D: readonly V3[] = CLASSIC_BULB_COLORS_3D.map(c => [c.x, c.y, c.z] as V3);
export const BULB_INTENSITY_3D = 0.1;
export const BULB_RANGE_3D = 1.4;

/** Key house dimensions the strands snap to. */
export const HOUSE_3D = {
    /** Roof eave edge (x = +-eaveX, y = eaveY) and gable edge z = +-roofZ. */
    eaveX: 4.5, eaveY: 2.8, ridgeY: 5.4, roofZ: 3.5,
    fasciaDepth: 0.08, fasciaHeight: 0.18,
    ridgeCapTop: 5.48,
    wallFront: 3.0, trimFront: 3.1,
    tree: { x: 7.2, z: 1.6, tiers: [[0.8, 1.9, 2.2], [2.2, 1.45, 1.9], [3.5, 0.95, 1.8]] as const }
} as const;

/** Clip offset off a surface: touching, not floating. */
const GAP = 0.006;

/** Outer radius of the tiered tree's foliage at height y (0 above the top or below the lowest tier). */
export function treeRadius3D(y: number): number {
    let r = 0;
    for (const [base, radius, height] of HOUSE_3D.tree.tiers) {
        if (y >= base && y <= base + height) r = Math.max(r, radius * (1 - (y - base) / height));
    }
    return r;
}

function strand(points: V3[], options: Partial<LightString3D> = {}): LightString3D {
    return { points: points.map(v), bulbSpacing: 0.25, sag: 0.05, colors: CLASSIC_BULB_COLORS_3D.map(c => ({ ...c })),
        bulbStyle: "c9", bulbAim: "down", tilt: 12, intensity: BULB_INTENSITY_3D, range: BULB_RANGE_3D,
        wireColor: { x: 0.015, y: 0.05, z: 0.02 }, ...options };
}

const between = (a: V3, b: V3, count: number): V3[] =>
    Array.from({ length: count + 1 }, (_, i) => add3(a, scale(sub(b, a), i / count)));

export interface HouseStrand3D { name: string; strand: LightString3D; model: Mat4 }

/** Every strand, snapped to the surfaces built in christmasHouseScene3D. */
export function christmasHouseStrands3D(): HouseStrand3D[] {
    const { eaveX, eaveY, ridgeY, roofZ, fasciaDepth, fasciaHeight, ridgeCapTop, trimFront, tree } = HOUSE_3D;
    const out: HouseStrand3D[] = [];
    // Side eaves: along the fascia's bottom outer edge, clips every ~0.7 m, bulbs hanging down.
    const fasciaBottom = eaveY - fasciaHeight - GAP;
    for (const side of [1, -1]) {
        const x = side * (eaveX + GAP);
        out.push({ name: side > 0 ? "eave-right" : "eave-left", model: IDENTITY,
            strand: strand(between([x, fasciaBottom, -roofZ + 0.1], [x, fasciaBottom, roofZ - 0.1], 10)) });
    }
    // Front rakes: under the rake board's lower front edge, following the slope over the peak.
    const run = eaveX, rise = ridgeY - eaveY, slope = Math.hypot(run, rise);
    const drop = fasciaHeight + GAP, nx = rise / slope, ny = run / slope;
    const z = roofZ + fasciaDepth / 2 - 0.02;
    const left: V3 = [-eaveX + nx * drop, eaveY - ny * drop, z], peak: V3 = [0, ridgeY - drop / ny, z];
    const right: V3 = [eaveX - nx * drop, eaveY - ny * drop, z];
    out.push({ name: "rakes", model: IDENTITY, strand: strand([...between(left, peak, 7), ...between(peak, right, 7).slice(1)]) });
    // Ridge: lying on top of the ridge cap, bulbs pointing up, no sag.
    out.push({ name: "ridge", model: IDENTITY, strand: strand(between([0, ridgeCapTop + GAP, roofZ - 0.1], [0, ridgeCapTop + GAP, -roofZ + 0.1], 8),
        { bulbAim: "up", sag: 0, bulbSpacing: 0.3, tilt: 8 }) });
    // Windows and door: on the trim faces, bulbs pointing out of the wall.
    const frame = (x0: number, x1: number, y0: number, y1: number, zf: number): V3[] =>
        [...between([x0, y0, zf], [x1, y0, zf], 3), ...between([x1, y0, zf], [x1, y1, zf], 2).slice(1),
            ...between([x1, y1, zf], [x0, y1, zf], 3).slice(1), ...between([x0, y1, zf], [x0, y0, zf], 2).slice(1, -1)];
    const mini = { bulbStyle: "mini" as const, bulbAim: "out" as const, bulbSpacing: 0.11, sag: 0.03, tilt: 10, intensity: 0.03, range: 0.8 };
    out.push({ name: "window-left", model: IDENTITY, strand: strand(frame(-3.35, -1.45, 1.05, 2.55, trimFront + GAP), { ...mini, closed: true }) });
    out.push({ name: "window-right", model: IDENTITY, strand: strand(frame(1.45, 3.35, 1.05, 2.55, trimFront + GAP), { ...mini, closed: true }) });
    // Right-wall window, authored in a node rotated so local +z faces world +x.
    out.push({ name: "window-side", model: FACING_RIGHT, strand: strand(frame(-1.05, 1.05, 1.05, 2.55, 4.1 + GAP), { ...mini, closed: true }) });
    out.push({ name: "door", model: IDENTITY, strand: strand([...between([-0.75, 0.3, trimFront + GAP], [-0.75, 2.35, trimFront + GAP], 3),
        ...between([-0.75, 2.35, trimFront + GAP], [0.75, 2.35, trimFront + GAP], 2).slice(1),
        ...between([0.75, 2.35, trimFront + GAP], [0.75, 0.3, trimFront + GAP], 3).slice(1)],
    { bulbStyle: "c7", bulbAim: "out", bulbSpacing: 0.16, sag: 0.04 }) });
    // Tree: a spiral hooked to the cone surface; the wire sits a touch inside the foliage so bulbs
    // aimed radially sit on it. The node origin is the trunk axis so radial means "out of the tree".
    const points: V3[] = [];
    const y0 = 1.0, y1 = 5.05, turns = 5.5;
    for (let a = 0; a <= turns * Math.PI * 2; a += 0.38) {
        const y = y0 + (y1 - y0) * a / (turns * Math.PI * 2), r = Math.max(0.08, treeRadius3D(y) - 0.012);
        points.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    out.push({ name: "tree", model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tree.x, 0, tree.z, 1],
        strand: strand(points, { bulbAim: "radial", bulbStyle: "c7", bulbSpacing: 0.2, sag: 0.04, tilt: 15 }) });
    return out;
}

export interface Bulb3D { position: V3; color: number }

export interface HouseEmitter3D { name: string; emitter: ParticleEmitter3D; model: Mat4 }

export interface ChristmasHouseScene3D {
    draws: Draw3D[];
    lights: FrameLight3D[];
    bulbs: Bulb3D[];
    strands: (HouseStrand3D & { build: LightStringBuild3D })[];
    fog: Fog3D;
    emitters: HouseEmitter3D[];
}

export function christmasHouseFog3D(): Fog3D {
    return { mode: "exp2", color: { x: 0.03, y: 0.04, z: 0.075 }, density: 0.012, start: 5, end: 80,
        heightDensity: 0.1, heightBase: 0, heightFalloff: 0.45, skyBlend: 0.55, lightGlow: 1 };
}

const translate = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export function christmasHouseEmitters3D(): HouseEmitter3D[] {
    return [
        { name: "snow", emitter: particlePreset3D("snowfall"), model: translate(2, 9, 2) },
        { name: "chimney-smoke", emitter: particlePreset3D("chimney-smoke"), model: translate(2.4, 6.3, -1.2) },
        { name: "tree-sparkles", emitter: particlePreset3D("sparkles"), model: translate(HOUSE_3D.tree.x, 4.3, HOUSE_3D.tree.z) }
    ];
}

/** Camera-independent scene: geometry, strands with their bulb lights, window glow, fog, emitters. */
export function christmasHouseScene3D(): ChristmasHouseScene3D {
    const { eaveX, eaveY, ridgeY, roofZ, fasciaDepth, fasciaHeight } = HOUSE_3D;
    const ground = new MeshBuilder().quad([-30, 0, 30], [30, 0, 30], [30, 0, -30], [-30, 0, -30]);
    const walls = new MeshBuilder().box([-4, 0, -3], [4, 3, 3])
        .tri([-4, 3, 3], [4, 3, 3], [0, 5.2, 3]).tri([4, 3, -3], [-4, 3, -3], [0, 5.2, -3]);
    const roof = new MeshBuilder()
        .quad([-eaveX, eaveY, roofZ], [0, ridgeY, roofZ], [0, ridgeY, -roofZ], [-eaveX, eaveY, -roofZ])
        .quad([eaveX, eaveY, -roofZ], [0, ridgeY, -roofZ], [0, ridgeY, roofZ], [eaveX, eaveY, roofZ]);
    const snowCap = new MeshBuilder()
        .quad([-3.0, 3.69, roofZ], [0, 5.43, roofZ], [0, 5.43, -roofZ], [-3.0, 3.69, -roofZ])
        .quad([3.0, 3.69, -roofZ], [0, 5.43, -roofZ], [0, 5.43, roofZ], [3.0, 3.69, roofZ]);
    // Boards the lights clip to: side fascia, front and back rake boards, ridge cap.
    const boards = new MeshBuilder();
    for (const side of [1, -1]) {
        const x = side * (eaveX - fasciaDepth / 2);
        boards.beam([x, eaveY - fasciaHeight / 2, -roofZ], [x, eaveY - fasciaHeight / 2, roofZ], fasciaDepth, fasciaHeight);
    }
    const run = eaveX, rise = ridgeY - eaveY, slope = Math.hypot(run, rise), nx = rise / slope, ny = run / slope;
    const half = fasciaHeight / 2;
    for (const zf of [roofZ - fasciaDepth / 2 + 0.02, -roofZ + fasciaDepth / 2 - 0.02]) {
        boards.beam([-eaveX + nx * half, eaveY - ny * half, zf], [0, ridgeY - half / ny, zf], fasciaDepth, fasciaHeight);
        boards.beam([0, ridgeY - half / ny, zf], [eaveX - nx * half, eaveY - ny * half, zf], fasciaDepth, fasciaHeight);
    }
    boards.box([-0.09, ridgeY - 0.02, -roofZ - 0.02], [0.09, HOUSE_3D.ridgeCapTop, roofZ + 0.02]);
    const trim = new MeshBuilder()
        .box([-3.4, 1.0, 3.0], [-1.4, 1.1, 3.1]).box([-3.4, 2.5, 3.0], [-1.4, 2.6, 3.1])
        .box([-3.4, 1.1, 3.0], [-3.3, 2.5, 3.1]).box([-1.5, 1.1, 3.0], [-1.4, 2.5, 3.1])
        .box([1.4, 1.0, 3.0], [3.4, 1.1, 3.1]).box([1.4, 2.5, 3.0], [3.4, 2.6, 3.1])
        .box([1.4, 1.1, 3.0], [1.5, 2.5, 3.1]).box([3.3, 1.1, 3.0], [3.4, 2.5, 3.1])
        .box([-2.45, 1.1, 3.0], [-2.35, 2.5, 3.08]).box([2.35, 1.1, 3.0], [2.45, 2.5, 3.08])
        .box([4.0, 1.0, -1.1], [4.1, 1.1, 1.1]).box([4.0, 2.5, -1.1], [4.1, 2.6, 1.1])
        .box([4.0, 1.1, -1.1], [4.1, 2.5, -1.0]).box([4.0, 1.1, 1.0], [4.1, 2.5, 1.1])
        .box([-0.8, 0, 3.0], [-0.7, 2.4, 3.1]).box([0.7, 0, 3.0], [0.8, 2.4, 3.1]).box([-0.8, 2.3, 3.0], [0.8, 2.4, 3.1])
        .box([-1.2, 0, 3.0], [1.2, 0.18, 3.9]);
    const glass = new MeshBuilder()
        .quad([-3.3, 1.1, 3.02], [-1.5, 1.1, 3.02], [-1.5, 2.5, 3.02], [-3.3, 2.5, 3.02])
        .quad([1.5, 1.1, 3.02], [3.3, 1.1, 3.02], [3.3, 2.5, 3.02], [1.5, 2.5, 3.02])
        .quad([4.02, 1.1, 1.0], [4.02, 1.1, -1.0], [4.02, 2.5, -1.0], [4.02, 2.5, 1.0]);
    const door = new MeshBuilder().box([-0.7, 0, 2.98], [0.7, 2.3, 3.06]);
    const chimney = new MeshBuilder().box([2.0, 3.6, -1.6], [2.8, 6.2, -0.8]);
    const trunk = new MeshBuilder().box([7.0, 0, 1.4], [7.4, 0.9, 1.8]);
    const tree = new MeshBuilder();
    for (const [base, radius, height] of HOUSE_3D.tree.tiers) tree.cone([HOUSE_3D.tree.x, base, HOUSE_3D.tree.z], radius, height, 18);
    const star = new MeshBuilder().sphere([7.2, 5.45, 1.6], 0.2, 8, 5);
    const moon = new MeshBuilder().sphere([-22, 26, -55], 3.2, 16, 10);
    const stars = new MeshBuilder();
    let seed = 7;
    const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 260; i++) {
        const azimuth = random() * Math.PI * 2, elevation = 0.12 + random() * 1.3;
        const d: V3 = [Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)];
        stars.sphere(scale(d, 90), 0.12 + random() * 0.18, 4, 2);
    }
    const draws: Draw3D[] = [
        draw("snow", ground.primitive(), [0.86, 0.9, 0.98, 1], { roughness: 0.95 }),
        draw("walls", walls.primitive(), [0.72, 0.6, 0.46, 1]),
        draw("roof", roof.primitive(), [0.32, 0.09, 0.08, 1], { roughness: 0.7 }),
        draw("roof-snow", snowCap.primitive(), [0.9, 0.93, 1, 1], { roughness: 0.95 }),
        draw("roof-boards", boards.primitive(), [0.9, 0.88, 0.84, 1], { roughness: 0.8 }),
        draw("trim", trim.primitive(), [0.92, 0.9, 0.86, 1]),
        draw("windows", glass.primitive(), [0.05, 0.04, 0.02, 1], { emissive: [0.9, 0.55, 0.18], roughness: 0.2 }),
        draw("door", door.primitive(), [0.05, 0.22, 0.1, 1], { roughness: 0.5 }),
        draw("chimney", chimney.primitive(), [0.42, 0.14, 0.1, 1]),
        draw("trunk", trunk.primitive(), [0.25, 0.14, 0.07, 1]),
        draw("tree", tree.primitive(), [0.04, 0.28, 0.1, 1], { roughness: 0.9 }),
        draw("tree-star", star.primitive(), [0.1, 0.08, 0, 1], { emissive: [1, 0.85, 0.2] }),
        draw("moon", moon.primitive(), [0.92, 0.94, 1, 1], { unlit: true }),
        draw("stars", stars.primitive(), [0.85, 0.88, 1, 1], { unlit: true })
    ];
    const lights: FrameLight3D[] = [
        { kind: "directional", color: [0.45, 0.55, 0.9], intensity: 0.22, direction: norm([0.35, -0.55, 0.75]) },
        // Warm light spilling out of the lit windows.
        ...([[-2.4, 1.8, 3.35], [2.4, 1.8, 3.35], [4.35, 1.8, 0]] as V3[]).map((position): FrameLight3D =>
            ({ kind: "point", color: [1, 0.62, 0.25], intensity: 0.2, range: 2.4, position }))
    ];
    const bulbs: Bulb3D[] = [];
    const strands = christmasHouseStrands3D().map(s => {
        const build = buildLightString3D(s.strand, s.model, `lights-${s.name}`);
        draws.push(...build.draws);
        lights.push(...build.lights);
        bulbs.push(...build.bulbs.map(b => ({ position: b.position, color: b.color })));
        return { ...s, build };
    });
    return { draws, lights, bulbs, strands, fog: christmasHouseFog3D(), emitters: christmasHouseEmitters3D() };
}

/** Particle batches at a time, within the scene particle cap. */
export function christmasHouseParticles3D(scene: ChristmasHouseScene3D, seconds: number): ParticleBatch3D[] {
    let budget = SCENE_PARTICLES_MAX;
    return scene.emitters.map(e => {
        const batch = sampleParticles3D(e.emitter, e.model, seconds, e.name, budget);
        budget -= batch.count;
        return batch;
    });
}

export interface ChristmasHouseView3D { eye: V3; target: V3; fovDegrees: number }
export const CHRISTMAS_HOUSE_VIEWS_3D: Readonly<Record<"front" | "corner" | "eave", ChristmasHouseView3D>> = {
    front: { eye: [1.8, 3.4, 17.5], target: [1.6, 2.7, 0], fovDegrees: 48 },
    corner: { eye: [6.4, 2.3, 8.6], target: [1.6, 2.9, 1.4], fovDegrees: 50 },
    eave: { eye: [5.65, 2.35, 4.75], target: [4.35, 2.68, 3.15], fovDegrees: 42 }
};

/** A ready Frame3D for one view at a time (seconds) for the particles; fog off when fog is false. */
export function christmasHouseFrame3D(scene: ChristmasHouseScene3D, view: ChristmasHouseView3D, aspect: number,
                                      seconds = 12, fog = true): Frame3D {
    const back = norm(sub(view.eye, view.target)), right = norm(cross3([0, 1, 0], back)), up = cross3(back, right);
    const cameraWorld = [...right, 0, ...up, 0, ...back, 0, ...view.eye, 1];
    const casters = scene.draws.filter(d => d.nodeId !== "moon" && d.nodeId !== "stars" && d.emissive.every(e => e === 0));
    const fitted = casters.map(d => d.nodeId === "snow"
        ? { ...d, primitive: new MeshBuilder().quad([-12, 0, 12], [12, 0, 12], [12, 0, -12], [-12, 0, -12]).primitive() } : d);
    return {
        view: invertMat4(cameraWorld)!, diagnostics: [],
        projection: projectionMatrix3D({ kind: "perspective", near: 0.05, far: 200, verticalFovDegrees: view.fovDegrees }, aspect),
        draws: scene.draws, lights: scene.lights, cameraNodeId: null, cameraPosition: view.eye, worlds: new Map(), environment: null,
        shadow: directionalShadowFrame3D(fitted, scene.lights),
        fog: fog ? scene.fog : null,
        particles: christmasHouseParticles3D(scene, seconds)
    };
}