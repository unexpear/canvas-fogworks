/** @module smoke-player-blockout @description Exported asset-free blockout rendering, keyboard collision, save/relaunch and restart in the isolated player. */
const {app}=require("electron");
const fs=require("fs"),path=require("path"),os=require("os");
const {packageGame}=require("./package-game");
const {createGameWindow}=require("../src/player3d/desktopWindow");
const root=path.resolve(__dirname,".."),temp=fs.mkdtempSync(path.join(os.tmpdir(),"fogworks-blockout-player-"));
app.setPath("userData",path.join(temp,"profile"));app.on("window-all-closed",()=>{});
const timeout=setTimeout(()=>{console.error("Exported blockout smoke timed out");app.exit(1);},75000);
app.on("quit",()=>{
    clearTimeout(timeout);
    // Only remove the exclusively created disposable smoke directory, never a project/output supplied by a user.
    if(path.dirname(temp)===path.resolve(os.tmpdir())&&path.basename(temp).startsWith("fogworks-blockout-player-")){
        try{fs.rmSync(temp,{recursive:true,force:true});}catch{/* Chromium can briefly retain its disposable profile. */}
    }
});
async function until(win,expression,budget=10000){
    const deadline=Date.now()+budget;
    while(Date.now()<deadline){
        if(await win.webContents.executeJavaScript(expression))return;
        await new Promise(resolve=>setTimeout(resolve,50));
    }
    const status=await win.webContents.executeJavaScript('JSON.stringify({status:document.getElementById("status").textContent,frames:window.blockoutFrames})');
    throw Error(`Exported blockout condition timed out: ${expression}; ${status}`);
}
const heroX='document.getElementById("scene").__vde3DLastFrame?.frame.draws.find(d=>d.nodeId==="triangle")?.model[12]';
const resume='if(document.getElementById("pause").textContent==="Resume")document.getElementById("pause").click();';
async function holdAgainstWall(win){
    await win.webContents.executeJavaScript(`${resume}window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyD"}));`);
    await until(win,`${heroX}>=1.7`);
    console.log("Exported blockout: player reached wall");
    // Continue pushing after reaching the wall: merely sampling the first near-wall frame would not prove blocking.
    await win.webContents.executeJavaScript('window.blockoutFrames=0;const step=()=>{window.blockoutFrames++;if(window.blockoutFrames<12)requestAnimationFrame(step);};requestAnimationFrame(step);void 0;');
    // Hidden Windows sessions can deliver only about one frame per second even with
    // background throttling disabled. Keep the frame assertion, give it a bounded budget.
    await until(win,'window.blockoutFrames>=12',20000);
    await win.webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyD"}));');
    const x=await win.webContents.executeJavaScript(heroX);
    if(!(x>=1.7&&x<=1.8+1e-9))throw Error(`Exported room wall failed to stop the player: ${x}`);
    return x;
}
app.whenReady().then(async()=>{
    const source=path.join(temp,"source");fs.mkdirSync(source);
    const doc=JSON.parse(fs.readFileSync(path.join(root,"reference-projects/animated-3d.vde"),"utf8"));
    doc.version="88";doc.document.assets3d=[];
    const hero=doc.document.nodes.triangle;
    hero.entity={body:"dynamic",player:true};
    hero.spatial3d={transform:hero.spatial3d.transform,blockout:{kind:"box",width:.4,height:.4,depth:.4},blockoutCollision:true};
    hero.spatial3d.transform.position={x:0,y:0,z:0};
    for(const [id,x,shape] of [
        ["room",0,{kind:"room",width:4,height:3,depth:4,thickness:.2,ceiling:false}],
        ["ramp",-6,{kind:"ramp",width:2,height:1,depth:3}],
        ["stairs",6,{kind:"stairs",width:2,height:2,depth:3,steps:4}]
    ]){
        const node=JSON.parse(JSON.stringify(hero));node.id=id;node.entity={body:"static"};
        node.spatial3d.blockout=shape;node.spatial3d.transform.position={x,y:-1,z:0};
        if(id==="room"){
            const leaf=(id,shape,position=[0,0,0])=>({id,kind:"shape",shape,position,rotation:[0,0,0],scale:[1,1,1]});
            node.spatial3d.solidTree={id:"doorway",kind:"operation",operation:"subtract",left:leaf("room-base",shape),right:leaf("door",{kind:"box",width:1,height:2,depth:1},[0,0,2.1])};
            delete node.spatial3d.blockout;
        }
        doc.document.nodes[id]=node;doc.document.rootNodeUuids.push(id);
    }
    const project=path.join(source,"entry.vde");fs.writeFileSync(project,JSON.stringify(doc));
    const output=await packageGame(project,path.join(temp,"export"));
    fs.renameSync(source,path.join(temp,"source-unavailable"));
    const html=path.join(output,"app/game.html");
    let win=await createGameWindow(html,{show:false});win.setSize(420,320);win.webContents.setBackgroundThrottling(false);
    await until(win,'document.getElementById("scene").dataset.presented==="true"');
    console.log("Exported blockout: first frame presented");
    const geometry=await win.webContents.executeJavaScript('document.getElementById("scene").__vde3DLastFrame.frame.draws.map(d=>[d.nodeId,d.primitive.indices.length/3])');
    for(const [id,count] of [["triangle",12],["room",null],["ramp",8],["stairs",48]]){
        if(!geometry.some(([name,triangles])=>name===id&&(count===null?triangles>0:triangles===count)))throw Error(`Export lost generated ${id} geometry: ${JSON.stringify(geometry)}`);
    }
    if(!await win.webContents.executeJavaScript('typeof require==="undefined"&&typeof window.electronAPI==="undefined"'))throw Error("Editor authority leaked into blockout player");
    const stoppedX=await holdAgainstWall(win);
    console.log("Exported blockout: sustained wall collision verified");
    await win.webContents.executeJavaScript('document.getElementById("save-progress").click()');
    await until(win,'document.getElementById("progress-note").textContent.includes("Progress saved")');
    const saved=await win.webContents.executeJavaScript('window.playerProgress.read().then(JSON.parse)');
    if(Math.abs(saved.position.x-stoppedX)>1e-9||JSON.stringify(saved).includes('"vertices"'))throw Error("Blockout progress lost position or persisted derived hulls");
    win.destroy();win=await createGameWindow(html,{show:false});win.setSize(420,320);win.webContents.setBackgroundThrottling(false);
    console.log("Exported blockout: reopened player");
    await until(win,'document.getElementById("scene").dataset.presented==="true"');
    await win.webContents.executeJavaScript('document.getElementById("load-progress").click()');
    await until(win,'document.getElementById("progress-note").textContent.includes("Progress restored")');
    await until(win,`Math.abs(${heroX}-${stoppedX})<1e-9`);
    const restoredX=await holdAgainstWall(win);
    await win.webContents.executeJavaScript('document.getElementById("start").click()');
    await until(win,`Math.abs(${heroX})<1e-9`);
    await win.webContents.executeJavaScript(`${resume}window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyS"}));`);
    const heroZ=heroX.replace("model[12]","model[14]");
    await until(win,`${heroZ}>3`,15000);
    await win.webContents.executeJavaScript('window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyS"}));');
    const throughDoorZ=await win.webContents.executeJavaScript(heroZ);
    win.destroy();
    console.log("EXPORTED_BLOCKOUT_SMOKE_READY:",JSON.stringify({geometry,stoppedX,restoredX,throughDoorZ,sourceUnavailable:true}));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
