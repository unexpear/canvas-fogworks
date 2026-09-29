/**
 * @module benchmark-authoring
 * @description Repeatable owned-fixture loading, frame-building, gameplay, soak and undo-memory measurements; reports budgets without hardware-dependent CI failures.
 */
const esbuild = require("esbuild");
const path = require("path");
const os = require("os");
const { performance } = require("perf_hooks");
const Module = require("module");
const budgets = require("./benchmark-budgets");
const bundle = esbuild.buildSync({ stdin: { resolveDir: path.join(__dirname, ".."), contents: `
    export { visualReference, gameReference } from './src/core/examples/ReferenceProjects';
export { pixelWorkshop, relayGameLevels, workshopPixels, noisyPixels, texturedRasterScene, texturedBillboards } from './src/core/examples/AuthoringProjects';
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
function rectDocument(size) {
    const doc=api.visualReference(), original=doc.nodes.values().next().value;
    doc.nodes.clear(); doc.rootNodeUuids=[];
    for(let i=0;i<size;i++) { const id=`node-${i}`; doc.nodes.set(id,{...original,id,geometry:{x:(i%50)*30,y:Math.floor(i/50)*30,width:24,height:24}}); doc.rootNodeUuids.push(id); }
    return doc;
}
function frameOf(doc, width, height) {
    return api.buildRenderModel({width,height},doc,{computed:api.computeGeometry(doc),selectedNodeIds:[],hoveredNodeId:null,viewport:{x:0,y:0,zoom:1}});
}
function historyOf(doc, edits) {
    global.gc?.(); const before=process.memoryUsage().heapUsed;
    const dispatcher=new api.ActionDispatcher(doc);
    for(let i=0;i<edits;i++) dispatcher.dispatchAction(new api.MoveNodeAction(dispatcher.getDocument(),"node-0",i,0));
    global.gc?.();
    const accounting=dispatcher.retainedHistoryAccounting();
    const retainedBytes=accounting.serializedUtf8Bytes+accounting.payloadUtf8Bytes;
    return { ...accounting, retainedBytes, serializedMiB:+(retainedBytes/1048576).toFixed(3),
        budgetEstimateMiB:+(accounting.budgetEstimateBytes/1048576).toFixed(3),
        processHeapDeltaMiB:+(Math.max(0,process.memoryUsage().heapUsed-before)/1048576).toFixed(2),
        withinTrimBudget:accounting.stackBudgetEstimateBytes<=budgets.HISTORY_TRIM_BYTES||accounting.revisionCount<=budgets.HISTORY_MIN_ENTRIES };
}
const cases=[];
for(const size of [250,1000]) {
    const doc=rectDocument(size);
    const serialized=api.serializeDocument(doc);
    const loadP95Ms=measure(()=>api.deserializeDocument(serialized));
    const frameP95Ms=measure(()=>frameOf(doc,1600,1000));
    cases.push({nodes:size,serializedKiB:+(Buffer.byteLength(serialized)/1024).toFixed(1),loadP95Ms,frameP95Ms,
        history:historyOf(rectDocument(size),50),
        frameBudgetMs:budgets.INTERACTIVE_FRAME_MS,loadBudgetMs:budgets.DESERIALIZE_GOAL_MS,historyBudgetMiB:128});
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
        frameCpuP95Ms: measure(() => frameOf(doc,1280,800)),
        ...(name.startsWith("relay-") ? { gameplay100StepsP95Ms: measure(() => {
            let world=api.worldFrom(doc);for(let i=0;i<100;i++)world=api.stepGameplay(doc,world,{controlled:"player",input:{...api.NO_INPUT,right:true}}).world;
        },10) } : {}) });
}
const raster=api.workshopPixels(1024), encoded=api.encodeSurface(raster);
const raster1024 = { rawMiB:raster.data.byteLength/1048576, packedKiB:+(encoded.packedBytes/1024).toFixed(1),
    encodeP95Ms:measure(()=>api.encodeSurface(raster),10), decodeP95Ms:measure(()=>api.decodeSurface(encoded.data,1024,1024),10) };
function soakSession() {
    const doc=rectDocument(1000);
    const relay=api.relayGameLevels()["relay-1.vde"];
    const dispatcher=new api.ActionDispatcher(doc);
    const samples=[];
    const started=performance.now();
    const deadline=started+120000;
    let edits=0;
    const edit=()=>{ dispatcher.dispatchAction(new api.MoveNodeAction(dispatcher.getDocument(),`node-${edits%1000}`,edits%80,edits%40)); edits++; };
    const sample=(phase)=>{
        global.gc?.();
        const accounting=dispatcher.retainedHistoryAccounting();
        samples.push({ phase, edits, revisionCount:accounting.revisionCount, uniqueSnapshots:accounting.uniqueSnapshots,
            truncated:accounting.truncated, serializedUtf8Bytes:accounting.serializedUtf8Bytes+accounting.payloadUtf8Bytes,
            stackBudgetEstimateBytes:accounting.stackBudgetEstimateBytes,
            budgetEstimateBytes:accounting.budgetEstimateBytes, heapUsedBytes:process.memoryUsage().heapUsed });
    };
    for(let cycle=0;cycle<40 && performance.now()<deadline;cycle++){
        for(let n=0;n<5;n++) edit();
        frameOf(dispatcher.getDocument(),1280,800);
        let world=api.worldFrom(relay);
        for(let step=0;step<25;step++) world=api.stepGameplay(relay,world,{controlled:"player",input:{...api.NO_INPUT,right:true}}).world;
        api.decodeSurface(encoded.data,1024,1024);
        sample("mixed");
    }
    let trimmedEdits=0;
    while(edits<600 && trimmedEdits<30 && performance.now()<deadline){
        edit();
        const trimmed=dispatcher.hasTruncatedHistory();
        if(trimmed) trimmedEdits++;
        if(trimmed || edits%10===0) sample(trimmed?"trimmed":"trim-probe");
    }
    sample("end");
    const end=samples[samples.length-1];
    return { cycles:samples.filter(item=>item.phase==="mixed").length, edits, elapsedMs:+(performance.now()-started).toFixed(0),
        accountedGrowth:budgets.soakRetainedAccounted(samples), tailPlateaued:budgets.soakTailPlateaued(samples),
        truncated:end.truncated, endSerializedMiB:+(end.serializedUtf8Bytes/1048576).toFixed(3),
        endBudgetEstimateMiB:+(end.budgetEstimateBytes/1048576).toFixed(3),
        peakSerializedMiB:+(Math.max(...samples.map(item=>item.serializedUtf8Bytes))/1048576).toFixed(3),
        endHeapMiB:+(end.heapUsedBytes/1048576).toFixed(2),
        withinTrimBudget:end.stackBudgetEstimateBytes<=budgets.HISTORY_TRIM_BYTES||end.revisionCount<=budgets.HISTORY_MIN_ENTRIES, samples };
}
const soak=soakSession();
const noisy2048=api.noisyPixels(2048,1), noisyEncoded=api.encodeSurface(noisy2048);
const raster2048Noisy = { samples:5, rawMiB:+(noisy2048.data.byteLength/1048576).toFixed(3), packedMiB:+(noisyEncoded.packedBytes/1048576).toFixed(3),
    encodeP95Ms:measure(()=>api.encodeSurface(noisy2048),5), decodeP95Ms:measure(()=>api.decodeSurface(noisyEncoded.data,2048,2048),5) };
const componentDoc=api.pixelWorkshop(), card=componentDoc.nodes.get("card-0");
for(let i=15;i<500;i++) {const id=`card-${i}`;componentDoc.nodes.set(id,{...card,id,geometry:{...card.geometry,x:(i%25)*204,y:Math.floor(i/25)*76}});componentDoc.rootNodeUuids.push(id);}
const components500 = { storedNodes:componentDoc.nodes.size, resolvedNodes:api.computeGeometry(componentDoc).nodes.size,
    geometryP95Ms:measure(()=>api.computeGeometry(componentDoc)) };
const meshDoc=api.deserializeDocument(require("fs").readFileSync(path.join(__dirname,"../reference-projects/animated-3d.vde"),"utf8"));
const template=meshDoc.nodes.get("triangle");
for(let i=1;i<100;i++){const id=`mesh-${i}`;meshDoc.nodes.set(id,{...template,id,spatial3d:{...template.spatial3d,transform:{...template.spatial3d.transform,position:{x:i%10,y:Math.floor(i/10),z:0}}}});meshDoc.rootNodeUuids.push(id);}
const meshes=new Map([["triangle-mesh",{instances:animated.instances,motion:animated.motion}]]);
const animatedMeshes100FrameCpuP95Ms=measure(()=>api.buildFrame3D(meshDoc,meshes,1280,800,new Map(),.5),10);
const billboards=api.texturedBillboards(80);
const billboardFrame=api.buildFrame3D(billboards,new Map(),1280,800,new Map(),0);
if(billboardFrame.draws.length!==80) throw new Error("textured billboard scene did not build 80 draws");
const texturedBillboards80 = { draws:billboardFrame.draws.length,
    uniqueTextures:new Set(billboardFrame.draws.map(draw=>draw.baseColorTexture)).size,
    frameCpuP95Ms:measure(()=>api.buildFrame3D(billboards,new Map(),1280,800,new Map(),0),10) };
const sceneStarted=performance.now();
const textured=api.texturedRasterScene();
const texturedBuildMs=+((performance.now()-sceneStarted)/1000).toFixed(3);
const payloadBytes=[...textured.nodes.values()].reduce((sum,node)=>sum+(node.surface?.data.length??0),0);
const texturedRasters = { nodes:textured.nodes.size, payloadMiB:+(payloadBytes/1048576).toFixed(3), sceneBuildSeconds:texturedBuildMs, samples:5,
    frameCpuP95Ms:measure(()=>frameOf(textured,1280,800),5) };
async function report() {
const fs=require("fs"), {resolveConfined}=require("../src/electron/confine");
const project=path.join(__dirname,"../reference-projects/animated-3d.vde"),folder=path.dirname(project);
const reader={readProject3DFile:async(_project,source)=>(await fs.promises.readFile(resolveConfined(folder,folder,source,"a benchmark asset"))).toString("base64"),
    readProject3DSidecar:async(_project,source,relative)=>(await fs.promises.readFile(resolveConfined(folder,path.dirname(path.join(folder,source)),relative,"a benchmark sidecar"))).toString("base64")};
const reload=[];
for(let i=0;i<21;i++){const at=performance.now();const loadedAssets=await api.rehydrateAssets3D(reader,project,meshDoc.assets3d);
    if(loadedAssets.failures.length)throw new Error(loadedAssets.failures[0].error);if(i)reload.push(performance.now()-at);}
const assetReloadP95Ms=+reload.sort((a,b)=>a-b)[18].toFixed(3);
const prior=budgets.PRIOR_WINDOWS_IRIS_XE;
const relayFrames=authoringProjects.filter(item=>item.name.startsWith("relay-")).map(item=>item.frameCpuP95Ms);
const relayPlay=authoringProjects.filter(item=>item.gameplay100StepsP95Ms!=null).map(item=>item.gameplay100StepsP95Ms);
const measuredMs={
    "rect-250-frame":cases[0].frameP95Ms, "rect-1000-frame":cases[1].frameP95Ms,
    "rect-250-load":cases[0].loadP95Ms, "rect-1000-load":cases[1].loadP95Ms,
    "pixel-workshop-frame":authoringProjects[0].frameCpuP95Ms, "relay-frame":Math.max(...relayFrames),
    "components-500":components500.geometryP95Ms, "animated-meshes-100":animatedMeshes100FrameCpuP95Ms,
    "gameplay-100":Math.max(gameplay100StepsP95Ms, ...relayPlay), "skin-3000":skin3000VerticesP95Ms,
    "raster-1024-encode":raster1024.encodeP95Ms, "raster-1024-decode":raster1024.decodeP95Ms,
    "asset-reload":assetReloadP95Ms, "raster-2048-noisy-encode":raster2048Noisy.encodeP95Ms,
    "raster-2048-noisy-decode":raster2048Noisy.decodeP95Ms, "textured-rasters-frame":texturedRasters.frameCpuP95Ms,
    "textured-billboards-80":texturedBillboards80.frameCpuP95Ms
};
const frameKeys=new Set(["rect-250-frame","rect-1000-frame","pixel-workshop-frame","relay-frame","components-500","animated-meshes-100","textured-rasters-frame","textured-billboards-80"]);
const releaseComparison={};
for (const [name, releaseBudgetMs] of Object.entries(budgets.RELEASE_BUDGETS_MS)) {
    const measured=measuredMs[name];
    releaseComparison[name]={ measuredMs:measured, releaseBudgetMs, hosts:budgets.RECORDED_P95_MS[name].length,
        overReleaseBudget:measured>releaseBudgetMs,
        ...(frameKeys.has(name)?{ overInteractiveGoal:measured>budgets.INTERACTIVE_FRAME_MS }: {}) };
}
const hostSample=budgets.normalizeHostSample({
    schemaVersion:budgets.HOST_SAMPLE_SCHEMA, id:null, recorded:new Date().toISOString().slice(0,10),
    kind:"cpu", rendererKind:"cpu",
    host:{ platform:process.platform, arch:process.arch, cpu:os.cpus()[0]?.model??"unknown",
        cpuCount:os.cpus().length, totalMemMiB:Math.round(os.totalmem()/1048576),
        node:process.version, gcControlled:typeof global.gc==="function" },
    p95Ms:measuredMs,
    note:"CPU sample. record-benchmark-sample.js stores it beside the frozen budgets and does not change them."
});
const budgetComparison=budgets.compareHostSample(hostSample);
console.log(JSON.stringify({ node:process.version, platform:process.platform, arch:process.arch,
    cpu:os.cpus()[0]?.model??"unknown", cpuCount:os.cpus().length, totalMemMiB:Math.round(os.totalmem()/1048576),
    gcControlled:typeof global.gc==="function", cases, gameplay100StepsP95Ms, skin3000VerticesP95Ms,
    authoringProjects, raster1024, raster2048Noisy, components500, animatedMeshes100FrameCpuP95Ms,
    texturedRasters, texturedBillboards80, assetReloadP95Ms, soak, releaseComparison, hostSample, budgetComparison,
    policy:{ headroom:budgets.HEADROOM, interactiveFrameMs:budgets.INTERACTIVE_FRAME_MS, deserializeGoalMs:budgets.DESERIALIZE_GOAL_MS,
        historyTrimBytes:budgets.HISTORY_TRIM_BYTES, priorHost:prior.id, ciGateEnabled:budgets.CI_GATE_ENABLED },
    notes:["Frame measurements cover geometry/display-list CPU work, not GPU presentation.",
        "History serializedUtf8Bytes plus payloadUtf8Bytes is the exact canonical JSON retention. processHeapDeltaMiB is a separate process measurement.",
        "Frozen release budgets live in scripts/benchmark-budgets.js: 1.5× the highest frozen-cohort p95. This run reports whether it exceeded them and does not move them.",
        "hostSample is a CPU record. Pass this JSON to scripts/record-benchmark-sample.js to store it. That command does not admit the sample.",
        "The soak mixes edits, frame builds, relay steps and a 1024 raster decode, then keeps editing through the trim ceiling."]},null,2));
}
report().catch(error=>{console.error(error);process.exitCode=1;});
