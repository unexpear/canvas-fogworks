/**
 * @module benchmark-gpu
 * @description Measures production WebGL submission and optional asynchronous GPU timer queries on original 2D/3D fixtures; unavailable/disjoint samples are never reported as zero.
 */
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const fs = require("fs"), path = require("path"), os = require("os");
const root = path.join(__dirname, "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-gpu-benchmark-"));
app.setPath("userData", profile);
const timeout = setTimeout(() => { console.error("GPU benchmark timed out"); app.exit(1); }, 55000);
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1280, height: 800,
        webPreferences: { sandbox: true, backgroundThrottling: false } });
    try {
        const doc3d = fs.readFileSync(path.join(root, "reference-projects/animated-3d.vde"), "utf8");
        const bundle = buildSync({ stdin: { resolveDir: root, contents: `
            import {pixelWorkshop,relayGameLevels} from './src/core/examples/AuthoringProjects';
            import {computeGeometry} from './src/core/geometry/GeometryEngine';
            import {buildRenderModel} from './src/renderer/RenderModel';
            import {emitWebGL} from './src/renderer/emitWebGL';
            import {emitWebGL3D} from './src/renderer/emitWebGL3D';
            import {buildFrame3D} from './src/renderer/Scene3D';
            import {animatedTriangle} from './src/core/examples/AnimatedTriangle';
            import {deserializeDocument} from './src/core/document/Serializer';
            window.workloads=()=>{
                const entries=Object.entries({'pixel-workshop':pixelWorkshop(),...relayGameLevels()}).map(([name,doc])=>{
                    const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=800;document.body.appendChild(canvas);
                    const vp={x:0,y:0,zoom:1},model=buildRenderModel({width:1280,height:800},doc,{computed:computeGeometry(doc),selectedNodeIds:[],hoveredNodeId:null,viewport:vp});
                    return {name,canvas,draw:()=>emitWebGL(canvas,model,vp,1)};
                });
                const doc=deserializeDocument(${JSON.stringify(doc3d)}),mesh=animatedTriangle();
                const template=doc.nodes.get('triangle');
                for(let i=1;i<100;i++){const id='mesh-'+i;doc.nodes.set(id,{...template,id,spatial3d:{...template.spatial3d,transform:{...template.spatial3d.transform,position:{x:(i%10)*.1,y:Math.floor(i/10)*.1,z:-i*.01}}}});doc.rootNodeUuids.push(id);}
                const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=800;document.body.appendChild(canvas);
                const frame=buildFrame3D(doc,new Map([['triangle-mesh',{instances:mesh.instances,motion:mesh.motion}]]),1280,800,new Map(),.5);
                entries.push({name:'animated-meshes-100',canvas,draw:()=>emitWebGL3D(canvas,frame,1)});return entries;
            };` }, bundle: true, platform: "browser", format: "iife", write: false }).outputFiles[0].text;
        await win.loadURL("data:text/html,<html><body></body></html>");
        await win.webContents.executeJavaScript(bundle);
        const results = await win.webContents.executeJavaScript(`(async()=>{
            const p95=values=>values.length?+values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1].toFixed(3):null;
            const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
            const results=[];
            for(const workload of window.workloads()) {
                if(!workload.draw())throw new Error(workload.name+': WebGL draw failed');
                await sleep(100); // allow image uploads; timed samples exclude initial shader compilation
                const gl=workload.canvas.getContext('webgl'),ext=gl.getExtension('EXT_disjoint_timer_query');
                const debug=gl.getExtension('WEBGL_debug_renderer_info');
                const cpu=[],gpu=[];let invalid=0;
                for(let i=0;i<20;i++){
                    if(gl.isContextLost())throw new Error('WebGL context lost');
                    const query=ext?.createQueryEXT();
                    if(query){gl.getParameter(ext.GPU_DISJOINT_EXT);ext.beginQueryEXT(ext.TIME_ELAPSED_EXT,query);}
                    const at=performance.now();if(!workload.draw())throw new Error('WebGL sample draw failed');cpu.push(performance.now()-at);
                    if(query){
                        ext.endQueryEXT(ext.TIME_ELAPSED_EXT);gl.flush();
                        const until=performance.now()+1000;let measured=false;
                        try {
                            while(performance.now()<until){
                                await sleep(4);
                                const available=ext.getQueryObjectEXT(query,ext.QUERY_RESULT_AVAILABLE_EXT);
                                if(gl.getParameter(ext.GPU_DISJOINT_EXT))break;
                                if(available){gpu.push(ext.getQueryObjectEXT(query,ext.QUERY_RESULT_EXT)/1e6);measured=true;break;}
                            }
                        }finally{ext.deleteQueryEXT(query);}
                        if(!measured)invalid++;
                    }
                }
                results.push({name:workload.name,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
                    cpuSubmissionP95Ms:p95(cpu),gpuP95Ms:p95(gpu),gpuSamples:gpu.length,invalidGpuSamples:invalid,
                    timerAvailable:!!ext,width:1280,height:800});
            }
            return results;
        })()`);
        console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome,
            results, notes: ["20 warmed samples. CPU submission excludes frame construction; GPU queries exclude CPU work and presentation.",
                "Unsupported or disjoint GPU timings are null. No hardware-independent release threshold is asserted."] }, null, 2));
        clearTimeout(timeout); win.destroy(); app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
});
app.on("quit", () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold its disposable profile. */ } });
