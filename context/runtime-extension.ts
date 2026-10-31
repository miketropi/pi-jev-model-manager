/** Safe Context Intelligence v2: observes Pi usage and projects old outputs.
 * No Pi session rewrite, no external telemetry, no automatic model calls.
 */
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {homedir} from "node:os";
import {DEFAULT_RUNTIME_POLICY,normalizeRuntimePolicy,projectHistory,
 type ContextRuntimePolicy, type ContextMode} from "./runtime-policy.ts";
import {ContextProfiler} from "./runtime-profiler.ts";

const settingsPath=join(process.env.PI_CODING_AGENT_DIR ||
 join(homedir(),".pi","agent"),"jev-context-v2.json");
const ENTRY="jev-context-protected-checkpoint";
function readPolicy():ContextRuntimePolicy {
 try {return normalizeRuntimePolicy(existsSync(settingsPath)?
  JSON.parse(readFileSync(settingsPath,"utf8")):{});}catch{return DEFAULT_RUNTIME_POLICY;}
}
function writePolicy(p:ContextRuntimePolicy) {
 mkdirSync(dirname(settingsPath),{recursive:true,mode:0o700});
 const tmp=settingsPath+"."+process.pid+".tmp";
 writeFileSync(tmp,JSON.stringify(p,null,2),{mode:0o600});renameSync(tmp,settingsPath);
}
function usageOf(ctx:any) {try{return typeof ctx.getContextUsage==="function"?
 ctx.getContextUsage():undefined;}catch{return undefined;}}
function checkpointState(ctx:any):any {
 const branch=typeof ctx.sessionManager?.getBranch==="function"?
  ctx.sessionManager.getBranch():[];
 // Extract ONLY narrow state; never copy plan or tool outputs into another file.
 const last=(kind:string)=>[...branch].reverse().find((x:any)=>
  x?.type==="custom"&&x.customType===kind)?.data;
 const plan=last("jev-plan-document");
 const progress=last("jev-implementation-progress");
 const phase=last("jev-workflow-phase");
 const steps=Array.isArray(progress?.steps)?progress.steps.map((x:any)=>({
  id:x.id,status:x.status})).slice(0,32):[];
 return {phase:typeof phase?.task==="string"?phase.task:null,
  planVersion:Number.isInteger(plan?.version)?plan.version:null,
  planStatus:typeof plan?.status==="string"?plan.status:null,
  checklist:steps};
}
export function registerContextRuntime(pi:ExtensionAPI):void {
 const profiler=new ContextProfiler();
 let lastCheckpoint="";
 let lastModel="";
 pi.registerCommand("jev-context-report",{
  description:"Report observed Pi context, tool output sizes and compaction events (no content logged)",
  handler:async(_args,ctx)=>{profiler.observe(usageOf(ctx));
   ctx.ui.notify(profiler.report()+"\nOptimization: "+readPolicy().mode,"info");}
 });
 pi.registerCommand("jev-context-opt",{
  description:"Choose safe context optimization mode: on, observe, off (does not change Pi journal)",
  handler:async(args,ctx)=>{
   const mode=String(args??"").trim().toLowerCase();
   const next:ContextMode|undefined=mode==="on"?"optimize":
    mode==="observe"?"observe":mode==="off"?"off":undefined;
   if(!next){ctx.ui.notify("Usage: /jev-context-opt on|observe|off. Current: "+readPolicy().mode,"info");return;}
   const policy={...readPolicy(),mode:next};
   writePolicy(policy);
   ctx.ui.notify("Jev context projection: "+next+
     "\nOnly old successful read/search/bash outputs are shortened in the model view at high pressure. Pi session data remains intact.","info");
  }
 });
 pi.on?.("session_start",()=>{profiler.reset();lastCheckpoint="";lastModel="";});
 pi.on?.("model_select",(_event:any,ctx:any)=>{
  const model=ctx?.model?ctx.model.provider+"/"+ctx.model.id:"";
  if(lastModel && model && model!==lastModel)profiler.modelSwitch();
  if(model)lastModel=model;
 });
 pi.on?.("before_agent_start",(event:any)=>{
  if(typeof event?.systemPrompt==="string")profiler.systemPrompt(event.systemPrompt.length);
 });
 pi.on?.("tool_result",(event:any,ctx:any)=>{
  profiler.recordTool(String(event.toolName??"other"),event.content);
  profiler.observe(usageOf(ctx));
 });
 pi.on?.("context",(event:any,ctx:any)=>{
  const policy=readPolicy();
  if(policy.mode==="off")return;
  const usage=usageOf(ctx);
  profiler.observe(usage);
  const ratio=Number.isFinite(usage?.tokens)&&Number.isFinite(usage?.contextWindow)
   &&usage.contextWindow>0?usage.tokens/usage.contextWindow:null;
  const projection=projectHistory(event.messages??[],policy,ratio);
  if(!projection.optimized)return;
  profiler.reclaim(projection.savedChars,projection.optimized);
  return {messages:projection.messages};
 });
 pi.on?.("session_before_compact",(_event:any,ctx:any)=>{
  profiler.beforeCompact();
  profiler.observe(usageOf(ctx));
  if(readPolicy().mode==="off"||typeof pi.appendEntry!=="function")return;
  const state=checkpointState(ctx);
  const signature=JSON.stringify(state);
  if(signature===lastCheckpoint)return;
  lastCheckpoint=signature;
  // Persist metadata in Pi's existing session journal, NEVER an independent file.
  pi.appendEntry(ENTRY,{version:1,at:new Date().toISOString(),...state});
  // Do not override Pi compaction; its own summarizer preserves user decisions.
 });
 pi.on?.("session_compact",(_event:any,ctx:any)=>{
  profiler.compact();profiler.observe(usageOf(ctx));
 });
}
