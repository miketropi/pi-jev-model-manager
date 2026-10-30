/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
import type { Message } from "@earendil-works/pi-ai";
import { defaultTaskRules, normalizeTaskRules, applyTaskRule, subagentTaskType, filterModels, type TaskRules, type TaskType } from "./task-routing.ts";
import { configureTaskRules } from "./task-ui.ts";
import { WORKFLOW_COMMANDS, WORKFLOW_ENTRY, isStrictPhase, toolsForPhase, canUseTool, instructionsForTask, selectExplicitModel } from "./workflow.ts";
import { registerPlanningTools, fetchPublicText } from "./planning-tools.ts";
import { matchingSkills, skillGuidance, type LoadedSkill } from "./skill-routing.ts";
import { PLAN_ENTRY, PLAN_MESSAGE, PLAN_UI_ENTRY, nextPlan, extractPlanText, latestPlanFromBranch, planPreview, implementationHandoff, type PlanDocument } from "./plan-artifact.ts";
import { mascotLines, normalizeMascotStyle, MASCOT_WIDGET_KEY, type MascotStyle, type MascotStatus } from "./mascot.ts";
import { RobotMotion } from "./robot-motion.ts";
import { PROGRESS_ENTRY, PROGRESS_WIDGET, newProgress, changeProgress, latestProgress, progressLines, type Progress } from "./progress.ts";
import { savePlanMirror, cleanPlanMirror, pruneOldPlanMirrors } from "./plan-cache.ts";
import { DELEGATION_ENTRY, DEFAULT_DELEGATION, normalizeDelegation,
  createDelegationSchedule, latestDelegation, subagentReady, scheduleInstructions,
  nextDelegationWave, recordDelegationRun, fallbackDelegationToLead, delegatePrompt,
  type DelegationSettings, type DelegationSchedule,
  type ProposedTask } from "./delegation.ts";
import { SESSION_ORIGIN_ENTRY, SESSION_LAUNCH_ENTRY, createOrigin,
  latestSessionOrigin, latestSessionLaunch, handoffTitle, type HandoffMode } from "./implementation-session.ts";
import { PIPELINE_ENTRY, startPipeline, advancePipeline, latestPipelineFromBranch,
  pipelineLines, reportGate, nextPhasePrompt, type PipelineState } from "./auto-pipeline.ts";
import { ModelHealth, DEFAULT_HEALTH, normalizeHealthSettings, type HealthSettings } from "./health.ts";
import { maskedInput, normalizeSecretInput, readSystemClipboardText } from "./config-ui.ts";
import { credentialSource, readSecrets, resolveSecret, writeSecrets, type SecretKind } from "./secrets.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  DEFAULT_NINE_ROUTER_KEY_ENV,
  DEFAULT_NINE_ROUTER_URL,
  NINE_ROUTER_BASE_URL_ENV,
  NINE_ROUTER_PROVIDER,
  normalizeNineRouterBaseUrl,
  resolveNineRouterBaseUrl,
  scanNineRouter,
  validateEnvName,
  type DiscoveredModel,
  type NineRouterSettings,
} from "./nine-router.ts";

const CONFIG_PATH = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "jev-model-manager.json",
);
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
const MAX_PROMPT_CHARS = 10_000;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = (typeof THINKING)[number];
type CostTier = "budget" | "balanced" | "premium";

interface ManagedModel {
  key: string; // provider/modelId; always maps to Pi's physical model catalog
  label: string;
  enabled: boolean;
  specialty: string;
  avoid: string;
  cost: CostTier;
  thinking: Thinking;
  // These optional fields are used for models registered via the 9Router proxy.
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}
interface Config {
  version: 1;
  enabled: boolean;
  mode: "auto" | "observe";
  classifier: { provider: string; model: string };
  fallback: string;
  minProbability: number;
  nineRouter: NineRouterSettings;
  models: ManagedModel[];
  taskRules: TaskRules;
  subagentRouting: boolean;
  delegation: DelegationSettings;
  health: HealthSettings;
  mascot: MascotStyle;
  robotMotion: boolean;
}
interface Decision {
  model: string;
  task: string;
  probability: number;
  reason: string;
  suggested?: string;
}
interface RouteState {
  last: Decision;
  attempted?: string[];
}

const defaults = (): Config => ({
  version: 1,
  enabled: false, // privacy-safe: explicit opt-in before sending prompts to Jev
  mode: "auto",
  classifier: { provider: "typesafe", model: "jev-latest" },
  fallback: "",
  minProbability: 0.43,
  nineRouter: { baseUrl: DEFAULT_NINE_ROUTER_URL, apiKeyEnv: DEFAULT_NINE_ROUTER_KEY_ENV },
  models: [],
  taskRules: defaultTaskRules(),
  subagentRouting: false, // external third-party model override remains opt-in
  delegation: { ...DEFAULT_DELEGATION },
  health: { ...DEFAULT_HEALTH },
  mascot: "mascot",
  robotMotion: true,
});

function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return defaults();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    const d = defaults();
    return {
      ...d,
      ...raw,
      classifier: { ...d.classifier, ...raw.classifier },
      nineRouter: { ...d.nineRouter, ...raw.nineRouter },
      models: Array.isArray(raw.models) ? raw.models.filter((m) => typeof m?.key === "string") : [],
      taskRules: normalizeTaskRules(raw.taskRules),
      subagentRouting: raw.subagentRouting === true,
      delegation: normalizeDelegation(raw.delegation),
      health: normalizeHealthSettings(raw.health),
      mascot: normalizeMascotStyle(raw.mascot),
      robotMotion: raw.robotMotion !== false,
    };
  } catch (e) {
    throw new Error(`Invalid config ${CONFIG_PATH}: ${String(e)}`);
  }
}

function saveConfig(config: Config): void {
  const parent = dirname(CONFIG_PATH);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, CONFIG_PATH);
}

/**
 * Jevling lives in a namespaced widget, never replacing Pi's own header/footer.
 * TUI only: RPC, print and JSON executions remain unaffected.
 */
function isJevSelected(model: { provider: string; id: string } | undefined): boolean {
  return model?.provider === ROUTER_PROVIDER && model.id === ROUTER_ID;
}

function isRoutingActive(config: Config, ctx: ExtensionContext): boolean {
  return config.enabled && config.mode === "auto" && isJevSelected(ctx.model);
}

let robotView: { ctx: ExtensionContext; config: Config; status: MascotStatus } | undefined;
let robotFrame = 0;
let robotAnimator: RobotMotion | undefined;

function paintRobot(frame: number): void {
  robotFrame = frame;
  if (!robotView) return;
  const { ctx, config, status } = robotView;
  const display: MascotStatus = isRoutingActive(config, ctx) ? status : {
    mood: "disabled",
    subtitle: config.enabled
      ? config.mode === "observe" && isJevSelected(ctx.model)
        ? "Observe only · /jev-on to route"
        : "Inactive · run /jev-on"
      : "Routing off · run /jev-on",
  };
  const lines = mascotLines(config.mascot, display, robotFrame);
  ctx.ui.setWidget(MASCOT_WIDGET_KEY, lines.length ? lines : undefined);
}

function updateJevling(ctx: ExtensionContext, config: Config, status: MascotStatus): void {
  if (ctx.mode !== "tui") return;
  robotView = { ctx, config, status };
  if ((config.mascot !== "mascot" || !config.robotMotion || !isRoutingActive(config, ctx))
    && robotAnimator?.running) robotAnimator.stop();
  paintRobot(robotFrame);
}

function keyOf(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}
function physicalCandidates(config: Config, ctx: ExtensionContext): ManagedModel[] {
  const allowed = new Set(
    ctx.modelRegistry.getAvailable()
      .filter((m) => m.api !== "pi-virtual")
      .map(keyOf),
  );
  const scoped = ctx.scopedModels.length
    ? new Set(ctx.scopedModels.map((item) => keyOf(item.model)))
    : null;
  return config.models.filter(
    (m) => m.enabled && allowed.has(m.key) && (!scoped || scoped.has(m.key)),
  );
}
function resolveModel(ctx: ExtensionContext, key: string) {
  const split = key.indexOf("/");
  if (split < 1) return undefined;
  return ctx.modelRegistry.find(key.slice(0, split), key.slice(split + 1));
}
function fallbackModel(candidates: ManagedModel[], config: Config): ManagedModel {
  const chosen = candidates.find((m) => m.key === config.fallback);
  // No unconfigured or inaccessible models are ever selected.
  return chosen || candidates[0];
}
function lastUserText(messages: readonly Message[]): string {
  const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  if (typeof content === "string") return content.slice(0, MAX_PROMPT_CHARS);
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .slice(0, MAX_PROMPT_CHARS);
}

async function choose(
  prompt: string,
  config: Config,
  candidates: ManagedModel[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Decision> {
  const base = fallbackModel(candidates, config);
  if (!config.enabled) return { model: base.key, task: "unknown", probability: 0, reason: "routing disabled" };
  if (candidates.length === 1) return { model: base.key, task: "unknown", probability: 1, reason: "only eligible model" };
  const classifier = ctx.modelRegistry.findOfType(
    "classifier", config.classifier.provider, config.classifier.model,
  );
  if (!classifier) return { model: base.key, task: "unknown", probability: 0, reason: "classifier unavailable" };

  // Jev makes a typed choice. Application code validates the answer and enforces policy.
  const criteria = Object.fromEntries(candidates.map((m, index) => [
    `m${index}`,
    [
      `Model: ${m.label} (${m.key}).`,
      `Best suited for: ${m.specialty || "general coding"}.`,
      `Avoid for: ${m.avoid || "none specified"}.`,
      `Relative cost: ${m.cost}.`,
      "Prefer lower cost when capabilities are comparable; favor correctness for critical tasks.",
    ].join(" "),
  ]));
  try {
    const result = await ctx.modelRegistry.classify(classifier, {
      state: { prompt },
      questions: {
        task: {
          type: "choice",
          instructions: "Classify the main user task, including software development and content creation.",
          criteria: {
            plan: "Plan an architecture, project, workflow or content outline",
            implement: "Write or change application code",
            debug: "Diagnose and fix a defect",
            review: "Review existing code, tests, or security",
            qa: "Run and evaluate tests, acceptance checks and regressions",
            research: "Investigate unfamiliar APIs, concepts, or libraries",
            explain: "Explain a concept without editing code",
            write: "Create or draft a blog post, article, tutorial, documentation or marketing content",
          },
        },
        selected_model: {
          type: "choice",
          instructions:
            "Select the best eligible model for solving this task. Follow model strengths and exclusions. Only choose from the provided choices.",
          criteria,
        },
      },
    }, { signal });
    if (result.stopReason !== "stop") throw new Error(`classifier stopped: ${result.stopReason}`);
    const modelAnswer = result.answers.selected_model;
    const taskAnswer = result.answers.task;
    if (modelAnswer?.type !== "choice") throw new Error("non-choice response");
    const index = Number(modelAnswer.choice?.slice(1));
    const picked = candidates[index];
    const probability = Number(modelAnswer.probabilities?.[modelAnswer.choice] ?? 0);
    const task = taskAnswer?.type === "choice" ? taskAnswer.choice : "unknown";
    if (!picked || !Number.isFinite(probability)) throw new Error("invalid model selection");
    const taskProbability = Number(taskAnswer?.probabilities?.[task] ?? 1);
    // The task policy overrides Jev's model recommendation only when task
    // classification is sufficiently confident and the target is available.
    const jevModel = probability < config.minProbability ? base.key : picked.key;
    const rule = applyTaskRule(task, jevModel, base.key, candidates.map((m) => m.key),
      config.taskRules, taskProbability, config.minProbability);
    return { model: rule.model, task, probability,
      reason: rule.reason === "Jev auto" && probability < config.minProbability
        ? "low confidence fallback" : rule.reason };
  } catch (e) {
    if (signal?.aborted) throw e;
    return {
      model: base.key, task: "unknown", probability: 0,
      reason: `classifier error; deterministic fallback (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/** Register the imported 9Router models as real Pi models. Never override the user's own 9router provider. */
function syncNineRouterProvider(pi: ExtensionAPI, config: Config): void {
  const imported = config.models.filter((m) => m.key.startsWith(`${NINE_ROUTER_PROVIDER}/`));
  if (!imported.length) {
    pi.unregisterProvider(NINE_ROUTER_PROVIDER);
    return;
  }
  const baseUrl = resolveNineRouterBaseUrl(config.nineRouter);
  const envName = validateEnvName(config.nineRouter.apiKeyEnv);
  pi.registerProvider(NINE_ROUTER_PROVIDER, {
    name: "9Router · Jev Manager",
    baseUrl,
    apiKey: credentialSource("nineRouter", envName) === "stored"
      ? resolveSecret("nineRouter", envName)!
      : `$${envName}`,
    api: "openai-completions",
    authHeader: true,
    models: imported.map((m) => ({
      id: m.key.slice(NINE_ROUTER_PROVIDER.length + 1),
      name: m.label,
      reasoning: m.reasoning ?? false,
      input: (m.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
      // 9Router does not guarantee live price metadata. These are placeholders, not price estimates.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: Math.min(m.maxTokens ?? 8_192, m.contextWindow ?? 128_000),
    })),
  });
}

function newNineRouterManagedModel(remote: DiscoveredModel): ManagedModel {
  return {
    key: `${NINE_ROUTER_PROVIDER}/${remote.id}`,
    label: remote.name,
    enabled: true,
    specialty: "General software engineering (edit capabilities after import)",
    avoid: "",
    cost: "balanced", // policy preference, not billed price
    thinking: "off", // safe until user confirms that reasoning effort is supported
    reasoning: false,
    vision: false,
    contextWindow: remote.contextWindow ?? 128_000,
    maxTokens: Math.min(remote.maxTokens ?? 8_192, remote.contextWindow ?? 128_000),
  };
}

/** Explicit import only: never rewrite hand-authored capabilities on subsequent scans. */
function importNineRouterModel(config: Config, remote: DiscoveredModel): ManagedModel {
  const key = `${NINE_ROUTER_PROVIDER}/${remote.id}`;
  const existing = config.models.find((m) => m.key === key);
  if (existing) return existing;
  const model = newNineRouterManagedModel(remote);
  config.models.push(model);
  if (!config.fallback) config.fallback = model.key;
  return model;
}

async function configureNineRouterSettings(ctx: ExtensionContext, config: Config): Promise<boolean> {
  const envOverride = process.env[NINE_ROUTER_BASE_URL_ENV]?.trim();
  if (envOverride) {
    ctx.ui.notify(`${NINE_ROUTER_BASE_URL_ENV} is set and overrides the saved URL. Change the environment variable and restart Pi to update the endpoint.`, "info");
  }
  const baseUrlInput = envOverride
    ? config.nineRouter.baseUrl
    : await ctx.ui.input("9Router URL (instance root or /v1; overridden by NINEROUTER_BASE_URL if set)", config.nineRouter.baseUrl);
  if (baseUrlInput == null) return false;
  const apiEnvInput = await ctx.ui.input("API key environment variable NAME (not the secret)", config.nineRouter.apiKeyEnv);
  if (apiEnvInput == null) return false;
  try {
    config.nineRouter = {
      baseUrl: normalizeNineRouterBaseUrl(baseUrlInput),
      apiKeyEnv: validateEnvName(apiEnvInput),
      endpointSource: config.nineRouter.endpointSource,
    };
    saveConfig(config);
    return true;
  } catch (e) {
    ctx.ui.notify(e instanceof Error ? e.message : "Invalid 9Router configuration", "warning");
    return false;
  }
}

/** When an in-app Jev key exists, register a provider-scoped override without modifying process.env. */
function syncJevCredentials(pi: ExtensionAPI, config: Config): void {
  if (credentialSource("jev", "TYPESAFE_API_KEY") === "stored" && config.classifier.provider === "typesafe") {
    pi.registerProvider("typesafe", { apiKey: resolveSecret("jev", "TYPESAFE_API_KEY")! });
  }
}

async function configureStoredKey(
  pi: ExtensionAPI, ctx: ExtensionContext, config: Config, kind: SecretKind,
): Promise<void> {
  const envName = kind === "jev" ? "TYPESAFE_API_KEY" : config.nineRouter.apiKeyEnv;
  const title = kind === "jev" ? "TypeSafe Jev" : "9Router";
  const source = credentialSource(kind, envName);
  const options = ["Set / replace securely", "Paste from system clipboard", ...(readSecrets()[kind] ? ["Delete saved key"] : []), "Back"];
  const action = await ctx.ui.select(`${title} API key · ${source === "env" ? "environment" : source === "stored" ? "saved" : "missing"}`, options);
  if (action === "Set / replace securely" || action === "Paste from system clipboard") {
    if (source === "env") {
      ctx.ui.notify(`${envName} from your shell has priority. Remove it from the Pi environment to use a saved key.`, "warning");
      return;
    }
    let key: string | undefined;
    if (action === "Paste from system clipboard") {
      const clipboard = await readSystemClipboardText();
      if (!clipboard) {
        ctx.ui.notify("No text in clipboard. Try Set / replace securely and use your terminal Paste shortcut.", "warning");
        return;
      }
      try { key = normalizeSecretInput(clipboard); }
      catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : "Invalid API key in clipboard", "warning");
        return;
      }
      if (!await ctx.ui.confirm(`Save ${title} key from clipboard?`, `Key length: ${key.length} characters (value hidden)`)) return;
    } else {
      key = await maskedInput(ctx, `Enter ${title} API key (masked)`);
    }
    if (!key) return;
    const secrets = readSecrets();
    secrets[kind] = key;
    writeSecrets(secrets);
    if (kind === "jev") syncJevCredentials(pi, config);
    else syncNineRouterProvider(pi, config);
    ctx.ui.notify(`${title} key saved in protected user-level storage.`, "info");
  } else if (action === "Delete saved key") {
    if (!await ctx.ui.confirm(`Delete saved ${title} key?`, "This will remove the addon-stored credential; shell variables are unaffected.")) return;
    const secrets = readSecrets();
    delete secrets[kind];
    writeSecrets(secrets);
    if (kind === "jev") {
      // The provider override is kept until reload so we do not disrupt another extension's provider.
      ctx.ui.notify("Stored Jev key deleted. Run /reload to refresh TypeSafe authentication.", "info");
    } else {
      syncNineRouterProvider(pi, config);
      ctx.ui.notify("Stored 9Router key deleted; shell credentials, if any, remain usable.", "info");
    }
  }
}

async function configureRoutingOptions(ctx: ExtensionContext, config: Config): Promise<void> {
  while (true) {
    const choice = await ctx.ui.select("Jev routing settings", [
      `Enabled: ${config.enabled ? "ON" : "OFF"}`,
      `Mode: ${config.mode}`,
      `Minimum confidence: ${config.minProbability.toFixed(2)}`,
      `Fallback: ${config.fallback || "not set"}`,
      `Classifier: ${config.classifier.provider}/${config.classifier.model}`,
      "Back",
    ]);
    if (!choice || choice === "Back") return;
    if (choice.startsWith("Enabled:")) {
      config.enabled = !config.enabled;
      if (config.enabled && !isJevSelected(ctx.model))
        ctx.ui.notify("Routing policy enabled, but Pi still uses a physical model. Run /jev-on to activate.", "info");
    }
    else if (choice.startsWith("Mode:")) config.mode = config.mode === "auto" ? "observe" : "auto";
    else if (choice.startsWith("Minimum confidence:")) {
      const raw = await ctx.ui.input("Minimum Jev confidence (0–1)", String(config.minProbability));
      if (raw != null) {
        const n = Number(raw);
        if (raw.trim() && Number.isFinite(n) && n >= 0 && n <= 1) config.minProbability = n;
        else ctx.ui.notify("Enter a number from 0 to 1.", "warning");
      }
    } else if (choice.startsWith("Fallback:")) {
      const models = config.models.filter(m => m.enabled).map(m => m.key);
      if (!models.length) ctx.ui.notify("Import or enable a model first with /jev-models.", "warning");
      else config.fallback = await ctx.ui.select("Choose fallback", models) || config.fallback;
    } else if (choice.startsWith("Classifier:")) {
      const provider = await ctx.ui.input("Classifier provider", config.classifier.provider);
      if (!provider?.trim()) continue;
      const model = await ctx.ui.input("Classifier model ID", config.classifier.model);
      if (!model?.trim()) continue;
      config.classifier = { provider: provider.trim(), model: model.trim() };
    }
    saveConfig(config);
  }
}



/** /jev-on is the user's durable opt-in. A later Pi process may restore that
 * choice without writing global config or prompting the user again.
 */
async function activateJev(pi: ExtensionAPI, ctx: ExtensionContext,
  options: { restore?: boolean } = {}): Promise<boolean> {
  const config = readConfig();
  const restoring = options.restore === true;
  if (restoring && (!config.enabled || config.mode !== "auto" ||
    process.env.JEV_AUTO_ACTIVATE === "0")) return false;
  if (isJevSelected(ctx.model) && config.enabled && config.mode === "auto") {
    if (!restoring) ctx.ui.notify("Jev routing is already active and remembered for future Pi sessions.", "info");
    return true;
  }
  const notify = (message: string, level: "warning" | "error") => {
    if (!restoring || ctx.hasUI) ctx.ui.notify(message, level);
  };
  const available = physicalCandidates(config, ctx);
  if (!available.length) {
    notify("Jev cannot activate: no enabled/authenticated models. Add them with /jev-models or /jev-scan.", "warning");
    return false;
  }
  if (typeof pi.setModel !== "function") {
    notify("This Pi build does not expose pi.setModel(). Select jev-manager/auto manually with /model.", "warning");
    return false;
  }
  const virtual = ctx.modelRegistry.find(ROUTER_PROVIDER, ROUTER_ID)
    ?? ctx.modelRegistry.getAvailable().find(m => m.provider === ROUTER_PROVIDER && m.id === ROUTER_ID);
  if (!virtual) {
    notify("Jev virtual model is missing. Run /reload, then use /model → jev-manager/auto.", "warning");
    return false;
  }
  try {
    const success = await pi.setModel(virtual);
    if (!success) {
      notify("Pi refused the virtual model selection. Verify credentials, or select jev-manager/auto with /model.", "error");
      return false;
    }
    // Startup restore must not rewrite a shared config while another Herdr/Pi
    // child may be reading or updating it. Only explicit /jev-on persists ON.
    if (!restoring) {
      config.enabled = true;
      config.mode = "auto";
      saveConfig(config);
    }
    updateJevling({ ...ctx, model: virtual }, config, { mood: "ready" });
    if (!restoring) {
      ctx.ui.notify("Jev routing ACTIVE and remembered for new Pi sessions. /jev-off disables startup restoration.", "info");
    } else if (ctx.hasUI) {
      ctx.ui.notify("Jev routing restored from saved ON state (jev-manager/auto).", "info");
    }
    return true;
  } catch {
    notify("Unable to switch model. Use /model to select jev-manager/auto and inspect /jev-status.", "error");
    return false;
  }
}

async function deactivateJev(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const config = readConfig();
  config.enabled = false;
  saveConfig(config);
  // The selection is independent of routing policy. Prefer a physical model
  // immediately so /jev-off also exits the virtual model where possible.
  if (isJevSelected(ctx.model)) {
    const available = physicalCandidates(config, ctx);
    const chosen = available.find(m => m.key === config.fallback) ?? available[0];
    const slash = chosen?.key.indexOf("/") ?? -1;
    const physical = chosen && slash > 0
      ? ctx.modelRegistry.find(chosen.key.slice(0, slash), chosen.key.slice(slash + 1))
      : undefined;
    if (physical && typeof pi.setModel === "function") {
      try {
        if (await pi.setModel(physical)) {
          updateJevling({ ...ctx, model: physical }, config, { mood: "disabled" });
          ctx.ui.notify("Jev routing OFF. Future Pi sessions will not auto-activate Jev.", "info");
          return;
        }
      } catch { /* no active fallback; notify the user below */ }
    }
    ctx.ui.notify("Jev saved OFF. Pi is still selecting the Jev virtual model; choose a physical model with /model.", "warning");
    return;
  }
  updateJevling(ctx, config, { mood: "disabled" });
  ctx.ui.notify("Jev routing OFF. Future Pi sessions will not auto-activate Jev.", "info");
}

async function probeModelHealth(ctx: ExtensionContext, config: Config, health: ModelHealth): Promise<void> {
  const available = new Set(ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`));
  const models = config.models.filter(m => m.enabled && available.has(m.key));
  if (!models.length) {
    ctx.ui.notify("No authenticated physical models available to probe.", "warning");
    return;
  }
  const filter = await ctx.ui.input("Search model name, provider or ID (optional)", "");
  if (filter == null) return;
  const matches = filterModels(models, filter, 50);
  if (!matches.length) {
    ctx.ui.notify("No models match the search.", "warning");
    return;
  }
  const selected = await ctx.ui.select("Run live model check · choose a model", matches.map(m => m.key));
  if (!selected) return;
  if (!await ctx.ui.confirm("Send a live 8-token test request?", "This incurs provider usage, tests only the chosen model, and may reveal its availability. No project files are sent.")) return;
  const model = resolveModel(ctx, selected);
  if (!model) return;
  try {
    const reply = await ctx.modelRegistry.complete(model, {
      systemPrompt: "Availability check: reply with OK.",
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: "Reply OK." }],
        timestamp: Date.now(),
      }],
    }, { maxTokens: 8, signal: AbortSignal.timeout(15000) });
    if (reply.stopReason === "stop" || reply.stopReason === "toolUse") {
      health.reportSuccess(selected);
      ctx.ui.notify(`${selected} responded successfully. Health marked OK.`, "info");
    } else {
      const kind = health.reportFailure(selected, reply.stopReason, reply.errorMessage, config.health);
      ctx.ui.notify(`${selected} failed live check${kind ? ` (${kind}; cooling down)` : " (not classified as an outage)"}.`, "warning");
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown provider error";
    const kind = health.reportFailure(selected, "error", reason, config.health);
    // Avoid displaying raw provider errors: they may contain tokens or personal data.
    ctx.ui.notify(`${selected}: live check failed${kind ? ` (${kind}; cooling down)` : " (unclassified)"}.`, "warning");
  }
}

async function configureHealthOptions(ctx: ExtensionContext, config: Config, health: ModelHealth): Promise<void> {
  while (true) {
    const disabled = health.list(config.models.map(m => m.key))
      .filter(s => s.status === "cooldown");
    const choice = await ctx.ui.select("Jev · Model health & failover", [
      `Health monitoring: ${config.health.enabled ? "ON" : "OFF"}`,
      `Retry failover: ${config.health.autoFailover ? "ON" : "OFF"}`,
      `Base cooldown: ${config.health.cooldownSeconds}s`,
      `Max cooldown: ${config.health.maxCooldownSeconds}s`,
      `Models cooling down: ${disabled.length}`,
      "View model health",
      "Test one model now (uses a few tokens)",
      "Clear all cooldowns",
      "Back",
    ]);
    if (!choice || choice === "Back") return;
    if (choice.startsWith("Health monitoring:")) config.health.enabled = !config.health.enabled;
    else if (choice.startsWith("Retry failover:")) config.health.autoFailover = !config.health.autoFailover;
    else if (choice.startsWith("Base cooldown:") || choice.startsWith("Max cooldown:")) {
      const isBase = choice.startsWith("Base");
      const field = isBase ? "cooldownSeconds" : "maxCooldownSeconds";
      const raw = await ctx.ui.input("Cooldown in seconds (5–86400)", String(config.health[field]));
      if (raw == null) continue;
      const n = Number(raw);
      if (Number.isSafeInteger(n) && n >= 5 && n <= 86400) {
        config.health[field] = n;
        if (config.health.maxCooldownSeconds < config.health.cooldownSeconds) {
          config.health.maxCooldownSeconds = config.health.cooldownSeconds;
        }
      } else ctx.ui.notify("Enter an integer between 5 and 86400 seconds.", "warning");
    } else if (choice === "View model health" || choice.startsWith("Models cooling down:")) {
      const statuses = health.list(config.models.map(m => m.key));
      const rows = statuses.slice(0, 70).map(s =>
        `${s.key}: ${s.status}${s.remainingSeconds ? ` (${s.remainingSeconds}s)` : ""}${s.reason ? ` [${s.reason}]` : ""}`
      );
      await ctx.ui.select("Observed model health · last Pi requests", [...rows, "Back"]);
    } else if (choice === "Test one model now (uses a few tokens)") {
      await probeModelHealth(ctx, config, health);
    } else if (choice === "Clear all cooldowns") {
      if (await ctx.ui.confirm("Clear observed health?", "This removes local error history; it does not fix an unavailable provider.")) {
        health.reset();
        ctx.ui.notify("Health cache cleared. Models will be eligible on their next request.", "info");
      }
    }
    saveConfig(config);
  }
}

/** Central, extensible configuration screen, accessible via /jev-config and /jev-models. */
async function configureAddon(pi: ExtensionAPI, ctx: ExtensionContext, health: ModelHealth): Promise<void> {
  if (!ctx.hasUI) return;
  const config = readConfig();
  while (true) {
    const status9 = credentialSource("nineRouter", config.nineRouter.apiKeyEnv);
    const statusJev = credentialSource("jev", "TYPESAFE_API_KEY");
    const url = resolveNineRouterBaseUrl(config.nineRouter);
    const choice = await ctx.ui.select("Jev Model Manager · Configuration", [
      `9Router endpoint: ${url}${config.nineRouter.endpointSource === "saved" ? " [saved]" : process.env[NINE_ROUTER_BASE_URL_ENV]?.trim() ? " [env]" : ""}`,
      `9Router key: ${status9}`,
      `9Router key variable: ${config.nineRouter.apiKeyEnv}`,
      `Jev key: ${statusJev}`,
      `Current selection: ${isJevSelected(ctx.model) ? "jev-manager/auto" : ctx.model ? keyOf(ctx.model) : "unknown"}`,
      `Routing active: ${isRoutingActive(config, ctx) ? "YES" : "NO"}`,
      "Activate routing for this session (/jev-on)",
      "Routing & classifier options",
      "Task routing (/jev-tasks)",
      `TUI mascot: ${config.mascot}`,
      `Robot animation: ${config.robotMotion ? "ON" : "OFF"}`,
      "Model health & failover (/jev-health)",
      `Subagent auto-routing: ${config.subagentRouting ? "ON" : "OFF"}`,
      `Implementation execution: ${config.delegation.strategy}`,
      `Max concurrent Builders: ${config.delegation.maxConcurrentBuilders}`,
      `Builder agent profile: ${config.delegation.builderAgent}`,
      "Test 9Router connection",
      "Manage models (/jev-models)",
      "Done",
    ]);
    if (!choice || choice === "Done") break;
    try {
      if (choice.startsWith("9Router endpoint:")) {
        const override = process.env[NINE_ROUTER_BASE_URL_ENV]?.trim();
        if (override) {
          const preference = await ctx.ui.select("9Router URL source", [
            "Use a custom URL (override environment)",
            "Use NINEROUTER_BASE_URL from environment",
            "Back",
          ]);
          if (!preference || preference === "Back") continue;
          if (preference.startsWith("Use NINEROUTER_BASE_URL")) {
            config.nineRouter.endpointSource = "auto";
            saveConfig(config);
            syncNineRouterProvider(pi, config);
            continue;
          }
          config.nineRouter.endpointSource = "saved";
        }
        const input = await ctx.ui.input("9Router base URL", config.nineRouter.baseUrl);
        if (input == null) continue;
        config.nineRouter.baseUrl = normalizeNineRouterBaseUrl(input);
        saveConfig(config);
        syncNineRouterProvider(pi, config);
      } else if (choice.startsWith("9Router key:")) {
        await configureStoredKey(pi, ctx, config, "nineRouter");
      } else if (choice.startsWith("9Router key variable:")) {
        const input = await ctx.ui.input("9Router API key environment variable name", config.nineRouter.apiKeyEnv);
        if (input == null) continue;
        config.nineRouter.apiKeyEnv = validateEnvName(input);
        saveConfig(config);
        syncNineRouterProvider(pi, config);
      } else if (choice.startsWith("Jev key:")) {
        await configureStoredKey(pi, ctx, config, "jev");
      } else if (choice === "Task routing (/jev-tasks)") {
        await configureTaskRules(ctx, config.taskRules, config.models.filter(m => m.enabled), () => saveConfig(config));
      } else if (choice.startsWith("TUI mascot:")) {
        const selected = await ctx.ui.select("Jevling · TUI display", [
          "Mascot (3 lines)", "Compact (1 line)", "Off (hidden)",
        ]);
        if (!selected) continue;
        config.mascot = selected.startsWith("Mascot") ? "mascot"
          : selected.startsWith("Compact") ? "compact" : "off";
        saveConfig(config);
        updateJevling(ctx, config, { mood: config.enabled ? "ready" : "disabled" });
      } else if (choice.startsWith("Robot animation:")) {
        config.robotMotion = !config.robotMotion;
        saveConfig(config);
        updateJevling(ctx, config, { mood: config.enabled ? "ready" : "disabled" });
      } else if (choice === "Model health & failover (/jev-health)") {
        await configureHealthOptions(ctx, config, health);
      } else if (choice.startsWith("Subagent auto-routing:")) {
        config.subagentRouting = !config.subagentRouting;
        saveConfig(config);
      } else if (choice.startsWith("Implementation execution:")) {
        const next=await ctx.ui.select("Implementation Execution Strategy",[
          "Prefer Subagents (recommended)","Always Delegate","Direct · Lead only"]);
        if(next){
          config.delegation.strategy=next.startsWith("Prefer")?"prefer":
            next.startsWith("Always")?"always":"direct";
          saveConfig(config);
        }
      } else if (choice.startsWith("Max concurrent Builders:")) {
        const next=await ctx.ui.select("Max concurrent Builders (file scopes must be disjoint)",["1","2"]);
        if(next==="1"||next==="2"){
          config.delegation.maxConcurrentBuilders=Number(next);
          saveConfig(config);
        }
      } else if (choice.startsWith("Builder agent profile:")) {
        const next=await ctx.ui.input("Pi subagent agent name (user-level only)",
          config.delegation.builderAgent);
        if(next!==undefined){
          const valid=normalizeDelegation({...config.delegation,builderAgent:next});
          if(valid.builderAgent!==next)ctx.ui.notify("Agent name must be alphanumeric, dash or underscore.", "warning");
          else {config.delegation=valid;saveConfig(config);}
        }
      } else if (choice === "Activate routing for this session (/jev-on)" || choice.startsWith("Routing active:")) {
        await activateJev(pi, ctx);
        Object.assign(config, readConfig());
      } else if (choice.startsWith("Current selection:")) {
        ctx.ui.notify("Select /jev-on to activate task-aware routing; otherwise Pi uses the current model directly.", "info");
      } else if (choice === "Routing & classifier options") {
        await configureRoutingOptions(ctx, config);
        syncJevCredentials(pi, config);
      } else if (choice === "Test 9Router connection") {
        const models = await scanNineRouter(config.nineRouter, fetch, resolveSecret("nineRouter", config.nineRouter.apiKeyEnv));
        ctx.ui.notify(`9Router connection OK · ${models.length} model IDs discovered.`, "info");
      } else if (choice === "Manage models (/jev-models)") {
        ctx.ui.notify("Use /jev-models to import and edit models after leaving this menu.", "info");
      }
    } catch (error) {
      // Error text from the scanner is sanitized and never includes keys.
      ctx.ui.notify(error instanceof Error ? error.message : "Configuration failed", "warning");
    }
  }
}

async function scanAndImportNineRouter(pi: ExtensionAPI, ctx: ExtensionContext, config: Config): Promise<void> {
  if (!ctx.hasUI) return;
  let discovered: DiscoveredModel[];
  try {
    discovered = await scanNineRouter(config.nineRouter, fetch, resolveSecret("nineRouter", config.nineRouter.apiKeyEnv));
  } catch (e) {
    ctx.ui.notify(e instanceof Error ? e.message : "9Router scan failed", "error");
    return;
  }
  if (!discovered.length) {
    ctx.ui.notify("9Router returned zero valid model IDs.", "warning");
    return;
  }
  let filter = "";
  ctx.ui.notify(`Found ${discovered.length} 9Router IDs. Listing does not guarantee model availability or quota.`, "info");
  while (true) {
    const matches = discovered.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()));
    const imported = new Set(config.models.map((m) => m.key));
    const unseen = matches.filter((m) => !imported.has(`${NINE_ROUTER_PROVIDER}/${m.id}`));
    const selectionMap = new Map<string, DiscoveredModel>();
    const rows = matches.slice(0, 60).map((m, i) => {
      const label = `${imported.has(`${NINE_ROUTER_PROVIDER}/${m.id}`) ? "✓" : "+"} ${m.id} [${i + 1}]`;
      selectionMap.set(label, m);
      return label;
    });
    const choice = await ctx.ui.select(`9Router · ${matches.length} matching · ${unseen.length} new${matches.length > 60 ? " · first 60 shown" : ""}`, [
      `Filter: ${filter || "all"}`,
      `Import all ${unseen.length} new matching models (max 30)`,
      ...rows,
      "Back",
    ]);
    if (!choice || choice === "Back") return;
    if (choice.startsWith("Filter:")) {
      const value = await ctx.ui.input("Filter by model name or ID (blank = all)", filter);
      if (value !== undefined) filter = value.trim();
    } else if (choice.startsWith("Import all ")) {
      if (!unseen.length) {
        ctx.ui.notify("No new models matching the filter", "info");
      } else if (unseen.length > 30) {
        ctx.ui.notify("Narrow the filter to 30 or fewer models before importing a batch. Large Jev candidate lists are inefficient.", "warning");
      } else if (await ctx.ui.confirm("Import models?", `Add ${unseen.length} model(s) to Jev. You can edit capabilities later.`)) {
        for (const m of unseen) importNineRouterModel(config, m);
        saveConfig(config);
        syncNineRouterProvider(pi, config);
        ctx.ui.notify(`Imported ${unseen.length} model(s). Use /jev-models to edit strengths and costs.`, "info");
      }
    } else {
      const remote = selectionMap.get(choice);
      if (!remote) continue;
      const model = importNineRouterModel(config, remote);
      saveConfig(config);
      syncNineRouterProvider(pi, config);
      await configureModel(ctx, config, model);
      syncNineRouterProvider(pi, config); // account for updated metadata or removal
    }
  }
}

async function configureModel(ctx: ExtensionContext, config: Config, model: ManagedModel): Promise<boolean> {
  while (true) {
    const choice = await ctx.ui.select(`Manage ${model.label}`, [
      `Enabled: ${model.enabled ? "yes" : "no"}`,
      `Display name: ${model.label}`,
      `Specialty: ${model.specialty || "—"}`,
      `Avoid: ${model.avoid || "—"}`,
      `Cost: ${model.cost}`,
      `Thinking: ${model.thinking}`,
      ...(model.key.startsWith(`${NINE_ROUTER_PROVIDER}/`) ? [
        `Reasoning supported: ${model.reasoning ? "yes" : "no"}`,
        `Images supported: ${model.vision ? "yes" : "no"}`,
        `Context window: ${model.contextWindow ?? 128000}`,
        `Max output tokens: ${model.maxTokens ?? 8192}`,
      ] : []),
      "Remove from registry", "Back",
    ]);
    if (!choice || choice === "Back") return true;
    if (choice.startsWith("Enabled:")) model.enabled = !model.enabled;
    if (choice.startsWith("Display name:")) {
      const value = await ctx.ui.input("Display name", model.label);
      if (value?.trim()) model.label = value.trim();
    }
    if (choice.startsWith("Specialty:")) {
      const value = await ctx.ui.editor("Best suited for (natural language)", model.specialty);
      if (value !== undefined) model.specialty = value.trim();
    }
    if (choice.startsWith("Avoid:")) {
      const value = await ctx.ui.editor("Avoid for (natural language)", model.avoid);
      if (value !== undefined) model.avoid = value.trim();
    }
    if (choice.startsWith("Cost:")) {
      const value = await ctx.ui.select("Relative cost", ["budget", "balanced", "premium"]);
      if (value) model.cost = value as CostTier;
    }
    if (choice.startsWith("Thinking:")) {
      const value = await ctx.ui.select("Reasoning effort", [...THINKING]);
      if (value) model.thinking = value as Thinking;
    }
    if (choice.startsWith("Reasoning supported:")) {
      model.reasoning = !model.reasoning;
      if (!model.reasoning) model.thinking = "off";
    }
    if (choice.startsWith("Images supported:")) model.vision = !model.vision;
    if (choice.startsWith("Context window:")) {
      const value = await ctx.ui.input("Context window tokens", String(model.contextWindow ?? 128000));
      if (value != null) {
        const n = Number(value);
        if (Number.isSafeInteger(n) && n > 0 && n <= 10_000_000 && n >= (model.maxTokens ?? 8192)) model.contextWindow = n;
        else ctx.ui.notify("Must be a positive integer at least as large as max output tokens (max 10M)", "warning");
      }
    }
    if (choice.startsWith("Max output tokens:")) {
      const value = await ctx.ui.input("Max output tokens", String(model.maxTokens ?? 8192));
      if (value != null) {
        const n = Number(value);
        if (Number.isSafeInteger(n) && n > 0 && n <= (model.contextWindow ?? 128000)) model.maxTokens = n;
        else ctx.ui.notify("Must be a positive integer no larger than context window", "warning");
      }
    }
    if (choice === "Remove from registry") {
      if (await ctx.ui.confirm("Remove model?", model.key)) {
        config.models = config.models.filter((m) => m.key !== model.key);
        if (config.fallback === model.key) config.fallback = "";
        return false;
      }
    }
    saveConfig(config);
  }
}

export default function (pi: ExtensionAPI) {
  robotAnimator?.stop();
  robotView = undefined;
  robotFrame = 0;
  robotAnimator = new RobotMotion(paintRobot);
  // Register read-only research and interactive choice tools at startup.
  if (typeof pi.registerTool === "function") registerPlanningTools(pi);
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

  function savePipeline(p: PipelineState, ctx: ExtensionContext): void {
    autoPipeline = p;
    pi.appendEntry(PIPELINE_ENTRY, p);
    if (ctx.hasUI) {
      ctx.ui.setStatus("jev-pipeline", ["cancelled","completed"].includes(p.status) ? undefined
        : "AUTO " + p.phase.toUpperCase() + " · " + p.status.toUpperCase());
    }
  }
  function cancelPipeline(ctx: ExtensionContext, reason = "Stopped by user"): void {
    if (!autoPipeline || ["cancelled","completed"].includes(autoPipeline.status)) return;
    savePipeline({...autoPipeline,status:"cancelled",reason},ctx);
  }


  function showProgress(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const p = implementationProgress;
    const visible = workflowTask === "implement" && p?.visible
      && p.stage !== "complete" && p.stage !== "cancelled";
    const rows=visible ? progressLines(p!) : undefined;
    if(rows && delegationSchedule?.version===p?.version){
      for(let i=1;i<rows.length;i++){
        const number=Number(/^.[ ]+(\d+)\./.exec(rows[i])?.[1]);
        const assigned=delegationSchedule.waves.find(w=>w.tasks.some(t=>t.stepId===number));
        if(assigned?.execution==="builder")rows[i]+=" · Builder";
        else if(assigned && delegationSchedule.fallbacks?.some(f=>
          delegationSchedule!.waves[f.wave]===assigned))rows[i]+=" · Lead fallback";
      }
    }
    ctx.ui.setWidget(PROGRESS_WIDGET,rows);
  }

  function saveProgress(p: Progress, ctx: ExtensionContext): void {
    implementationProgress = p;
    pi.appendEntry(PROGRESS_ENTRY, p);
    showProgress(ctx);
  }

  function closeProgress(ctx: ExtensionContext): void {
    if (implementationProgress && implementationProgress.stage !== "complete") {
      saveProgress({...implementationProgress,stage:"cancelled",visible:false},ctx);
    } else {
      if (ctx.mode === "tui") ctx.ui.setWidget(PROGRESS_WIDGET,undefined);
    }
    cleanPlanMirror(trackedSessionId);
  }

  function showPlanSummary(ctx: ExtensionContext, show: boolean, persist = true): void {
    const nextVisible = show && planDocument?.status === "draft";
    if (persist && nextVisible !== planSummaryVisible)
      pi.appendEntry(PLAN_UI_ENTRY, { visible: nextVisible });
    planSummaryVisible = nextVisible;
    if (ctx.mode === "tui") ctx.ui.setWidget("jev-plan-summary",
      planSummaryVisible && planDocument ? planPreview(planDocument) : undefined);
  }

  function savePlan(document: PlanDocument, ctx: ExtensionContext): void {
    planDocument = document;
    pi.appendEntry(PLAN_ENTRY, document);
    // Canonical source is the Pi session. A private temporary Markdown mirror
    // is optional and never uses ctx.cwd or the repository directory.
    try {
      savePlanMirror(trackedSessionId ?? ctx.sessionManager?.getSessionId?.(), document.markdown);
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
    if (!planDocument || planDocument.status !== "approved") {
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
    const last=latestSessionLaunch(ctx.sessionManager?.getBranch?.()??[],planDocument.version);
    if (last && last.status === "requested") {
      const confirm=await ctx.ui.confirm?.("Already launched?",
        "An Implementation Session may already exist for plan v"+planDocument.version+
        ". Check Pi /resume first. Create another session?");
      if (confirm!==true)return;
    }
    // Capture only immutable data; callbacks run after the old extension is destroyed.
    const snapshot=JSON.parse(JSON.stringify(planDocument)) as PlanDocument;
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
    if (!planDocument) {
      ctx.ui.notify("No saved Jev plan yet. Run /jev-plan first.", "warning");
      return;
    }
    if (!ctx.hasUI || !ctx.ui.select) {
      ctx.ui.notify("Plan saved in session. Open the session in Pi TUI to review/edit.", "info");
      return;
    }
    for (let step = 0; step < 12; step++) {
      const choice = await ctx.ui.select(
        `Jev Plan v${planDocument.version} · ${planDocument.status} · next action`,
        ["View / edit full plan",
         "Implement now · New session (recommended)",
         "Auto Implement → QA → Review · New session",
         "Implement now (approve plan)",
         "Auto Implement → QA → Review (approve plan)",
         "Refine with AI", "Keep plan for later", "Cancel"],
      );
      if (!choice || choice === "Keep plan for later" || choice === "Cancel") {
        showPlanSummary(ctx, false);
        cleanPlanMirror(trackedSessionId);
        return;
      }
      if (choice === "View / edit full plan") {
        const edited = await ctx.ui.editor("Jev Plan · Markdown (edit to revise)",
          planDocument.markdown);
        if (typeof edited === "string" && edited.trim() && edited.trim() !== planDocument.markdown) {
          savePlan(nextPlan(edited, planDocument), ctx);
          ctx.ui.notify("Plan revised and saved in this Pi session.", "info");
        }
      } else if (choice === "Refine with AI") {
        const change = await ctx.ui.editor("What should change in the plan?", "");
        if (change?.trim()) {
          // Switch back to Plan to enforce no project writes during revision.
          if (workflowTask !== "plan") await runWorkflowCommand("plan", "", ctx);
          if (workflowTask === "plan")
            pi.sendUserMessage("Revise the existing Jev plan based on this feedback. Do not implement.\nCurrent plan:\n"+
              planDocument.markdown+"\nFeedback:\n"+change.trim(), {deliverAs:"followUp"});
        }
        return;
      } else if (choice === "Implement now · New session (recommended)"
        || choice === "Auto Implement → QA → Review · New session") {
        const mode: HandoffMode=choice.startsWith("Auto")?"auto":"manual";
        const approved={...planDocument,status:"approved" as const};
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
        const approved = { ...planDocument, status: "approved" as const };
        savePlan(approved, ctx);
        if (automatic) savePipeline(startPipeline(approved.version),ctx);
        else cancelPipeline(ctx,"User selected manual Implement now");
        await runWorkflowCommand("implement", "", ctx, false, automatic);
        if (workflowTask !== "implement") {
          if (automatic) savePipeline({...autoPipeline!,status:"paused",
            reason:"Could not activate Implementation"},ctx);
          ctx.ui.notify("Could not switch to Implementation; approved plan remains saved.", "error");
          return;
        }
        implementationHandoffPending = true;
        pi.sendUserMessage(implementationHandoff(approved), {deliverAs:"followUp"});
        return;
      }
    }
  }


  function changeWorkflow(task: TaskType | undefined): void {
    if (workflowTask === "implement" && task !== "implement") {
      const remove=[
        ...(delegationToolInjected?["jev_delegate"]:[]),
        ...(nativeSubagentInjected?["subagent"]:[])
      ];
      if(remove.length)pi.setActiveTools(pi.getActiveTools().filter(name=>!remove.includes(name)));
      delegationToolInjected=false;
      nativeSubagentInjected=false;
    }
    if (pipelineGateInjected && task !== workflowTask) {
      pi.setActiveTools(pi.getActiveTools().filter(n=>n!=="jev_quality_gate"));
      pipelineGateInjected = false;
    }
    if (workflowTask === "implement" && task !== "implement" && progressToolInjected) {
      pi.setActiveTools(pi.getActiveTools().filter(name=>name!=="jev_progress"));
      progressToolInjected = false;
    }
    const wasStrict = isStrictPhase(workflowTask);
    const nextStrict = isStrictPhase(task);
    // Restore the user's tool selection later, including tools activated by extensions.
    if (nextStrict && !wasStrict) {
      toolsBeforeStrictPhase = pi.getActiveTools();
      const registered = typeof pi.getAllTools === "function"
        ? new Set(pi.getAllTools().map(tool => tool.name)) : new Set<string>();
      const additions = ["jev_web_fetch", "jev_ask_user",
        ...(task === "review" && autoPipeline?.phase === "review" ? ["jev_quality_gate"] : [])]
        .filter(name => registered.has(name) && !toolsBeforeStrictPhase!.includes(name));
      if (additions.includes("jev_quality_gate")) pipelineGateInjected = true;
      pi.setActiveTools(toolsForPhase([...toolsBeforeStrictPhase, ...additions], task!));
    } else if (wasStrict && !nextStrict && toolsBeforeStrictPhase) {
      pi.setActiveTools(toolsBeforeStrictPhase);
      toolsBeforeStrictPhase = undefined;
    }
    workflowTask = task;
  }

  async function runWorkflowCommand(task: TaskType, args: string, ctx: ExtensionContext,
    skipIdle = false, fromPipeline = false): Promise<void> {
    // This is only skipped at the final agent-settled boundary, never mid-turn.
    if (!skipIdle) await ctx.waitForIdle?.();
    if (!await activateJev(pi, ctx)) return;
    if (!fromPipeline) cancelPipeline(ctx,"Switched task phase manually");
    changeWorkflow(task);
    if (task === "implement" && planDocument?.status === "approved") {
      if (!implementationProgress || implementationProgress.version !== planDocument.version
        || ["cancelled","complete"].includes(implementationProgress.stage)) {
        delegationSchedule=undefined;
        pi.appendEntry(DELEGATION_ENTRY,{cleared:true});
        saveProgress(newProgress(planDocument.markdown,planDocument.version),ctx);
      } else saveProgress({...implementationProgress,stage:"running",visible:true},ctx);
    } else if (task !== "implement" && implementationProgress?.visible) {
      closeProgress(ctx);
    }
    if (task === "plan" && args.trim()) planOriginalRequest = args.trim();
    if (task !== "implement") implementationHandoffPending = false;
    if (task !== "plan") showPlanSummary(ctx, false);
    if (fromPipeline && task === "qa" && typeof pi.getAllTools === "function") {
      const enabled = pi.getAllTools().some(t=>t.name==="jev_quality_gate");
      if (enabled && !pi.getActiveTools().includes("jev_quality_gate")) {
        pi.setActiveTools([...pi.getActiveTools(),"jev_quality_gate"]);
        pipelineGateInjected = true;
      }
    }
    if (task === "implement" && typeof pi.getAllTools === "function") {
      const registeredNames=pi.getAllTools().map(t=>t.name);
      const extras=["jev_delegate",...(readConfig().delegation.strategy==="direct"?[]:
        registeredNames.includes("subagent")?["subagent"]:[])];
      const newly=extras.filter(name=>registeredNames.includes(name)&&
        !pi.getActiveTools().includes(name));
      if(newly.length)pi.setActiveTools([...pi.getActiveTools(),...newly]);
      delegationToolInjected=newly.includes("jev_delegate");
      nativeSubagentInjected=newly.includes("subagent");
      const registered = pi.getAllTools().some(t=>t.name==="jev_progress");
      if (registered && !pi.getActiveTools().includes("jev_progress")) {
        pi.setActiveTools([...pi.getActiveTools(),"jev_progress"]);
        progressToolInjected = true;
      }
    }
    showProgress(ctx);
    if (ctx.hasUI) ctx.ui.setStatus("jev-workflow",
      `Jev ${task.toUpperCase()}${isStrictPhase(task) ? " · READ ONLY" : ""}`);
    pi.appendEntry(WORKFLOW_ENTRY, { task, toolsBeforeStrictPhase });
    ctx.ui.notify(`Jev ${task.toUpperCase()} active${isStrictPhase(task) ? " · read-only tool guard" : ""}. Use /jev-auto to reset.`, "info");
    if (args.trim()) pi.sendUserMessage(args.trim(), { deliverAs: "followUp" });
  }

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
      const p=implementationProgress;
      if (workflowTask !== "implement" || !p)
        return {isError:true,content:[{type:"text",text:"No active implementation checklist. Select Implement now first."}]};
      try{
        if(params.action==="update"){
          if(!Number.isInteger(params.stepId)||!["active","done","blocked"].includes(params.status))
            throw Error("Supply valid stepId and status.");
          if(params.status==="done" && delegationSchedule?.version===p.version){
            const waveIndex=delegationSchedule.waves.findIndex(w=>w.execution==="builder" &&
              w.tasks.some(t=>t.stepId===params.stepId));
            if(waveIndex>=0 && !delegationSchedule.runs?.some(r=>
              r.wave===waveIndex && r.status==="reported"))
              throw Error("Builder step has no successful subagent tool result. Use jev_delegate(action=run), or jev_delegate(action=lead,reason=...) for audited direct Lead fallback; then verify the work.");
            const leadFallback=delegationSchedule.fallbacks?.some(f=>
              delegationSchedule!.waves[f.wave]?.tasks.some(t=>t.stepId===params.stepId));
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
        const current=implementationProgress!;
        if(current.stage==="complete")cleanPlanMirror(trackedSessionId);
        return {content:[{type:"text",text:progressLines(current,24).join("\n")}],
          details:current};
      }catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}
    },
  });

  if (typeof pi.registerTool === "function") pi.registerTool({
    name:"jev_quality_gate",label:"Jev · QA/Review verdict",
    description:"Record the outcome of an automatic QA or Review phase. Required for automatic advancement; provide factual evidence of checks performed. A fail outcome stops the pipeline.",
    defaultActive:false,
    promptSnippet:"Record verified QA/Review pass or fail for the active Jev pipeline.",
    promptGuidelines:["When running an automatic Jev QA or Review phase, call jev_quality_gate exactly once with actual evidence, pass/fail and findings. Never claim pass without verification."],
    parameters:{type:"object",required:["outcome","evidence"],additionalProperties:false,
      properties:{
        outcome:{type:"string",enum:["pass","fail"]},
        evidence:{type:"string",minLength:12,maxLength:1000},
        findings:{type:"array",items:{type:"string"},maxItems:16},
      }} as any,
    async execute(_id,params,_signal,_onUpdate,ctx){
      if(!autoPipeline || autoPipeline.status!=="running"
        || !["qa","review"].includes(autoPipeline.phase)
        || workflowTask !== autoPipeline.phase)
        return {isError:true,content:[{type:"text",
          text:"No active automatic QA/Review phase. Manual phases are not auto-gated."}]};
      try{
        const stage=workflowTask as "qa"|"review";
        const gate=reportGate(stage,params.outcome,params.evidence,params.findings??[]);
        savePipeline({...autoPipeline,[stage]:gate},ctx);
        return {content:[{type:"text",text:stage.toUpperCase()+" verdict recorded: "+
          gate.outcome+". Evidence: "+gate.evidence}],details:gate};
      }catch(e){return {isError:true,content:[{type:"text",text:String(e)}]};}
    },
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
      tasks:{type:"array",maxItems:16,items:{type:"object",required:["stepId","files","dependsOn","effort"],
        additionalProperties:false,properties:{
          stepId:{type:"integer"},files:{type:"array",items:{type:"string"},maxItems:24},
          dependsOn:{type:"array",items:{type:"integer"},maxItems:16},
          effort:{type:"string",enum:["small","medium","large"]},
        }}},
    }} as any,
    async execute(_id,params,signal,onUpdate,ctx){
      if(workflowTask!=="implement" || !implementationProgress ||
        !planDocument || planDocument.status!=="approved")
        return {isError:true,content:[{type:"text",text:"jev_delegate requires an approved plan in Jev Implementation mode."}]};
      const config=readConfig().delegation;
      try {
        const toolNames=typeof pi.getAllTools==="function" ? pi.getAllTools().map(t=>t.name) : [];
        const nativeAvailable=subagentReady(toolNames) && typeof (ctx as any).executeTool==="function";
        const unavailableReason="Native Pi subagent unavailable; NO Builder was spawned.";
        const saveSchedule=(schedule:DelegationSchedule)=>{
          delegationSchedule=schedule;
          pi.appendEntry(DELEGATION_ENTRY,schedule);
        };
        if(params.action==="plan"){
          if(!Array.isArray(params.tasks))throw Error("Supply tasks with step IDs, file scopes, dependencies and effort");
          let schedule=createDelegationSchedule(implementationProgress,
            params.tasks as ProposedTask[],config);
          if(!nativeAvailable && config.strategy!=="always")
            schedule=fallbackDelegationToLead(schedule,implementationProgress,unavailableReason,
              {allowStrategyChange:config.strategy!=="always"});
          saveSchedule(schedule);
          const fallback=schedule.fallbacks?.length;
          return {content:[{type:"text",text:scheduleInstructions(schedule,planDocument.markdown)+
            "\nNative Pi subagent: "+(nativeAvailable?"AVAILABLE":"NOT AVAILABLE")+
            (fallback?" · pending Builder waves switched to Lead. NO Builder was spawned.":
             !nativeAvailable?" · Always Delegate prevents automatic Lead fallback; change the strategy if needed.":"")+
            "\nCall jev_delegate(action=run) for the next wave, verify actual work and report it with jev_progress."}],
            details:{schedule,nativeSubagentAvailable:nativeAvailable}};
        }
        if(!delegationSchedule || delegationSchedule.version!==implementationProgress.version)
          throw Error("Create a delegation schedule first (jev_delegate action=plan).");
        if(params.action==="lead"){
          if(config.strategy==="always")throw Error("Always Delegate is enabled. Change execution strategy to Prefer or Direct before Lead fallback.");
          const updated=fallbackDelegationToLead(delegationSchedule,implementationProgress,
            params.reason,{allowErroredRun:true,allowStrategyChange:true});
          if(updated===delegationSchedule)
            return {content:[{type:"text",text:"No unfinished Builder waves need Lead fallback."}],details:delegationSchedule};
          saveSchedule(updated);
          return {content:[{type:"text",text:"Pending Builder waves switched to audited Lead fallback. NO Builder success was recorded. Inspect any partial changes, implement outstanding steps directly, verify files/tests, then use jev_progress.\n"+
            scheduleInstructions(updated,planDocument.markdown)}],details:{schedule:updated,execution:"lead"}};
        }
        if(params.action==="status"){
          const next=nextDelegationWave(delegationSchedule,implementationProgress);
          const message=next?scheduleInstructions({...delegationSchedule,
            waves:delegationSchedule.waves.slice(next.index)},planDocument.markdown):"All scheduled waves are verified.";
          return {content:[{type:"text",text:message}],details:delegationSchedule};
        }
        if(params.action!=="run")throw Error("Unknown delegation action");
        if(!nativeAvailable && config.strategy!=="always"){
          const updated=fallbackDelegationToLead(delegationSchedule,implementationProgress,unavailableReason,
            {allowStrategyChange:true});
          if(updated!==delegationSchedule)saveSchedule(updated);
        }
        const next=nextDelegationWave(delegationSchedule,implementationProgress);
        if(!next)
          return {content:[{type:"text",text:"All scheduled tasks have been verified by the Lead."}]};
        const {index,wave}=next;
        if(wave.execution==="lead"){
          return {content:[{type:"text",text:"Wave "+(index+1)+
            " is a direct Lead task"+(delegationSchedule.fallbacks?.some(f=>f.wave===index)
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
          agent:delegationSchedule!.builderAgent,
          task:delegatePrompt(t,planDocument!.markdown),
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
          const updated=fallbackDelegationToLead(delegationSchedule!,implementationProgress!,
             "Native Pi subagent returned no spawned Builder: "+reason.slice(0,130),
            {allowStrategyChange:true});
          saveSchedule(updated);
          return {content:[{type:"text",text:"NO Builder was spawned. Switched unfinished Builder waves to audited Lead fallback. Implement and verify each task directly, then call jev_progress with factual verification.\n"+
            scheduleInstructions(updated,planDocument!.markdown)}],details:{execution:"lead",schedule:updated}};
        };
        let result:any;
        try {
          result=await (ctx as any).executeTool("subagent",call,{signal,onUpdate});
        } catch(error){
          const message=error instanceof Error?error.message:String(error);
          if(noSpawn(message))return switchToLead(message);
          throw error;
        } finally {
          if(ctx.hasUI)ctx.ui.setStatus("jev-builders",undefined);
        }
        const content=Array.isArray(result?.content)?result.content.filter(
          (c:any)=>c.type==="text").map((c:any)=>String(c.text)).join("\n"):"";
        if(noSpawn(content))return switchToLead(content);
        const failed=result?.isError===true || !Array.isArray(result?.content)
          || !content.trim();
        const status=failed?"error":"reported";
        delegationSchedule=recordDelegationRun(delegationSchedule,index,status,content||"No text returned");
        pi.appendEntry(DELEGATION_ENTRY,delegationSchedule);
        const summary="Builder wave "+(index+1)+" "+status+
          " · "+wave.tasks.map(t=>"#"+t.stepId).join(", ")+
          "\nLEAD MUST inspect changed files and tests. Do not mark checklist done on the basis of a successful process exit alone.\n";
        return {isError:failed,
          content:[{type:"text",text:summary+(content||"Subagent returned no text.").slice(0,36000)}],
          details:{wave:index+1,status,delegation:delegationSchedule,subagent:result?.details}};
      }catch(e){
        return {isError:true,content:[{type:"text",text:e instanceof Error?e.message:String(e)}]};
      }
    }
  });

  const health = new ModelHealth();

  pi.on?.("session_start", async (event, ctx) => {
    robotView = undefined;
    robotAnimator?.stop();
    implementationHandoffPending = false;
    planRunActive = false;
    pendingPlanText = undefined;
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    trackedSessionId = ctx.sessionManager?.getSessionId?.();
    try{pruneOldPlanMirrors();}catch{ /* no writes to cwd on cache failure */ }
    progressToolInjected = false;
    planDocument = latestPlanFromBranch(branch);
    implementationProgress = latestProgress(branch);
    delegationSchedule = latestDelegation(branch);
    if(delegationSchedule?.version!==implementationProgress?.version)
      delegationSchedule=undefined;
    implementationOrigin = latestSessionOrigin(branch);
    autoPipeline = latestPipelineFromBranch(branch);
    // The just-created child must start its approved pipeline. A later reload
    // or resume is paused until the user explicitly resumes.
    const initialHandoff = event?.reason === "new" && !!implementationOrigin;
    if (autoPipeline?.status === "running" && !initialHandoff) {
      autoPipeline = {...autoPipeline,status:"paused",reason:"Session resumed; use /jev-pipeline-resume"};
      pi.appendEntry(PIPELINE_ENTRY,autoPipeline);
    }
    if(ctx.hasUI)ctx.ui.setStatus("jev-pipeline",
      autoPipeline && !["cancelled","completed"].includes(autoPipeline.status)
        ? "AUTO "+autoPipeline.phase.toUpperCase()+" · "+autoPipeline.status.toUpperCase() : undefined);
    planOriginalRequest = planDocument?.request;
    const savedUi = [...branch].reverse().find((e: any) =>
      e?.type === "custom" && e.customType === PLAN_UI_ENTRY);
    planSummaryVisible = savedUi?.data?.visible === true;
    // Restore phase when resuming/reloading; session-specific entries avoid global leakage.
    workflowTask = undefined;
    toolsBeforeStrictPhase = undefined;
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    const latest = [...entries].reverse().find((e: any) => e.type === "custom"
      && e.customType === WORKFLOW_ENTRY);
    const saved = latest?.data;
    if (saved && (saved.task === null || saved.task in WORKFLOW_COMMANDS)) {
      workflowTask = saved.task ?? undefined;
      if (isStrictPhase(workflowTask)) {
        toolsBeforeStrictPhase = Array.isArray(saved.toolsBeforeStrictPhase)
          ? saved.toolsBeforeStrictPhase.filter((x: unknown) => typeof x === "string")
          : pi.getActiveTools();
        pi.setActiveTools(toolsForPhase(pi.getActiveTools(), workflowTask!));
      }
    }
    if(workflowTask==="implement" && typeof pi.getAllTools==="function"){
      const names=pi.getAllTools().map(t=>t.name);
      const activeBefore=pi.getActiveTools();
      const needs=["jev_delegate",...(readConfig().delegation.strategy==="direct"?[]:
        names.includes("subagent")?["subagent"]:[])].filter(n=>
        names.includes(n)&&!activeBefore.includes(n));
      if(needs.length)pi.setActiveTools([...activeBefore,...needs]);
      delegationToolInjected=needs.includes("jev_delegate");
      nativeSubagentInjected=needs.includes("subagent");
      const active=pi.getActiveTools();
      if(pi.getAllTools().some(t=>t.name==="jev_progress") && !active.includes("jev_progress")){
        pi.setActiveTools([...active,"jev_progress"]);
        progressToolInjected=true;
      }
    }
    // Approved handoffs have their own activation; other Pi/Herdr sessions
    // restore only a previously saved Jev ON preference.
    let selectedAtHandoff = false;
    let selectedAtStartup = false;
    if (initialHandoff && workflowTask === "implement") {
      selectedAtHandoff = await activateJev(pi, ctx);
      if (!selectedAtHandoff) {
        if (autoPipeline?.status === "running") {
          savePipeline({...autoPipeline, status:"paused",
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
    showPlanSummary(ctx, workflowTask === "plan" && planSummaryVisible, false);
    showProgress(ctx);
    if (ctx.hasUI) ctx.ui.setStatus("jev-workflow",
      workflowTask ? `Jev ${workflowTask.toUpperCase()}${isStrictPhase(workflowTask) ? " · READ ONLY" : ""}` : undefined);
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
    if (workflowTask === "plan" && planRunActive) {
      pendingPlanText = extractPlanText(event.messages) ?? pendingPlanText;
    }
    // agent_end may be followed by an automatic retry or tool continuation.
    // Keep animation active until the final agent_settled event.
  });

  pi.on?.("agent_start", (_event, ctx) => {
    if (workflowTask === "implement" && implementationProgress?.stage === "paused")
      saveProgress({...implementationProgress,stage:"running",visible:true},ctx);
    if (workflowTask === "implement" && planDocument?.status==="approved") {
      try{savePlanMirror(trackedSessionId,planDocument.markdown);}
      catch{ /* canonical plan remains in the Pi session */ }
    }
    planRunActive = workflowTask === "plan";
    pendingPlanText = undefined;
    const config = readConfig();
    updateJevling(ctx, config, {
      mood: config.enabled ? "routing" : "disabled",
      task: workflowTask ?? lastDecision?.task,
      model: lastDecision
        ? config.models.find(m => m.key === lastDecision.model)?.label ?? lastDecision.model
        : undefined,
    });
    if (ctx.mode === "tui" && config.robotMotion && config.mascot === "mascot"
      && isRoutingActive(config, ctx)) robotAnimator?.start();
  });

  // Only run the interactive handoff after Pi has fully settled, not during retries.
  pi.on?.("agent_settled", async (event, ctx) => {
    robotAnimator?.stop();
    const config = readConfig();
    updateJevling(ctx, config, {
      mood: config.enabled ? "ready" : "disabled",
      task: workflowTask ?? lastDecision?.task,
      model: lastDecision
        ? config.models.find(m => m.key === lastDecision.model)?.label ?? lastDecision.model
        : undefined,
    });
    if (workflowTask === "implement") {
      implementationHandoffPending = false;
      showPlanSummary(ctx, false);
      if (implementationProgress && implementationProgress.stage==="running")
        saveProgress({...implementationProgress,stage:"paused"},ctx);
      cleanPlanMirror(trackedSessionId);
      showProgress(ctx);
    }
    const pipeline = autoPipeline;
    if (pipeline?.status === "running" && pipeline.phase === workflowTask) {
      const updated=advancePipeline(pipeline,{
        implementationCompleted:implementationProgress?.stage==="complete",
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
        }else if(updated.phase!==pipeline.phase && ["qa","review"].includes(updated.phase)){
          const next=updated.phase as "qa"|"review";
          await runWorkflowCommand(next,"",ctx,true,true);
          if(workflowTask !== next){
            savePipeline({...updated,status:"paused",reason:"Could not activate "+next},ctx);
          }else{
            pi.sendUserMessage(nextPhasePrompt(next,planDocument?.markdown??"",
              planDocument?.request),{deliverAs:"followUp"});
          }
        }
      }
    }
    if (!planRunActive) return;
    planRunActive = false;
    const text = pendingPlanText;
    pendingPlanText = undefined;
    if (event?.aborted || !text || workflowTask !== "plan") return;
    savePlan(nextPlan(text, planDocument, new Date(), planOriginalRequest), ctx);
    if (ctx.mode === "tui" && ctx.hasUI) await openPlan(ctx);
  });

  pi.on?.("session_shutdown", () => {
    robotView = undefined;
    robotAnimator?.stop();
    // Reload and exit never leave a temporary .md file in the project.
    cleanPlanMirror(trackedSessionId);
    trackedSessionId = undefined;
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
      health.reportFailure(key, message.stopReason, message.errorMessage, config.health);
    } else if (message.stopReason === "stop" || message.stopReason === "toolUse") {
      health.reportSuccess(key);
    }
  });
  pi.on?.("before_agent_start", (event) => {
    if (!workflowTask) return;
    if (workflowTask === "plan" && typeof event.prompt === "string"
      && event.prompt.trim() && !event.prompt.startsWith("Revise the existing Jev plan"))
      planOriginalRequest = event.prompt.trim().slice(0,2000);
    const skills = Array.isArray(event.systemPromptOptions?.skills)
      ? event.systemPromptOptions.skills as LoadedSkill[] : [];
    let instructions = instructionsForTask(workflowTask) + "\n\n" +
      skillGuidance(workflowTask, skills);
    if (workflowTask === "plan") {
      instructions += "\n\nPLAN DOCUMENT STORAGE: Do not create any plan.md, plan-*.md or planning scratch files in the project working directory. Return the final Markdown as your answer; Jev saves it inside the Pi session and mirrors it outside the project. Include actionable numbered steps or Markdown checkboxes for implementation progress.\n\nPLAN DOCUMENT REQUIREMENT: On finishing the research, output a complete self-contained Markdown implementation plan. Include Goal, Evidence & assumptions, Decisions & tradeoffs, Numbered steps, Files to touch, Validation, Risks and Acceptance criteria. Do not implement it. Jev will save the final answer and ask the user whether to review, refine, keep or implement.";
    } else if (["qa","review"].includes(workflowTask)
      && autoPipeline?.status === "running" && autoPipeline.phase === workflowTask) {
      instructions += "\n\nJEV AUTO QUALITY GATE: This phase must finish by calling jev_quality_gate with outcome pass or fail, meaningful evidence and findings. Do not claim pass without running/inspecting appropriate verification. Report fail if unable to verify. No automatic repair loops. QA may run tests; Review is strictly read-only.";
    } else if (workflowTask === "implement" && planDocument?.status === "approved") {
      instructions += "\n\nIMPLEMENTATION PROGRESS: The active checklist belongs to this Pi session. Call jev_progress(action=list) to see step IDs; call jev_progress(action=update,stepId=N,status=active) before working on a step, status=done only after verifying that step with a short factual note, or status=blocked with the reason. Never mark steps done automatically or without evidence. The TUI updates from these calls; do not merely report progress in prose. Do not write auxiliary plan Markdown files inside the working repository; the approved plan is managed outside the project. Only write actual user-requested deliverables.\n";
      instructions += "\n\nApproved Jev plan v" + planDocument.version + " is the execution baseline. Do not produce another plan, planning document, review or outline instead of performing the final work.";
      const delegation=readConfig().delegation;
      const nativeAvailable=typeof pi.getAllTools==="function" &&
        subagentReady(pi.getAllTools().map(t=>t.name));
      if(delegation.strategy!=="direct"){
        instructions += "\n\nJEV SUBAGENT-FIRST IMPLEMENTATION: You are the Lead / Orchestrator. BEFORE directly implementing substantial checklist steps, call jev_progress(action=list), inspect the affected files and then call jev_delegate(action=plan) with the remaining checklist step IDs, exact relative file or directory ownership scopes, dependencies and small/medium/large effort. Use jev_delegate(action=run) to actually spawn Pi native Builder subagents for each ready, independent wave (at most "+delegation.maxConcurrentBuilders+" Builders). The delegation tool calls native Pi subagent directly; do not call subagent directly, do not make up tool results. Small fixes may remain with Lead. Unknown or overlapping file scopes MUST run sequentially. After each Builder wave, inspect diff and run suitable tests, then only the Lead calls jev_progress(status=done, note=verified evidence). Never mark delegated steps done solely because subprocess exited. Proceed wave by wave; do not skip dependency checks or automatically retry a failed wave. QA/Review remain separate pipeline phases.";
        if(!nativeAvailable)instructions += "\n\nNATIVE PI SUBAGENT NOT INSTALLED: Jev cannot spawn Builders; implement directly as Lead or tell the user how to enable the official Pi subagent extension. Never claim a Builder ran.";
        if(delegationSchedule?.version===implementationProgress?.version)
          instructions += "\n\nExisting delegation schedule in session: "+
            scheduleInstructions(delegationSchedule,planDocument.markdown).slice(0,18000);
      } else {
        instructions += "\n\nJEV DIRECT EXECUTION: Lead implements all tasks. Do not spawn subagents.";
      }
      if (implementationHandoffPending) {
        instructions += "\n\nCRITICAL APPROVAL HANDOFF: User selected IMPLEMENT NOW. Execute the approved deliverables immediately. For blog/content projects, WRITE THE FINAL ARTICLE; for code projects, IMPLEMENT CHANGES. Do NOT update/rewrite the plan artifact and do not return a plan again. Use allowed tools to complete the actual deliverable.";
      }
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + instructions };
  });
  pi.on?.("user_bash", (event) => {
    if (!isStrictPhase(workflowTask)) return;
    if (canUseTool(workflowTask, "bash", { command: event.command })) return;
    return { result: {
      output: `Blocked: Jev ${workflowTask} permits only verified read-only shell commands. Use /jev-implement before making changes.`,
      exitCode: 1, cancelled: false, truncated: false,
    }};
  });

  // Saved imports are available immediately on startup, even when the proxy is offline.
  // Discovery itself is intentionally manual and never sends task prompts to 9Router.
  syncNineRouterProvider(pi, readConfig());
  syncJevCredentials(pi, readConfig());

  pi.registerVirtualModel<RouteState>({
    provider: ROUTER_PROVIDER,
    id: ROUTER_ID,
    name: "Jev • Auto Model Manager",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    async route(request: ModelRouteRequest<RouteState>, ctx) {
      const config = readConfig();
      const allCandidates = physicalCandidates(config, ctx);
      if (!allCandidates.length) {
        throw new Error("Jev Manager: no eligible authenticated physical models. Run /jev-models.");
      }
      const candidates = allCandidates.filter(m => health.isEligible(m.key, config.health));
      const sticky = request.failed ?? request.previous;

      if (request.reason === "continuation" && sticky && allCandidates.some(m => m.key === keyOf(sticky.model))) {
        // Do not switch in the middle of a successful turn; tool/thinking state may be model-specific.
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      if (request.reason === "retry" && request.failed) {
        const failedKey = keyOf(request.failed.model);
        const problem = health.reportFailure(
          failedKey, request.failed.message.stopReason, request.failed.message.errorMessage, config.health,
        );
        if (problem && config.enabled && config.mode === "auto" && config.health.autoFailover) {
          const attempted = new Set([...(request.state?.attempted ?? []), failedKey]);
          const available = candidates.filter(m => !attempted.has(m.key));
          const next = available.find(m => m.key === config.fallback) ?? available[0];
          if (next) {
            const decision: Decision = {
              model: next.key, task: request.state?.last.task ?? "unknown",
              probability: 0, reason: `health failover (${problem}) from ${failedKey}`,
            };
            lastDecision = decision;
            if (ctx.hasUI) ctx.ui.setStatus("jev-manager", `Jev recovery → ${next.label}`);
            updateJevling(ctx, config, { mood: "recovery", task: decision.task, model: next.label });
            return {
              model: resolveModel(ctx, next.key)!,
              thinkingLevel: next.thinking,
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
        const base = candidates.find(m => m.key === config.fallback) ?? candidates[0]
          ?? fallbackModel(allCandidates, config);
        const forced = workflowTask ? selectExplicitModel(workflowTask, base.key, base.key,
          candidates.map(m => m.key), config.taskRules).model : base.key;
        const model = candidates.find(m => m.key === forced) ?? base;
        updateJevling(ctx, config, {
          mood: config.enabled ? "routing" : "disabled", model: model.label,
        });
        return { model: resolveModel(ctx, model.key)!, thinkingLevel: model.thinking };
      }
      if (!candidates.length) {
        throw new Error("Jev Manager: all configured models are cooling down after provider errors. Run /jev-health to inspect or reset.");
      }
      const base = fallbackModel(candidates, config);
      const prompt = lastUserText(request.messages);
      let decision: Decision;
      if (workflowTask) {
        const rule = config.taskRules[workflowTask];
        // Prefer/Force bypass Jev task classification: the explicit command is authoritative.
        if (rule && rule.mode !== "auto") {
          const chosen = selectExplicitModel(workflowTask, base.key, base.key,
            candidates.map(m => m.key), config.taskRules);
          decision = { model: chosen.model, task: workflowTask, probability: 1, reason: chosen.reason };
        } else {
          // Auto still lets Jev rank models, but may not reclassify the explicit phase.
          const auto = prompt
            ? await choose(`Task phase: ${workflowTask}. ${prompt}`, {
                ...config, taskRules: defaultTaskRules(),
              }, candidates, ctx, request.signal)
            : { model: base.key, task: workflowTask, probability: 0, reason: "empty text prompt" };
          const chosen = selectExplicitModel(workflowTask, auto.model, base.key,
            candidates.map(m => m.key), config.taskRules);
          decision = { model: chosen.model, task: workflowTask,
            probability: auto.probability, reason: `explicit ${workflowTask} · ${auto.reason}` };
        }
      } else {
        decision = prompt
          ? await choose(prompt, config, candidates, ctx, request.signal)
          : { model: base.key, task: "unknown", probability: 0, reason: "empty text prompt" };
      }
      lastDecision = decision;
      const selected = config.mode === "observe" ? base : candidates.find((m) => m.key === decision.model) ?? base;
      const physical = resolveModel(ctx, selected.key);
      if (!physical) throw new Error(`Jev Manager: ${selected.key} missing from model registry`);
      if (ctx.hasUI) {
        ctx.ui.setStatus("jev-manager", `Jev ${config.mode}: ${selected.label} · ${decision.task}`);
      }
      updateJevling(ctx, config, {
        mood: config.enabled ? "routing" : "disabled",
        task: decision.task,
        model: selected.label,
      });
      return { model: physical, thinkingLevel: selected.thinking, state: { last: decision, attempted: [selected.key] } };
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
    if (!canUseTool(workflowTask, event.toolName, event.input)) {
      return { block: true, reason: `Jev ${workflowTask} is read-only. Use /jev-implement or /jev-auto before modifying files or running commands.` };
    }
    const settings = readConfig();
    // Jev owns concurrency and scope during Implementation. Direct subagent
    // calls would bypass the scheduler; nested calls from jev_delegate are safe.
    if(workflowTask==="implement" && event.toolName==="subagent" &&
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
      .filter(m => health.isEligible(m.key, settings.health));
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
          await configureAddon(pi, ctx, health);
          config = readConfig();
        } else if (choice === "Task routing (/jev-tasks)") {
          await configureTaskRules(ctx, config.taskRules, config.models.filter(m => m.enabled), () => saveConfig(config));
        } else if (choice === "Model health & failover (/jev-health)") {
          await configureHealthOptions(ctx, config, health);
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
        task: lastDecision?.task,
        model: lastDecision ? config.models.find(m => m.key === lastDecision.model)?.label ?? lastDecision.model : undefined,
      });
      ctx.ui.notify(`Jevling display set to ${config.mascot}.`, "info");
    },
  });

  pi.registerCommand("jev-config", {
    description: "Configure 9Router endpoint, API keys and routing options",
    handler: async (_args, ctx) => { await configureAddon(pi, ctx); },
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
      await configureHealthOptions(ctx, config, health);
    },
  });

  for (const [task, command] of Object.entries(WORKFLOW_COMMANDS) as [TaskType, string][]) {
    pi.registerCommand(command, {
      description: `Switch to ${task} phase${isStrictPhase(task) ? " (strict read-only)" : ""}; optionally supply a task prompt`,
      handler: async (args, ctx) => { await runWorkflowCommand(task, args, ctx); },
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
    description:"Inspect current implementation step statuses and verification notes",
    handler:async (_args,ctx)=>{
      const p=implementationProgress;
      if(!p){ctx.ui.notify("No Jev implementation checklist in this session.","info");return;}
      if(ctx.hasUI && ctx.ui.select){
        const entries=p.steps.map(s=>(s.status==="done"?"☑":s.status==="active"?"◉":s.status==="blocked"?"!":"☐")+" "+s.id+". "+s.title.slice(0,85));
        const choice=await ctx.ui.select("Jev implementation · "+p.stage,[
          ...entries,"Dismiss checklist (keep history)","Back",
        ]);
        if(choice==="Dismiss checklist (keep history)") {
          saveProgress({...p,visible:false},ctx);
          return;
        }
        const i=entries.indexOf(choice??"");
        if(i>=0)ctx.ui.notify(p.steps[i].title+" · "+p.steps[i].status+
          (p.steps[i].note?" · "+p.steps[i].note:""),"info");
      }else ctx.ui.notify(progressLines(p,24).join("\n"),"info");
    },
  });
  pi.registerCommand("jev-progress-clear", {
    description:"End and hide Jev checklist, remove temporary plan mirror, keep session history",
    handler:async (_args,ctx)=>{
      closeProgress(ctx);
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
      const waves=delegationSchedule?.waves.map((w,i)=>
        "Wave "+(i+1)+": "+w.execution+" · "+
        w.tasks.map(t=>"#"+t.stepId).join(", ")+
        (delegationSchedule?.runs?.some(r=>r.wave===i)?" · dispatched":"")).join("\n")??"No delegation schedule yet.";
      ctx.ui.notify("Jev delegation: "+cfg.strategy+" · max "+cfg.maxConcurrentBuilders+
        " Builders · agent "+cfg.builderAgent+"\nNative Pi subagent: "+
        (found?"available":"missing")+"\n"+waves,"info");
    },
  });

  pi.registerCommand("jev-pipeline-status", {
    description:"Inspect the current opt-in Auto Implement → QA → Review pipeline",
    handler: async (_args,ctx)=>{
      if(!autoPipeline){ctx.ui.notify("No auto pipeline in this session.", "info");return;}
      ctx.ui.notify(pipelineLines(autoPipeline).join("\n"),"info");
    },
  });
  pi.registerCommand("jev-pipeline-stop", {
    description:"Stop automatic advancement; keep plan, progress, and QA/Review findings",
    handler: async (_args,ctx)=>{
      cancelPipeline(ctx);
      ctx.ui.notify("Automatic phase transitions disabled. Current task and session history remain.", "info");
    },
  });
  pi.registerCommand("jev-pipeline-resume", {
    description:"Resume a paused auto pipeline at its last unverified phase",
    handler: async (_args,ctx)=>{
      const p=autoPipeline;
      if(!p || p.status!=="paused" || !["implement","qa","review"].includes(p.phase)){
        ctx.ui.notify("No paused auto pipeline to resume.", "warning");return;
      }
      savePipeline({...p,status:"running",reason:undefined},ctx);
      await runWorkflowCommand(p.phase as TaskType,"",ctx,false,true);
      if(workflowTask!==p.phase){
        savePipeline({...p,status:"paused",reason:"Could not activate "+p.phase},ctx);
        ctx.ui.notify("Could not resume pipeline phase.", "error");
        return;
      }
      const message=p.phase==="implement"
        ? "Resume the approved plan implementation. Consult jev_progress for incomplete steps, complete the deliverables and verify them.\n\n"+(planDocument?.markdown??"")
        : nextPhasePrompt(p.phase as "qa"|"review",planDocument?.markdown??"",
            planDocument?.request);
      pi.sendUserMessage(message,{deliverAs:"followUp"});
    },
  });

  pi.registerCommand("jev-implement-session", {
    description:"Create a clean linked Pi Implementation Session from approved plan, with optional automatic QA/Review",
    handler:async (args,ctx)=>{
      const mode:HandoffMode=args.trim()==="auto"?"auto":"manual";
      await ctx.waitForIdle?.();
      await createImplementationSession(ctx,mode);
    },
  });
  pi.registerCommand("jev-session-origin", {
    description:"Show the Planning Session linked to the current Implementation Session",
    handler:async (_args,ctx)=>{
      const origin=implementationOrigin;
      ctx.ui.notify(origin
        ? "Jev Implementation · plan v"+origin.planVersion+" · "+origin.mode+
          "\nPlanning Session: "+origin.parentSession
        : "This session is not linked to a Jev Planning Session.", "info");
    },
  });

  pi.registerCommand("jev-plan-open", {
    description: "Review, edit or approve the latest saved Jev plan and choose what happens next",
    handler: async (_args, ctx) => { await openPlan(ctx); },
  });
  pi.registerCommand("jev-plan-hide", {
    description: "Dismiss the plan summary widget; the saved plan is retained in this session",
    handler: async (_args, ctx) => {
      showPlanSummary(ctx, false);
      cleanPlanMirror(trackedSessionId);
      ctx.ui.notify("Plan widget hidden. Use /jev-plan-open to review the saved plan again.", "info");
    },
  });

  pi.registerCommand("jev-auto", {
    description: "Leave explicit task phase and restore automatic Jev routing / tools",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.();
      cancelPipeline(ctx,"User exited to automatic model routing");
      changeWorkflow(undefined);
      implementationHandoffPending = false;
      showPlanSummary(ctx, false);
      closeProgress(ctx);
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
      const d = lastDecision;
      ctx.ui.notify(
        `Jev routing ${isRoutingActive(config, ctx) ? "ACTIVE" : "INACTIVE"} · configured ${config.enabled ? "ON" : "OFF"} · mode ${config.mode}` +
        `\nRestore on Pi startup: ${config.enabled && config.mode === "auto" && process.env.JEV_AUTO_ACTIVATE !== "0" ? "ON" : "OFF"}` +
        `\nPi selected model: ${ctx.model ? keyOf(ctx.model) : "unknown"}` +
        `\nWorkflow phase: ${workflowTask ?? "auto"}${isStrictPhase(workflowTask) ? " [READ ONLY]" : ""}` +
        `\nPlan: ${planDocument ? "v" + planDocument.version + " " + planDocument.status : "none"} · widget ${planSummaryVisible ? "visible" : "hidden"}` +
        `\nAuto pipeline: ${autoPipeline ? autoPipeline.phase + " · " + autoPipeline.status : "none"}` +
        `\nEligible models: ${physicalCandidates(config, ctx).length}/${config.models.filter(m => m.enabled).length} · cooldown=${health.list(config.models.map(m => m.key)).filter(s => s.status === "cooldown").length} · fallback=${config.fallback || "unset"}` +
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
      const candidates = physicalCandidates(config, ctx).filter(m => health.isEligible(m.key, config.health));
      if (!candidates.length) return ctx.ui.notify("No healthy eligible models. Run /jev-health or /jev-models.", "warning");
      const prompt = args.trim() || (ctx.hasUI ? await ctx.ui.input("Test task") : "") || "";
      if (!prompt) return;
      const d = await choose(prompt, { ...config, enabled: true }, candidates, ctx);
      ctx.ui.notify(`${d.task} → ${d.model} (p=${d.probability.toFixed(2)})\n${d.reason}`, "info");
    },
  });
}
