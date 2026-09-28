/**
 * @module smoke-authoring
 * @description Real Chromium smoke for whole-canvas PNG and an offline packaged game using owned reference projects.
 */
const { app, BrowserWindow } = require("electron");
const esbuild = require("esbuild"), fs=require("fs"), path=require("path"), os=require("os"), Module=require("module");
const root=path.join(__dirname,"..");
const built=esbuild.buildSync({stdin:{resolveDir:root,contents:`export { gameReference } from './src/core/examples/ReferenceProjects'; export { relayGameLevels } from './src/core/examples/AuthoringProjects'; export { serializeDocument } from './src/core/document/Serializer'; export { gameHtml } from './src/core/export/GameExport';`},bundle:true,platform:"node",format:"cjs",write:false});
const loaded=new Module(__filename,module); loaded._compile(built.outputFiles[0].text,__filename);
const {gameReference,serializeDocument,gameHtml}=loaded.exports;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"fogworks-authoring-smoke-"));
const finish=code=>{clearTimeout(timeout);fs.rmSync(temp,{recursive:true,force:true});app.exit(code);};
const timeout=setTimeout(()=>{console.error("Authoring smoke timed out");finish(1);},55000);
app.whenReady().then(async()=>{
    const win=new BrowserWindow({show:false,x:-10000,y:-10000,width:800,height:600,webPreferences:{sandbox:true,backgroundThrottling:false}});
    try {
        const pngBundle=esbuild.buildSync({stdin:{resolveDir:root,contents:`import { visualReference } from './src/core/examples/ReferenceProjects'; import { exportCanvasPng } from './src/app/CanvasExport'; import { RuntimeAudio } from './src/app/RuntimeAudio'; window.RuntimeAudio=RuntimeAudio; window.pngSmoke=async(lit=false)=>{const doc=visualReference();if(lit){doc.lights=[{x:0,y:0,z:-1,color:'#ffffff',intensity:0.5}];doc.ambient=0;}return exportCanvasPng(doc);};`},bundle:true,platform:"browser",format:"iife",write:false}).outputFiles[0].text;
        await win.loadURL("data:text/html,<html></html>");await win.webContents.executeJavaScript(pngBundle);
        const png=await win.webContents.executeJavaScript(`(async()=>{const url=await window.pngSmoke(); const img=new Image();img.src=url;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {width:c.width,height:c.height,pixel:Array.from(ctx.getImageData(10,10,1,1).data)};})()`);
        if(png.width!==136||png.height!==104||png.pixel[0]!==232||png.pixel[1]!==89||png.pixel[2]!==85||png.pixel[3]!==255)throw new Error(`PNG mismatch: ${JSON.stringify(png)}`);
        const lit=await win.webContents.executeJavaScript(`(async()=>{const img=new Image();img.src=await window.pngSmoke(true);await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return Array.from(ctx.getImageData(10,10,1,1).data);})()`);
        if(Math.abs(lit[0]-116)>2||Math.abs(lit[1]-45)>2||Math.abs(lit[2]-43)>2||lit[3]!==255)throw new Error('Lit PNG mismatch: '+JSON.stringify(lit));
        const sound=await win.webContents.executeJavaScript(`(async()=>{
            const errors=[],audio=new window.RuntimeAudio(message=>errors.push(message));
            const bytes=new Uint8Array(44+8000),view=new DataView(bytes.buffer),text=(offset,value)=>{for(let i=0;i<value.length;i++)bytes[offset+i]=value.charCodeAt(i);};
            text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,8000,true);view.setUint16(32,1,true);view.setUint16(34,8,true);text(36,'data');view.setUint32(40,8000,true);bytes.fill(128,44);
            audio.unlock();await audio.play({source:'data:audio/wav;base64,'+btoa(String.fromCharCode(...bytes)),volume:0});
            const playing=audio.voices.size;audio.stop();const stopped=audio.voices.size;audio.dispose();return {errors,playing,stopped};
        })()`,true);
        if(sound.errors.length||sound.playing!==1||sound.stopped!==0)throw new Error('Audio smoke failed: '+JSON.stringify(sound));
        const graphGame=gameReference(), graphGoal=graphGame.nodes.get("goal");
        graphGame.nodes.set("goal",{...graphGoal,entity:{behavior:{version:1,enabled:true,nodes:[
            {id:"enter",kind:"event",event:"enter",other:"any",next:"branch"},
            {id:"branch",kind:"branch",condition:{kind:"player"},onTrue:"win",onFalse:null},
            {id:"win",kind:"action",target:"self",action:{kind:"win"},next:null}
        ]}}});
        const content=serializeDocument(graphGame);
        const html=gameHtml({entry:"level0",levels:{level0:{content,links:{}}}},fs.readFileSync(path.join(root,"dist/app/player.js")).toString("base64"));
        const file=path.join(temp,"game.html");fs.writeFileSync(file,html);await win.loadFile(file);win.showInactive();
        const result=await win.webContents.executeJavaScript(`(async()=>{document.getElementById('start').click();document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));const until=performance.now()+6000;while(performance.now()<until){if(document.getElementById('game').dataset.outcome==='won')return 'won';await new Promise(r=>setTimeout(r,30));}return document.getElementById('status').textContent;})()`);
        if(result!=="won")throw new Error(`Packaged game failed: ${result}`);
        const saved = await win.webContents.executeJavaScript(`(async()=>{
            document.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
            document.getElementById('checkpoint').click(); document.getElementById('save-progress').click();
            const until=performance.now()+5000;
            while(performance.now()<until){
                const note=document.getElementById('progress-note').textContent;
                if(note.includes('Progress saved'))return true;
                if(note.includes('Progress error'))throw new Error(note);
                await new Promise(r=>setTimeout(r,30));
            } return false;
        })()`);
        if(!saved)throw new Error('2D progress save timed out');
        await win.loadFile(file);
        const restored = await win.webContents.executeJavaScript(`(async()=>{
            document.getElementById('load-progress').click(); const until=performance.now()+5000;
            while(performance.now()<until){
                const note=document.getElementById('progress-note').textContent;
                if(note.includes('Progress restored'))return true;
                if(note.includes('Progress error'))throw new Error(note);
                await new Promise(r=>setTimeout(r,30));
            } return false;
        })()`);
        if(!restored)throw new Error('2D progress restore after reload timed out');
        const levels = Object.fromEntries(Object.entries(loaded.exports.relayGameLevels()).map(([name, doc]) => [name,
            { content: serializeDocument(doc), links: Object.fromEntries([...doc.nodes.values()].filter(n=>n.entity?.transitionTo).map(n=>[n.entity.transitionTo,n.entity.transitionTo])) }]));
        fs.writeFileSync(file, gameHtml({entry:"relay-1.vde",levels},fs.readFileSync(path.join(root,"dist/app/player.js")).toString("base64")));
        await win.loadFile(file);
        const relay = await win.webContents.executeJavaScript(`(async()=>{
            document.getElementById('start').click(); const until=performance.now()+25000;
            while(performance.now()<until){
                // New levels intentionally clear held input: repeat a fresh press for each stage.
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true}));
                if(document.getElementById('game').dataset.outcome==='won') return 'won';
                await new Promise(r=>setTimeout(r,30));
            } return document.getElementById('status').textContent;
        })()`);
        if(relay!=="won")throw new Error("Three-level relay failed: "+relay);
        const workshopBundle=esbuild.buildSync({stdin:{resolveDir:root,contents:`import {pixelWorkshop} from './src/core/examples/AuthoringProjects'; import {exportCanvasPng} from './src/app/CanvasExport'; window.workshopPng=()=>exportCanvasPng(pixelWorkshop());`},bundle:true,platform:"browser",format:"iife",write:false}).outputFiles[0].text;
        await win.loadURL("data:text/html,<html></html>"); await win.webContents.executeJavaScript(workshopBundle);
        const workshop=await win.webContents.executeJavaScript(`(async()=>{const data=await window.workshopPng(),img=new Image();img.src=data;await img.decode();return {data,width:img.width,height:img.height};})()`);
        if(workshop.width!==1296||workshop.height!==816)throw new Error("Workshop PNG dimensions mismatch: "+workshop.width+"x"+workshop.height);
        if(process.env.FOGWORKS_SMOKE_ARTIFACTS) {
            fs.mkdirSync(process.env.FOGWORKS_SMOKE_ARTIFACTS,{recursive:true});
            fs.writeFileSync(path.join(process.env.FOGWORKS_SMOKE_ARTIFACTS,"pixel-workshop.png"),Buffer.from(workshop.data.split(',')[1],"base64"));
        }
        console.log("Authoring smoke passed: unlit/lit PNG pixels, WAV playback, offline behavior graph victory, 2D checkpoint save/reload/restore, complete three-level relay and component/raster workshop PNG.");finish(0);
    }catch(error){console.error(error);finish(1);}
});
