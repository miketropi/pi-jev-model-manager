/** Opt-in, sequential Plan → Implement → QA → Review execution, one pass only. */
export const PIPELINE_ENTRY = "jev-auto-pipeline";
export const PIPELINE_WIDGET = "jev-auto-pipeline-status";
export type PipelinePhase = "implement" | "qa" | "review" | "completed";
export type PipelineStatus = "running" | "paused" | "failed" | "completed" | "cancelled";
export type GateStage = "qa" | "review";
export type GateResult = {stage:GateStage;outcome:"pass"|"fail";evidence:string;findings?:string[]};
export interface PipelineState {
 planVersion:number;
 phase:PipelinePhase;
 status:PipelineStatus;
 qa?:GateResult;
 review?:GateResult;
 reason?:string;
}
export function startPipeline(planVersion:number):PipelineState {
 if(!Number.isInteger(planVersion)||planVersion<1)throw Error("Invalid approved plan version");
 return {planVersion,phase:"implement",status:"running"};
}
export function reportGate(stage:GateStage,outcome:"pass"|"fail",evidence:string,findings:string[]=[]):GateResult {
 const note=evidence?.trim();
 if(!note||note.length<12)throw Error("QA/Review requires factual verification evidence (minimum 12 characters).");
 if(!["pass","fail"].includes(outcome))throw Error("Invalid gate outcome.");
 return {stage,outcome,evidence:note.slice(0,1000),findings:findings.slice(0,16).map(x=>x.slice(0,240))};
}
export function advancePipeline(state:PipelineState, input:{
 implementationCompleted?:boolean; result?:GateResult; aborted?:boolean
}):PipelineState {
 if(state.status!=="running")return state;
 if(input.aborted)return {...state,status:"paused",reason:"Agent turn aborted"};
 if(state.phase==="implement"){
  return input.implementationCompleted
   ? {...state,phase:"qa",reason:undefined}
   : {...state,status:"paused",reason:"Implementation checklist has unverified steps"};
 }
 if(state.phase==="qa"||state.phase==="review"){
  const outcome=input.result;
  if(!outcome || outcome.stage!==state.phase)
   return {...state,status:"paused",reason:state.phase.toUpperCase()+" did not report a verified gate result"};
  if(outcome.outcome==="fail")
   return {...state,[state.phase]:outcome,status:"failed",reason:state.phase.toUpperCase()+" reported issues"};
  if(state.phase==="qa")return {...state,qa:outcome,phase:"review",reason:undefined};
  return {...state,review:outcome,phase:"completed",status:"completed",reason:undefined};
 }
 return state;
}
export function latestPipelineFromBranch(entries:readonly any[]):PipelineState|undefined {
 for(const e of [...entries].reverse())
  if(e?.type==="custom" && e.customType===PIPELINE_ENTRY &&
    Number.isInteger(e.data?.planVersion) && ["implement","qa","review","completed"].includes(e.data?.phase))
    return e.data as PipelineState;
}
export function pipelineLines(p:PipelineState):string[]{
 const phases:PipelinePhase[]=["implement","qa","review"];
 const marker=(phase:PipelinePhase)=>{
  if(p.phase==="completed")return "☑";
  if(phase==="implement" && p.phase!=="implement")return "☑";
  if(phase==="qa" && (p.phase==="review"||p.qa?.outcome==="pass"))return "☑";
  if(phase===p.phase && p.status==="running")return "◉";
  if(phase===p.phase && ["paused","failed"].includes(p.status))return "!";
  return "☐";
 };
 return ["JEV AUTO · "+p.status.toUpperCase()+" · plan v"+p.planVersion,
  ...phases.map(phase=>marker(phase)+" "+phase.toUpperCase()),
  ...(p.reason?["Reason: "+p.reason.slice(0,100)]:[]),
  "/jev-pipeline-status · /jev-pipeline-stop"];
}

export function nextPhasePrompt(stage:"qa"|"review",approvedPlan:string,originalRequest?:string):string {
 const context=[
  "[JEV AUTO PIPELINE — "+stage.toUpperCase()+"]",
  "This phase was explicitly authorized by the user when choosing Auto Implement > QA > Review.",
  "Approved plan (use as acceptance requirements):",
  approvedPlan.slice(0,32000),
  originalRequest?"Original request: "+originalRequest.slice(0,2000):"",
 ];
 if(stage==="qa")context.push(
  "Execute relevant functional/acceptance/regression checks of the actual implemented deliverable.",
  "Do not implement new features or rewrite the plan. If checks are impossible, report fail and explain blockers.",
  "When finished call jev_quality_gate with outcome pass/fail, concrete evidence and findings.",
  "The next Review phase starts ONLY if this gate passes."
 );
 else context.push(
  "Perform a read-only code/content review against the approved plan and actual Implementation/QA results.",
  "Inspect correctness, security, architecture and regressions; do not modify project files.",
  "When finished call jev_quality_gate with outcome pass/fail, concrete evidence and findings.",
  "The pipeline will complete ONLY if Review passes."
 );
 return context.filter(Boolean).join("\n\n");
}
