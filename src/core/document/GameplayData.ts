/** @module GameplayData @description Explicit gameplay scalar declarations and function-port contracts, separate from design tokens. */
export type GameplayValue = number | boolean | string;
export type GameplayType = "number" | "boolean" | "string";
export type GameplayScope = "entity" | "game";
export type GameplayVariable = {id:string;scope:GameplayScope} & (
    {type:"number";initial:number} | {type:"boolean";initial:boolean} | {type:"string";initial:string});
export interface GameplayPort {id:string;type:GameplayType}
export type GameplaySource =
    | {kind:"literal";value:GameplayValue}
    | {kind:"variable";scope:GameplayScope;id:string}
    | {kind:"input";id:string};
export const GAMEPLAY_VARIABLE_LIMIT=256;
export const gameplayIdOK=(id:unknown):id is string=>typeof id==="string"&&/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(id);
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const only=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));
export function gameplayValueError(value:unknown,type?:GameplayType):string|null {
    if(type!==undefined&&typeof value!==type)return "Gameplay value does not match its declared type.";
    if(typeof value==="number")return Number.isFinite(value)&&Math.abs(value)<=1e9?null:"Gameplay numbers must be finite and within ±1000000000.";
    if(typeof value==="boolean")return null;
    if(typeof value==="string")return value.length<=4096?null:"Gameplay strings are limited to 4096 characters.";
    return "Gameplay values must be numbers, booleans or strings.";
}
export function gameplayVariablesError(value:unknown):string|null {
    if(value===undefined)return null;
    if(!Array.isArray(value)||value.length>GAMEPLAY_VARIABLE_LIMIT)return "At most 256 gameplay variables are allowed.";
    const seen=new Set<string>();
    for(const v of value){
        if(!record(v)||!only(v,["id","scope","type","initial"])||!gameplayIdOK(v.id)
            ||!["entity","game"].includes(v.scope as string)||!["number","boolean","string"].includes(v.type as string))
            return "Invalid gameplay variable declaration.";
        const key=v.scope+"/"+v.id;if(seen.has(key))return "Duplicate gameplay variable in the same scope.";
        seen.add(key);const error=gameplayValueError(v.initial,v.type as GameplayType);if(error)return error;
    }return null;
}
export function gameplayPortsError(value:unknown):string|null {
    if(!Array.isArray(value)||value.length>64)return "Function signatures allow at most 64 ports.";
    const seen=new Set<string>();
    for(const p of value){
        if(!record(p)||!only(p,["id","type"])||!gameplayIdOK(p.id)||seen.has(p.id)||!["number","boolean","string"].includes(p.type as string))
            return "Invalid or duplicate function port.";
        seen.add(p.id);
    }return null;
}
export function gameplaySourceError(value:unknown):string|null {
    if(!record(value))return "Invalid gameplay value source.";
    if(value.kind==="literal")return only(value,["kind","value"])?gameplayValueError(value.value):"Unknown literal field.";
    if(value.kind==="variable")return only(value,["kind","scope","id"])&&gameplayIdOK(value.id)&&["entity","game"].includes(value.scope as string)?null:"Invalid gameplay variable reference.";
    if(value.kind==="input")return only(value,["kind","id"])&&gameplayIdOK(value.id)?null:"Invalid function input reference.";
    return "Unknown gameplay value source.";
}
export function gameplaySourceType(source:GameplaySource,variables:readonly GameplayVariable[],inputs:readonly GameplayPort[]=[]):GameplayType {
    const error=gameplaySourceError(source);if(error)throw new Error(error);
    if(source.kind==="literal")return typeof source.value as GameplayType;
    const declaration=source.kind==="input"?inputs.find(p=>p.id===source.id):variables.find(v=>v.id===source.id&&v.scope===source.scope);
    if(!declaration)throw new Error("Missing gameplay variable or function input.");
    return declaration.type;
}
