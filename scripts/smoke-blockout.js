/** @module smoke-blockout @description Real Electron blockout inspector edits, Action undo/reopen and generated geometry WebGL picking. */
const {app,BrowserWindow}=require("electron");
const {buildSync}=require("esbuild");
const fs=require("fs"),path=require("path"),os=require("os");
const project=path.resolve(__dirname,".."),temp=fs.mkdtempSync(path.join(os.tmpdir(),"fogworks-blockout-"));
app.setPath("userData",path.join(temp,"profile"));
const timeout=setTimeout(()=>{console.error("Blockout smoke timed out");app.exit(1);},30000);
app.on("quit",()=>{clearTimeout(timeout);try{fs.rmSync(temp,{recursive:true,force:true});}catch{/* Disposable Chromium profile may remain locked. */}});
app.whenReady().then(async()=>{
    try{
        const bundle=buildSync({stdin:{resolveDir:project,loader:"tsx",contents:`
            import React from 'react';import {createRoot} from 'react-dom/client';
            import {ThreeDInspector} from './src/app/ThreeDInspector';
            import {gameReference} from './src/core/examples/ReferenceProjects';
            import {ActionDispatcher} from './src/core/actions/ActionDispatcher';
            import {SetSpatial3DAction} from './src/core/actions/SetSpatial3DAction';
            import {serializeDocument,deserializeDocument} from './src/core/document/Serializer';
            import {buildFrame3D} from './src/renderer/Scene3D';
            import {emitWebGL3D,pickWebGL3D} from './src/renderer/emitWebGL3D';
            import {world3DFrom,stepWorld3D} from './src/core/runtime/World3D';
            const doc=gameReference();doc.nodes.get('goal').spatial3d={transform:{position:{x:0,y:-1.5,z:0},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}},blockout:{kind:'room',width:4,height:3,depth:4,thickness:.2,ceiling:false}};
            const dispatcher=new ActionDispatcher(doc),root=createRoot(document.getElementById('root'));
            const read=()=>dispatcher.getDocument().nodes.get('goal').spatial3d.blockout;
            function render(){root.render(<ThreeDInspector node={dispatcher.getDocument().nodes.get('goal')} assets={[]} meshes={new Map()} onChange={next=>{
                if(!dispatcher.dispatchAction(new SetSpatial3DAction(dispatcher.getDocument(),'goal',next)).success)throw Error('Edit rejected');render();
            }}/>);}render();
            window.blockoutSmoke={read,tree:()=>dispatcher.getDocument().nodes.get('goal').spatial3d.solidTree,solid:()=>dispatcher.getDocument().nodes.get('goal').spatial3d.blockoutCollision,verify:()=>{
                const saved=serializeDocument(dispatcher.getDocument()),reopened=deserializeDocument(saved);
                if(reopened.nodes.get('goal').spatial3d.blockout.width!==8)throw Error('Reopen lost dimensions');
                if(reopened.nodes.get('goal').spatial3d.blockoutCollision!==true)throw Error('Reopen lost solid setting');
                dispatcher.undo();if(dispatcher.getDocument().nodes.get('goal').spatial3d.blockoutCollision)throw Error('Solid undo failed');
                dispatcher.undo();if(read().width!==4)throw Error('Undo failed');dispatcher.redo();if(read().width!==8)throw Error('Redo failed');
                dispatcher.redo();if(!dispatcher.getDocument().nodes.get('goal').spatial3d.blockoutCollision)throw Error('Solid redo failed');
                const canvas=document.getElementById('viewport'),frame=buildFrame3D(reopened,new Map(),128,128);
                if(!emitWebGL3D(canvas,frame))throw Error('WebGL drawing failed');
                let hits=0;for(let y=4;y<128;y+=8)for(let x=4;x<128;x+=8)if(pickWebGL3D(canvas,x,y)==='goal')hits++;
                if(!hits)throw Error('Generated room missing from GPU pick buffer');
                const playable=deserializeDocument(saved);playable.nodes.get('goal').entity={body:'static'};
                const player=playable.nodes.get('player');player.entity={body:'dynamic',player:true};
                player.spatial3d={transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}},collider:{kind:'sphere',radius:.2}};
                let world=world3DFrom(playable);for(let tick=0;tick<90;tick++)world=stepWorld3D(playable,world,new Map([['player',{x:1,y:0,z:0}]]));
                const stoppedX=world.bodies.get('player').transform.position.x;if(stoppedX>3.8+1e-9||stoppedX<3.6)throw Error('Reopened room did not block runtime movement: '+stoppedX+'; '+world.outcome);
                return {hits,stoppedX,triangles:frame.draws.find(d=>d.nodeId==='goal').primitive.indices.length/3,schema:JSON.parse(saved).version};
            },verifySolid:()=>{
                const saved=serializeDocument(dispatcher.getDocument()),cutDoc=deserializeDocument(saved),tree=cutDoc.nodes.get('goal').spatial3d.solidTree;
                if(tree.kind!=='operation'||tree.operation!=='subtract')throw Error('Reopen lost authored operation');
                dispatcher.undo();if(dispatcher.getDocument().nodes.get('goal').spatial3d.solidTree.kind!=='shape')throw Error('Cut undo failed');
                dispatcher.redo();if(JSON.stringify(dispatcher.getDocument().nodes.get('goal').spatial3d.solidTree)!==JSON.stringify(tree))throw Error('Cut redo failed');
                const canvas=document.getElementById('viewport'),cutFrame=buildFrame3D(cutDoc,new Map(),128,128);
                if(!emitWebGL3D(canvas,cutFrame))throw Error('Cutout drawing failed');
                const cutoutPicks=[[64,64],[32,64],[64,40]].map(([x,y])=>pickWebGL3D(canvas,x,y));
                if(cutoutPicks[0]!==null||cutoutPicks[1]!=='goal'||cutoutPicks[2]!=='goal')throw Error('Doorway GPU opening/jamb/header mismatch: '+JSON.stringify(cutoutPicks));
                cutDoc.nodes.get('goal').entity={body:'static'};
                const player=cutDoc.nodes.get('player');player.entity={body:'dynamic',player:true};
                player.spatial3d={transform:{position:{x:0,y:-.5,z:-1},rotation:{x:0,y:0,z:0,w:1},scale:{x:1,y:1,z:1}},collider:{kind:'sphere',radius:.2}};
                const travel=()=>{let world=world3DFrom(cutDoc);for(let i=0;i<40;i++)world=stepWorld3D(cutDoc,world,new Map([['player',{x:0,y:0,z:1}]]));return world.bodies.get('player').transform.position.z;};
                const throughZ=travel();player.spatial3d.transform.position.x=1;const blockedZ=travel();
                if(throughZ<1||blockedZ>-.4+1e-8)throw Error('Authored doorway collision mismatch');
                return {cutoutPicks,throughZ,blockedZ,cutoutTriangles:cutFrame.draws.find(d=>d.nodeId==='goal').primitive.indices.length/3};
            }};
        `},bundle:true,platform:"browser",format:"iife",write:false}).outputFiles[0].text;
        const win=new BrowserWindow({show:false,width:600,height:600,webPreferences:{sandbox:true,backgroundThrottling:false}});
        await win.loadURL("data:text/html,<div id='root'></div><canvas id='viewport' width='128' height='128' style='width:128px;height:128px'></canvas>");
        await win.webContents.executeJavaScript(bundle);
        const result=await win.webContents.executeJavaScript(`(async()=>{
            const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('Control update timed out');};
            await wait(()=>document.querySelector('[aria-label="Blockout width"]'));
            const input=document.querySelector('[aria-label="Blockout width"]');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'8');input.dispatchEvent(new Event('input',{bubbles:true}));
            await wait(()=>window.blockoutSmoke.read().width===8);
            document.querySelector('[aria-label="Blockout solid collision"]').click();
            await wait(()=>window.blockoutSmoke.solid()===true);const room=window.blockoutSmoke.verify();
            const click=text=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===text);if(!button)throw Error('Missing '+text);button.click();};
            click('Edit solid operations');await wait(()=>window.blockoutSmoke.tree());
            const shape=document.querySelector('[aria-label="Solid base shape"]');shape.value='wall';shape.dispatchEvent(new Event('change',{bubbles:true}));
            await wait(()=>window.blockoutSmoke.tree().shape.kind==='wall');
            for(const [key,value] of [['width',4],['depth',.4]]){
                const field=document.querySelector('[aria-label="Solid base '+key+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,String(value));field.dispatchEvent(new Event('input',{bubbles:true}));
                await wait(()=>window.blockoutSmoke.tree().shape[key]===value);
            }
            click('subtract operand base');await wait(()=>window.blockoutSmoke.tree().kind==='operation');
            return {...room,...window.blockoutSmoke.verifySolid()};
        })()`);
        console.log("Blockout smoke passed:",JSON.stringify(result));app.exit(0);
    }catch(error){console.error(error);app.exit(1);}
});
