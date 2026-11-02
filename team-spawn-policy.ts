/** Explicit opt-in limits; relative cost tiers are not live prices. */
export interface TeamSpawnPolicy {
 enabled:boolean;
 maxAgents:number;
 maxConcurrentStarts:number;
 maxPremiumAgents:number;
 maxCostUsdPerAgent:number; // 0 disables the OMP CLI dollar cap
}
export const DEFAULT_TEAM_SPAWN:TeamSpawnPolicy={
 enabled:false,maxAgents:5,maxConcurrentStarts:2,maxPremiumAgents:1,
 maxCostUsdPerAgent:0,
};
export function normalizeTeamSpawn(raw:unknown):TeamSpawnPolicy {
 const d=DEFAULT_TEAM_SPAWN;
 if(!raw||typeof raw!=="object")return {...d};
 const x=raw as Record<string,unknown>;
 const clamp=(v:unknown,min:number,max:number,fallback:number)=>
  Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max?Number(v):fallback;
 return {
  enabled:x.enabled===true,
  maxAgents:clamp(x.maxAgents,1,12,d.maxAgents),
  maxConcurrentStarts:clamp(x.maxConcurrentStarts,1,4,d.maxConcurrentStarts),
  maxPremiumAgents:clamp(x.maxPremiumAgents,0,4,d.maxPremiumAgents),
  maxCostUsdPerAgent:typeof x.maxCostUsdPerAgent==="number"&&Number.isFinite(x.maxCostUsdPerAgent)&&
   x.maxCostUsdPerAgent>=0&&x.maxCostUsdPerAgent<=50?
    x.maxCostUsdPerAgent:d.maxCostUsdPerAgent,
 };
}
