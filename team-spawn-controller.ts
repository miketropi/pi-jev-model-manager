/**
 * Model-agnostic, idempotent spawn transaction controller.
 * Adapter implements only external execution; policy & budgets live here.
 */
import type {ManagedModel} from "./core/config.ts";
import type {TaskRules} from "./task-routing.ts";
import {resolveTeamRole,type Difficulty,type TeamRole,type TeamRoute} from "./team-routing.ts";
import type {TeamSpawnPolicy} from "./team-spawn-policy.ts";
import {confirmedIdentity,safeAgentName,safePaneId,type SpawnAdapter,
 type SpawnPlatform} from "./team-spawn-adapters.ts";
export interface TeamSpawnInput {
 requestId:string;name:string;paneId:string;role:TeamRole;
 difficulty:Difficulty;platform:SpawnPlatform;adapter:string;
}
export interface SpawnReceipt {
 requestId:string;name:string;paneId:string;adapter:string;
 role:TeamRole;model:string;thinking:string;relativeCost:string;
 state:"ready"|"uncertain";modelVerified:false;
 note:string;
}
export type SpawnResponse={ok:true;receipt:SpawnReceipt}|
 {ok:false;reason:string;code:string};
export type SpawnAudit=(receipt:SpawnReceipt)=>void;
const safeRequest=/^[a-zA-Z0-9][a-zA-Z0-9:_-]{4,79}$/;
export class TeamSpawnController {
 private readonly adapters=new Map<string,SpawnAdapter>();
 private readonly reservations=new Map<string,{fingerprint:string;result:Promise<SpawnResponse>}>();
 private readonly receipts=new Map<string,SpawnReceipt>();
 private starting=0;
 private startingPremium=0;
 private readonly audit?:SpawnAudit;
 constructor(adapters:readonly SpawnAdapter[],audit?:SpawnAudit){
  this.audit=audit;
  for(const adapter of adapters){
   if(!/^[a-z][a-z0-9_-]{0,31}$/.test(adapter.id)||
    this.adapters.has(adapter.id))throw Error("Invalid/duplicate spawn adapter");
   this.adapters.set(adapter.id,adapter);
  }
 }
 reset(){this.reservations.clear();this.receipts.clear();this.starting=0;this.startingPremium=0;}
 get(name:string){return this.receipts.get(name);}
 getAll(){return [...this.receipts.values()];}
 restore(receipts:readonly SpawnReceipt[]){
  for(const item of receipts){
   if(safeAgentName.test(item.name)&&safePaneId.test(item.paneId)&&
     item.state && (item.state==="ready"||item.state==="uncertain"))
     this.receipts.set(item.name,item);
  }
 }
 private denied(code:string,reason:string):SpawnResponse{return {ok:false,code,reason};}
 async status(adapterId:string,name:string,signal?:AbortSignal):
 Promise<{state:string;name:string;modelVerified:false}>{
  const adapter=this.adapters.get(adapterId);
  if(!adapter || !safeAgentName.test(name))return {state:"invalid",name,modelVerified:false};
  const observation=await adapter.lookup(name,signal);
  const saved=this.receipts.get(name);
  if(observation.state==="present" && saved &&
    confirmedIdentity(observation,saved.name,saved.paneId)){
    if(saved.state!=="ready"){
     const receipt={...saved,state:"ready" as const};
     this.receipts.set(name,receipt);this.audit?.(receipt);
    }
  }
  return {state:observation.state==="present"?
    (saved&&confirmedIdentity(observation,saved.name,saved.paneId)?
     "ready (model not verified)":"occupied") :observation.state,
    name,modelVerified:false};
 }
 async spawn(input:TeamSpawnInput,config:TeamSpawnPolicy,
  models:readonly ManagedModel[],rules:TaskRules,signal?:AbortSignal,
  preflight?:()=>Promise<boolean>):Promise<SpawnResponse>{
  if(!config.enabled)return this.denied("disabled","Team Spawn Controller is disabled; run /jev-team-spawn-on explicitly.");
  if(!safeRequest.test(input.requestId)||!safeAgentName.test(input.name)||
    !safePaneId.test(input.paneId)||!["omp","pi"].includes(input.platform))
   return this.denied("invalid","Invalid request ID, agent name, pane or platform.");
  const adapter=this.adapters.get(input.adapter);
  if(!adapter)return this.denied("unsupported","Spawn adapter not installed. No command was executed.");
  const fingerprint=JSON.stringify(input);
  const existing=this.reservations.get(input.requestId);
  if(existing)return existing.fingerprint===fingerprint?existing.result:
    this.denied("conflict","Request ID was already used for another spawn.");
  const prior=this.receipts.get(input.name);
  if(prior){
   if(prior.requestId===input.requestId && prior.paneId===input.paneId &&
     prior.adapter===input.adapter && prior.role===input.role)
    return {ok:true,receipt:prior};
   return this.denied("occupied","Agent name already reserved by this session; inspect status instead of spawning twice.");
  }
  const choice=resolveTeamRole(input.role,input.difficulty,models,rules);
  if(!choice.ok)return this.denied("routing",choice.error);
  const route=choice.route;
  if(route.cost==="premium" &&
    this.getAll().filter(x=>x.relativeCost==="premium").length+
      this.startingPremium>=config.maxPremiumAgents)
   return this.denied("premium_budget","Premium-agent limit reached. No automatic expensive fallback.");
  if(this.receipts.size+this.starting>=config.maxAgents)
   return this.denied("team_budget","Maximum team agents reached.");
  if(this.starting>=config.maxConcurrentStarts)
   return this.denied("concurrency","Maximum concurrent starts reached; retry with a NEW request ID after current starts settle.");
  if(config.maxCostUsdPerAgent>0&&input.platform!=="omp")
   return this.denied("unsupported_cost_cap","Hard per-agent USD limit is implemented only for OMP; cannot enforce it for Pi.");
  this.starting++;
  if(route.cost==="premium")this.startingPremium++;
  // Reserve before first await. All uncertain outcomes must not be retried.
  const run=this.doSpawn(adapter,input,route,config,signal,preflight)
   .finally(()=>{this.starting--;if(route.cost==="premium")this.startingPremium--;});
  this.reservations.set(input.requestId,{fingerprint,result:run});
  return run;
 }
 private async doSpawn(adapter:SpawnAdapter,input:TeamSpawnInput,route:TeamRoute,
  config:TeamSpawnPolicy,signal?:AbortSignal,
  preflight?:()=>Promise<boolean>):Promise<SpawnResponse>{
  try{
   if(preflight && !(await preflight()))
    return this.denied("unavailable","Optional spawn service is not attached/healthy. No agent started.");
   // A running agent under this name is never overwritten.
   const before=await adapter.lookup(input.name,signal);
   if(before.state!=="absent")
    return this.denied(before.state==="present"?"occupied":"unverified",
      before.state==="present"?"Agent name is already occupied.":
        "Could not verify that the name is free; refusing unsafe spawn.");
   const flags=[...route.cliArgs];
   if(input.platform==="omp"){
    if(route.role!=="pm"){
     // URL resolution is independent of the host working directory.
     const {fileURLToPath}=await import("node:url");
     flags.push("--config",fileURLToPath(new URL("./assets/omp-team-worker.yml",import.meta.url)));
    }
    if(config.maxCostUsdPerAgent>0)
     flags.push("--max-cost",String(config.maxCostUsdPerAgent));
   }
   let observed;
   try {
    observed=await adapter.start({...input,args:flags,timeoutMs:30000},signal);
   } catch {
    // Unknown outcome: Herdr may have launched the agent before CLI timed out.
    const uncertain=this.record(input,route,"uncertain",
      "Spawn outcome uncertain. Inspect status; NEVER retry automatically.");
    return {ok:true,receipt:uncertain};
   }
   // Herdr start already awaits readiness, but inspect identity once more to
   // avoid trusting an unrelated shell pane or stale name.
   let checked;
   try{checked=await adapter.lookup(input.name,signal);}
   catch{checked={state:"unknown" as const};}
   const valid=confirmedIdentity(checked,input.name,input.paneId)&&
    confirmedIdentity(observed,input.name,input.paneId);
   const receipt=this.record(input,route,valid?"ready":"uncertain",
    valid?"Herdr confirmed agent identity and pane. Physical model not independently verified.":
      "Startup output could not be cross-verified; inspect agent status before dispatch. Do not retry.");
   return {ok:true,receipt};
  }catch{
   return this.denied("preflight_failed",
    "Spawn preflight could not be completed. No CLI start was attempted unless a prior uncertain receipt exists.");
  }
 }
 private record(input:TeamSpawnInput,route:TeamRoute,state:SpawnReceipt["state"],note:string){
  const receipt:SpawnReceipt={requestId:input.requestId,name:input.name,
   paneId:input.paneId,adapter:input.adapter,role:route.role,
   model:route.model,thinking:route.thinking,relativeCost:route.cost,
   state,modelVerified:false,note};
  this.receipts.set(input.name,receipt);this.audit?.(receipt);
  return receipt;
 }
}
