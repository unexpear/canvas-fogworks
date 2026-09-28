/**
 * @module benchmark-authoring
 * @description Repeatable owned-fixture loading, frame-building, gameplay and undo-memory measurements; reports budgets without hardware-dependent CI failures.
 */
const esbuild = require("esbuild");
const path = require("path");
const { performance } = require("perf_hooks");
const Module = require("module");
const bundle = esbuild.buildSync({ stdin: { resolveDir: path.join(__dirname, ".."), contents: `
export { visualReference, gameReference } from './src/core/examples/ReferenceProjects';
export { pixelWorkshop, relayGameLevels, workshopPixels } from './src/core/examples/AuthoringProjects';
export { encodeSurface, decodeSurface } from './src/core/paint/PixelCodec';
export { buildFrame3D } from './src/renderer/Scene3D';
export { rehydrateAssets3D } from './src/app/Asset3DImportWorkflow';
export { serializeDocument, deserializeDocument } from './src/core/document/Serializer';
export { computeGeometry } from './src/core/geometry/GeometryEngine';
export { buildRenderModel } from './src/renderer/RenderModel';
export { ActionDispatcher } from './src/core/actions/ActionDispatcher';
export { MoveNodeAction } from './src/core/actions/MoveNodeAction';
export { worldFrom, NO_INPUT } from './src/core/runtime/World';
export { stepGameplay } from './src/core/runtime/GameplaySession';
export { animatedTriangle } from './src/core/examples/AnimatedTriangle';
export { sampleGltfMotion } from './src/core/import/GltfMotion';` }, bundle: true, platform: "node", format: "cjs", write: false });
const loaded = new Module(__filename, module); loaded._compile(bundle.outputFiles[0].text, __filename);
const api = loaded.exports;
function measure(fn, count = 20) {
    fn(); const times=[];
    for(let i=0;i<count;i++) { const at=performance.now(); fn(); times.push(performance.now()-at); }
    times.sort((a,b)=>a-b); return +times[Math.ceil(.95*times.length)-1].toFixed(3);
}
const cases=[];
for(const size of [250,1000]) {
    const doc=api.visualReference(), original=doc.nodes.values().next().value;
    doc.nodes.clear(); doc.rootNodeUuids=[];
    for(let i=0;i<size;i++) { const id=`node-${i}`; doc.nodes.set(id,{...original,id,geometry:{x:(i%50)*30,y:Math.floor(i/50)*30,width:24,height:24}}); doc.rootNodeUuids.push(id); }
    const serialized=api.serializeDocument(doc);
    const loadP95Ms=measure(()=>api.deserializeDocument(serialized));
    const frameP95Ms=measure(()=>api.buildRenderModel({width:1600,height:1000},doc,{computed:api.computeGeometry(doc),selectedNodeIds:[],hoveredNodeId:null,viewport:{x:0,y:0,zoom:1}}));
    global.gc?.(); const before=process.memoryUsage().heapUsed;
    const dispatcher=new api.ActionDispatcher(doc);
    for(let i=0;i<50;i++) dispatcher.dispatchAction(new api.MoveNodeAction(dispatcher.getDocument(),"node-0",i,0));
    global.gc?.(); const historyHeapDeltaMiB=+(Math.max(0,process.memoryUsage().heapUsed-before)/1048576).toFixed(2);
    cases.push({nodes:size,serializedKiB:+(Buffer.byteLength(serialized)/1024).toFixed(1),loadP95Ms,frameP95Ms,historyHeapDeltaMiB,
        frameBudgetMs:16.67,loadBudgetMs:100,historyBudgetMiB:128});
}
const game=api.gameReference();
const gameplay100StepsP95Ms=measure(()=>{let world=api.worldFrom(game);for(let i=0;i<100;i++)world=api.stepGameplay(game,world,{controlled:"player",input:api.NO_INPUT}).world;},10);
const animated=api.animatedTriangle(), original=animated.instances[0];
const repeat=(data,count)=>{const out=new data.constructor(data.length*count);for(let i=0;i<count;i++)out.set(data,i*data.length);return out;};
const large={...original,primitive:{...original.primitive,positions:repeat(original.primitive.positions,1000),normals:repeat(original.primitive.normals,1000),indices:Uint32Array.from({length:3000},(_,i)=>i)}};
const influence=animated.motion.influences.get(original);
const motion={...animated.motion,influences:new Map([[large,{...influence,weights:repeat(influence.weights,1000),joints:repeat(influence.joints,1000)}]])};
const skin3000VerticesP95Ms=measure(()=>api.sampleGltfMotion(motion,[large],.5,{clip:0}),10);
const authoringProjects = [];
for (const [name, doc] of Object.entries({ "pixel-workshop": api.pixelWorkshop(), ...api.relayGameLevels() })) {
    const bytes = api.serializeDocument(doc);
    authoringProjects.push({ name, nodes: doc.nodes.size, resolvedNodes: api.computeGeometry(doc).nodes.size,
        serializedKiB: +(Buffer.byteLength(bytes)/1024).toFixed(1),
        loadP95Ms: measure(() => api.deserializeDocument(bytes)),
        frameCpuP95Ms: measure(() => api.buildRenderModel({width:1280,height:800},doc,
            {computed:api.computeGeometry(doc),selectedNodeIds:[],hoveredNodeId:null,viewport:{x:0,y:0,zoom:1}})),
        ...(name.startsWith("relay-") ? { gameplay100StepsP95Ms: measure(() => {
            let world=api.worldFrom(doc);for(let i=0;i<100;i++)world=api.stepGameplay(doc,world,{controlled:"player",input:{...api.NO_INPUT,right:true}}).world;
        },10) } : {}) });
}
const raster=api.workshopPixels(1024), encoded=api.encodeSurface(raster);
const raster1024 = { rawMiB:raster.data.byteLength/1048576, packedKiB:+(encoded.packedBytes/1024).toFixed(1),
    encodeP95Ms:measure(()=>api.encodeSurface(raster),10), decodeP95Ms:measure(()=>api.decodeSurface(encoded.data,1024,1024),10) };
const componentDoc=api.pixelWorkshop(), card=componentDoc.nodes.get("card-0");
for(let i=15;i<500;i++) {const id=`card-${i}`;componentDoc.nodes.set(id,{...card,id,geometry:{...card.geometry,x:(i%25)*204,y:Math.floor(i/25)*76}});componentDoc.rootNodeUuids.push(id);}
const components500 = { storedNodes:componentDoc.nodes.size, resolvedNodes:api.computeGeometry(componentDoc).nodes.size,
    geometryP95Ms:measure(()=>api.computeGeometry(componentDoc)) };
const meshDoc=api.deserializeDocument(require("fs").readFileSync(path.join(__dirname,"../reference-projects/animated-3d.vde"),"utf8"));
const template=meshDoc.nodes.get("triangle");
for(let i=1;i<100;i++){const id=`mesh-${i}`;meshDoc.nodes.set(id,{...template,id,spatial3d:{...template.spatial3d,transform:{...template.spatial3d.transform,position:{x:i%10,y:Math.floor(i/10),z:0}}}});meshDoc.rootNodeUuids.push(id);}
const meshes=new Map([["triangle-mesh",{instances:animated.instances,motion:animated.motion}]]);
const animatedMeshes100FrameCpuP95Ms=measure(()=>api.buildFrame3D(meshDoc,meshes,1280,800,new Map(),.5),10);
async function report() {
const fs=require("fs"), {resolveConfined}=require("../src/electron/confine");
const project=path.join(__dirname,"../reference-projects/animated-3d.vde"),folder=path.dirname(project);
const reader={readProject3DFile:async(_project,source)=>(await fs.promises.readFile(resolveConfined(folder,folder,source,"a benchmark asset"))).toString("base64"),
    readProject3DSidecar:async(_project,source,relative)=>(await fs.promises.readFile(resolveConfined(folder,path.dirname(path.join(folder,source)),relative,"a benchmark sidecar"))).toString("base64")};
const reload=[];
for(let i=0;i<21;i++){const at=performance.now();const loaded=await api.rehydrateAssets3D(reader,project,meshDoc.assets3d);
    if(loaded.failures.length)throw new Error(loaded.failures[0].error);if(i)reload.push(performance.now()-at);}
const assetReloadP95Ms=+reload.sort((a,b)=>a-b)[18].toFixed(3);
console.log(JSON.stringify({ node:process.version,platform:process.platform,arch:process.arch,gcControlled:typeof global.gc==="function",cases,gameplay100StepsP95Ms,skin3000VerticesP95Ms,
    authoringProjects,raster1024,components500,animatedMeshes100FrameCpuP95Ms,assetReloadP95Ms,
    notes:["Frame measurements cover geometry/display-list CPU work, not GPU presentation.","Heap deltas are approximate retained-process measurements, not exact history accounting.","Run benchmark:gpu for optional disjoint timer queries; hardware-specific budgets remain informational."]},null,2));
}
report().catch(error=>{console.error(error);process.exitCode=1;});
