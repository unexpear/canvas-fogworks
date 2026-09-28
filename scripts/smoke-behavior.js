/** @module smoke-behavior @description Real Chromium graph authoring, cycle refusal, persistence and optional screenshot using the production panel and Actions. */
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");
const fs = require("fs"), path = require("path"), os = require("os");
const root = path.resolve(__dirname,".."), temp = fs.mkdtempSync(path.join(os.tmpdir(),"fogworks-graph-smoke-"));
app.setPath("userData",path.join(temp,"profile"));
const timeout=setTimeout(()=>{console.error("Behavior authoring smoke timed out");app.exit(1);},30000);
app.on("quit",()=>{try{fs.rmSync(temp,{recursive:true,force:true});}catch{/* Chromium may retain a disposable profile lock. */}});
app.whenReady().then(async()=>{
    const bundle=buildSync({stdin:{resolveDir:root,loader:"tsx",contents:`
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {SetGameplayVariablesAction} from './src/core/actions/SetGameplayVariablesAction';
        import {SetBehaviorFunctionsAction} from './src/core/actions/SetBehaviorFunctionsAction';
        import {SetBehaviorAssetsAction} from './src/core/actions/SetBehaviorAssetsAction';
        import {resolveBehavior} from './src/core/document/BehaviorAssets';
        import {GameplayPanel} from './src/app/GameplayPanel';
        import {ActionDispatcher} from './src/core/actions/ActionDispatcher';
        import {UpdateNodeContentAction} from './src/core/actions/UpdateNodeContentAction';
        import {gameReference} from './src/core/examples/ReferenceProjects';
        import {serializeDocument,deserializeDocument} from './src/core/document/Serializer';
        const doc=gameReference(); doc.nodes.get('goal')!.entity={};
        const dispatcher=new ActionDispatcher(doc), root=createRoot(document.getElementById('root')!);
        function render(){root.render(<GameplayPanel onFunctionsChange={functions=>{const result=dispatcher.dispatchAction(new SetBehaviorFunctionsAction(dispatcher.getDocument(),functions));render();return result.success;}} functions={dispatcher.getDocument().behaviorFunctions} variables={dispatcher.getDocument().gameplayVariables} onVariablesChange={variables=>{const result=dispatcher.dispatchAction(new SetGameplayVariablesAction(dispatcher.getDocument(),variables));render();return result.success;}} assets={dispatcher.getDocument().behaviorAssets} onAssetsChange={(assets,entity)=>{if(!dispatcher.dispatchAction(new SetBehaviorAssetsAction(dispatcher.getDocument(),assets,entity?{nodeId:'goal',entity}:undefined)).success)throw new Error('Asset Action rejected');render();}} entity={dispatcher.getDocument().nodes.get('goal')!.entity!} onChange={entity=>{
            if(!dispatcher.dispatchAction(new UpdateNodeContentAction(dispatcher.getDocument(),'goal',{entity})).success)throw new Error('Entity Action rejected');render();
        }}/>);}
        window.graphSmoke={read:()=>{const d=deserializeDocument(serializeDocument(dispatcher.getDocument()));return resolveBehavior(d,d.nodes.get('goal')!.entity);},asset:()=>dispatcher.getDocument().nodes.get('goal')!.entity!.behaviorAssetId};render();
    `},bundle:true,platform:"browser",format:"iife",write:false}).outputFiles[0].text;
    const win=new BrowserWindow({show:false,width:460,height:920,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    await win.loadURL('data:text/html,'+encodeURIComponent('<style>body{background:#222630;color:#edf0f5;font:14px sans-serif;margin:12px}</style><div id="root"></div>'));
    await win.webContents.executeJavaScript(bundle);
    const result=await win.webContents.executeJavaScript(`(async()=>{
        const wait=async(test)=>{const end=performance.now()+4000;while(!test()){if(performance.now()>end)throw new Error('Graph UI timed out');await new Promise(r=>setTimeout(r,20));}};
        await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Add behavior graph'));
        [...document.querySelectorAll('button')].find(b=>b.textContent==='Add behavior graph').click();
        await wait(()=>window.graphSmoke.read()?.nodes.length===5);
        document.querySelector('[aria-label="Select behavior node check"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
        await wait(()=>document.querySelector('[aria-label="Behavior true"]'));
        const select=document.querySelector('[aria-label="Behavior true"]');select.value='count';select.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(()=>document.querySelector('[role="alert"]'));
        if(!document.querySelector('[role="alert"]').textContent.includes('cycles')||window.graphSmoke.read().nodes.find(n=>n.id==='check').onTrue!=='win')throw new Error('Cycle replaced valid graph');
        select.value='checkpoint';select.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(()=>window.graphSmoke.read().nodes.find(n=>n.id==='check').onTrue==='checkpoint');
        const click=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text).click();
        click('Add delay node');await wait(()=>window.graphSmoke.read().nodes.length===6);
        click('Add repeat node');await wait(()=>window.graphSmoke.read().nodes.length===7);
        const body=document.querySelector('[aria-label="Behavior body"]');body.value='delay1';body.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(()=>window.graphSmoke.read().nodes.find(n=>n.id==='repeat1').body==='delay1');
        click('Save as reusable graph');await wait(()=>window.graphSmoke.asset());
        if(window.graphSmoke.read().version!==2)throw new Error('Graph v2 was not preserved');
        click('Detach local copy');await wait(()=>!window.graphSmoke.asset());
        document.querySelector('[aria-label="Select behavior node interact"]').dispatchEvent(new MouseEvent('click',{bubbles:true}));
        await wait(()=>document.querySelector('[aria-label="Behavior event"]'));
        const event=document.querySelector('[aria-label="Behavior event"]');event.value='update';event.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(()=>window.graphSmoke.read().version===3);
        click('Add emit node');await wait(()=>window.graphSmoke.read().nodes.length===8);
        click('Add gameplay variable');await wait(()=>document.querySelector('[aria-label="Gameplay variable name 0"]'));
        click('Add assign node');await wait(()=>window.graphSmoke.read().nodes.length===9&&window.graphSmoke.read().version===4);
        click('Add compare node');await wait(()=>window.graphSmoke.read().nodes.length===10);
        [...document.querySelectorAll('summary')].find(s=>s.textContent.startsWith('Reusable functions')).click();
        click('New function');await wait(()=>document.querySelector('[aria-label="Function name"]'));
        click('Add function inputs');await wait(()=>document.querySelector('[aria-label="Function inputs name 0"]'));
        click('Add function outputs');await wait(()=>document.querySelector('[aria-label="Return value1 source"]'));
        const returnSource=document.querySelector('[aria-label="Return value1 source"]');returnSource.value='input';returnSource.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(()=>document.querySelector('[aria-label="Return value1 reference"]'));
        click('Apply function draft');await wait(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Apply function draft').disabled);
        click('Add call node');await wait(()=>window.graphSmoke.read().nodes.length===11&&window.graphSmoke.read().version===5);
        const amount=document.querySelector('[aria-label="Function input value1 value"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(amount,'25');amount.dispatchEvent(new Event('input',{bubbles:true}));
        await wait(()=>window.graphSmoke.read().nodes.find(n=>n.kind==='call').inputs[0].value.value===25);
        await wait(()=>![...document.querySelectorAll('summary')].find(s=>s.textContent.startsWith('Reusable functions')).textContent.includes('unapplied'));
        return {nodes:window.graphSmoke.read().nodes.length,svg:!!document.querySelector('[aria-label="Behavior graph connections"]'),overflow:document.documentElement.scrollWidth>window.innerWidth};
    })()`);
    if(result.nodes!==11||!result.svg||result.overflow)throw new Error('Graph UI failed: '+JSON.stringify(result));
    if(process.env.FOGWORKS_GRAPH_SCREENSHOT){
        await win.webContents.executeJavaScript(`(async()=>{document.querySelector('[aria-label="Function graph connections"]').scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`);
        fs.writeFileSync(process.env.FOGWORKS_GRAPH_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    }
    clearTimeout(timeout);console.log("Behavior authoring smoke passed: visual connections, cycle refusal, delays/repeats, shared assets, lifecycle/send, typed values, function creation/signatures/returns/calls and save/reopen.");win.destroy();app.exit(0);
}).catch(error=>{clearTimeout(timeout);console.error(error);app.exit(1);});
