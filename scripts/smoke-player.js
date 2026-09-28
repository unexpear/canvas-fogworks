/** @module smoke-player @description Exercises exported HTML in the real isolated desktop host: rendering, input, levels, controls, confinement and damaged payload. */
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), path = require("path"), os = require("os");
const { packageGame } = require("./package-game");
const { createGameWindow } = require("../src/player3d/desktopWindow");
const root = path.resolve(__dirname, ".."), temp = fs.mkdtempSync(path.join(os.tmpdir(), "fogworks-player-smoke-"));
app.setPath("userData", path.join(temp, "profile"));
app.on("window-all-closed", () => {}); // This harness opens the corrupted-package window after the valid one.
const timeout = setTimeout(() => { console.error("Standalone player smoke timed out"); app.exit(1); }, 45000);
app.on("quit", () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* locked disposable profile may remain */ } });
async function until(win, expression) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (await win.webContents.executeJavaScript(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 80));
    }
    const diagnostic=await win.webContents.executeJavaScript('(async()=>({status:document.getElementById("status")?.textContent,visibility:document.visibilityState,note:document.getElementById("progress-note")?.textContent,progress:await window.playerProgress?.read()}))()');
    throw new Error(`Player condition timed out: ${expression}; ${JSON.stringify(diagnostic)}`);
}
app.whenReady().then(async () => {
    const source = path.join(temp, "source"); fs.mkdirSync(source);
    const doc = JSON.parse(fs.readFileSync(path.join(root, "reference-projects/animated-3d.vde"), "utf8"));
    doc.version = "85";
    const hero = doc.document.nodes.triangle;
    hero.entity = { player: true, body: "dynamic" };
    hero.spatial3d.transform.position = { x: 0, y: 0, z: 0 };
    hero.spatial3d.collider = { kind: "box", halfExtents: { x: .5, y: .5, z: .5 } };
    const second = JSON.parse(JSON.stringify(doc));
    second.document.gameplayVariables=[{id:"health",scope:"entity",type:"number",initial:100},{id:"keys",scope:"game",type:"number",initial:0}];
    second.document.behaviorFunctions=[
        {id:"heal",name:"Heal",inputs:[],outputs:[{id:"value",type:"number"}],locals:[{id:"result",type:"number"}],entry:"call",nodes:[
            {id:"call",kind:"call",functionId:"delayedHeal",inputs:[],outputs:[{id:"value",target:{kind:"local",id:"result"}}],next:"return"},
            {id:"return",kind:"return",values:[{id:"value",value:{kind:"local",id:"result"}}]}]},
        {id:"delayedHeal",name:"Delayed heal",inputs:[],outputs:[{id:"value",type:"number"}],locals:[{id:"result",type:"number"}],entry:"wait",nodes:[
            {id:"wait",kind:"delay",seconds:.1,next:"copy"},
            {id:"copy",kind:"local",variable:"result",operation:"set",value:{kind:"variable",scope:"entity",id:"health"},next:"add"},
            {id:"add",kind:"local",variable:"result",operation:"add",value:{kind:"literal",value:1},next:"tick"},
            {id:"tick",kind:"action",target:"self",action:{kind:"score",key:"ticks"},next:"return"},
            {id:"return",kind:"return",values:[{id:"value",value:{kind:"local",id:"result"}}]}]}
    ];
    second.document.nodes.lever = { ...hero, id: "lever", entity: { behavior: {version:5,enabled:true,nodes:[
        { id:"event",kind:"event",event:"interact",other:"player",next:"branch" },
        { id:"branch",kind:"branch",condition:{kind:"player"},onTrue:"spawn",onFalse:null },
        { id:"spawn",kind:"action",target:"self",action:{kind:"spawn",templateId:"template"},next:"score" },
        { id:"score",kind:"action",target:"self",action:{kind:"score",key:"uses"},next:"checkpoint" },
        { id:"checkpoint",kind:"action",target:"self",action:{kind:"checkpoint"},next:"hurt" },
        { id:"hurt",kind:"assign",scope:"entity",variable:"health",operation:"subtract",value:{kind:"literal",value:25},next:"key" },
        { id:"key",kind:"assign",scope:"game",variable:"keys",operation:"add",value:{kind:"literal",value:1},next:"repeat" },
        { id:"repeat",kind:"repeat",count:2,body:"heal",next:null },
        { id:"heal",kind:"call",functionId:"heal",inputs:[],outputs:[{id:"value",target:{kind:"variable",scope:"entity",id:"health"}}],next:null }
    ]} }, spatial3d: { transform: { ...hero.spatial3d.transform, position: { x: 1,y:0,z:0 } } } };
    second.document.behaviorAssets=[{id:"leverGraph",name:"Timed lever",graph:second.document.nodes.lever.entity.behavior}];
    second.document.nodes.lever.entity={behaviorAssetId:"leverGraph"};
    second.document.nodes.template = { ...hero, id: "template", hidden: true, entity: { body: "dynamic" },
        spatial3d: { ...hero.spatial3d, transform: { ...hero.spatial3d.transform, position: { x:100,y:0,z:0 } } } };
    second.document.rootNodeUuids.push("lever","template");
    doc.document.nodes.goal = { ...hero, id: "goal", entity: { body: "static", goal: true, transitionTo: "second.vde" },
        spatial3d: { transform: { ...hero.spatial3d.transform, position: { x: 1.05, y: 0, z: 0 } }, collider: hero.spatial3d.collider } };
    doc.document.rootNodeUuids.push("goal");
    const project = path.join(source, "entry.vde");
    fs.writeFileSync(project, JSON.stringify(doc)); fs.writeFileSync(path.join(source, "second.vde"), JSON.stringify(second));
    for (const name of ["triangle.gltf", "triangle.bin"]) fs.copyFileSync(path.join(root, "reference-projects", name), path.join(source, name));
    const output = await packageGame(project, path.join(temp, "export"));
    // Move the source away to prove that the player cannot accidentally fall back to it.
    fs.renameSync(source, path.join(temp, "source-unavailable"));
    const html = path.join(output, "app/game.html"), win = await createGameWindow(html, { show: false });
    win.webContents.setBackgroundThrottling(false);
    await until(win, 'document.getElementById("scene").dataset.presented === "true"');
    if (!await win.webContents.executeJavaScript('typeof window.electronAPI === "undefined" && typeof require === "undefined"')) throw new Error("Editor or Node authority leaked into player");
    await win.webContents.executeJavaScript('if(document.getElementById("pause").textContent === "Resume") document.getElementById("pause").click(); window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyD"}));');
    await until(win, 'document.getElementById("status").textContent.includes("level1")');
    await win.webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyD"})); window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyF"})); window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyF",repeat:true})); document.getElementById("save-progress").click();');
    await until(win, 'document.getElementById("progress-note").textContent.includes("Progress saved")');
    const progress = await win.webContents.executeJavaScript('window.playerProgress.read().then(JSON.parse)');
    if (progress.level !== "level1" || progress.spawns.length !== 1 || progress.tallies[0][1] !== 1) throw new Error("Interaction/save did not retain one instance and tally");
    if(progress.version!==6||progress.campaign?.levels?.map(level=>level.level).join()!=="level0"||progress.behaviors?.length!==1||progress.behaviors[0].stack[0].remaining!==2)throw new Error("Pending shared graph repeat or visited level was not saved");
    if(progress.behaviors[0].functions?.length!==2||JSON.stringify(progress).includes('"definitions"'))throw new Error("Nested function frames were not saved as data-only continuations");
    if(progress.data.entities.find(([id])=>id==="lever")?.[1].find(([id])=>id==="health")?.[1]!==75||progress.data.game.find(([id])=>id==="keys")?.[1]!==1)throw new Error("Typed entity/game values were not saved");
    await win.webContents.executeJavaScript('window.dispatchEvent(new Event("blur"))');
    await until(win, 'document.getElementById("status").dataset.state === "paused"');
    await win.webContents.executeJavaScript('document.getElementById("pause").click(); document.getElementById("start").click();');
    await until(win, 'document.getElementById("status").textContent.includes("level0") && document.getElementById("status").dataset.state === "running"');
    // Held D was cleared by blur/restart; the fresh entry must not transition on its own.
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await win.webContents.executeJavaScript('document.getElementById("status").textContent.includes("level0")')) throw new Error("Held movement leaked into restart");
    await win.webContents.executeJavaScript('document.getElementById("stop").click()');
    await until(win, 'document.getElementById("status").dataset.state === "stopped"');
    await win.webContents.executeJavaScript('document.getElementById("start").click()');
    await until(win, 'document.getElementById("status").dataset.state === "running"');
    const denied = await win.webContents.executeJavaScript('fetch("https://example.com/").then(()=>false,()=>true)');
    if (!denied) throw new Error("Player allowed network fetch");
    await win.webContents.executeJavaScript('window.open("https://example.com/");');
    if (BrowserWindow.getAllWindows().length !== 1) throw new Error("Player opened an external window");
    const before = win.webContents.getURL();
    await win.webContents.executeJavaScript('location.href="https://example.com/"; void 0;');
    await new Promise(resolve => setTimeout(resolve, 100));
    if (win.webContents.getURL() !== before) throw new Error("Player navigated away");
    win.destroy();
    const reopened = await createGameWindow(html, { show: false }); reopened.webContents.setBackgroundThrottling(false);
    await until(reopened, 'document.getElementById("scene").dataset.presented === "true"');
    await reopened.webContents.executeJavaScript('document.getElementById("load-progress").click()');
    await until(reopened, 'document.getElementById("progress-note").textContent.includes("Progress restored")');
    if (!await reopened.webContents.executeJavaScript('document.getElementById("status").textContent.includes("level1") && document.getElementById("status").dataset.state === "paused"')) throw new Error("New-window save restore failed");
    await until(reopened, 'document.getElementById("scene").__vde3DLastFrame?.frame.draws.length === 2');
    await reopened.webContents.executeJavaScript('document.getElementById("pause").click()');
    await until(reopened, `(async()=>{if(document.getElementById("pause").textContent==="Resume")document.getElementById("pause").click();await new Promise(resolve=>{let count=0;const frame=()=>{if(++count>=20)resolve();else requestAnimationFrame(frame);};requestAnimationFrame(frame);});document.getElementById("save-progress").click();await new Promise(r=>setTimeout(r,100));const p=JSON.parse(await window.playerProgress.read());return p.tallies.some(([key,value])=>key==="ticks"&&value===2)&&p.behaviors.length===0;})()`);
    const resumed=await reopened.webContents.executeJavaScript('window.playerProgress.read().then(JSON.parse)');
    if(resumed.data.entities.find(([id])=>id==="lever")?.[1].find(([id])=>id==="health")?.[1]!==77||resumed.data.game.find(([id])=>id==="keys")?.[1]!==1)throw new Error("Typed values did not resume exactly once across player reopen");
    await reopened.webContents.executeJavaScript('window.playerProgress.write("corrupt").then(()=>document.getElementById("load-progress").click())');
    await until(reopened, 'document.getElementById("progress-note").textContent.includes("Progress error")');
    if (!await reopened.webContents.executeJavaScript('document.getElementById("status").textContent.includes("level1")')) throw new Error("Corrupt save replaced current level");
    reopened.destroy();
    const corrupt = path.join(output, "app/corrupt.html");
    fs.writeFileSync(corrupt, fs.readFileSync(html, "utf8").replace(/data-sha256="[a-f0-9]{64}"/, `data-sha256="${"0".repeat(64)}"`));
    const bad = await createGameWindow(corrupt, { show: false }); bad.webContents.setBackgroundThrottling(false);
    await until(bad, 'document.getElementById("status").textContent.includes("integrity check failed")'); bad.destroy();
    clearTimeout(timeout); console.log("STANDALONE_PLAYER_SMOKE_READY: export, WebGL, input, levels, behavior graph interaction/branch/spawning, shared timers/repeats, typed values and checkpoint save/new-window continuation restore, corruption refusal, no editor/network authority"); app.exit(0);
}).catch(error => { clearTimeout(timeout); console.error(error.message); app.exit(1); });
