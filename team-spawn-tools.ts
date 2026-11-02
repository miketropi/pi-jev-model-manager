/**
 * Human opt-in and read-only status + guarded spawn tool.
 * No direct arbitrary executable or command strings enter an adapter.
 */
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import type {TaskType} from "./task-routing.ts";
import type {PeerCapabilities} from "./peer-capabilities.ts";
import {readConfig,saveConfig} from "./core/config.ts";
import {physicalCandidates} from "./routing/selectors.ts";
import {TeamSpawnController,type SpawnReceipt} from "./team-spawn-controller.ts";
import {HerdrSpawnAdapter,type SpawnAdapter} from "./team-spawn-adapters.ts";
import type {TeamSpawnInput} from "./team-spawn-controller.ts";
import {inferTeamDifficulty} from "./team-spawn-difficulty.ts";
export const TEAM_SPAWN_TOOL="jev_team_spawn";
export const TEAM_SPAWN_ENTRY="jev-team-spawn-receipt";
const reply=(value:unknown,error=false)=>({
 ...(error?{isError:true}:{}),
 content:[{type:"text" as const,text:typeof value==="string"?value:JSON.stringify(value,null,2)}]
});
export interface TeamSpawnBindings {
 getPhase:()=>TaskType|undefined;
 peers:PeerCapabilities;
 // Code-provided adapters supply their own read-only capability preflight.
 // Without an override, use the existing peer capability registry.
 probeAdapter?:(id:string)=>Promise<boolean>;
}
export function registerTeamSpawnTools(pi:ExtensionAPI,env:TeamSpawnBindings,
 adapters:readonly SpawnAdapter[]=[new HerdrSpawnAdapter()]):void {
 const inferred=new Map<string,{summary:string;difficulty:"small"|"normal"|"hard"}>();
 const controller=new TeamSpawnController(adapters,receipt=>{
  pi.appendEntry?.(TEAM_SPAWN_ENTRY,receipt);
 });
 pi.on?.("session_start",(_event:any,ctx:any)=>{
  controller.reset();inferred.clear();
  const entries=ctx.sessionManager?.getBranch?.()??[];
  const receipts=entries.filter((e:any)=>e?.type==="custom" &&
   e.customType===TEAM_SPAWN_ENTRY).map((e:any)=>e.data as SpawnReceipt);
  controller.restore(receipts);
 });
 pi.registerTool({
  name:TEAM_SPAWN_TOOL,label:"JEV · Team Spawn Controller",
  description:"Actually start a role-pinned Pi/OMP child through a verified spawn adapter (Herdr initially). Explicit opt-in, budget guarded and idempotent; separate from read-only jev_team_route.",
  defaultActive:true,
  promptSnippet:"To launch an IT team in an execution-capable phase, use jev_team_spawn(action=spawn) with a unique requestId, agent name, existing idle Herdr pane, role and platform. Do not spawn by shell, and do not retry after uncertain startup. Use action=status to inspect.",
  promptGuidelines:[
   "Required: /jev-team-spawn-on enabled by the human operator. Never start agents in Plan/Review/QA read-only phases.",
   "An existing idle shell pane must already exist; never invent a pane ID. Spawn never creates Herdr layouts.",
   "Always assign role: PM, Dev, QA, Reviewer, etc. Each child receives a physical model and thinking level. OMP non-PM workers get a process-only non-Plan overlay.",
   "Request ID must be stable for retries; if outcome is uncertain, inspect status and never submit another start with a different request ID.",
   "Herdr confirms ready agent identity, NOT the model's active backend. Verify model/mode in child UI before dispatching costly work.",
  ],
  parameters:{type:"object",additionalProperties:false,required:["action","name"],
   properties:{
    action:{type:"string",enum:["spawn","status"]},
    adapter:{type:"string",maxLength:32},
    requestId:{type:"string",minLength:5,maxLength:80},
    name:{type:"string",maxLength:32},
    paneId:{type:"string",maxLength:80},
    role:{type:"string",enum:["orchestrator","pm","dev","qa","reviewer","researcher"]},
    difficulty:{type:"string",enum:["small","normal","hard"]},
    taskSummary:{type:"string",maxLength:1200,description:"Optional concise task summary sent to configured TypeSafe Jev for difficulty inference when no difficulty is supplied; omit secrets."},
    platform:{type:"string",enum:["omp","pi"]},
   }} as any,
  async execute(_id,args,signal,_update,ctx){
   const adapter=args.adapter??"herdr";
   if(args.action==="status"){
    const result=await controller.status(adapter,args.name,signal);
    return reply({...result,receipt:controller.get(args.name)??null});
   }
   if(args.action!=="spawn")return reply("Invalid spawn action.",true);
   const phase=env.getPhase();
   if(phase==="plan"||phase==="review"||phase==="qa")
    return reply("Team spawning is disabled during strict read-only "+phase+
      ". Finish Planning and switch to execution before creating workers.",true);
   const config=readConfig();
   const {teamSpawn}=config;
   let difficulty=args.difficulty??"normal";
   if(!args.difficulty && config.enabled && teamSpawn.enabled &&
     typeof args.taskSummary==="string" && typeof args.requestId==="string"){
     const cache=inferred.get(args.requestId);
     if(cache && cache.summary===args.taskSummary)difficulty=cache.difficulty;
     else {
      const choice=await inferTeamDifficulty(args.taskSummary,ctx.modelRegistry,
        config.classifier,signal);
      difficulty=choice.difficulty;
      inferred.set(args.requestId,{summary:args.taskSummary,difficulty});
     }
   }
   const input:TeamSpawnInput={
    requestId:args.requestId??"",name:args.name??"",paneId:args.paneId??"",
    role:args.role??"" as any,difficulty,
    platform:args.platform??"omp",adapter,
   };
   const result=await controller.spawn(input,teamSpawn,
     physicalCandidates(config,ctx),config.taskRules,signal,
     async()=>env.probeAdapter?await env.probeAdapter(adapter):
       await env.peers.probe(adapter,config.peerAdapters,true)==="ready");
   // A structured tool result is preferable to claiming execution success
   // when a provider has not been verified in the independent child.
   return reply(result,!result.ok && result.code!=="unavailable");
  },
 } as any);
 pi.registerCommand("jev-team-spawn-on",{
  description:"Authorize spawning external agents through JEV's controlled adapter",
  handler:async(_args,ctx)=>{
   if(!ctx.hasUI || typeof ctx.ui.confirm!=="function"){
    ctx.ui?.notify?.("Enable team spawning from an interactive Pi/OMP session; confirmation is required.","warning");return;
   }
   const ok=await ctx.ui.confirm("Enable Team Spawn Controller?",
    "Allows an orchestrator to launch new external Pi/OMP processes into existing Herdr panes. Cost limits apply; model identity is checked only at launch, not guaranteed inside child. Continue?");
   if(!ok)return;
   const config=readConfig();
   config.teamSpawn.enabled=true;
   saveConfig(config);
   ctx.ui.notify("Team Spawn Controller enabled. Limits: "+
    config.teamSpawn.maxAgents+" agents, "+
    config.teamSpawn.maxConcurrentStarts+" simultaneous starts, "+
    config.teamSpawn.maxPremiumAgents+" premium agents. Use /jev-team-spawn-off to disable.","info");
  },
 });
 pi.registerCommand("jev-team-spawn-off",{
  description:"Disable further team spawn requests (does not stop existing agents)",
  handler:async(_args,ctx)=>{
   const config=readConfig();config.teamSpawn.enabled=false;saveConfig(config);
   if(ctx.hasUI)ctx.ui.notify("Team spawning disabled. Existing external agents are NOT stopped.","info");
  },
 });
 pi.registerCommand("jev-team-spawn-status",{
  description:"Display team spawning limits and current session's launch records",
  handler:async(_args,ctx)=>{
   const p=readConfig().teamSpawn;
   const rows=controller.getAll().map(r=>
    r.name+" · "+r.role+" · "+r.model+" · "+r.state+" (model unverified)");
   if(ctx.hasUI)ctx.ui.notify("Team Spawn Controller: "+(p.enabled?"ENABLED":"OFF")+
    "\nAdapters: herdr (others can register a SpawnAdapter)"+
    "\nLimits: "+p.maxAgents+" agents, "+p.maxConcurrentStarts+
    " simultaneous starts, "+p.maxPremiumAgents+" premium"+
    (p.maxCostUsdPerAgent>0?", OMP max $"+p.maxCostUsdPerAgent+"/agent":"")+
    "\n"+(rows.join("\n")||"No spawned agents in this session."),"info");
  },
 });
 return;
}
