import { type TaskType } from "../task-routing.ts";
import { registerPlanningTools } from "../planning-tools.ts";
import { registerHerdrPlanningTool } from "../herdr-collaboration.ts";
import { registerCollaborationTool } from "../collaboration-adapters.ts";
import {registerTeamTools} from "../team-tools.ts";
import {PeerCapabilities} from "../peer-capabilities.ts";
import {HERDR_PLAN_TOOL} from "../herdr-collaboration.ts";
import {COLLABORATION_TOOL} from "../collaboration-adapters.ts";
import { type PlanDocument } from "../plan-artifact.ts";
import { type Progress } from "../progress.ts";
import { type DelegationSchedule } from "../delegation.ts";
import { latestSessionOrigin } from "../implementation-session.ts";
import { type PipelineState } from "../auto-pipeline.ts";
import { ModelHealth } from "../health.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readConfig } from "../core/config.ts";
import { type Decision } from "../routing/choose.ts";
import { resetJevling } from "../ui/mascot-controller.ts";
import { registerCommands } from "../commands/register.ts";
import { registerWorkflowTools } from "./tool-handlers.ts";
import { registerLifecycleEvents } from "./lifecycle.ts";
import { createWorkflowController } from "./workflow-controller.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER="jev-manager";
const ROUTER_ID="auto";
interface RouteState {
  last: Decision;
  attempted?: string[];
}

/**
 * Jevling lives in a namespaced widget, never replacing Pi's own header/footer.
 * TUI only: RPC, print and JSON executions remain unaffected.
 */
export default function (pi: ExtensionAPI) {
  resetJevling();
  const peers=new PeerCapabilities();
  // Register read-only research and interactive choice tools at startup.
  if (typeof pi.registerTool === "function"){
    registerPlanningTools(pi);
    registerTeamTools(pi);
    registerHerdrPlanningTool(pi,undefined,peers); // backwards-compatible alias
    registerCollaborationTool(pi,()=>readConfig().peerAdapters,undefined,peers);
    pi.registerCommand("jev-peers-refresh",{
      description:"Explicitly recheck optional peer services; no background spawning",
      handler:async(_args,ctx)=>{
        const config=readConfig();
        await peers.refresh(config.peerAdapters,true);
        if(workflowTask==="plan" && typeof pi.getAllTools==="function"){
          const installed=new Set(pi.getAllTools().map(t=>t.name));
          const active=pi.getActiveTools().filter(n=>
            n!==HERDR_PLAN_TOOL && n!==COLLABORATION_TOOL);
          const optional=[
            ...(peers.ready("herdr")?[HERDR_PLAN_TOOL]:[]),
            ...(peers.anyReady(config.peerAdapters)?[COLLABORATION_TOOL]:[])
          ].filter(name=>installed.has(name));
          pi.setActiveTools([...new Set([...active,...optional])]);
        }
        if(ctx.hasUI)ctx.ui.notify(peers.summary(config.peerAdapters),"info");
      }
    });
  }
  let lastDecision: Decision | undefined;
  let workflowTask: TaskType | undefined;
  let toolsBeforeStrictPhase: string[] | undefined;
  let planDocument: PlanDocument | undefined;
  let planRunActive = false;
  let pendingPlanText: string | undefined;
  let planSummaryVisible = false;
  let implementationHandoffPending = false;
  let planOriginalRequest: string | undefined;
  let implementationProgress: Progress | undefined;
  let trackedSessionId: string | undefined;
  let progressToolInjected = false;
  let delegationToolInjected = false;
  let nativeSubagentInjected = false;
  let delegationSchedule: DelegationSchedule | undefined;
  let implementationOrigin: ReturnType<typeof latestSessionOrigin>;
  let autoPipeline: PipelineState | undefined;
  let pipelineGateInjected = false;
  let qaRecoveryToolsInjected: string[] = [];

  const { savePipeline, cancelPipeline, showProgress, saveProgress, closeProgress, showPlanSummary, savePlan, createImplementationSession, openPlan, changeWorkflow, runWorkflowCommand } = createWorkflowController(pi, {
    peers,
    get workflowTask() { return workflowTask; },
    set workflowTask(value: TaskType | undefined) { workflowTask = value; },
    get toolsBeforeStrictPhase() { return toolsBeforeStrictPhase; },
    set toolsBeforeStrictPhase(value: string[] | undefined) { toolsBeforeStrictPhase = value; },
    get planDocument() { return planDocument; },
    set planDocument(value: PlanDocument | undefined) { planDocument = value; },
    get planSummaryVisible() { return planSummaryVisible; },
    set planSummaryVisible(value: boolean) { planSummaryVisible = value; },
    get implementationHandoffPending() { return implementationHandoffPending; },
    set implementationHandoffPending(value: boolean) { implementationHandoffPending = value; },
    get planOriginalRequest() { return planOriginalRequest; },
    set planOriginalRequest(value: string | undefined) { planOriginalRequest = value; },
    get implementationProgress() { return implementationProgress; },
    set implementationProgress(value: Progress | undefined) { implementationProgress = value; },
    get trackedSessionId() { return trackedSessionId; },
    set trackedSessionId(value: string | undefined) { trackedSessionId = value; },
    get progressToolInjected() { return progressToolInjected; },
    set progressToolInjected(value: boolean) { progressToolInjected = value; },
    get delegationToolInjected() { return delegationToolInjected; },
    set delegationToolInjected(value: boolean) { delegationToolInjected = value; },
    get nativeSubagentInjected() { return nativeSubagentInjected; },
    set nativeSubagentInjected(value: boolean) { nativeSubagentInjected = value; },
    get delegationSchedule() { return delegationSchedule; },
    set delegationSchedule(value: DelegationSchedule | undefined) { delegationSchedule = value; },
    get autoPipeline() { return autoPipeline; },
    set autoPipeline(value: PipelineState | undefined) { autoPipeline = value; },
    get pipelineGateInjected() { return pipelineGateInjected; },
    set pipelineGateInjected(value: boolean) { pipelineGateInjected = value; },
    get qaRecoveryToolsInjected() { return qaRecoveryToolsInjected; },
    set qaRecoveryToolsInjected(value: string[]) { qaRecoveryToolsInjected = value; },
  });

  const health = new ModelHealth();
  const env = {
    health,peers,
    get lastDecision() { return lastDecision; },
    set lastDecision(value: Decision | undefined) { lastDecision = value; },
    get workflowTask() { return workflowTask; },
    set workflowTask(value: TaskType | undefined) { workflowTask = value; },
    get toolsBeforeStrictPhase() { return toolsBeforeStrictPhase; },
    set toolsBeforeStrictPhase(value: string[] | undefined) { toolsBeforeStrictPhase = value; },
    get planDocument() { return planDocument; },
    set planDocument(value: PlanDocument | undefined) { planDocument = value; },
    get planRunActive() { return planRunActive; },
    set planRunActive(value: boolean) { planRunActive = value; },
    get pendingPlanText() { return pendingPlanText; },
    set pendingPlanText(value: string | undefined) { pendingPlanText = value; },
    get planSummaryVisible() { return planSummaryVisible; },
    set planSummaryVisible(value: boolean) { planSummaryVisible = value; },
    get implementationHandoffPending() { return implementationHandoffPending; },
    set implementationHandoffPending(value: boolean) { implementationHandoffPending = value; },
    get planOriginalRequest() { return planOriginalRequest; },
    set planOriginalRequest(value: string | undefined) { planOriginalRequest = value; },
    get implementationProgress() { return implementationProgress; },
    set implementationProgress(value: Progress | undefined) { implementationProgress = value; },
    get trackedSessionId() { return trackedSessionId; },
    set trackedSessionId(value: string | undefined) { trackedSessionId = value; },
    get progressToolInjected() { return progressToolInjected; },
    set progressToolInjected(value: boolean) { progressToolInjected = value; },
    get delegationToolInjected() { return delegationToolInjected; },
    set delegationToolInjected(value: boolean) { delegationToolInjected = value; },
    get nativeSubagentInjected() { return nativeSubagentInjected; },
    set nativeSubagentInjected(value: boolean) { nativeSubagentInjected = value; },
    get delegationSchedule() { return delegationSchedule; },
    set delegationSchedule(value: DelegationSchedule | undefined) { delegationSchedule = value; },
    get implementationOrigin() { return implementationOrigin; },
    set implementationOrigin(value: ReturnType<typeof latestSessionOrigin>) { implementationOrigin = value; },
    get autoPipeline() { return autoPipeline; },
    set autoPipeline(value: PipelineState | undefined) { autoPipeline = value; },
    get pipelineGateInjected() { return pipelineGateInjected; },
    set pipelineGateInjected(value: boolean) { pipelineGateInjected = value; },
    get qaRecoveryToolsInjected() { return qaRecoveryToolsInjected; },
    set qaRecoveryToolsInjected(value: string[]) { qaRecoveryToolsInjected = value; },
    savePipeline, cancelPipeline, showProgress, saveProgress, closeProgress, showPlanSummary,
    savePlan, createImplementationSession, openPlan, changeWorkflow, runWorkflowCommand,
  };
  registerWorkflowTools(pi, env);
  registerLifecycleEvents(pi, env);
  registerCommands(pi, env);
}
