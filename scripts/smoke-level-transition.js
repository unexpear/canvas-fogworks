/**
 * @module smoke-level-transition
 * @description Real Electron preload/IPC smoke for staged 3D levels and player entry/restart/frame lifecycle using relocated original fixtures.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs"), path = require("path"), os = require("os");
const { buildSync } = require("esbuild"), { resolveConfined } = require("../src/electron/confine");
const { copyProjectDependencies } = require("../src/electron/projectDependencies");
const { embedProjectImages } = require("../src/electron/projectImages");
const root = path.join(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-level-smoke-"));
app.setPath("userData", path.join(temp, "profile"));
const finish = code => { clearTimeout(timeout); app.exit(code); };
const timeout = setTimeout(() => { console.error("Level transition smoke timed out"); finish(1); }, 30000);
app.on("quit", () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* disposable locked profile may remain */ } });
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 400, height: 300,
        webPreferences: { sandbox: true, preload: path.join(root, "dist/electron/preload.js") } });
    try {
        const document = JSON.parse(fs.readFileSync(path.join(root, "reference-projects/animated-3d.vde"), "utf8"));
        document.document.assets3d.push({ id: "sky", kind: "texture", source: "sky.hdr", name: "Owned sky" });
        const camera = document.document.nodes.camera;
        document.document.nodes.environment = { ...camera, id: "environment", spatial3d: {
            transform: camera.spatial3d.transform, environment: { textureAssetId: "sky", intensity: 1, rotationDegrees: 0 } } };
        document.document.rootNodeUuids.push("environment");
        document.document.nodes.triangle.entity = { goal: true, transitionTo: "second.vde" };
        document.document.nodes.badge = { id:"badge",type:"core.image",parent:null,children:[],geometry:{x:0,y:0,width:16,height:16},style:{fill:"#ffffff",opacity:1},layout:{},src:"badge.png" };
        document.document.rootNodeUuids.push("badge");
        const sourceProject = path.join(temp, "entry.vde"), second = path.join(temp, "second.vde");
        fs.writeFileSync(sourceProject, JSON.stringify(document));
        const returnLevel = JSON.parse(JSON.stringify(document));
        returnLevel.document.nodes.triangle.entity.transitionTo = process.platform === "win32" ? "ENTRY.vde" : "entry.vde";
        fs.writeFileSync(second, JSON.stringify(returnLevel));
        await win.loadURL("data:text/html,<canvas id='scene' width='400' height='300'></canvas>");
        const png = await win.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas');c.width=1;c.height=1;const ctx=c.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,1,1);return c.toDataURL('image/png').split(',')[1];})()`);
        fs.writeFileSync(path.join(temp,"badge.png"),Buffer.from(png,"base64"));
        const gltf=JSON.parse(fs.readFileSync(path.join(root,"reference-projects/triangle.gltf"),"utf8"));
        const binary=fs.readFileSync(path.join(root,"reference-projects/triangle.bin"));
        const uv=Buffer.from(new Float32Array([0,0,1,0,0,1]).buffer);
        gltf.bufferViews.push({buffer:0,byteOffset:binary.length,byteLength:uv.length});
        gltf.accessors.push({bufferView:gltf.bufferViews.length-1,componentType:5126,count:3,type:"VEC2"});
        gltf.meshes[0].primitives[0].attributes.TEXCOORD_0=gltf.accessors.length-1;
        gltf.meshes[0].primitives[0].material=0;
        gltf.images=[{uri:process.platform === "win32" ? "BADGE.png" : "badge.png"}];gltf.textures=[{source:0}];
        gltf.materials=[{pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:1}}];
        gltf.buffers[0].byteLength=binary.length+uv.length;
        fs.writeFileSync(path.join(temp,"triangle.bin"),Buffer.concat([binary,uv]));
        fs.writeFileSync(path.join(temp,"triangle.gltf"),JSON.stringify(gltf));
        fs.writeFileSync(path.join(temp, "sky.hdr"), Buffer.concat([
            Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n"), Buffer.from([128,64,32,129])]));
        // Relocate the graph first. All renderer reads below are confined to the copied folder.
        const destination=path.join(temp,"portable");fs.mkdirSync(destination);
        const project=path.join(destination,"renamed.vde");
        await copyProjectDependencies(sourceProject,project,JSON.stringify(document));
        const copiedLevel = JSON.parse(fs.readFileSync(path.join(destination,"second.vde"),"utf8"));
        if(copiedLevel.document.nodes.triangle.entity.transitionTo !== "renamed.vde"
            || fs.existsSync(path.join(destination,"entry.vde"))) throw new Error("Entry return link retained a stale case-aliased copy");
        fs.writeFileSync(project,JSON.stringify(document));
        if(fs.existsSync(path.join(destination,"profile")))throw new Error("Unreferenced profile was copied");
        const approved = new Set([project]);
        const check = (event, file) => { if (event.sender !== win.webContents || !approved.has(file)) throw new Error("Unapproved smoke read"); };
        ipcMain.handle("read-level-file", async (event, current, target) => {
            check(event, current); const filePath=resolveConfined(destination,path.dirname(current),target,"a smoke level");
            const content=await embedProjectImages(filePath,await fs.promises.readFile(filePath,"utf8"));approved.add(filePath);return {filePath,content};
        });
        ipcMain.handle("read-project-3d-file", async (event, file, source) => {
            check(event,file);return (await fs.promises.readFile(resolveConfined(destination,path.dirname(file),source,"a smoke model"))).toString("base64");
        });
        ipcMain.handle("read-project-3d-sidecar", async (event,file,source,relative) => {
            check(event,file);return (await fs.promises.readFile(resolveConfined(destination,path.dirname(path.join(destination,source)),relative,"a smoke sidecar"))).toString("base64");
        });
        ipcMain.handle("read-project-environment-file", async (event,file,source) => {
            check(event,file);return (await fs.promises.readFile(resolveConfined(destination,path.dirname(file),source,"a smoke HDR"))).toString("base64");
        });
        // Package only the relocated fixture's explicit dependencies; no runtime filesystem fallback.
        const entryContent = await embedProjectImages(project, await fs.promises.readFile(project, "utf8"));
        const packageResources = [
            { path: "triangle.gltf", file: "model" }, { path: "triangle.bin", file: "buffer" },
            { path: "badge.png", file: "image" }, { path: "sky.hdr", file: "environment" }
        ];
        const inlinePackage = JSON.stringify({ format: "canvas-fogworks-game", version: 1, entry: "entry",
            requiredCapabilities: ["spatial3d-v1"], levels: [
                { id: "entry", content: entryContent, links: [{ target: "second.vde", level: "second" }], resources: packageResources },
                { id: "second", content: await embedProjectImages(path.join(destination,"second.vde"),
                    await fs.promises.readFile(path.join(destination,"second.vde"),"utf8")),
                    links: [{ target: "renamed.vde", level: "entry" }], resources: packageResources }
            ], files: packageResources.map((resource,index) => {
                const data = fs.readFileSync(path.join(destination,resource.path));
                return { id: resource.file, kind: ["gltf","buffer","image","hdr"][index], bytes: data.length, data: data.toString("base64") };
            }) });
        const bundle=buildSync({stdin:{resolveDir:root,contents:`
            import {RuntimeProject} from './src/app/LevelTransitionWorkflow';
            import {PlayerSession3D} from './src/runtime/PlayerSession3D';
            import {createPackageReader} from './src/runtime/GamePackage';
            import {buildFrame3D} from './src/renderer/Scene3D';
            import {emitWebGL3D} from './src/renderer/emitWebGL3D';
            window.levelSmoke=async()=>{
                const runtime=new RuntimeProject();
                await runtime.transition(window.electronAPI,${JSON.stringify(project)},'second.vde');
                const frame=buildFrame3D(runtime.document,runtime.meshes,400,300,runtime.environments,.5);
                const texture=frame.draws[0]?.baseColorTexture;
                if(!texture?.startsWith('data:image/png;')||!runtime.document.nodes.get('badge').src.startsWith('data:image/png;'))throw new Error('Relocated image/material texture missing');
                const image=new Image();image.src=texture;await image.decode();
                const canvas=document.getElementById('scene');
                if(frame.draws.length!==1||!frame.environment||!emitWebGL3D(canvas,frame,1))throw new Error('Destination frame did not hydrate and draw');
                const saved=runtime.document,meshes=runtime.meshes;
                let refused=false;try{await runtime.transition(window.electronAPI,null,'missing.vde');}catch{refused=true;}
                if(!refused||runtime.document!==saved||runtime.meshes!==meshes)throw new Error('Failed level changed runtime');
                runtime.reset();if(runtime.document||runtime.meshes.size||runtime.environments.size)throw new Error('Stop retained runtime assets');
                const packaged=createPackageReader(${JSON.stringify(inlinePackage)});
                if((await packaged.readLevelFile('second','RENAMED.vde')).filePath!=='entry')throw new Error('Packaged return link failed');
                const player=new PlayerSession3D(packaged,packaged.entryKey);
                await player.start();player.advance(1000);player.advance(1000+1000/60);
                const playerFrame=player.frame(400,300);
                if(player.world.time<=0||playerFrame.draws.length!==1||!emitWebGL3D(canvas,playerFrame,1))throw new Error('Player entry did not simulate and draw');
                player.pause();const pausedTime=player.world.time;player.advance(90000);
                if(player.world.time!==pausedTime)throw new Error('Paused player advanced');
                await player.restart();if(player.world.time!==0||player.status!=='running')throw new Error('Player restart failed');
                const late=player.restart();player.stop();if(await late||player.status!=='stopped'||player.frame(400,300)!==null)throw new Error('Late restart revived stopped player');
                return {draws:frame.draws.length,environment:frame.environment.assetId,priorMeshes:meshes.size,textureWidth:image.width,portable:true,playerLifecycle:true,packageReader:true};
            };`},bundle:true,platform:"browser",format:"iife",write:false}).outputFiles[0].text;
        await win.webContents.executeJavaScript(bundle);
        console.log("Level transition smoke passed: "+JSON.stringify(await win.webContents.executeJavaScript("window.levelSmoke()")));
        finish(0);
    }catch(error){console.error(error);finish(1);}
});
