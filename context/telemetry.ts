/** Explicit observations only; no synthetic token measurements. */
import { contextBudget } from "./store.ts";
export interface ContextObservation {usedTokens:number; contextWindow:number; reserveTokens:number; at:string;}
export interface ContextHealth {ratio:number; usable:number; level:"normal"|"warning"|"critical"|"overflow";}
export function contextHealth(o:ContextObservation, warnAt=0.8):ContextHealth {
  if (![o.usedTokens,o.contextWindow,o.reserveTokens].every(Number.isFinite) || o.usedTokens<0 || o.contextWindow<=0 || o.reserveTokens<0) throw Error("Invalid context observation");
  const budget=contextBudget(o.usedTokens,o.contextWindow,o.reserveTokens);
  return {ratio:budget.ratio,usable:budget.usable,level:budget.overflow?"overflow":budget.ratio>=0.95?"critical":budget.ratio>=warnAt?"warning":"normal"};
}
export function isModelSwitchSafe(used:number,targetWindow:number,targetReserve:number,margin=0.05):boolean {
  if (![used,targetWindow,targetReserve,margin].every(Number.isFinite)) return false;
  if(used<0||targetWindow<=0||targetReserve<0||margin<0||margin>=1)return false;
  return used <= Math.max(0,targetWindow-targetReserve)*(1-margin);
}
