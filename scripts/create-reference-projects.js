/**
 * @module create-reference-projects
 * @description Generates original, portable visual/game/animated-mesh examples into a new folder without overwriting user work.
 */
const fs = require("fs"), path = require("path"), Module = require("module"), esbuild = require("esbuild");
const root = path.join(__dirname, "..");
const bundle = esbuild.buildSync({ stdin: { resolveDir: root, contents: `
export { visualReference, gameReference } from './src/core/examples/ReferenceProjects';
export { pixelWorkshop, relayGameLevels } from './src/core/examples/AuthoringProjects';
export { animatedTriangle } from './src/core/examples/AnimatedTriangle';
export { createEmptyDocument } from './src/core/document/Document';
export { serializeDocument, deserializeDocument } from './src/core/document/Serializer';
export { IDENTITY_TRANSFORM_3D } from './src/core/document/Spatial3D';` }, bundle: true, platform: "node", format: "cjs", write: false });
const loaded = new Module(__filename, module); loaded._compile(bundle.outputFiles[0].text, __filename);
const api = loaded.exports;
const destination = path.resolve(process.argv[2] || path.join(root, "reference-projects"));
// Refuse even a previously generated folder: the user may have edited its projects since generation.
if (fs.existsSync(destination)) throw new Error("Choose a new output folder; existing examples are never overwritten.");
const animated = api.animatedTriangle(), doc = api.createEmptyDocument();
doc.metadata.project_name = "Fogworks animated triangle"; doc.metadata.date = new Date("2026-09-05T00:00:00Z");
doc.timeline = { fps: 24, frames: 48 };
doc.assets3d = [{ id: "triangle-mesh", kind: "mesh", source: "triangle.gltf", name: "Original skinned triangle" }];
const node = (id, spatial3d) => ({ id, type: "core.rectangle", parent: null, children: [], geometry: { x: 0, y: 0, width: 1, height: 1 }, style: {fill:"#58bfa8",opacity:1}, layout: {}, spatial3d });
const transform = (position) => ({ ...api.IDENTITY_TRANSFORM_3D, position });
for (const n of [node("triangle", { transform: transform({x:0,y:0,z:0}), renderable: {meshAssetId:"triangle-mesh"}, animation:{clip:0,loop:true} }),
    node("camera", { transform: transform({x:1,y:.5,z:5}), camera:{kind:"perspective",near:.1,far:100,verticalFovDegrees:60} }),
    node("light", { transform: transform({x:0,y:0,z:3}), light:{kind:"directional",color:{x:1,y:1,z:1},intensity:2} })]) {
    doc.nodes.set(n.id,n); doc.rootNodeUuids.push(n.id);
}
const projects = {"visual.vde":api.visualReference(),"game.vde":api.gameReference(),"animated-3d.vde":doc,
    "pixel-workshop.vde":api.pixelWorkshop(), ...api.relayGameLevels()};
const files = Object.entries(projects).map(([name, project]) => {
    const content = api.serializeDocument(project); api.deserializeDocument(content); return [name, content];
});
animated.json.buffers[0].uri = "triangle.bin";
files.push(["triangle.gltf",JSON.stringify(animated.json,null,2)], ["triangle.bin",Buffer.from(animated.buffer)]);
fs.mkdirSync(destination, {recursive:true});
for (const [name,content] of files) fs.writeFileSync(path.join(destination,name),content,{flag:"wx"});
console.log(`Original reference projects created in ${destination}`);
