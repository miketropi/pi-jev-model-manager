import { type TaskType } from "../task-routing.ts";
import { WORKFLOW_ENTRY, isStrictPhase, toolsForPhase } from "../workflow.ts";
import { HERDR_PLAN_TOOL } from "../herdr-collaboration.ts";
import { COLLABORATION_TOOL } from "../collaboration-adapters.ts";
import type {PeerCapabilities} from "../peer-capabilities.ts";
import { PLAN_ENTRY, PLAN_MESSAGE, PLAN_UI_ENTRY, nextPlan, planPreview, implementationHandoff, type PlanDocument } from "../plan-artifact.ts";
import { choosePlanReviewAction } from "../plan-review-ui.ts";
import { MASCOT_WIDGET_KEY } from "../mascot.ts";
import { PROGRESS_ENTRY, PROGRESS_WIDGET, newProgress, progressLines, type Progress } from "../progress.ts";
import { savePlanMirror, cleanPlanMirror } from "../plan-cache.ts";
import { DELEGATION_ENTRY, type DelegationSchedule } from "../delegation.ts";
import { SESSION_ORIGIN_ENTRY, SESSION_LAUNCH_ENTRY, createOrigin, latestSessionLaunch, handoffTitle, type HandoffMode } from "../implementation-session.ts";
import { PIPELINE_ENTRY, startPipeline, type PipelineState } from "../auto-pipeline.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../core/config.ts";
import { isRoutingActive, setPlanReviewActive, stopJevling, repaintJevling } from "../ui/mascot-controller.ts";
import { activateJev } from "../ui/activation.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER="jev-manager";
const ROUTER_ID="auto";
export interface WorkflowBindings {
  peers?:PeerCapabilities;
  workflowTask: TaskType | undefined;
  toolsBeforeStrictPhase: string[] | undefined;
  planDocument: PlanDocument | undefined;
  planSummaryVisible: boolean;
  implementationHandoffPending: boolean;
  planOriginalRequest: string | undefined;
  implementationProgress: Progress | undefined;
  trackedSessionId: string | undefined;
  progressToolInjected: boolean;
  delegationToolInjected: boolean;
  nativeSubagentInjected: boolean;
  delegationSchedule: DelegationSchedule | undefined;
  autoPipeline: PipelineState | undefined;
  pipelineGateInjected: boolean;
  qaRecoveryToolsInjected: string[];
}
export function createWorkflowController(pi: ExtensionAPI, env: WorkflowBindings) {
  function savePipeline(p: PipelineState, ctx: ExtensionContext): void {
    env.autoPipeline = p;
    pi.appendEntry(PIPELINE_ENTRY, p);
    if (ctx.hasUI) {
      ctx.ui.setStatus("jev-pipeline", ["cancelled","completed"].includes(p.status) ? undefined
        : "AUTO " + p.phase.toUpperCase() + " · " + p.status.toUpperCase());
    }
  }
  function cancelPipeline(ctx: ExtensionContext, reason = "Stopped by user"): void {
    if (!env.autoPipeline || ["cancelled","completed"].includes(env.autoPipeline.status)) return;
    savePipeline({...env.autoPipeline,status:"cancelled",reason},ctx);
  }


  function showProgress(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const p = env.implementationProgress;
    const visible = env.workflowTask === "implement" && p?.visible
      && p.stage !== "complete" && p.stage !== "cancelled";
    const rows=visible ? progressLines(p!) : undefined;
    if(rows && env.delegationSchedule?.version===p?.version){
      for(let i=1;i<rows.length;i++){
        const number=Number(/^.[ ]+(\d+)\./.exec(rows[i])?.[1]);
        const assigned=env.delegationSchedule.waves.find(w=>w.tasks.some(t=>t.stepId===number));
        if(assigned?.execution==="builder")rows[i]+=" · Builder";
        else if(assigned && env.delegationSchedule.fallbacks?.some(f=>
          env.delegationSchedule!.waves[f.wave]===assigned))rows[i]+=" · Lead fallback";
      }
    }
    ctx.ui.setWidget(PROGRESS_WIDGET,rows);
  }

  function saveProgress(p: Progress, ctx: ExtensionContext): void {
    env.implementationProgress = p;
    pi.appendEntry(PROGRESS_ENTRY, p);
    showProgress(ctx);
  }

  function closeProgress(ctx: ExtensionContext): void {
    if (env.implementationProgress && env.implementationProgress.stage !== "complete") {
      saveProgress({...env.implementationProgress,stage:"cancelled",visible:false},ctx);
    } else {
      if (ctx.mode === "tui") ctx.ui.setWidget(PROGRESS_WIDGET,undefined);
    }
    cleanPlanMirror(env.trackedSessionId);
  }

  function showPlanSummary(ctx: ExtensionContext, show: boolean, persist = true): void {
    const nextVisible = show && env.planDocument?.status === "draft";
    if (persist && nextVisible !== env.planSummaryVisible)
      pi.appendEntry(PLAN_UI_ENTRY, { visible: nextVisible });
    env.planSummaryVisible = nextVisible;
    if (ctx.mode === "tui") ctx.ui.setWidget("jev-plan-summary",
      env.planSummaryVisible && env.planDocument ? planPreview(env.planDocument) : undefined);
  }

  function savePlan(document: PlanDocument, ctx: ExtensionContext): void {
    env.planDocument = document;
    pi.appendEntry(PLAN_ENTRY, document);
    // Canonical source is the Pi session. A private temporary Markdown mirror
    // is optional and never uses ctx.cwd or the repository directory.
    try {
      savePlanMirror(env.trackedSessionId ?? ctx.sessionManager?.getSessionId?.(), document.markdown);
    } catch {
      if (ctx.hasUI) ctx.ui.notify("Jev plan is safe in session, but the global temporary mirror could not be written.", "warning");
    }
    showPlanSummary(ctx, document.status === "draft");
    // Publishing the plan a second time after approval confuses the next model:
    // show it once during drafting only, never when entering Implementation.
    if (document.status === "draft") {
      pi.sendMessage({ customType: PLAN_MESSAGE,
        content: document.markdown, display: true,
        details: { version: document.version, status: document.status } },
        { triggerTurn: false });
    }
  }

  async function createImplementationSession(ctx: any, mode: HandoffMode): Promise<void> {
    if (!env.planDocument || env.planDocument.status !== "approved") {
      ctx.ui.notify("Approve a Jev plan before creating an Implementation Session.", "warning");
      return;
    }
    if (typeof ctx.newSession !== "function") {
      ctx.ui.notify("New sessions require Pi command context; run /jev-implement-session "+mode+".", "warning");
      return;
    }
    const parentPath=ctx.sessionManager?.getSessionFile?.();
    if (!parentPath) {
      ctx.ui.notify("A persistent Planning Session is needed to link Implementation. Save the session first.", "warning");
      return;
    }
    const last=latestSessionLaunch(ctx.sessionManager?.getBranch?.()??[],env.planDocument.version);
    if (last && last.status === "requested") {
      const confirm=await ctx.ui.confirm?.("Already launched?",
        "An Implementation Session may already exist for plan v"+env.planDocument.version+
        ". Check Pi /resume first. Create another session?");
      if (confirm!==true)return;
    }
    // Capture only immutable data; callbacks run after the old extension is destroyed.
    const snapshot=JSON.parse(JSON.stringify(env.planDocument)) as PlanDocument;
    const plan=implementationHandoff(snapshot);
    const origin=createOrigin(parentPath,snapshot,mode);
    const title=handoffTitle(snapshot);
    pi.appendEntry(SESSION_LAUNCH_ENTRY,{
      planVersion:snapshot.version,mode,status:"requested",createdAt:origin.createdAt,
    });
    try {
      const result=await ctx.newSession({
        parentSession:parentPath,
        setup:async (sm:any)=>{
          sm.appendCustomEntry(PLAN_ENTRY,snapshot);
          sm.appendCustomEntry(SESSION_ORIGIN_ENTRY,origin);
          sm.appendCustomEntry(WORKFLOW_ENTRY,{task:"implement"});
          sm.appendCustomEntry(PROGRESS_ENTRY,newProgress(snapshot.markdown,snapshot.version));
          if(mode==="auto")sm.appendCustomEntry(PIPELINE_ENTRY,startPipeline(snapshot.version));
          sm.appendModelChange("jev-manager","auto");
          sm.appendSessionInfo(title);
        },
        withSession:async (fresh:any)=>{
          // The replacement runtime must have selected the actual virtual
          // model, not merely recorded model_change in session JSONL.
          // Fail closed: no Implementation prompt can run on a stray model.
          if (!isRoutingActive(readConfig(),fresh)) {
            fresh.ui.notify("Jev session handoff is NOT active; Implementation was not started. " +
              "Run /jev-on, then /jev-implement (or /jev-pipeline-resume).", "error");
            return;
          }
          await fresh.sendUserMessage(plan);
        },
      });
      if(result?.cancelled){
        // Only on cancellation is the original command context still valid.
        pi.appendEntry(SESSION_LAUNCH_ENTRY,{
          planVersion:snapshot.version,mode,status:"cancelled",createdAt:origin.createdAt,
        });
        ctx.ui.notify("New-session handoff cancelled; the approved plan is preserved.", "info");
      }
    }catch(error){
      // Lifecycle may already have switched; do not access captured Pi APIs here.
      throw new Error("Could not launch Jev Implementation Session: "+
        (error instanceof Error?error.message:String(error)));
    }
  }

  async function openPlan(ctx: ExtensionContext): Promise<void> {
    if (!env.planDocument) {
      ctx.ui.notify("No saved Jev plan yet. Run /jev-plan first.", "warning");
      return;
    }
    if (!ctx.hasUI || !ctx.ui.select) {
      ctx.ui.notify("Plan saved in session. Open the session in Pi TUI to review/edit.", "info");
      return;
    }
    setPlanReviewActive(true);
    try {
    for (let step = 0; step < 12; step++) {
      // Give review content its own scrollable viewport; suppress widgets.
      if (ctx.mode === "tui") {
        ctx.ui.setWidget("jev-plan-summary", undefined);
        ctx.ui.setWidget(MASCOT_WIDGET_KEY, undefined);
        stopJevling();
      }
      const choice = await choosePlanReviewAction(ctx, env.planDocument);
      if (!choice || choice === "Keep plan for later" || choice === "Cancel") {
        showPlanSummary(ctx, false);
        cleanPlanMirror(env.trackedSessionId);
        return;
      }
      if (choice === "View / edit full plan") {
        const edited = await ctx.ui.editor("Jev Plan · Markdown (edit to revise)",
          env.planDocument.markdown);
        if (typeof edited === "string" && edited.trim() && edited.trim() !== env.planDocument.markdown) {
          savePlan(nextPlan(edited, env.planDocument), ctx);
          ctx.ui.notify("Plan revised and saved in this Pi session.", "info");
        }
      } else if (choice === "Refine with AI") {
        const change = await ctx.ui.editor("What should change in the plan?", "");
        if (change?.trim()) {
          // Switch back to Plan to enforce no project writes during revision.
          if (env.workflowTask !== "plan") await runWorkflowCommand("plan", "", ctx);
          if (env.workflowTask === "plan")
            pi.sendUserMessage("Revise the existing Jev plan based on this feedback. Do not implement.\nCurrent plan:\n"+
              env.planDocument.markdown+"\nFeedback:\n"+change.trim(), {deliverAs:"followUp"});
        }
        return;
      } else if (choice === "Implement now · New session (recommended)"
        || choice === "Auto Implement → QA → Review · New session") {
        const mode: HandoffMode=choice.startsWith("Auto")?"auto":"manual";
        const approved={...env.planDocument,status:"approved" as const};
        savePlan(approved,ctx);
        if (typeof (ctx as any).newSession === "function") {
          await createImplementationSession(ctx as any,mode);
        } else {
          const cmd="/jev-implement-session "+mode;
          if (ctx.hasUI && ctx.ui.setEditorText) ctx.ui.setEditorText(cmd);
          ctx.ui.notify("Plan approved. Pi requires a slash command to switch sessions. Press Enter on "+cmd+
            " to create the linked implementation session.", "info");
        }
        return;
      } else if (choice === "Implement now (approve plan)"
        || choice === "Auto Implement → QA → Review (approve plan)") {
        const automatic = choice.startsWith("Auto Implement");
        const approved = { ...env.planDocument, status: "approved" as const };
        savePlan(approved, ctx);
        if (automatic) savePipeline(startPipeline(approved.version),ctx);
        else cancelPipeline(ctx,"User selected manual Implement now");
        await runWorkflowCommand("implement", "", ctx, false, automatic);
        if (env.workflowTask !== "implement") {
          if (automatic) savePipeline({...env.autoPipeline!,status:"paused",
            reason:"Could not activate Implementation"},ctx);
          ctx.ui.notify("Could not switch to Implementation; approved plan remains saved.", "error");
          return;
        }
        env.implementationHandoffPending = true;
        pi.sendUserMessage(implementationHandoff(approved), {deliverAs:"followUp"});
        return;
      }
    }
    } finally {
      setPlanReviewActive(false);
      // Restore robot after review closes, even after edit/refine or errors.
      if (ctx.mode === "tui") {
        showPlanSummary(ctx, env.planSummaryVisible && env.workflowTask === "plan", false);
        repaintJevling();
      }
    }
  }


  function changeWorkflow(task: TaskType | undefined): void {
    if (env.workflowTask === "implement" && task !== "implement") {
      const remove=[
        ...env.qaRecoveryToolsInjected,
        ...(env.delegationToolInjected?["jev_delegate"]:[]),
        ...(env.nativeSubagentInjected?["subagent"]:[])
      ];
      if(remove.length)pi.setActiveTools(pi.getActiveTools().filter(name=>!remove.includes(name)));
      env.delegationToolInjected=false;
      env.nativeSubagentInjected=false;
      env.qaRecoveryToolsInjected=[];
    }
    if (env.pipelineGateInjected && task !== env.workflowTask) {
      pi.setActiveTools(pi.getActiveTools().filter(n=>n!=="jev_quality_gate"));
      env.pipelineGateInjected = false;
    }
    if (env.workflowTask === "implement" && task !== "implement" && env.progressToolInjected) {
      pi.setActiveTools(pi.getActiveTools().filter(name=>name!=="jev_progress"));
      env.progressToolInjected = false;
    }
    const wasStrict = isStrictPhase(env.workflowTask);
    const nextStrict = isStrictPhase(task);
    if(nextStrict){
      if(!wasStrict)env.toolsBeforeStrictPhase=pi.getActiveTools();
      const originalBaseline=env.toolsBeforeStrictPhase??pi.getActiveTools();
      const config=readConfig();
      // A peer left active by a prior session is not proof its daemon is still up.
      const baseline=originalBaseline.filter(name=>
        (name!==HERDR_PLAN_TOOL || env.peers?.ready("herdr")) &&
        (name!==COLLABORATION_TOOL || env.peers?.anyReady(config.peerAdapters)));
      const registered=typeof pi.getAllTools==="function"
        ?new Set(pi.getAllTools().map(tool=>tool.name)):new Set<string>();
      const candidates=[
        ...baseline,
        "jev_web_fetch","jev_ask_user",
        ...(task==="plan" && env.peers?.ready("herdr")?[HERDR_PLAN_TOOL]:[]),
        ...(task==="plan" && env.peers?.anyReady(config.peerAdapters)?[COLLABORATION_TOOL]:[]),
        ...(task==="review" && env.autoPipeline?.phase==="review"?["jev_quality_gate"]:[]),
        ...config.toolGrants.map(grant=>grant.tool)
      ];
      const active=[...new Set(candidates)].filter(x=>
        baseline.includes(x)||registered.has(x));
      pi.setActiveTools(toolsForPhase(active,task!,config.toolGrants));
      if(task==="review"&&env.autoPipeline?.phase==="review" &&
        active.includes("jev_quality_gate")&&!baseline.includes("jev_quality_gate"))
        env.pipelineGateInjected=true;
    }else if(wasStrict&&env.toolsBeforeStrictPhase){
      pi.setActiveTools(env.toolsBeforeStrictPhase);
      env.toolsBeforeStrictPhase=undefined;
    }
    env.workflowTask = task;
  }

  async function runWorkflowCommand(task: TaskType, args: string, ctx: ExtensionContext,
    skipIdle = false, fromPipeline = false): Promise<void> {
    // This is only skipped at the final agent-settled boundary, never mid-turn.
    if (!skipIdle) await ctx.waitForIdle?.();
    if (!await activateJev(pi, ctx)) return;
    if (!fromPipeline) cancelPipeline(ctx,"Switched task phase manually");
    // Read-only, bounded capability probes run only on entering Plan.
    // A missing optional peer never blocks local Planning or raises a warning.
    if(task==="plan")await env.peers?.refresh(readConfig().peerAdapters,true);
    changeWorkflow(task);
    if (task === "implement" && env.planDocument?.status === "approved") {
      // QA repair is a separate, bounded correction workflow. Reusing the
      // approved checklist must not reset the already-completed deliverable.
      const repairing=fromPipeline && !!env.autoPipeline?.qaRecovery;
      if (!repairing && (!env.implementationProgress || env.implementationProgress.version !== env.planDocument.version
        || ["cancelled","complete"].includes(env.implementationProgress.stage))) {
        env.delegationSchedule=undefined;
        pi.appendEntry(DELEGATION_ENTRY,{cleared:true});
        saveProgress(newProgress(env.planDocument.markdown,env.planDocument.version),ctx);
      } else if (!repairing && env.implementationProgress)
        saveProgress({...env.implementationProgress,stage:"running",visible:true},ctx);
    } else if (task !== "implement" && env.implementationProgress?.visible) {
      closeProgress(ctx);
    }
    if (task === "plan" && args.trim()) env.planOriginalRequest = args.trim();
    if (task !== "implement") env.implementationHandoffPending = false;
    if (task !== "plan") showPlanSummary(ctx, false);
    if (fromPipeline && (task === "qa" || task === "review")
      && typeof pi.getAllTools === "function") {
      const enabled = pi.getAllTools().some(t=>t.name==="jev_quality_gate");
      if (enabled && !pi.getActiveTools().includes("jev_quality_gate")) {
        pi.setActiveTools([...pi.getActiveTools(),"jev_quality_gate"]);
        env.pipelineGateInjected = true;
      }
    }
    if (task === "implement" && typeof pi.getAllTools === "function") {
      const registeredNames=pi.getAllTools().map(t=>t.name);
      const extras=["jev_delegate",...(readConfig().delegation.strategy==="direct"?[]:
        registeredNames.includes("subagent")?["subagent"]:[])];
      const newly=extras.filter(name=>registeredNames.includes(name)&&
        !pi.getActiveTools().includes(name));
      if(newly.length)pi.setActiveTools([...pi.getActiveTools(),...newly]);
      env.delegationToolInjected=newly.includes("jev_delegate");
      env.nativeSubagentInjected=newly.includes("subagent");
      const registered = pi.getAllTools().some(t=>t.name==="jev_progress");
      if (registered && !pi.getActiveTools().includes("jev_progress")) {
        pi.setActiveTools([...pi.getActiveTools(),"jev_progress"]);
        env.progressToolInjected = true;
      }
    }
    if(task==="implement" && fromPipeline && env.autoPipeline?.qaRecovery &&
      typeof pi.getAllTools==="function"){
      const known=pi.getAllTools().map(t=>t.name);
      const extra=["jev_qa_triage","jev_qa_fix"].filter(t=>
        known.includes(t) && !pi.getActiveTools().includes(t));
      if(extra.length)pi.setActiveTools([...pi.getActiveTools(),...extra]);
      env.qaRecoveryToolsInjected=extra;
    }
    showProgress(ctx);
    if (ctx.hasUI) ctx.ui.setStatus("jev-workflow",
      `Jev ${task.toUpperCase()}${isStrictPhase(task) ? " · READ ONLY" : ""}`);
    pi.appendEntry(WORKFLOW_ENTRY, { task, toolsBeforeStrictPhase: env.toolsBeforeStrictPhase });
    ctx.ui.notify(`Jev ${task.toUpperCase()} active${isStrictPhase(task) ? " · read-only tool guard" : ""}. Use /jev-auto to reset.`, "info");
    if (args.trim()) pi.sendUserMessage(args.trim(), { deliverAs: "followUp" });
  }

  return { savePipeline, cancelPipeline, showProgress, saveProgress, closeProgress, showPlanSummary, savePlan, createImplementationSession, openPlan, changeWorkflow, runWorkflowCommand };
}
