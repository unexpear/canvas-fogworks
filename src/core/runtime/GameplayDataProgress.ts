/** @module GameplayDataProgress @description Bounded scalar save tables and declaration-aware staged restoration. */
import {GameplayValue,gameplayValueError} from "../document/GameplayData";
import {ReadonlyDocument} from "../document/Document";
import {GameplayDataState,emptyGameplayData,writeGameplayValue} from "./GameplayDataState";
export interface SavedGameplayData {game:[string,GameplayValue][];entities:[string,[string,GameplayValue][]][]}
export function validateGameplayDataProgress(value:unknown):asserts value is SavedGameplayData{
    const data=value as SavedGameplayData;
    if(!data||typeof data!=="object"||Array.isArray(data)||Object.keys(data).length!==2||!Array.isArray(data.game)||!Array.isArray(data.entities)||data.entities.length>16384)throw new Error("Invalid saved gameplay data.");
    const table=(rows:unknown)=>{
        if(!Array.isArray(rows)||rows.length>256)throw new Error("Invalid saved gameplay value table.");
        const ids=new Set<string>();
        for(const row of rows){
            if(!Array.isArray(row)||row.length!==2||typeof row[0]!=="string"||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(row[0])||ids.has(row[0])||gameplayValueError(row[1]))throw new Error("Invalid or duplicate saved gameplay value.");
            ids.add(row[0]);
        }
    };
    table(data.game);const owners=new Set<string>();
    for(const row of data.entities){
        if(!Array.isArray(row)||row.length!==2||typeof row[0]!=="string"||!row[0]||row[0].length>4096||/[\u0000-\u001f]/.test(row[0])||owners.has(row[0]))throw new Error("Invalid or duplicate saved gameplay owner.");
        owners.add(row[0]);table(row[1]);
    }
}
export function captureGameplayData(state:GameplayDataState|undefined):SavedGameplayData{
    return {game:[...(state?.game??[])],entities:[...(state?.entities??[])].map(([owner,values])=>[owner,[...values]])};
}
export function restoreGameplayData(doc:ReadonlyDocument,saved:SavedGameplayData|undefined):GameplayDataState{
    let state=emptyGameplayData();if(saved===undefined)return state;validateGameplayDataProgress(saved);
    const variables=doc.gameplayVariables??[];
    for(const [id,value]of saved.game)state=writeGameplayValue(state,variables,"","game",id,value);
    const entities=new Map(state.entities);
    for(const [owner,values]of saved.entities){
        if(!doc.nodes.has(owner))throw new Error("Unknown saved gameplay owner.");
        const restored=new Map<string,GameplayValue>();
        for(const [id,value]of values){const variable=variables.find(v=>v.scope==="entity"&&v.id===id);if(!variable||gameplayValueError(value,variable.type))throw new Error("Invalid saved gameplay declaration or type.");restored.set(id,value);}
        entities.set(owner,restored);
    }return {...state,entities};
}
