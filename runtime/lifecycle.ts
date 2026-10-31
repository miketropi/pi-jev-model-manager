import { allowedCandidates, safeThinking } from "../routing/compatibility.ts";
import { describeDispatchIssue } from "../health.ts";
import { defaultTaskRules, applyTaskRule, subagentTaskType } from "../task-routing.ts";
import { WORKFLOW_COMMANDS, WORKFLOW_ENTRY, isStrictPhase, toolsForPhase, canUseTool, instructionsForTask, selectExplicitModel } from "../workflow.ts";
import { HERDR_PLAN_TOOL } from "../herdr-collaboration.ts";
import { COLLABORATION_TOOL } from "../collaboration-adapters.ts";
import { skillGuidance, type LoadedSkill } from "../skill-routing.ts";
import { PLAN_UI_ENTRY, nextPlan, extractPlanText, latestPlanFromBranch } from "../plan-artifact.ts";
import { latestProgress } from "../progress.ts";
import { savePlanMirror, cleanPlanMirror, pruneOldPlanMirrors } from "../plan-cache.ts";
import { latestDelegation, subagentReady, scheduleInstructions } from "../delegation.ts";
import { latestSessionOrigin } from "../implementation-session.ts";
import { PIPELINE_ENTRY, advancePipeline, latestPipelineFromBranch, nextPhasePrompt, qaRemediationPrompt } from "../auto-pipeline.ts";
import type { ExtensionAPI, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../core/config.ts";
import { keyOf, physicalCandidates, resolveModel, fallbackModel, lastUserText } from "../routing/selectors.ts";
import { choose, type Decision } from "../routing/choose.ts";
import {planningPool, planningTier} from "../routing/planning-quality.ts";
import { syncNineRouterProvider } from "../integrations/nine-router-provider.ts";
import { isJevSelected, isRoutingActive, updateJevling, setPlanReviewActive, clearJevling, stopJevling, startJevling } from "../ui/mascot-controller.ts";
import { activateJev } from "../ui/activation.ts";
import { syncJevCredentials } from "../ui/credentials.ts";
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
export function registerLifecycleEvents(pi: ExtensionAPI, env: RuntimeBindings): void {
  const { savePipeline, cancelPipeline, showProgress, saveProgress, closeProgress, showPlanSummary, savePlan, createImplementationSession, openPlan, changeWorkflow, runWorkflowCommand } = env;
  pi.on?.("session_start", async (event, ctx) => {
    env.lastDecision = undefined;
    setPlanReviewActive(false); // a new Pi session cannot inherit an old modal
    clearJevling();
    stopJevling();
    env.implementationHandoffPending = false;
    env.planRunActive = false;
    env.pendingPlanText = undefined;
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    env.trackedSessionId = ctx.sessionManager?.getSessionId?.();
    try{pruneOldPlanMirrors();}catch{ /* no writes to cwd on cache failure */ }
    env.progressToolInjected = false;
    env.planDocument = latestPlanFromBranch(branch);
    env.implementationProgress = latestProgress(branch);
    env.delegationSchedule = latestDelegation(branch);
    if(env.delegationSchedule?.version!==env.implementationProgress?.version)
      env.delegationSchedule=undefined;
    env.implementationOrigin = latestSessionOrigin(branch);
    env.autoPipeline = latestPipelineFromBranch(branch);
    // The just-created child must start its approved pipeline. A later reload
    // or resume is paused until the user explicitly resumes.
    const initialHandoff = event?.reason === "new" && !!env.implementationOrigin;
    if (env.autoPipeline?.status === "running" && !initialHandoff) {
      env.autoPipeline = {...env.autoPipeline,status:"paused",reason:"Session resumed; use /jev-pipeline-resume"};
      pi.appendEntry(PIPELINE_ENTRY,env.autoPipeline);
    }
    if(ctx.hasUI)ctx.ui.setStatus("jev-pipeline",
      env.autoPipeline && !["cancelled","completed"].includes(env.autoPipeline.status)
        ? "AUTO "+env.autoPipeline.phase.toUpperCase()+" · "+env.autoPipeline.status.toUpperCase() : undefined);
    env.planOriginalRequest = env.planDocument?.request;
    const savedUi = [...branch].reverse().find((e: any) =>
      e?.type === "custom" && e.customType === PLAN_UI_ENTRY);
    env.planSummaryVisible = savedUi?.data?.visible === true;
    // Restore phase when resuming/reloading; session-specific entries avoid global leakage.
    env.workflowTask = undefined;
    env.toolsBeforeStrictPhase = undefined;
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    const latest = [...entries].reverse().find((e: any) => e.type === "custom"
      && e.customType === WORKFLOW_ENTRY);
    const saved = latest?.data;
    if (saved && (saved.task === null || saved.task in WORKFLOW_COMMANDS)) {
      env.workflowTask = saved.task ?? undefined;
      if (isStrictPhase(env.workflowTask)) {
        env.toolsBeforeStrictPhase = Array.isArray(saved.toolsBeforeStrictPhase)
          ? saved.toolsBeforeStrictPhase.filter((x: unknown) => typeof x === "string")
          : pi.getActiveTools();
        const registered=typeof pi.getAllTools==="function"
          ?new Set(pi.getAllTools().map(t=>t.name)):new Set<string>();
        const config=readConfig();
        const candidates=[...pi.getActiveTools(),
          "jev_web_fetch","jev_ask_user",
          ...(env.workflowTask==="plan"?[HERDR_PLAN_TOOL,COLLABORATION_TOOL]:[]),
          ...config.toolGrants.map(g=>g.tool)];
        pi.setActiveTools(toolsForPhase([...new Set(candidates)].filter(x=>
          pi.getActiveTools().includes(x)||registered.has(x)),
          env.workflowTask!,config.toolGrants));
      }
    }
    if(env.workflowTask==="implement" && typeof pi.getAllTools==="function"){
      const names=pi.getAllTools().map(t=>t.name);
      const activeBefore=pi.getActiveTools();
      const needs=["jev_delegate",...(readConfig().delegation.strategy==="direct"?[]:
        names.includes("subagent")?["subagent"]:[])].filter(n=>
        names.includes(n)&&!activeBefore.includes(n));
      if(needs.length)pi.setActiveTools([...activeBefore,...needs]);
      env.delegationToolInjected=needs.includes("jev_delegate");
      env.nativeSubagentInjected=needs.includes("subagent");
      const active=pi.getActiveTools();
      if(pi.getAllTools().some(t=>t.name==="jev_progress") && !active.includes("jev_progress")){
        pi.setActiveTools([...active,"jev_progress"]);
        env.progressToolInjected=true;
      }
    }
    // Approved handoffs have their own activation; other Pi/Herdr sessions
    // restore only a previously saved Jev ON preference.
    let selectedAtHandoff = false;
    let selectedAtStartup = false;
    if (initialHandoff && env.workflowTask === "implement") {
      selectedAtHandoff = await activateJev(pi, ctx);
      if (!selectedAtHandoff) {
        if (env.autoPipeline?.status === "running") {
          savePipeline({...env.autoPipeline, status:"paused",
            reason:"Jev routing could not activate in the new Implementation Session"}, ctx);
        }
        ctx.ui.notify("Jev routing could not activate in the new session. " +
          "Implementation will NOT start with an unrelated model. Run /jev-on, " +
          "then /jev-implement or /jev-pipeline-resume.", "error");
      }
    } else {
      // Restore saved /jev-on; no automatic continuation of QA/Review.
      selectedAtStartup = await activateJev(pi, ctx, { restore: true });
    }
    const config = readConfig();
    showPlanSummary(ctx, env.workflowTask === "plan" && env.planSummaryVisible, false);
    showProgress(ctx);
    if (ctx.hasUI) ctx.ui.setStatus("jev-workflow",
      env.workflowTask ? `Jev ${env.workflowTask.toUpperCase()}${isStrictPhase(env.workflowTask) ? " · READ ONLY" : ""}` : undefined);
    // ctx.model can be a snapshot taken before pi.setModel(); do not draw a
    // false "Inactive" widget after a successful child-session activation.
    const autoSelected = selectedAtHandoff || selectedAtStartup;
    const displayModel = autoSelected
      ? ctx.modelRegistry.find(ROUTER_PROVIDER, ROUTER_ID) ?? ctx.model : ctx.model;
    const displayCtx = autoSelected ? {...ctx, model:displayModel} : ctx;
    updateJevling(displayCtx, config, { mood: config.enabled ? "ready" : "disabled" });
    if (ctx.mode === "tui" && config.enabled && !isJevSelected(displayCtx.model)) {
      ctx.ui.notify("Jev is configured but INACTIVE: Pi is using a physical model. Run /jev-on to activate routing.", "info");
    }
  });
  pi.on?.("model_select", (event, ctx) => {
    const config = readConfig();
    updateJevling({ ...ctx, model: event.model }, config, {
      mood: config.enabled ? "ready" : "disabled",
    });
  });
  // Mark the character ready at the end of a turn, retaining the last routed model.
  pi.on?.("agent_end", (event) => {
    if (env.workflowTask === "plan" && env.planRunActive) {
      env.pendingPlanText = extractPlanText(event.messages) ?? env.pendingPlanText;
    }
    // agent_end may be followed by an automatic retry or tool continuation.
    // Keep animation active until the final agent_settled event.
  });

  pi.on?.("agent_start", (_event, ctx) => {
    if (env.workflowTask === "implement" && env.implementationProgress?.stage === "paused")
      saveProgress({...env.implementationProgress,stage:"running",visible:true},ctx);
    if (env.workflowTask === "implement" && env.planDocument?.status==="approved") {
      try{savePlanMirror(env.trackedSessionId,env.planDocument.markdown);}
      catch{ /* canonical plan remains in the Pi session */ }
    }
    env.planRunActive = env.workflowTask === "plan";
    env.pendingPlanText = undefined;
    const config = readConfig();
    updateJevling(ctx, config, {
      mood: config.enabled ? "routing" : "disabled",
      task: env.workflowTask ?? env.lastDecision?.task,
      model: env.lastDecision
        ? config.models.find(m => m.key === env.lastDecision.model)?.label ?? env.lastDecision.model
        : undefined,
    });
    if (ctx.mode === "tui" && config.robotMotion && config.mascot === "mascot"
      && isRoutingActive(config, ctx)) startJevling();
  });

  // Only run the interactive handoff after Pi has fully settled, not during retries.
  pi.on?.("agent_settled", async (event, ctx) => {
    stopJevling();
    const config = readConfig();
    updateJevling(ctx, config, {
      mood: config.enabled ? "ready" : "disabled",
      task: env.workflowTask ?? env.lastDecision?.task,
      model: env.lastDecision
        ? config.models.find(m => m.key === env.lastDecision.model)?.label ?? env.lastDecision.model
        : undefined,
    });
    if (env.workflowTask === "implement") {
      env.implementationHandoffPending = false;
      showPlanSummary(ctx, false);
      if (env.implementationProgress && env.implementationProgress.stage==="running")
        saveProgress({...env.implementationProgress,stage:"paused"},ctx);
      cleanPlanMirror(env.trackedSessionId);
      showProgress(ctx);
    }
    const pipeline = env.autoPipeline;
    if (pipeline?.status === "running" && pipeline.phase === env.workflowTask) {
      const updated=advancePipeline(pipeline,{
        implementationCompleted:env.implementationProgress?.stage==="complete",
        result:pipeline.phase==="qa" ? pipeline.qa : pipeline.phase==="review" ? pipeline.review : undefined,
        aborted:event?.aborted === true,
      });
      if(updated!==pipeline){
        savePipeline(updated,ctx);
        if(updated.status==="completed"){
          ctx.ui.notify("Jev Auto pipeline complete · Implementation, QA and Review verified.", "info");
        }else if(updated.status==="failed" || updated.status==="paused"){
          ctx.ui.notify("Jev Auto stopped at "+pipeline.phase.toUpperCase()+": "+
            (updated.reason ?? "verification incomplete")+
            ". Inspect /jev-pipeline-status or continue manually.", "warning");
        }else if(updated.phase!==pipeline.phase &&
          ["implement","qa","review"].includes(updated.phase)){
          const next=updated.phase as "implement"|"qa"|"review";
          await runWorkflowCommand(next,"",ctx,true,true);
          if(env.workflowTask !== next){
            savePipeline({...updated,status:"paused",reason:"Could not activate "+next},ctx);
          }else{
            const prompt=next==="implement"
              ?qaRemediationPrompt(updated,env.planDocument?.markdown??"",env.planDocument?.request)
              :nextPhasePrompt(next,env.planDocument?.markdown??"",env.planDocument?.request,
                updated.qaRecovery);
            pi.sendUserMessage(prompt,{deliverAs:"followUp"});
          }
        }
      }
    }
    if (!env.planRunActive) return;
    env.planRunActive = false;
    const text = env.pendingPlanText;
    env.pendingPlanText = undefined;
    if (event?.aborted || !text || env.workflowTask !== "plan") return;
    savePlan(nextPlan(text, env.planDocument, new Date(), env.planOriginalRequest), ctx);
    if (ctx.mode === "tui" && ctx.hasUI) await openPlan(ctx);
  });

  pi.on?.("session_shutdown", () => {
    clearJevling();
    stopJevling();
    // Reload and exit never leave a temporary .md file in the project.
    cleanPlanMirror(env.trackedSessionId);
    env.trackedSessionId = undefined;
  });

  // Track real provider outcomes instead of trusting the static Pi catalog.
  // Observation must not mutate session messages or tool results.
  pi.on?.("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const config = readConfig();
    if (!config.health.enabled) return;
    const key = `${message.provider}/${message.model}`;
    if (!config.models.some(m => m.key === key)) return;
    if (message.stopReason === "error") {
      env.health.reportFailure(key, message.stopReason, message.errorMessage, config.health);
    } else if (message.stopReason === "stop" || message.stopReason === "toolUse") {
      env.health.reportSuccess(key);
    }
  });
  pi.on?.("before_agent_start", (event) => {
    if (!env.workflowTask) return;
    if (env.workflowTask === "plan" && typeof event.prompt === "string"
      && event.prompt.trim() && !event.prompt.startsWith("Revise the existing Jev plan"))
      env.planOriginalRequest = event.prompt.trim().slice(0,2000);
    const skills = Array.isArray(event.systemPromptOptions?.skills)
      ? event.systemPromptOptions.skills as LoadedSkill[] : [];
    let instructions = instructionsForTask(env.workflowTask) + "\n\n" +
      skillGuidance(env.workflowTask, skills);
    if (env.workflowTask === "plan") {
      instructions += "\n\nPLAN DOCUMENT STORAGE: Do not create any plan.md, plan-*.md or planning scratch files in the project working directory. Return the final Markdown as your answer; Jev saves it inside the Pi session and mirrors it outside the project. Include actionable numbered steps or Markdown checkboxes for implementation progress.\n\nPLAN DOCUMENT REQUIREMENT: On finishing the research, output a complete self-contained Markdown implementation plan. Include Goal, Evidence & assumptions, Decisions & tradeoffs, Numbered steps, Files to touch, Validation, Risks and Acceptance criteria. Do not implement it. Jev will save the final answer and ask the user whether to review, refine, keep or implement.";
    } else if (["qa","review"].includes(env.workflowTask)
      && env.autoPipeline?.status === "running" && env.autoPipeline.phase === env.workflowTask) {
      instructions += "\n\nJEV AUTO QUALITY GATE: This phase must finish by calling jev_quality_gate with outcome pass or fail, meaningful evidence and findings. Do not claim pass without running/inspecting appropriate verification. Report fail if unable to verify. No automatic repair loops. QA may run tests; Review is strictly read-only.";
    } else if (env.workflowTask === "implement" && env.autoPipeline?.phase==="implement"
      && env.autoPipeline.qaRecovery && ["running","paused"].includes(env.autoPipeline.status)) {
      instructions += "\n\nJEV AUTO QA REMEDIATION: "+
        qaRemediationPrompt(env.autoPipeline,env.planDocument?.markdown??"",env.planDocument?.request)+
        "\nDo not start a new implementation checklist or delegate an unrelated Builder wave. "+
        "Resolve only validated QA issues, use jev_qa_triage then jev_qa_fix, and let the pipeline re-run QA. "+
        "A correction is not a pass until read-only QA reports a fresh pass.";
    } else if (env.workflowTask === "implement" && env.planDocument?.status === "approved") {
      instructions += "\n\nIMPLEMENTATION PROGRESS: The active checklist belongs to this Pi session. Call jev_progress(action=list) to see step IDs; call jev_progress(action=update,stepId=N,status=active) before working on a step, status=done only after verifying that step with a short factual note, or status=blocked with the reason. Never mark steps done automatically or without evidence. The TUI updates from these calls; do not merely report progress in prose. Do not write auxiliary plan Markdown files inside the working repository; the approved plan is managed outside the project. Only write actual user-requested deliverables.\n";
      instructions += "\n\nApproved Jev plan v" + env.planDocument.version + " is the execution baseline. Do not produce another plan, planning document, review or outline instead of performing the final work.";
      const delegation=readConfig().delegation;
      const nativeAvailable=typeof pi.getAllTools==="function" &&
        subagentReady(pi.getAllTools().map(t=>t.name));
      if(delegation.strategy!=="direct"){
        instructions += "\n\nJEV SUBAGENT-FIRST IMPLEMENTATION: You are the Lead / Orchestrator. BEFORE directly implementing substantial checklist steps, call jev_progress(action=list), inspect the affected files and then call jev_delegate(action=plan) with the remaining checklist step IDs, exact relative file or directory ownership scopes, dependencies and small/medium/large effort. Use jev_delegate(action=run) to actually spawn Pi native Builder subagents for each ready, independent wave (at most "+delegation.maxConcurrentBuilders+" Builders). The delegation tool calls native Pi subagent directly; do not call subagent directly, do not make up tool results. Small fixes may remain with Lead. Unknown or overlapping file scopes MUST run sequentially. After each Builder wave, inspect diff and run suitable tests, then only the Lead calls jev_progress(status=done, note=verified evidence). Never mark delegated steps done solely because subprocess exited. Proceed wave by wave; do not skip dependency checks or automatically retry a failed wave. QA/Review remain separate pipeline phases.";
        if(!nativeAvailable)instructions += "\n\nNATIVE PI SUBAGENT NOT INSTALLED: Jev cannot spawn Builders; implement directly as Lead or tell the user how to enable the official Pi subagent extension. Never claim a Builder ran.";
        if(env.delegationSchedule?.version===env.implementationProgress?.version)
          instructions += "\n\nExisting delegation schedule in session: "+
            scheduleInstructions(env.delegationSchedule,env.planDocument.markdown).slice(0,18000);
      } else {
        instructions += "\n\nJEV DIRECT EXECUTION: Lead implements all tasks. Do not spawn subagents.";
      }
      if (env.implementationHandoffPending) {
        instructions += "\n\nCRITICAL APPROVAL HANDOFF: User selected IMPLEMENT NOW. Execute the approved deliverables immediately. For blog/content projects, WRITE THE FINAL ARTICLE; for code projects, IMPLEMENT CHANGES. Do NOT update/rewrite the plan artifact and do not return a plan again. Use allowed tools to complete the actual deliverable.";
      }
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + instructions };
  });
  pi.on?.("user_bash", (event) => {
    if (!isStrictPhase(env.workflowTask)) return;
    if (canUseTool(env.workflowTask, "bash", { command: event.command },readConfig().toolGrants)) return;
    return { result: {
      output: `Blocked: Jev ${env.workflowTask} permits only verified read-only shell commands. Use /jev-implement before making changes.`,
      exitCode: 1, cancelled: false, truncated: false,
    }};
  });

  // Saved imports are available immediately on startup, even when the proxy is offline.
  // Discovery itself is intentionally manual and never sends task prompts to 9Router.
  syncNineRouterProvider(pi, readConfig());
  syncJevCredentials(pi, readConfig());

  let warnedWeakPlan = false;
  let lastRoutedPhase: string | undefined;
  pi.registerVirtualModel<RouteState>({
    provider: ROUTER_PROVIDER,
    id: ROUTER_ID,
    name: "Jev • Auto Model Manager",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    async route(request: ModelRouteRequest<RouteState>, ctx) {
      const config = readConfig();
      if (lastRoutedPhase !== env.workflowTask) {
        warnedWeakPlan = false;
        lastRoutedPhase = env.workflowTask;
      }
      const allCandidates = physicalCandidates(config, ctx);
      if (!allCandidates.length) {
        throw new Error("Jev Manager: no eligible authenticated physical models. Run /jev-models.");
      }
      const observed = typeof ctx.getContextUsage === "function"
        ? ctx.getContextUsage()?.tokens : undefined;
      const healthy = allCandidates.filter(m => env.health.isEligible(m.key, config.health));
      const fit = allowedCandidates(healthy, m => resolveModel(ctx, m.key), observed);
      const candidates = fit.models;
      const planAuto = env.workflowTask === "plan" &&
        (config.taskRules.plan?.mode ?? "auto") === "auto";
      const pool = planAuto && candidates.length ? planningPool(candidates) : undefined;
      const notifyDegraded = (modelKey: string, quality = pool) => {
        if (!quality?.degraded || warnedWeakPlan || !ctx.hasUI || config.mode !== "auto") return;
        warnedWeakPlan = true;
        ctx.ui.notify("Jev Plan quality warning: " + quality.reason +
          ". Selected " + modelKey + ". Add a deep/balanced planning model, " +
          "or choose /jev-tasks -> Planning & Architecture -> Force a model.", "warning");
      };
      const sticky = request.failed ?? request.previous;

      if (request.reason === "continuation" && sticky && allCandidates.some(m => m.key === keyOf(sticky.model))) {
        // Do not switch in the middle of a successful turn; tool/thinking state may be model-specific.
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      if (request.reason === "retry" && request.failed) {
        const failedKey = keyOf(request.failed.model);
        const issue = describeDispatchIssue(request.failed.message?.errorMessage);
        if (request.failed.message?.stopReason === "error" && issue.kind === "parameter") {
          env.health.reportFailure(failedKey, "error", request.failed.message.errorMessage, config.health);
          throw new Error("Jev: invalid provider model parameters. Run /jev-diagnose to verify model limits; stopped blind retry.");
        }
        const problem = env.health.reportFailure(
          failedKey, request.failed.message.stopReason, request.failed.message.errorMessage, config.health,
        );
        if (problem && config.enabled && config.mode === "auto" && config.health.autoFailover) {
          const attempted = new Set([...(request.state?.attempted ?? []), failedKey]);
          const available = candidates.filter(m => !attempted.has(m.key));
          const planningRetry = available.length && (env.workflowTask === "plan" ||
            request.state?.last?.task === "plan") &&
            (config.taskRules.plan?.mode ?? "auto") === "auto"
            ? planningPool(available) : undefined;
          const next = planningRetry
            ? planningRetry.candidates.find(m => m.key === config.fallback) ??
              planningRetry.preferred
            : available.find(m => m.key === config.fallback) ?? available[0];
          if (next) {
            if (planningRetry) notifyDegraded(next.key,planningRetry);
            const decision: Decision = {
              model: next.key, task: request.state?.last.task ?? "unknown",
              probability: 0, reason: `health failover (${problem}) from ${failedKey}`,
            };
            env.lastDecision = decision;
            if (ctx.hasUI) ctx.ui.setStatus("jev-manager", `Jev recovery → ${next.label}`);
            updateJevling(ctx, config, { mood: "recovery", task: decision.task, model: next.label });
            return {
              model: resolveModel(ctx, next.key)!,
              thinkingLevel: safeThinking(next, resolveModel(ctx, next.key)),
              state: { last: decision, attempted: [...attempted, next.key] },
            };
          }
          if (ctx.hasUI) ctx.ui.notify("No healthy alternate model available for retry. Pi may retry the same model.", "warning");
        }
      }
      // Pi may retry non-provider failures (e.g. compaction) without rerouting.
      if (request.reason === "retry" && sticky && allCandidates.some(m => m.key === keyOf(sticky.model))) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      if (request.reason === "direct") {
        const base = pool?.preferred ?? (candidates.find(m => m.key === config.fallback) ??
          candidates[0] ?? fallbackModel(allCandidates, config));
        const forced = env.workflowTask ? selectExplicitModel(env.workflowTask, base.key, base.key,
          candidates.map(m => m.key), config.taskRules).model : base.key;
        const model = candidates.find(m => m.key === forced) ?? base;
        if (planAuto) notifyDegraded(model.key);
        updateJevling(ctx, config, {
          mood: config.enabled ? "routing" : "disabled", model: model.label,
        });
        return { model: resolveModel(ctx, model.key)!, thinkingLevel: safeThinking(model, resolveModel(ctx, model.key)) };
      }
      if (!candidates.length) {
        throw new Error("Jev Manager: all configured models are cooling down after provider errors. Run /jev-health to inspect or reset.");
      }
      const base = config.mode === "observe"
        ? fallbackModel(candidates,config)
        : pool?.preferred ?? fallbackModel(candidates, config);
      const prompt = lastUserText(request.messages);
      let decision: Decision;
      // Stable model for an ongoing explicit coding phase; avoid reclassification
      // between turns when the existing model is still eligible and fits context.
      const previous = request.state?.last ?? env.lastDecision;
      const affinityRule = env.workflowTask ? config.taskRules[env.workflowTask] : undefined;
      const affiliated = request.reason === "user" && env.workflowTask
        && ["plan","implement","debug","qa","review"].includes(env.workflowTask)
        && (!affinityRule || affinityRule.mode === "auto")
        && previous?.task === env.workflowTask
        ? (pool?.candidates ?? candidates).find(m => m.key === previous.model) : undefined;
      if (affiliated) {
        decision = {model:affiliated.key,task:env.workflowTask!,probability:1,
          reason:"task-affinity continuation"};
      } else if (env.workflowTask) {
        const rule = config.taskRules[env.workflowTask];
        // Prefer/Force bypass Jev task classification: the explicit command is authoritative.
        if (rule && rule.mode !== "auto") {
          const chosen = selectExplicitModel(env.workflowTask, base.key, base.key,
            candidates.map(m => m.key), config.taskRules);
          decision = { model: chosen.model, task: env.workflowTask, probability: 1, reason: chosen.reason };
        } else {
          // Auto still lets Jev rank models, but may not reclassify the explicit phase.
          const eligible = pool?.candidates ?? candidates;
          const auto = prompt
            ? await choose(`Task phase: ${env.workflowTask}. ${prompt}`, {
                ...config, fallback: base.key, taskRules: defaultTaskRules(),
              }, eligible, ctx, request.signal)
            : { model: base.key, task: env.workflowTask, probability: 0, reason: "empty text prompt" };
          const chosen = selectExplicitModel(env.workflowTask, auto.model, base.key,
            candidates.map(m => m.key), config.taskRules);
          decision = { model: chosen.model, task: env.workflowTask,
            probability: auto.probability, reason: `explicit ${env.workflowTask} · ${auto.reason}` +
              (pool?.restricted ? ` · ${pool.reason}` : "") };
        }
      } else {
        decision = prompt
          ? await choose(prompt, config, candidates, ctx, request.signal)
          : { model: base.key, task: "unknown", probability: 0, reason: "empty text prompt" };
      }
      env.lastDecision = decision;
      const selected = config.mode === "observe" ? base : candidates.find((m) => m.key === decision.model) ?? base;
      const physical = resolveModel(ctx, selected.key);
      if (planAuto) notifyDegraded(selected.key);
      if (planAuto && config.mode === "observe" &&
          planningTier(selected) === "fast" && ctx.hasUI && !warnedWeakPlan) {
        warnedWeakPlan = true;
        ctx.ui.notify("Jev Plan is in OBSERVE mode: model selection is advisory only. " +
          "The configured fallback is fast-tier. Use /jev-tasks to force a planning model, " +
          "or enable Jev auto routing.", "warning");
      }
      if (!physical) throw new Error(`Jev Manager: ${selected.key} missing from model registry`);
      if (ctx.hasUI) {
        ctx.ui.setStatus("jev-manager", `Jev ${config.mode}: ${selected.label} · ${decision.task}`);
      }
      updateJevling(ctx, config, {
        mood: config.enabled ? "routing" : "disabled",
        task: decision.task,
        model: selected.label,
      });
      return { model: physical, thinkingLevel: safeThinking(selected, physical), state: { last: decision, attempted: [selected.key] } };
    },
  });

  // Subagent adapters: for known spawn tools accepting an optional "model"
  // parameter, select a physical model once for the child's entire task.
  // Covers pi-subagents-hub Agent and other spawn tools with a model argument.
  // Does not touch the official reference "subagent" tool (its schema has no
  // model field) or override an explicit user/agent model selection.
  pi.on?.("tool_call", async (event, ctx) => {
    // Strict plan/review mode: deny all write-capable tools, including bash,
    // custom extensions, remote MCP tools, subagents and nested tool calls.
    if (!canUseTool(env.workflowTask, event.toolName, event.input,readConfig().toolGrants)) {
      return { block: true, reason: `Jev ${env.workflowTask} is read-only. Use /jev-implement or /jev-auto before modifying files or running commands.` };
    }
    const settings = readConfig();
    // Jev owns concurrency and scope during Implementation. Direct subagent
    // calls would bypass the scheduler; nested calls from jev_delegate are safe.
    if(env.workflowTask==="implement" && event.toolName==="subagent" &&
      !event.parentToolCallId && settings.delegation.strategy!=="direct")
      return {block:true,reason:"Use jev_delegate(action=plan/run) so Pi Builder work is limited to two file-disjoint tasks and verified before the next wave."};
    if (!settings.enabled || !settings.subagentRouting || settings.mode !== "auto") return;
    if (!["Agent", "agent_spawn", "spawn_agent", "subagent_spawn"].includes(event.toolName)) return;
    const input = event.input as Record<string, unknown>;
    if (input.model !== undefined && input.model !== null && input.model !== "") return;
    const task = typeof input.task === "string" ? input.task :
      typeof input.prompt === "string" ? input.prompt : "";
    if (!task.trim()) return;
    const candidates = physicalCandidates(settings, ctx)
      .filter(m => env.health.isEligible(m.key, settings.health));
    if (!candidates.length) return;
    const role = subagentTaskType(input);
    // Explicit agent roles apply to task policies; otherwise classify the task.
    const decision = role && settings.taskRules[role].mode !== "auto"
      ? applyTaskRule(role, fallbackModel(candidates, settings).key,
          fallbackModel(candidates, settings).key, candidates.map(m => m.key), settings.taskRules)
      : null;
    const model = decision?.model || (await choose(task, settings, candidates, ctx)).model;
    if (!candidates.some(m => m.key === model)) return;
    // This intentionally touches only adapters with a documented model option.
    input.model = model;
  });

}
