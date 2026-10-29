/** Conservative planning for delegated Implementation work.
 * Pi subagent extension performs the actual spawning. Jev never executes
 * untrusted plans or marks parent checklist steps completed automatically.
 */
import type { Progress } from "./progress.ts";

export const DELEGATION_ENTRY="jev-implementation-delegation";
export type Strategy="prefer"|"always"|"direct";
export interface DelegationSettings {
 strategy:Strategy;
 maxConcurrentBuilders:number;
 builderAgent:string;
}
export const DEFAULT_DELEGATION:DelegationSettings={
 strategy:"prefer",maxConcurrentBuilders:2,builderAgent:"worker"
};
export function normalizeDelegation(value:unknown):DelegationSettings {
 const raw=value&&typeof value==="object"?value as Record<string,unknown>:{};
 const strategy=["prefer","always","direct"].includes(String(raw.strategy))
   ?raw.strategy as Strategy:"prefer";
 const maxConcurrentBuilders=Number.isInteger(raw.maxConcurrentBuilders)
   ?Math.max(1,Math.min(2,raw.maxConcurrentBuilders as number)):2;
 const builderAgent=typeof raw.builderAgent==="string"&&
   /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/.test(raw.builderAgent)
   ?raw.builderAgent:"worker";
 return {strategy,maxConcurrentBuilders,builderAgent};
}
export interface ProposedTask {
 stepId:number;
 files:string[];
 dependsOn:number[];
 effort:"small"|"medium"|"large";
}
export interface ScheduledTask extends ProposedTask {
 title:string;
 execution:"lead"|"builder";
 reason:string;
}
export interface Wave {execution:"lead"|"builder";tasks:ScheduledTask[]}
export interface DelegationSchedule {
 version:number;
 waves:Wave[];
 strategy:Strategy;
 maxConcurrentBuilders:number;
 builderAgent:string;
 runs?: DelegationRun[];
}
export interface DelegationRun {
 wave:number;
 status:"reported"|"error";
 summary:string;
 at:string;
}
export function nextDelegationWave(schedule:DelegationSchedule,progress:Progress):
 {index:number;wave:Wave}|undefined {
 if(schedule.version!==progress.version)throw Error("Delegation is for a different plan version");
 for(let i=0;i<schedule.waves.length;i++){
  const wave=schedule.waves[i];
  const statuses=wave.tasks.map(t=>progress.steps.find(s=>s.id===t.stepId)?.status);
  if(statuses.every(s=>s==="done"))continue;
  if(statuses.some(s=>s==="done"))
   throw Error("Partially verified wave: verify remaining tasks before continuing");
  for(const task of wave.tasks){
   for(const dep of task.dependsOn)
    if(progress.steps.find(s=>s.id===dep)?.status!=="done")
     throw Error("Dependency #"+dep+" has not been verified by Lead");
  }
  if(schedule.runs?.some(r=>r.wave===i))
   throw Error("Wave "+(i+1)+" was already dispatched. Verify results before any retry.");
  return {index:i,wave};
 }
}
export function recordDelegationRun(schedule:DelegationSchedule, wave:number,
 status:"reported"|"error",summary:string,date=new Date()):DelegationSchedule {
 if(!schedule.waves[wave]||schedule.runs?.some(r=>r.wave===wave))
  throw Error("Unknown or previously dispatched delegation wave");
 return {...schedule,runs:[...(schedule.runs??[]),{wave,status,
   summary:summary.slice(0,2500),at:date.toISOString()}]};
}
function scopedPath(input:string):string {
 const path=input.trim().replaceAll("\\","/");
 const segments=path.split("/");
 if(!path || path.startsWith("/") || path.includes("\0") ||
  segments.some(s=>!s||s==="."||s==="..") ||
  /^[A-Za-z]:/.test(path) || path.includes("*") ||
  path.includes("?") || path.includes(":"))
  throw Error("Unsafe or ambiguous file scope: "+path.slice(0,90));
 return path;
}
function overlaps(a:readonly string[],b:readonly string[]):boolean {
 return a.some(x=>b.some(y=>x===y || x.startsWith(y+"/") || y.startsWith(x+"/")));
}
export function createDelegationSchedule(progress:Progress, proposals:ProposedTask[],
 settings:DelegationSettings):DelegationSchedule {
 const config=normalizeDelegation(settings);
 if(!Array.isArray(proposals)||!proposals.length || proposals.length>16)
  throw Error("Provide 1–16 checklist task proposals");
 const lookup=new Map(progress.steps.map(s=>[s.id,s]));
 const seen=new Set<number>();
 const tasks:ScheduledTask[]=proposals.map(raw=>{
  if(!Number.isInteger(raw.stepId)||seen.has(raw.stepId)||!lookup.has(raw.stepId))
   throw Error("Unknown or duplicate checklist stepId");
  seen.add(raw.stepId);
  const step=lookup.get(raw.stepId)!;
  if(step.status==="done") throw Error("Already verified step cannot be delegated");
  if(!["small","medium","large"].includes(raw.effort))throw Error("Invalid effort");
  if(!Array.isArray(raw.files)||raw.files.length>24||!Array.isArray(raw.dependsOn)||
   raw.dependsOn.length>16)throw Error("Invalid file scopes/dependencies");
  const files=[...new Set(raw.files.map(scopedPath))];
  const dependsOn=[...new Set(raw.dependsOn)];
  if(dependsOn.some(n=>!Number.isInteger(n)||n===raw.stepId||!lookup.has(n)))
   throw Error("Unknown or circular self-dependency");
  const builder=config.strategy!=="direct" &&
   (config.strategy==="always" || raw.effort!=="small");
  return {...raw,files,dependsOn,title:step.title,execution:builder?"builder":"lead",
   reason:builder?"Bounded subagent task":"Small/direct implementation task"};
 });
 for(const t of tasks)
  for(const dep of t.dependsOn) {
   const target=lookup.get(dep)!;
   if(target.status!=="done"&&!seen.has(dep))
    throw Error("Dependency step "+dep+" is pending but not included in delegation batch");
  }
 const waiting=[...tasks],waves:Wave[]=[],done=new Set(progress.steps.filter(s=>s.status==="done").map(s=>s.id));
 while(waiting.length){
  const ready=waiting.filter(t=>t.dependsOn.every(dep=>done.has(dep)));
  if(!ready.length)throw Error("Circular dependency between implementation steps");
  const first=ready[0];
  const group=[first];
  if(first.execution==="builder" && first.files.length>0) {
   for(const task of ready.slice(1)) {
    if(group.length>=config.maxConcurrentBuilders)break;
    if(task.execution==="builder"&&task.files.length>0 &&
       group.every(peer=>!overlaps(peer.files,task.files)))group.push(task);
   }
  }
  // Unknown file scopes serialize execution, never speculate about safety.
  waves.push({execution:first.execution,tasks:group});
  for(const item of group) {
   waiting.splice(waiting.indexOf(item),1);
   done.add(item.stepId);
  }
 }
 return {version:progress.version,waves,strategy:config.strategy,
  maxConcurrentBuilders:config.maxConcurrentBuilders,builderAgent:config.builderAgent};
}
export function latestDelegation(entries:readonly any[]):DelegationSchedule|undefined {
 for(const e of [...entries].reverse())
  if(e?.type==="custom"&&e.customType===DELEGATION_ENTRY)
   return Number.isInteger(e.data?.version)&&Array.isArray(e.data?.waves)
     ?e.data as DelegationSchedule:undefined;
}
export function subagentReady(toolNames:readonly string[]):boolean {
 return toolNames.includes("subagent");
}
export function delegatePrompt(step:ScheduledTask,approvedPlan:string):string {
 return [
  "JEV BUILDER TASK #"+step.stepId+" — "+step.title,
  "You are a bounded coding Builder. Implement only this task and never change unrelated files.",
  "Allowed change scope: "+(step.files.length?step.files.join(", "):"unknown — do not start without clarifying scope"),
  "Dependencies already completed: "+(step.dependsOn.length?step.dependsOn.join(", "):"none"),
  "Approved plan (source of truth):",approvedPlan.slice(0,12000),
  "Run focused tests. Do not commit or publish. Do not spawn other subagents.",
  "Report: files modified, tests actually run with outcomes, unresolved problems, and verification evidence.",
  "Do not call jev_progress; only the Lead may mark the parent checklist done."
 ].join("\n\n");
}
export function scheduleInstructions(schedule:DelegationSchedule,plan:string):string {
 const lines=["JEV DELEGATION WAVES · "+schedule.strategy+" · up to "+schedule.maxConcurrentBuilders+" builders"];
 for(let i=0;i<schedule.waves.length;i++){
  const wave=schedule.waves[i];
  lines.push("Wave "+(i+1)+" ("+wave.execution+", "+wave.tasks.length+" task(s))");
  for(const t of wave.tasks)
   lines.push("  #"+t.stepId+": "+t.title+" | files: "+(t.files.join(", ")||"unscoped"));
 }
 const current=schedule.waves[0];
 if(current?.execution==="builder"){
  const tasks=current.tasks.map(t=>({agent:schedule.builderAgent,task:delegatePrompt(t,plan)}));
  lines.push("Suggested native Pi subagent tool arguments:\n"+
   JSON.stringify(tasks.length===1?tasks[0]:{tasks},null,2).slice(0,24000));
 }
 return lines.join("\n");
}
