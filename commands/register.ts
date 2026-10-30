import { type TaskType } from "../task-routing.ts";
import { effectiveModelProfile } from "../model-profiles.ts";
import { configureTaskRules } from "../task-ui.ts";
import { WORKFLOW_COMMANDS, WORKFLOW_ENTRY, isStrictPhase } from "../workflow.ts";
import { fetchPublicText } from "../planning-tools.ts";
import { matchingSkills, type LoadedSkill } from "../skill-routing.ts";
import { type PlanDocument } from "../plan-artifact.ts";
import { progressLines, type Progress } from "../progress.ts";
import { chooseChecklistAction } from "../progress-review-ui.ts";
import { cleanPlanMirror } from "../plan-cache.ts";
import { subagentReady, type DelegationSchedule } from "../delegation.ts";
import { latestSessionOrigin, type HandoffMode } from "../implementation-session.ts";
import { pipelineLines, nextPhasePrompt, qaRemediationPrompt, type PipelineState } from "../auto-pipeline.ts";
import { ModelHealth } from "../health.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { NINE_ROUTER_BASE_URL_ENV, NINE_ROUTER_PROVIDER, resolveNineRouterBaseUrl } from "../nine-router.ts";
import { CONFIG_PATH, readConfig, saveConfig, type ManagedModel } from "../core/config.ts";
import { keyOf, physicalCandidates } from "../routing/selectors.ts";
import { choose, type Decision } from "../routing/choose.ts";
import { syncNineRouterProvider } from "../integrations/nine-router-provider.ts";
import { isJevSelected, isRoutingActive, updateJevling } from "../ui/mascot-controller.ts";
import { configureAddon } from "../ui/configuration.ts";
import { configureHealthOptions } from "../ui/model-health.ts";
import { scanAndImportNineRouter, configureModel } from "../ui/model-admin.ts";
import { activateJev, deactivateJev } from "../ui/activation.ts";
import { configureNineRouterSettings } from "../ui/credentials.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER="jev-manager";
const ROUTER_ID="auto";
export interface CommandBindings {
  health: ModelHealth;
  readonly lastDecision: Decision | undefined;
  readonly workflowTask: TaskType | undefined;
  readonly planDocument: PlanDocument | undefined;
  readonly planSummaryVisible: boolean;
  implementationHandoffPending: boolean;
  readonly implementationProgress: Progress | undefined;
  readonly trackedSessionId: string | undefined;
  readonly delegationSchedule: DelegationSchedule | undefined;
  readonly implementationOrigin: ReturnType<typeof latestSessionOrigin>;
  readonly autoPipeline: PipelineState | undefined;
  saveProgress(p: Progress, ctx: ExtensionContext): void;
  closeProgress(ctx: ExtensionContext): void;
  cancelPipeline(ctx: ExtensionContext, reason?: string): void;
  savePipeline(p: PipelineState, ctx: ExtensionContext): void;
  runWorkflowCommand(task: TaskType, args: string, ctx: ExtensionContext, skipIdle?: boolean, fromPipeline?: boolean): Promise<void>;
  createImplementationSession(ctx: any, mode: HandoffMode): Promise<void>;
  openPlan(ctx: ExtensionContext): Promise<void>;
  showPlanSummary(ctx: ExtensionContext, show: boolean, persist?: boolean): void;
  changeWorkflow(task: TaskType | undefined): void;
}

export function registerCommands(pi: ExtensionAPI, env: CommandBindings): void {
  pi.registerCommand("jev-models", {
    description: "Open Jev Model Manager (TUI)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      let config = readConfig();
      while (true) {
        const names = config.models.map((m) => `${m.enabled ? "●" : "○"} ${m.label}  [${m.key}]`);
        const choice = await ctx.ui.select("Jev Model Manager", [
          `Routing: ${config.enabled ? "ON" : "OFF"}`,
          `Mode: ${config.mode}`,
          `Fallback: ${config.fallback || "not set"}`,
          `Minimum probability: ${config.minProbability.toFixed(2)}`,
          "Add a model from Pi catalog",
          "Configure addon (/jev-config)",
          "Task routing (/jev-tasks)",
          "Model health & failover (/jev-health)",
          `9Router settings: ${resolveNineRouterBaseUrl(config.nineRouter)}${process.env[NINE_ROUTER_BASE_URL_ENV]?.trim() ? " [env]" : ""}`,
          "Scan 9Router models",
          ...names, "Done",
        ]);
        if (!choice || choice === "Done") break;
        if (choice.startsWith("Routing:")) {
          config.enabled = !config.enabled;
          if (config.enabled && !isJevSelected(ctx.model))
            ctx.ui.notify("Routing policy enabled, but Pi still uses a physical model. Run /jev-on to activate.", "info");
        }
        else if (choice.startsWith("Mode:")) config.mode = config.mode === "auto" ? "observe" : "auto";
        else if (choice.startsWith("Fallback:")) {
          const item = await ctx.ui.select("Select fallback", config.models.filter((m) => m.enabled).map((m) => m.key));
          if (item) config.fallback = item;
        } else if (choice.startsWith("Minimum probability:")) {
          const value = await ctx.ui.input("Minimum choice probability (0–1)", String(config.minProbability));
          if (value != null && value.trim() !== "") {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0 && n <= 1) config.minProbability = n;
            else ctx.ui.notify("Enter a number between 0 and 1", "warning");
          }
        } else if (choice === "Configure addon (/jev-config)") {
          await configureAddon(pi, ctx, env.health);
          config = readConfig();
        } else if (choice === "Task routing (/jev-tasks)") {
          await configureTaskRules(ctx, config.taskRules, config.models.filter(m => m.enabled), () => saveConfig(config));
        } else if (choice === "Model health & failover (/jev-health)") {
          await configureHealthOptions(ctx, config, env.health);
        } else if (choice.startsWith("9Router settings:")) {
          if (await configureNineRouterSettings(ctx, config)) syncNineRouterProvider(pi, config);
        } else if (choice === "Scan 9Router models") {
          await scanAndImportNineRouter(pi, ctx, config);
        } else if (choice === "Add a model from Pi catalog") {
          const added = new Set(config.models.map((m) => m.key));
          const available = ctx.modelRegistry.getAvailable()
            .filter((m) => m.api !== "pi-virtual" && !added.has(keyOf(m)));
          const key = await ctx.ui.select("Available Pi models", available.map(keyOf));
          if (key) {
            const model: ManagedModel = {
              key, label: key, enabled: true, specialty: "General software engineering",
              avoid: "", cost: "balanced", thinking: "medium",
            };
            const hints = effectiveModelProfile(model);
            model.specialty = hints.specialty;
            model.avoid = hints.avoid;
            config.models.push(model);
            if (!config.fallback) config.fallback = key;
            await configureModel(ctx, config, model);
          }
        } else {
          const match = config.models.find((m) => choice.endsWith(`[${m.key}]`));
          if (match) {
            await configureModel(ctx, config, match);
            if (match.key.startsWith(`${NINE_ROUTER_PROVIDER}/`)) syncNineRouterProvider(pi, config);
          }
        }
        saveConfig(config);
      }
      ctx.ui.notify(`Saved Jev configuration: ${CONFIG_PATH}`, "info");
    },
  });

  pi.registerCommand("jev-tasks", {
    description: "Configure task-based model routing with searchable model selector",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const config = readConfig();
      await configureTaskRules(ctx, config.taskRules,
        config.models.filter(m => m.enabled), () => saveConfig(config));
    },
  });

  pi.registerCommand("jev-mascot", {
    description: "Choose Jevling mascot, compact icon, or hide the TUI widget",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const config = readConfig();
      const selected = await ctx.ui.select("Jevling · TUI mascot", [
        "Mascot (3 lines)", "Compact (1 line)", "Off (hidden)",
        `Robot animation: ${config.robotMotion ? "ON" : "OFF"}`,
      ]);
      if (!selected) return;
      if (selected.startsWith("Robot animation:"))
        config.robotMotion = !config.robotMotion;
      else
        config.mascot = selected.startsWith("Mascot") ? "mascot"
          : selected.startsWith("Compact") ? "compact" : "off";
      saveConfig(config);
      updateJevling(ctx, config, {
        mood: config.enabled ? "ready" : "disabled",
        task: env.lastDecision?.task,
        model: env.lastDecision ? config.models.find(m => m.key === env.lastDecision.model)?.label ?? env.lastDecision.model : undefined,
      });
      ctx.ui.notify(`Jevling display set to ${config.mascot}.`, "info");
    },
  });

  pi.registerCommand("jev-config", {
    description: "Configure 9Router endpoint, API keys and routing options",
    handler: async (_args, ctx) => { await configureAddon(pi, ctx, env.health); },
  });

  pi.registerCommand("jev-scan", {
    description: "Scan available 9Router models and import selected IDs into Jev",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const config = readConfig();
      await scanAndImportNineRouter(pi, ctx, config);
    },
  });

  pi.registerCommand("jev-health", {
    description: "Inspect observed model outages, cooldowns and recovery options",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const config = readConfig();
      await configureHealthOptions(ctx, config, env.health);
    },
  });

  for (const [task, command] of Object.entries(WORKFLOW_COMMANDS) as [TaskType, string][]) {
    pi.registerCommand(command, {
      description: `Switch to ${task} phase${isStrictPhase(task) ? " (strict read-only)" : ""}; optionally supply a task prompt`,
      handler: async (args, ctx) => { await env.runWorkflowCommand(task, args, ctx); },
    });
  }
  pi.registerCommand("jev-skills", {
    description: "Inspect Pi-discovered global/project skills used for each Jev workflow phase",
    handler: async (_args, ctx) => {
      const loaded = ctx.getSystemPromptOptions?.().skills as LoadedSkill[] | undefined ?? [];
      if (!loaded.length) {
        ctx.ui.notify("No skills currently reported by Pi. Install global skills or install Jev as a Pi package with bundled skills, then /reload.", "warning");
        return;
      }
      const task = await ctx.ui.select("Jev · Skills for phase", [
        "plan","implement","qa","review","debug","research","write","explain",
      ]) as TaskType | undefined;
      if (!task) return;
      const recommended = matchingSkills(task, loaded);
      ctx.ui.notify(recommended.length
        ? "Pi-discovered skills for "+task+": "+recommended.map(s=>s.name).join(", ")+". The agent reads relevant SKILL.md on demand."
        : "No recommended skill for "+task+" is loaded. The built-in Jev phase quality gate still applies.", "info");
    },
  });

  pi.registerCommand("jev-progress", {
    description:"Inspect all task statuses and verification notes in a scrollable view; toggle widget visibility",
    handler:async (_args,ctx)=>{
      const p=env.implementationProgress;
      if(!p){ctx.ui.notify("No Jev implementation checklist in this session.","info");return;}
      const choice=await chooseChecklistAction(ctx,p);
      // The agent may have reported newer progress while this dialog was open.
      // Never overwrite its fresh step statuses with the stale UI snapshot.
      const current=env.implementationProgress??p;
      if(choice==="back")return;
      if(choice==="toggle"){
        env.saveProgress({...current,visible:!current.visible},ctx);
        ctx.ui.notify("Jev checklist widget "+(!current.visible?"shown":"hidden")+
          ". Use /jev-progress to view all tasks or change visibility.","info");
        return;
      }
      if(choice?.startsWith("step:")){
        const id=Number(choice.slice(5));
        const step=current.steps.find(s=>s.id===id);
        if(step)ctx.ui.notify("#"+step.id+" "+step.title+" · "+step.status+
          (step.note?" · "+step.note:""),"info");
        return;
      }
      // The legacy Pi selector still shows the complete checklist, but
      // newer Pi builds use the bounded scroll viewer above.
      if(ctx.hasUI && ctx.ui.select){
        const entries=p.steps.map(s=>(s.status==="done"?"☑":s.status==="active"?"◉":s.status==="blocked"?"!":"☐")+
          " "+s.id+". "+s.title.slice(0,85));
        const toggle=p.visible?"Hide checklist widget":"Show checklist widget";
        const chosen=await ctx.ui.select("Jev implementation · "+p.stage,[
          ...entries,toggle,"Back"
        ]);
        if(chosen===toggle)env.saveProgress({...current,visible:!current.visible},ctx);
        else {
          const i=entries.indexOf(chosen??"");
          if(i>=0)ctx.ui.notify(p.steps[i].title+" · "+p.steps[i].status+
            (p.steps[i].note?" · "+p.steps[i].note:""),"info");
        }
      }else ctx.ui.notify(progressLines(p,24).join("\n"),"info");
    },
  });
  pi.registerCommand("jev-progress-clear", {
    description:"End and hide Jev checklist, remove temporary plan mirror, keep session history",
    handler:async (_args,ctx)=>{
      env.closeProgress(ctx);
      ctx.ui.notify("Checklist dismissed and temporary plan cache cleaned. Session history remains.","info");
    },
  });

  pi.registerCommand("jev-web-check", {
    description:"Diagnose public HTTPS access from the Pi runtime (Node fetch / curl fallback)",
    handler: async (args, ctx) => {
      const url = args.trim() || "https://wordpress.org/news/2026/10/wordpress-7-1-4/";
      try {
        const page = await fetchPublicText(url);
        ctx.ui.notify("Jev web check OK · HTTP " + page.status +
          " · transport " + page.transport + "\n" + page.url +
          "\nReceived " + page.text.length + " text characters.", "info");
      } catch(error) {
        ctx.ui.notify("Jev web check FAILED · " +
          (error instanceof Error ? error.message : String(error)) +
          "\nCheck DNS, HTTPS_PROXY, firewall and TLS certificates.", "error");
      }
    },
  });

  pi.registerCommand("jev-delegation", {
    description:"Inspect Jev Implementation task delegation strategy and native subagent availability",
    handler:async (_args,ctx)=>{
      const cfg=readConfig().delegation;
      const found=typeof pi.getAllTools==="function" &&
        subagentReady(pi.getAllTools().map(t=>t.name));
      const waves=env.delegationSchedule?.waves.map((w,i)=>
        "Wave "+(i+1)+": "+w.execution+" · "+
        w.tasks.map(t=>"#"+t.stepId).join(", ")+
        (env.delegationSchedule?.runs?.some(r=>r.wave===i)?" · dispatched":"")).join("\n")??"No delegation schedule yet.";
      ctx.ui.notify("Jev delegation: "+cfg.strategy+" · max "+cfg.maxConcurrentBuilders+
        " Builders · agent "+cfg.builderAgent+"\nNative Pi subagent: "+
        (found?"available":"missing")+"\n"+waves,"info");
    },
  });

  pi.registerCommand("jev-pipeline-status", {
    description:"Inspect the current opt-in Auto Implement → QA → Review pipeline",
    handler: async (_args,ctx)=>{
      if(!env.autoPipeline){ctx.ui.notify("No auto pipeline in this session.", "info");return;}
      ctx.ui.notify(pipelineLines(env.autoPipeline).join("\n"),"info");
    },
  });
  pi.registerCommand("jev-pipeline-stop", {
    description:"Stop automatic advancement; keep plan, progress, and QA/Review findings",
    handler: async (_args,ctx)=>{
      env.cancelPipeline(ctx);
      ctx.ui.notify("Automatic phase transitions disabled. Current task and session history remain.", "info");
    },
  });
  pi.registerCommand("jev-pipeline-resume", {
    description:"Resume a paused auto pipeline at its last unverified phase",
    handler: async (_args,ctx)=>{
      const p=env.autoPipeline;
      if(!p || p.status!=="paused" || !["implement","qa","review"].includes(p.phase)){
        ctx.ui.notify("No paused auto pipeline to resume.", "warning");return;
      }
      env.savePipeline({...p,status:"running",reason:undefined},ctx);
      await env.runWorkflowCommand(p.phase as TaskType,"",ctx,false,true);
      if(env.workflowTask!==p.phase){
        env.savePipeline({...p,status:"paused",reason:"Could not activate "+p.phase},ctx);
        ctx.ui.notify("Could not resume pipeline phase.", "error");
        return;
      }
      const message=p.phase==="implement"
        ? p.qaRecovery
          ? qaRemediationPrompt(p,env.planDocument?.markdown??"",env.planDocument?.request)
          : "Resume the approved plan implementation. Consult jev_progress for incomplete steps, complete the deliverables and verify them.\n\n"+(env.planDocument?.markdown??"")
        : nextPhasePrompt(p.phase as "qa"|"review",env.planDocument?.markdown??"",
            env.planDocument?.request,p.qaRecovery);
      pi.sendUserMessage(message,{deliverAs:"followUp"});
    },
  });

  pi.registerCommand("jev-implement-session", {
    description:"Create a clean linked Pi Implementation Session from approved plan, with optional automatic QA/Review",
    handler:async (args,ctx)=>{
      const mode:HandoffMode=args.trim()==="auto"?"auto":"manual";
      await ctx.waitForIdle?.();
      await env.createImplementationSession(ctx,mode);
    },
  });
  pi.registerCommand("jev-session-origin", {
    description:"Show the Planning Session linked to the current Implementation Session",
    handler:async (_args,ctx)=>{
      const origin=env.implementationOrigin;
      ctx.ui.notify(origin
        ? "Jev Implementation · plan v"+origin.planVersion+" · "+origin.mode+
          "\nPlanning Session: "+origin.parentSession
        : "This session is not linked to a Jev Planning Session.", "info");
    },
  });

  pi.registerCommand("jev-plan-open", {
    description: "Review, edit or approve the latest saved Jev plan and choose what happens next",
    handler: async (_args, ctx) => { await env.openPlan(ctx); },
  });
  pi.registerCommand("jev-plan-hide", {
    description: "Dismiss the plan summary widget; the saved plan is retained in this session",
    handler: async (_args, ctx) => {
      env.showPlanSummary(ctx, false);
      cleanPlanMirror(env.trackedSessionId);
      ctx.ui.notify("Plan widget hidden. Use /jev-plan-open to review the saved plan again.", "info");
    },
  });

  pi.registerCommand("jev-auto", {
    description: "Leave explicit task phase and restore automatic Jev routing / tools",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.();
      env.cancelPipeline(ctx,"User exited to automatic model routing");
      env.changeWorkflow(undefined);
      env.implementationHandoffPending = false;
      env.showPlanSummary(ctx, false);
      env.closeProgress(ctx);
      pi.appendEntry(WORKFLOW_ENTRY, { task: null });
      if (ctx.hasUI) ctx.ui.setStatus("jev-workflow", undefined);
      ctx.ui.notify("Jev AUTO mode restored; explicit task intent cleared and original tools restored.", "info");
    },
  });

  pi.registerCommand("jev-on", {
    description: "Activate Jev routing and remember ON for future Pi/Herdr sessions",
    handler: async (_args, ctx) => { await activateJev(pi, ctx); },
  });

  pi.registerCommand("jev-off", {
    description: "Turn off routing and auto-activation on future Pi launches",
    handler: async (_args, ctx) => { await deactivateJev(pi, ctx); },
  });

  pi.registerCommand("jev-status", {
    description: "Show routing status and latest Jev selection",
    handler: async (_args, ctx) => {
      const config = readConfig();
      const d = env.lastDecision;
      ctx.ui.notify(
        `Jev routing ${isRoutingActive(config, ctx) ? "ACTIVE" : "INACTIVE"} · configured ${config.enabled ? "ON" : "OFF"} · mode ${config.mode}` +
        `\nRestore on Pi startup: ${config.enabled && config.mode === "auto" && process.env.JEV_AUTO_ACTIVATE !== "0" ? "ON" : "OFF"}` +
        `\nPi selected model: ${ctx.model ? keyOf(ctx.model) : "unknown"}` +
        `\nWorkflow phase: ${env.workflowTask ?? "auto"}${isStrictPhase(env.workflowTask) ? " [READ ONLY]" : ""}` +
        `\nPlan: ${env.planDocument ? "v" + env.planDocument.version + " " + env.planDocument.status : "none"} · widget ${env.planSummaryVisible ? "visible" : "hidden"}` +
        `\nAuto pipeline: ${env.autoPipeline ? env.autoPipeline.phase + " · " + env.autoPipeline.status : "none"}` +
        `\nEligible models: ${physicalCandidates(config, ctx).length}/${config.models.filter(m => m.enabled).length} · cooldown=${env.health.list(config.models.map(m => m.key)).filter(s => s.status === "cooldown").length} · fallback=${config.fallback || "unset"}` +
        (isRoutingActive(config, ctx) ? "" : "\nTo activate routing now: /jev-on") +
        (d ? `\nLast: ${d.task} → ${d.model}, p=${d.probability.toFixed(2)} (${d.reason})` : ""),
        "info",
      );
    },
  });

  pi.registerCommand("jev-test", {
    description: "Dry-run a prompt through Jev, without changing the active model",
    handler: async (args, ctx) => {
      const config = readConfig();
      const candidates = physicalCandidates(config, ctx).filter(m => env.health.isEligible(m.key, config.health));
      if (!candidates.length) return ctx.ui.notify("No healthy eligible models. Run /jev-health or /jev-models.", "warning");
      const prompt = args.trim() || (ctx.hasUI ? await ctx.ui.input("Test task") : "") || "";
      if (!prompt) return;
      const d = await choose(prompt, { ...config, enabled: true }, candidates, ctx);
      ctx.ui.notify(`${d.task} → ${d.model} (p=${d.probability.toFixed(2)})\n${d.reason}`, "info");
    },
  });
}
