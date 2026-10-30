/** Opt-in Plan → Implement → QA → bounded Lead remediation → QA → Review. */
export const PIPELINE_ENTRY = "jev-auto-pipeline";
export const PIPELINE_WIDGET = "jev-auto-pipeline-status";
export type PipelinePhase = "implement" | "qa" | "review" | "completed";
export type PipelineStatus = "running" | "paused" | "failed" | "completed" | "cancelled";
export type GateStage = "qa" | "review";
export type GateResult = {stage:GateStage;outcome:"pass"|"fail";evidence:string;findings?:string[]};
export const MAX_QA_FIX_ROUNDS = 3;
export type QaDisposition = "fix" | "reject" | "needs_user";
export interface QaDecision {
  issueId:string;
  disposition:QaDisposition;
  rationale:string;
  evidence:string;
}
export interface QaRecovery {
  fixRounds:number; // successful Lead correction attempts, not QA passes
  fingerprints:string[];
  stage:"triage" | "fixing" | "verified";
  issues:{id:string;text:string}[];
  decisions?:QaDecision[];
  fixes?:{round:number;changedFiles:string[];evidence:string;verification:string;issueIds:string[]}[];
}
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
export interface StructuredQaIssue {
 location:string; observed:string; expected:string; evidence:string; suggestedFix:string;
}
/** Preserve actionable context while keeping previous findings[] API compatible. */
export function formatQaIssues(issues:StructuredQaIssue[]):string[] {
 if(!Array.isArray(issues)||issues.length>16)throw Error("Provide at most 16 QA issues.");
 return issues.map((i,index)=>{
  const fields=[i?.location,i?.observed,i?.expected,i?.evidence,i?.suggestedFix];
  if(fields.some(v=>typeof v!=="string"||v.trim().length<8))
    throw Error("QA issue "+(index+1)+" needs location, observed, expected, evidence and suggestedFix (at least 8 characters each).");
  return ("Location: "+i.location.trim()+"; Observed: "+i.observed.trim()+
    "; Expected: "+i.expected.trim()+"; Evidence: "+i.evidence.trim()+
    "; Suggested fix: "+i.suggestedFix.trim()).slice(0,400);
 });
}

export function reportGate(stage:GateStage,outcome:"pass"|"fail",evidence:string,findings:string[]=[]):GateResult {
 const note=evidence?.trim();
 if(!note||note.length<12)throw Error("QA/Review requires factual verification evidence (minimum 12 characters).");
 if(!["pass","fail"].includes(outcome))throw Error("Invalid gate outcome.");
 const issues=Array.isArray(findings)?findings.slice(0,16).map(x=>String(x).trim().slice(0,400)).filter(Boolean):[];
 if(outcome==="fail"&&stage==="qa"&&(!issues.length||issues.some(x=>x.length<12)))
   throw Error("Failed QA requires actionable findings (at least 12 characters per issue) with expected vs actual and evidence.");
 return {stage,outcome,evidence:note.slice(0,1000),findings:issues};
}
export function advancePipeline(state:PipelineState, input:{
 implementationCompleted?:boolean; result?:GateResult; aborted?:boolean
}):PipelineState {
 if(state.status!=="running")return state;
 if(input.aborted)return {...state,status:"paused",reason:"Agent turn aborted"};
 if(state.phase==="implement"){
  if(state.qaRecovery?.stage!=="verified" && state.qaRecovery)
    return {...state,status:"paused",reason:"Lead did not finish QA issue assessment/corrections; manual resume required"};
  return input.implementationCompleted
   ? {...state,phase:"qa",qa:undefined,reason:undefined}
   : {...state,status:"paused",reason:"Implementation checklist has unverified steps"};
 }
 if(state.phase==="qa"||state.phase==="review"){
  const outcome=input.result;
  if(!outcome||outcome.stage!==state.phase)
    return {...state,status:"paused",reason:state.phase.toUpperCase()+" did not report a verified gate result"};
  if(outcome.outcome==="fail"){
   if(state.phase==="review")
     return {...state,review:outcome,status:"failed",reason:"Review reported issues"};
   const previous=state.qaRecovery;
   const fingerprint=JSON.stringify((outcome.findings??[]).map(x=>
     x.trim().toLowerCase().replace(/\s+/g," ")).sort());
   if(!outcome.findings?.length)
     return {...state,qa:outcome,status:"paused",reason:"QA failure gave no actionable findings; manual review required"};
   if(previous?.fingerprints.includes(fingerprint))
     return {...state,qa:outcome,status:"paused",
       reason:"Repeated identical QA findings after correction; stopped to prevent a loop"};
   if((previous?.fixRounds??0)>=MAX_QA_FIX_ROUNDS)
     return {...state,qa:outcome,status:"paused",
       reason:"QA remediation budget exhausted after "+MAX_QA_FIX_ROUNDS+" correction rounds"};
   const recovery:QaRecovery={
     fixRounds:previous?.fixRounds??0,
     fingerprints:[...(previous?.fingerprints??[]),fingerprint],
     stage:"triage",issues:outcome.findings.map((text,i)=>({id:"QA"+(i+1),text})),
     fixes:previous?.fixes??[]
   };
   return {...state,qa:outcome,phase:"implement",status:"running",
     qaRecovery:recovery,reason:"Lead must assess QA feedback before correcting the deliverable"};
  }
  if(state.phase==="qa")return {...state,qa:outcome,phase:"review",reason:undefined};
  return {...state,review:outcome,phase:"completed",status:"completed",reason:undefined};
 }
 return state;
}
export function triageQaFeedback(state:PipelineState,decisions:QaDecision[]):PipelineState {
  const r=state.qaRecovery;
  if(state.phase!=="implement"||state.status!=="running"||r?.stage!=="triage")
    throw Error("No QA findings are awaiting Lead triage.");
  if(!Array.isArray(decisions)||decisions.length!==r.issues.length)
    throw Error("Lead must assess EVERY QA issue before remediation.");
  const expected=new Set(r.issues.map(i=>i.id));
  if(new Set(decisions.map(d=>d.issueId)).size!==expected.size ||
     decisions.some(d=>!expected.has(d.issueId)))
    throw Error("Unknown or duplicate QA issue ID.");
  for(const d of decisions) {
    if(!["fix","reject","needs_user"].includes(d.disposition) ||
      d.rationale?.trim().length<12 || d.evidence?.trim().length<12)
      throw Error("Each QA decision needs a valid disposition, rationale and supporting evidence.");
  }
  const normalized=decisions.map(d=>({...d,
    rationale:d.rationale.trim().slice(0,600),evidence:d.evidence.trim().slice(0,600)}));
  const pending=normalized.some(d=>d.disposition==="needs_user");
  const accepted=normalized.some(d=>d.disposition==="fix");
  return {...state,qaRecovery:{...r,stage:pending||!accepted?"triage":"fixing",decisions:normalized},
    ...(pending||!accepted?{status:"paused" as const,reason:pending
      ?"Lead identified QA feedback requiring user decision"
      :"Lead rejected all QA findings; manual review required"}:{reason:"Lead accepted actionable QA feedback; implement and verify corrections"})};
}

export function recordQaFix(state:PipelineState,input:{
 changedFiles:string[];evidence:string;verification:string;issueIds:string[];
}):PipelineState {
 const r=state.qaRecovery;
 if(state.status!=="running"||state.phase!=="implement"||r?.stage!=="fixing")
   throw Error("No accepted QA issues are awaiting verified Lead fixes.");
 const accepted=r.decisions?.filter(d=>d.disposition==="fix").map(d=>d.issueId)??[];
 if(!accepted.length||!Array.isArray(input.issueIds) ||
   input.issueIds.length!==accepted.length ||
   new Set(input.issueIds).size!==accepted.length ||
   accepted.some(id=>!input.issueIds.includes(id)))
   throw Error("All accepted QA issues must have verified fixes.");
 if(!Array.isArray(input.changedFiles)||input.changedFiles.length<1||
    input.changedFiles.length>30 ||input.changedFiles.some(f=>typeof f!=="string"||
      !f.trim() ||f.includes("..")||f.startsWith("/")))
   throw Error("Provide real project-relative files changed to address QA.");
 if(input.evidence?.trim().length<20||input.verification?.trim().length<20)
   throw Error("Lead must report concrete corrections and verification evidence (at least 20 characters each).");
 return {...state,qaRecovery:{...r,stage:"verified",fixRounds:r.fixRounds+1,
    fixes:[...(r.fixes??[]),{round:r.fixRounds+1,
      changedFiles:input.changedFiles.map(f=>f.trim().slice(0,240)),
      evidence:input.evidence.trim().slice(0,1000),
      verification:input.verification.trim().slice(0,1000),issueIds:[...accepted]}]},
      reason:"Lead recorded corrections; re-run QA against actual changes"};
}

export function qaRemediationPrompt(state:PipelineState,approvedPlan:string,request?:string):string {
 const r=state.qaRecovery;
 if(!r)throw Error("Missing QA feedback");
 return ["[JEV AUTO QA REMEDIATION — LEAD]",
   "This correction round was approved by the user in Auto Implement → QA → Review. You are Lead in writable Implementation mode; QA itself remains read-only.",
   "Approved plan: "+approvedPlan.slice(0,24000),
   request?"Original user request: "+request.slice(0,2000):"",
   "QA verdict evidence: "+(state.qa?.evidence??""),
   ...r.issues.map(i=>i.id+": "+i.text),
   "Before editing, inspect the actual deliverable and reproduce/check every finding against the approved requirements. A QA claim may be mistaken or unsupported.",
   "Call jev_qa_triage with one supported decision per issue: fix, reject or needs_user. Cite concrete file/source/test observations; never accept unsupported QA claims automatically.",
   "If any issue requires product judgment or sources do not support a safe change, select needs_user and PAUSE, not a speculative edit.",
   "For accepted issues, implement the narrow fixes, run real verification, then call jev_qa_fix with changedFiles, issueIds, evidence and verification. Do not self-declare QA PASS.",
   "There are at most "+MAX_QA_FIX_ROUNDS+" automatic correction rounds; unchanged QA failures stop further retries."
 ].filter(Boolean).join("\n\n");
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
  if(phase==="qa" && p.qa?.outcome==="fail")return "!";
  if(phase===p.phase && p.status==="running")return "◉";
  if(phase===p.phase && ["paused","failed"].includes(p.status))return "!";
  return "☐";
 };
 return ["JEV AUTO · "+p.status.toUpperCase()+" · plan v"+p.planVersion,
  ...phases.map(phase=>marker(phase)+" "+phase.toUpperCase()),
  ...(p.qaRecovery?["QA correction rounds: "+p.qaRecovery.fixRounds+"/"+MAX_QA_FIX_ROUNDS+
     " · Lead: "+p.qaRecovery.stage]:[]),
  ...(p.qa?.outcome==="fail" ? [
    "Most recent QA failure:",
    ...(p.qa.findings??[]).map((x,i)=>"QA"+(i+1)+": "+x.slice(0,380))
  ]:[]),
  ...(p.reason?["Reason: "+p.reason.slice(0,220)]:[]),
  "/jev-pipeline-status · /jev-pipeline-stop"];
}

export function nextPhasePrompt(stage:"qa"|"review",approvedPlan:string,originalRequest?:string,
  recovery?:QaRecovery):string {
 const context=[
  "[JEV AUTO PIPELINE — "+stage.toUpperCase()+"]",
  "This phase was explicitly authorized by the user when choosing Auto Implement > QA > Review.",
  "Approved plan (use as acceptance requirements):",
  approvedPlan.slice(0,32000),
  originalRequest?"Original request: "+originalRequest.slice(0,2000):"",
  ...(stage==="qa" && recovery?.fixes?.length?
    ["Prior QA correction attempts: "+recovery.fixes.map(f=>
      "Round "+f.round+" files "+f.changedFiles.join(", ")+
      " changes "+f.evidence+" checks "+f.verification).join("; ").slice(0,3500),
      "Independently re-test original requirements and previous failures. Lead's self-report is not a QA pass."] : []),
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
