/** @module GameplayDataState @description Immutable typed entity/game values and checked arithmetic for graph execution. */
import {GameplayValue,GameplayVariable,GameplayScope,GameplaySource,gameplayValueError,gameplaySourceError} from "../document/GameplayData";
export interface GameplayDataState {
    game:ReadonlyMap<string,GameplayValue>;
    entities:ReadonlyMap<string,ReadonlyMap<string,GameplayValue>>;
}
export const emptyGameplayData=():GameplayDataState=>({game:new Map(),entities:new Map()});
function declaration(variables:readonly GameplayVariable[],scope:GameplayScope,id:string){
    const found=variables.find(v=>v.scope===scope&&v.id===id);
    if(!found)throw new Error("Undeclared gameplay variable: "+scope+"/"+id);
    return found;
}
export function readGameplayValue(state:GameplayDataState,variables:readonly GameplayVariable[],owner:string,scope:GameplayScope,id:string):GameplayValue{
    const variable=declaration(variables,scope,id),table=scope==="game"?state.game:state.entities.get(owner);
    const value=table?.has(id)?table.get(id)!:variable.initial,error=gameplayValueError(value,variable.type);
    if(error)throw new Error(error);return value;
}
export function resolveGameplaySource(source:GameplaySource,state:GameplayDataState,variables:readonly GameplayVariable[],owner:string,inputs:ReadonlyMap<string,GameplayValue>=new Map()):GameplayValue{
    const error=gameplaySourceError(source);if(error)throw new Error(error);
    if(source.kind==="literal")return source.value;
    if(source.kind==="variable")return readGameplayValue(state,variables,owner,source.scope,source.id);
    if(!inputs.has(source.id))throw new Error("Missing function input value.");
    const value=inputs.get(source.id)!;const invalid=gameplayValueError(value);if(invalid)throw new Error(invalid);return value;
}
export function writeGameplayValue(state:GameplayDataState,variables:readonly GameplayVariable[],owner:string,scope:GameplayScope,id:string,value:GameplayValue):GameplayDataState{
    const variable=declaration(variables,scope,id),error=gameplayValueError(value,variable.type);if(error)throw new Error(error);
    if(scope==="game"){const game=new Map(state.game);game.set(id,value);return {...state,game};}
    if(!owner||owner.length>4096)throw new Error("Gameplay entity values need a bounded owner ID.");
    if(!state.entities.has(owner)&&state.entities.size>=16384)throw new Error("Gameplay entity value table limit exceeded.");
    const entities=new Map(state.entities),values=new Map(entities.get(owner));values.set(id,value);entities.set(owner,values);
    return {...state,entities};
}
export type GameplayOperation="set"|"add"|"subtract"|"multiply"|"divide";
export function assignGameplayValue(state:GameplayDataState,variables:readonly GameplayVariable[],owner:string,scope:GameplayScope,id:string,operation:GameplayOperation,value:GameplayValue):GameplayDataState{
    if(operation==="set")return writeGameplayValue(state,variables,owner,scope,id,value);
    const current=readGameplayValue(state,variables,owner,scope,id);
    return writeGameplayValue(state,variables,owner,scope,id,gameplayArithmetic(current,operation,value));
}
/** Shared checked arithmetic for gameplay storage and per-call local storage. */
export function gameplayArithmetic(current:GameplayValue,operation:Exclude<GameplayOperation,"set">,value:GameplayValue):number{
    if(typeof current!=="number"||typeof value!=="number")throw new Error("Arithmetic requires numeric gameplay values.");
    if(operation==="divide"&&value===0)throw new Error("Gameplay division by zero is refused.");
    let next:number;
    switch(operation){
        case "add":next=current+value;break;
        case "subtract":next=current-value;break;
        case "multiply":next=current*value;break;
        case "divide":next=current/value;break;
        default:throw new Error("Unknown gameplay arithmetic operation.");
    }
    const error=gameplayValueError(next,"number");if(error)throw new Error(error);return next;
}
