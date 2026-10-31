import {boundAgentReport} from "../context/subagent-brief.ts";
import { changeProgress, progressLines } from "../progress.ts";
import { cleanPlanMirror } from "../plan-cache.ts";
import { DELEGATION_ENTRY, createDelegationSchedule, subagentReady, scheduleInstructions, nextDelegationWave, recordDelegationRun, fallbackDelegationToLead, delegatePrompt, type DelegationSchedule, type ProposedTask } from "../delegation.ts";
import { reportGate, triageQaFeedback, recordQaFix, formatQaIssues } from "../auto-pipeline.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readConfig } from "../core/config.ts";
import type { RuntimeBindings } from "./contracts.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER="jev-manager";
const ROUTER_ID="auto";
export function registerWorkflowTools(pi: ExtensionAPI, env: RuntimeBindings): void {
  const { savePipeline, cancelPipeline, showProgress, saveProgress, closeProgress, showPlanSummary, savePlan, createImplementationSession, openPlan, changeWorkflow, runWorkflowCommand } = env;
  if (typeof pi.registerTool === "function") pi.registerTool({
    name:"jev_progress",label:"Jev · Implementation Checklist",
    description:"Report the current implementation step, verified completion, or a blocker. Use after each meaningful step; never mark done without verification.",
    promptSnippet:"Update the live Jev implementation checklist as you work.",
    promptGuidelines:["When in Jev IMPLEMENT mode, call jev_progress for each step change. Set status=done only with a factual verification note. Never claim untested work is complete."],
    parameters:{type:"object",properties:{
      action:{type:"string",enum:["list","update","set_steps"]},
      stepId:{type:"number"},status:{type:"string",enum:["active","done","blocked"]},
      note:{type:"string"},
      steps:{type:"array",items:{type:"string"},maxItems:16},
    },required:["action"],additionalProperties:false} as any,
    async execute(_id,params,_signal,_onUpdate,ctx) {
      const p=env.implementationProgress;
      if (env.workflowTask !== "implement" || !p)
        return {isError:true,content:[{type:"text",text:"No active implementation checklist. Select Implement now first."}]};
      try{
        if(params.action==="update"){
          if(!Number.isInteger(params.stepId)||!["active","done","blocked"].includes(params.status))
            throw Error("Supply valid stepId and status.");
          if(params.status==="done" && env.delegationSchedule?.version===p.version){
            const waveIndex=env.delegationSchedule.waves.findIndex(w=>w.execution==="builder" &&
              w.tasks.some(t=>t.stepId===params.stepId));
            if(waveIndex>=0 && !env.delegationSchedule.runs?.some(r=>
              r.wave===waveIndex && r.status==="reported")){
              const attempt=env.delegationSchedule.runs?.find(r=>r.wave===waveIndex);
              throw Error("Builder wave "+(waveIndex+1)+" has "+
                (attempt?.status==="error"?"a recorded error":"no successful subagent report")+
                ". Inspect partial edits and verify them before recovery. "+
                "Use jev_delegate(action=lead,wave="+(waveIndex+1)+
                ",reason=...) in Prefer/Direct, then mark done with factual evidence.");
            }
            const leadFallback=env.delegationSchedule.fallbacks?.some(f=>
              env.delegationSchedule!.waves[f.wave]?.tasks.some(t=>t.stepId===params.stepId));
            if(leadFallback && (typeof params.note!=="string"||params.note.trim().length<12))
              throw Error("Lead fallback completion requires meaningful verification evidence (at least 12 characters).");
          }
          saveProgress(changeProgress(p,params.stepId,params.status,params.note),ctx);
        } else if(params.action==="set_steps"){
          if(!Array.isArray(params.steps)||!params.steps.length||params.steps.length>16
            ||p.steps.some(s=>s.status==="done"))throw Error("Cannot replace completed checklist.");
          const steps=params.steps.map((x:string,i:number)=>({id:i+1,title:String(x).slice(0,110),
            status:(i===0?"active":"pending") as "active"|"pending"}));
          saveProgress({...p,steps,stage:"running",visible:true},ctx);
        }
        const current=env.implementationProgress!;
        if(current.stage==="complete")cleanPlanMirror(env.trackedSessionId);
        return {content:[{type:"text",text:progressLines(current,24).join("\n")}],
          details:current};
      }catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}
    },
  });

  if (typeof pi.registerTool === "function") pi.registerTool({
    name:"jev_quality_gate",label:"Jev · QA/Review verdict",
    description:"Record verified QA/Review results. Failed QA must include individual actionable findings; Jev can route them to bounded Lead remediation.",
    defaultActive:false,
    promptSnippet:"Record verified QA/Review pass or fail for the active Jev pipeline.",
    promptGuidelines:["When running automatic QA/Review, call jev_quality_gate exactly once with observed verification. For failed QA, prefer issues[] with location, observed, expected, evidence and suggestedFix for EVERY problem; legacy findings[] remains available. QA must not edit files."],
    parameters:{type:"object",required:["outcome","evidence"],additionalProperties:false,
      properties:{
        outcome:{type:"string",enum:["pass","fail"]},
        evidence:{type:"string",minLength:12,maxLength:1000},
        findings:{type:"array",items:{type:"string",minLength:12,maxLength:400},maxItems:16},
        issues:{type:"array",maxItems:16,items:{type:"object",
          required:["location","observed","expected","evidence","suggestedFix"],
          additionalProperties:false,properties:{
            location:{type:"string",minLength:8,maxLength:240},
            observed:{type:"string",minLength:8,maxLength:240},
            expected:{type:"string",minLength:8,maxLength:240},
            evidence:{type:"string",minLength:8,maxLength:400},
            suggestedFix:{type:"string",minLength:8,maxLength:400}
          }}},
      }} as any,
    async execute(_id,params,_signal,_onUpdate,ctx){
      if(!env.autoPipeline || env.autoPipeline.status!=="running"
        || !["qa","review"].includes(env.autoPipeline.phase)
        || env.workflowTask !== env.autoPipeline.phase)
        return {isError:true,content:[{type:"text",
          text:"No active automatic QA/Review phase. Manual phases are not auto-gated."}]};
      try{
        const stage=env.workflowTask as "qa"|"review";
        if(env.autoPipeline[stage])throw Error("Already recorded this phase verdict; wait for the pipeline transition.");
        const findings=Array.isArray(params.issues)&&params.issues.length
          ? formatQaIssues(params.issues)
          : params.findings??[];
        const gate=reportGate(stage,params.outcome,params.evidence,findings);
        savePipeline({...env.autoPipeline,[stage]:gate},ctx);
        return {content:[{type:"text",text:stage.toUpperCase()+" verdict recorded: "+
          gate.outcome+". Evidence: "+gate.evidence+
          (gate.findings?.length?"\nIssues: "+gate.findings.join("\n"):"")}],details:gate};
      }catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}
    },
  });

  if (typeof pi.registerTool === "function") pi.registerTool({
    name:"jev_qa_triage",label:"Jev · Assess QA Feedback",
    description:"Lead reviews EACH failed QA issue for correctness/evidence before editing. Decide fix, reject or needs_user; invalid/unsupported claims must not trigger speculative edits.",
    defaultActive:false,
    promptSnippet:"Assess every QA finding with actual evidence before applying corrections.",
    parameters:{type:"object",required:["decisions"],additionalProperties:false,
      properties:{decisions:{type:"array",minItems:1,maxItems:16,items:{
        type:"object",required:["issueId","disposition","rationale","evidence"],
        additionalProperties:false,properties:{
          issueId:{type:"string"},
          disposition:{type:"string",enum:["fix","reject","needs_user"]},
          rationale:{type:"string",minLength:12,maxLength:600},
          evidence:{type:"string",minLength:12,maxLength:600}
        }}}}} as any,
    async execute(_id,params,_signal,_update,ctx){
      try{
        if(env.workflowTask!=="implement"||env.autoPipeline?.status!=="running")
          throw Error("Lead QA triage only runs during active Implementation remediation.");
        const updated=triageQaFeedback(env.autoPipeline,params.decisions);
        savePipeline(updated,ctx);
        return {content:[{type:"text",text:
          "Lead assessment recorded: "+updated.qaRecovery!.decisions!
            .map(d=>d.issueId+"="+d.disposition+" ("+d.rationale+")").join("; ")+
          (updated.status==="paused"
            ?"\nAutomatic correction PAUSED: "+updated.reason+
              ". Review /jev-pipeline-status; ask the user before continuing."
            :"\nFix accepted issues now; verify real edits, then call jev_qa_fix. Do not self-pass QA.")}],
          details:updated};
      }catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}
    }
  });

  if (typeof pi.registerTool === "function") pi.registerTool({
    name:"jev_qa_fix",label:"Jev · Verify QA Fixes",
    description:"Lead records corrections and verification for ALL accepted QA issues. Only then will the pipeline re-run read-only QA.",
    defaultActive:false,
    promptSnippet:"After actually editing and checking accepted issues, report changed files and verification before rerunning QA.",
    parameters:{type:"object",required:["changedFiles","issueIds","evidence","verification"],
      additionalProperties:false,properties:{
        changedFiles:{type:"array",minItems:1,maxItems:30,items:{type:"string"}},
        issueIds:{type:"array",minItems:1,maxItems:16,items:{type:"string"}},
        evidence:{type:"string",minLength:20,maxLength:1000},
        verification:{type:"string",minLength:20,maxLength:1000}
      }} as any,
    async execute(_id,params,_signal,_update,ctx){
      try{
        if(env.workflowTask!=="implement"||env.autoPipeline?.status!=="running")
          throw Error("No active Lead QA correction phase.");
        const updated=recordQaFix(env.autoPipeline,params);
        savePipeline(updated,ctx);
        return {content:[{type:"text",text:"Lead corrections recorded with verification. "+
          "Finish this turn to rerun QA read-only. QA has NOT passed yet."}],
          details:updated};
      }catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}
    }
  });

  if (typeof pi.registerTool === "function") pi.registerTool({
    name:"jev_delegate",label:"Jev · Delegate Implementation Tasks",
    description:"Schedule approved checklist steps conservatively, then actually execute Builder waves using Pi's native subagent tool (isolated process). Lead must verify results before updating jev_progress. Actions: plan, run, lead, status.",
    defaultActive:false,
    promptSnippet:"Use jev_delegate to plan independent scoped implementation tasks and run Builder waves. Lead verifies every wave before checking off steps.",
    promptGuidelines:["Only in Jev IMPLEMENT: call jev_delegate(action=plan) with each checklist step, relative file ownership, dependencies and estimated effort. Call action=run to execute one verified-ready wave. Never declare a subagent successful without reviewing the tool result and running checks."],
    parameters:{type:"object",required:["action"],additionalProperties:false,properties:{
      action:{type:"string",enum:["plan","run","lead","status"]},
        reason:{type:"string",minLength:12,maxLength:240},
        wave:{type:"integer",minimum:1},
      tasks:{type:"array",maxItems:16,items:{type:"object",required:["stepId","files","dependsOn","effort"],
        additionalProperties:false,properties:{
          stepId:{type:"integer"},files:{type:"array",items:{type:"string"},maxItems:24},
          dependsOn:{type:"array",items:{type:"integer"},maxItems:16},
          effort:{type:"string",enum:["small","medium","large"]},
        }}},
    }} as any,
    async execute(_id,params,signal,onUpdate,ctx){
      if(env.workflowTask!=="implement" || !env.implementationProgress ||
        !env.planDocument || env.planDocument.status!=="approved")
        return {isError:true,content:[{type:"text",text:"jev_delegate requires an approved plan in Jev Implementation mode."}]};
      const config=readConfig().delegation;
      try {
        const toolNames=typeof pi.getAllTools==="function" ? pi.getAllTools().map(t=>t.name) : [];
        const nativeAvailable=subagentReady(toolNames) && typeof (ctx as any).executeTool==="function";
        const unavailableReason="Native Pi subagent unavailable; NO Builder was spawned.";
        const saveSchedule=(schedule:DelegationSchedule)=>{
          env.delegationSchedule=schedule;
          pi.appendEntry(DELEGATION_ENTRY,schedule);
        };
        if(params.action==="plan"){
          if(!Array.isArray(params.tasks))throw Error("Supply tasks with step IDs, file scopes, dependencies and effort");
          let schedule=createDelegationSchedule(env.implementationProgress,
            params.tasks as ProposedTask[],config);
          if(!nativeAvailable && config.strategy!=="always")
            schedule=fallbackDelegationToLead(schedule,env.implementationProgress,unavailableReason,
              {allowStrategyChange:config.strategy!=="always"});
          saveSchedule(schedule);
          const fallback=schedule.fallbacks?.length;
          return {content:[{type:"text",text:scheduleInstructions(schedule,env.planDocument.markdown)+
            "\nNative Pi subagent: "+(nativeAvailable?"AVAILABLE":"NOT AVAILABLE")+
            (fallback?" · pending Builder waves switched to Lead. NO Builder was spawned.":
             !nativeAvailable?" · Always Delegate prevents automatic Lead fallback; change the strategy if needed.":"")+
            "\nCall jev_delegate(action=run) for the next wave, verify actual work and report it with jev_progress."}],
            details:{schedule,nativeSubagentAvailable:nativeAvailable}};
        }
        if(!env.delegationSchedule || env.delegationSchedule.version!==env.implementationProgress.version)
          throw Error("Create a delegation schedule first (jev_delegate action=plan).");
        if(params.action==="lead"){
          if(config.strategy==="always")throw Error("Always Delegate is enabled. Change execution strategy to Prefer or Direct before Lead fallback.");
          const waveNumber=params.wave===undefined?undefined:Number(params.wave);
          if(waveNumber!==undefined && (!Number.isInteger(waveNumber)||waveNumber<1))
            throw Error("Supply a one-based positive wave number.");
          const updated=fallbackDelegationToLead(env.delegationSchedule,env.implementationProgress,
            params.reason,{allowErroredRun:true,allowStrategyChange:true,
              wave:waveNumber===undefined?undefined:waveNumber-1});
          if(updated===env.delegationSchedule)
            return {content:[{type:"text",text:"No unfinished Builder waves need Lead fallback."}],details:env.delegationSchedule};
          saveSchedule(updated);
          return {content:[{type:"text",text:"Pending Builder waves switched to audited Lead fallback. NO Builder success was recorded. Inspect any partial changes, implement outstanding steps directly, verify files/tests, then use jev_progress.\n"+
            scheduleInstructions(updated,env.planDocument.markdown)}],details:{schedule:updated,execution:"lead"}};
        }
        if(params.action==="status"){
          // Inspect even if an earlier Builder wave is already dispatched or
          // errored. nextDelegationWave intentionally refuses unsafe reruns.
          const outstanding=env.delegationSchedule.waves.map((wave,i)=>{
            const pending=wave.tasks.filter(t=>
              env.implementationProgress!.steps.find(s=>s.id===t.stepId)?.status!=="done");
            if(!pending.length)return undefined;
            const run=env.delegationSchedule!.runs?.find(r=>r.wave===i);
            return "Wave "+(i+1)+" · "+wave.execution.toUpperCase()+
              " · "+(run?.status??"not dispatched")+
              " · steps "+pending.map(t=>"#"+t.stepId).join(", ")+
              (env.delegationSchedule!.fallbacks?.some(f=>f.wave===i)?" · audited Lead fallback":"");
          }).filter(Boolean);
          const message=scheduleInstructions(env.delegationSchedule,env.planDocument.markdown)+
            "\n"+(outstanding.length?"Pending: \n"+outstanding.join("\n"):
              "All scheduled waves are verified.");
          return {content:[{type:"text",text:message}],details:env.delegationSchedule};
        }
        if(params.action!=="run")throw Error("Unknown delegation action");
        if(!nativeAvailable && config.strategy!=="always"){
          const updated=fallbackDelegationToLead(env.delegationSchedule,env.implementationProgress,unavailableReason,
            {allowStrategyChange:true});
          if(updated!==env.delegationSchedule)saveSchedule(updated);
        }
        const next=nextDelegationWave(env.delegationSchedule,env.implementationProgress);
        if(!next)
          return {content:[{type:"text",text:"All scheduled tasks have been verified by the Lead."}]};
        const {index,wave}=next;
        if(wave.execution==="lead"){
          return {content:[{type:"text",text:"Wave "+(index+1)+
            " is a direct Lead task"+(env.delegationSchedule.fallbacks?.some(f=>f.wave===index)
              ?" (fallback: no Builder execution was credited)":"")+
            ". Complete it in this session, verify it, then use jev_progress. "+
            wave.tasks.map(t=>"#"+t.stepId+" "+t.title).join("; ")}],
            details:{wave:index+1,execution:"lead"}};
        }
        if(!nativeAvailable){
          return {isError:true,content:[{type:"text",
            text:"Pi native subagent unavailable. NO Builder was spawned. Always Delegate is enabled: change strategy to Prefer/Direct or enable Pi subagent, then /reload. Do not claim a Builder result."}]};
        }
        const tasks=wave.tasks.map(t=>({
          agent:env.delegationSchedule!.builderAgent,
          task:delegatePrompt(t,env.planDocument!.markdown),
        }));
        // Only one wave at a time. Scheduler enforces <=2 non-overlapping
        // file scopes; nested tool calls use Pi's tool validator / abort signal.
        const call=tasks.length===1?{...tasks[0],agentScope:"user"}:
          {tasks,agentScope:"user"};
        if(ctx.hasUI)ctx.ui.setStatus("jev-builders",
          "Jev BUILDERS · "+tasks.length+" running · wave "+(index+1));
        const noSpawn=(message:string)=>/\b(?:no builder was spawned|no subagent was spawned|native pi subagent (?:extension )?unavailable)\b/i.test(message);
        const switchToLead=(reason:string)=>{
          if(config.strategy==="always")return {isError:true,content:[{type:"text",text:
            "NO Builder was spawned. Always Delegate is enabled; switch to Prefer/Direct or enable your Pi subagent before retrying."}]};
          const updated=fallbackDelegationToLead(env.delegationSchedule!,env.implementationProgress!,
             "Native Pi subagent returned no spawned Builder: "+reason.slice(0,130),
            {allowStrategyChange:true});
          saveSchedule(updated);
          return {content:[{type:"text",text:"NO Builder was spawned. Switched unfinished Builder waves to audited Lead fallback. Implement and verify each task directly, then call jev_progress with factual verification.\n"+
            scheduleInstructions(updated,env.planDocument!.markdown)}],details:{execution:"lead",schedule:updated}};
        };
        // Missing Builder output can coexist with partial file writes. Never
        // credit a successful run or retry that wave without verification.
        const recoverError=(explanation:string,details?:unknown)=>{
          const errored=recordDelegationRun(env.delegationSchedule!,index,"error",explanation);
          const steps=wave.tasks.map(t=>"#"+t.stepId).join(", ");
          if(config.strategy!=="always" && !signal?.aborted){
            const updated=fallbackDelegationToLead(errored,env.implementationProgress!,
              "Builder wave "+(index+1)+" had an unverified result: "+explanation.slice(0,140),
              {allowErroredRun:true,wave:index});
            saveSchedule(updated);
            return {content:[{type:"text",text:"Builder wave "+(index+1)+" ERROR · "+steps+
              " · "+explanation+
              "\nRecovered ONLY this wave to audited Lead execution. NO successful Builder result recorded; NO checklist step auto-completed. "+
              "Lead must inspect partial edits, verify source evidence and tests, finish missing work, "+
              "then call jev_progress(action=update,status=done) with a factual verification note. "+
              "Future pending Builder waves remain delegated."}],
              details:{wave:index+1,status:"lead-verification-required",builderStatus:"error",
                delegation:updated,subagent:details}};
          }
          saveSchedule(errored);
          return {isError:true,content:[{type:"text",text:"Builder wave "+(index+1)+" ERROR · "+steps+
            " · "+explanation+
            "\nNo Builder success recorded; checklist remains unverified. "+
            (signal?.aborted?"Run was aborted; inspect partial edits before any recovery.":
              "Always Delegate is enabled. Switch to Prefer/Direct and call "+
              "jev_delegate(action=lead,wave="+(index+1)+",reason=...) after inspecting partial edits.")}],
            details:{wave:index+1,status:"error",delegation:errored,subagent:details}};
        };
        let result:any;
        try {
          result=await (ctx as any).executeTool("subagent",call,{signal,onUpdate});
        } catch(error){
          const message=error instanceof Error?error.message:String(error);
          if(noSpawn(message))return switchToLead(message);
          return recoverError("Subagent tool threw: "+message.slice(0,350));
        } finally {
          if(ctx.hasUI)ctx.ui.setStatus("jev-builders",undefined);
        }
        const content=Array.isArray(result?.content)?result.content.filter(
          (c:any)=>c.type==="text").map((c:any)=>String(c.text)).join("\n"):"";
        if(noSpawn(content))return switchToLead(content);
        const failed=result?.isError===true || !Array.isArray(result?.content)
          || !content.trim();
        if(failed)return recoverError(result?.isError===true
          ? "Subagent reported an error: "+(content.trim().slice(0,700)||"no text returned")
          : "Subagent returned no text; partial file edits may exist.",result?.details);
        env.delegationSchedule=recordDelegationRun(env.delegationSchedule,index,"reported",content);
        pi.appendEntry(DELEGATION_ENTRY,env.delegationSchedule);
        return {isError:false,content:[{type:"text",text:"Builder wave "+(index+1)+
          " reported · "+wave.tasks.map(t=>"#"+t.stepId).join(", ")+
          "\nLEAD MUST inspect changed files and tests before marking done.\n"+
          boundAgentReport(content)}],
          details:{wave:index+1,status:"reported",delegation:env.delegationSchedule,
            reportChars:content.length,shortened:content.length>7500}};
      }catch(e){
        return {isError:true,content:[{type:"text",text:e instanceof Error?e.message:String(e)}]};
      }
    }
  });

}
