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
import { mascotLines, normalizeMascotStyle, MASCOT_WIDGET_KEY, type MascotStyle, type MascotStatus } from "./mascot.ts";
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
  health: HealthSettings;
  mascot: MascotStyle;
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
  subagentRouting: false, // explicit opt-in: do not rewrite external spawn tools by default
  health: { ...DEFAULT_HEALTH },
  mascot: "mascot",
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
      health: normalizeHealthSettings(raw.health),
      mascot: normalizeMascotStyle(raw.mascot),
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

function updateJevling(ctx: ExtensionContext, config: Config, status: MascotStatus): void {
  if (ctx.mode !== "tui") return;
  const display: MascotStatus = isRoutingActive(config, ctx) ? status : {
    mood: "disabled",
    subtitle: config.enabled
      ? config.mode === "observe" && isJevSelected(ctx.model)
        ? "Observe only · /jev-on to route"
        : "Inactive · run /jev-on"
      : "Routing off · run /jev-on",
  };
  const lines = mascotLines(config.mascot, display);
  ctx.ui.setWidget(MASCOT_WIDGET_KEY, lines.length ? lines : undefined);
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



/** Explicit opt-in: enable routing and activate the virtual model for this Pi session. */
async function activateJev(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  const config = readConfig();
  const available = physicalCandidates(config, ctx);
  if (!available.length) {
    ctx.ui.notify("Jev cannot activate: no enabled/authenticated models. Add them with /jev-models or /jev-scan.", "warning");
    return false;
  }
  if (typeof pi.setModel !== "function") {
    ctx.ui.notify("This Pi build does not expose pi.setModel(). Select jev-manager/auto manually with /model.", "warning");
    return false;
  }
  const virtual = ctx.modelRegistry.find(ROUTER_PROVIDER, ROUTER_ID)
    ?? ctx.modelRegistry.getAvailable().find(m => m.provider === ROUTER_PROVIDER && m.id === ROUTER_ID);
  if (!virtual) {
    ctx.ui.notify("Jev virtual model is missing. Run /reload, then use /model → jev-manager/auto.", "warning");
    return false;
  }
  try {
    const success = await pi.setModel(virtual);
    if (!success) {
      ctx.ui.notify("Pi refused the virtual model selection. Verify credentials, or select jev-manager/auto with /model.", "error");
      return false;
    }
    config.enabled = true;
    config.mode = "auto";
    saveConfig(config);
    // The model_select event may fire before we save routing=ON.
    updateJevling({ ...ctx, model: virtual }, config, { mood: "ready" });
    ctx.ui.notify("Jev routing ACTIVE. Pi is now using jev-manager/auto for this session.", "info");
    return true;
  } catch {
    ctx.ui.notify("Unable to switch model. Use /model to select jev-manager/auto and inspect /jev-status.", "error");
    return false;
  }
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
      "Model health & failover (/jev-health)",
      `Subagent auto-routing: ${config.subagentRouting ? "ON" : "OFF"}`,
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
      } else if (choice === "Model health & failover (/jev-health)") {
        await configureHealthOptions(ctx, config, health);
      } else if (choice.startsWith("Subagent auto-routing:")) {
        config.subagentRouting = !config.subagentRouting;
        saveConfig(config);
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
  let lastDecision: Decision | undefined;
  let workflowTask: TaskType | undefined;
  let toolsBeforeStrictPhase: string[] | undefined;

  function changeWorkflow(task: TaskType | undefined): void {
    const wasStrict = isStrictPhase(workflowTask);
    const nextStrict = isStrictPhase(task);
    // Preserve the actual user/extension-selected tool set; never restore a hardcoded default.
    if (nextStrict && !wasStrict) {
      toolsBeforeStrictPhase = pi.getActiveTools();
      pi.setActiveTools(toolsForPhase(toolsBeforeStrictPhase, task!));
    } else if (wasStrict && !nextStrict && toolsBeforeStrictPhase) {
      pi.setActiveTools(toolsBeforeStrictPhase);
      toolsBeforeStrictPhase = undefined;
    }
    workflowTask = task;
  }

  async function runWorkflowCommand(task: TaskType, args: string, ctx: ExtensionContext): Promise<void> {
    // Do not lift a previous read-only guard while its turn is still executing.
    await ctx.waitForIdle?.();
    // No task state change when Jev cannot be activated.
    if (!await activateJev(pi, ctx)) return;
    changeWorkflow(task);
    if (ctx.hasUI) ctx.ui.setStatus("jev-workflow",
      `Jev ${task.toUpperCase()}${isStrictPhase(task) ? " · READ ONLY" : ""}`);
    pi.appendEntry(WORKFLOW_ENTRY, { task, toolsBeforeStrictPhase });
    ctx.ui.notify(`Jev ${task.toUpperCase()} active${isStrictPhase(task) ? " · read-only tool guard" : ""}. Use /jev-auto to reset.`, "info");
    if (args.trim()) pi.sendUserMessage(args.trim(), { deliverAs: "followUp" });
  }

  const health = new ModelHealth();

  pi.on?.("session_start", (_event, ctx) => {
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
    const config = readConfig();
    if (ctx.hasUI) ctx.ui.setStatus("jev-workflow",
      workflowTask ? `Jev ${workflowTask.toUpperCase()}${isStrictPhase(workflowTask) ? " · READ ONLY" : ""}` : undefined);
    updateJevling(ctx, config, { mood: config.enabled ? "ready" : "disabled" });
    // Do not hijack sessions that intentionally selected a physical model.
    if (ctx.mode === "tui" && config.enabled && !isJevSelected(ctx.model)) {
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
  pi.on?.("agent_end", (_event, ctx) => {
    const config = readConfig();
    updateJevling(ctx, config, {
      mood: config.enabled ? "ready" : "disabled",
      task: lastDecision?.task,
      model: lastDecision
        ? config.models.find(m => m.key === lastDecision.model)?.label ?? lastDecision.model
        : undefined,
    });
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
    return { systemPrompt: event.systemPrompt + "\n\n" + instructionsForTask(workflowTask) };
  });
  pi.on?.("user_bash", () => {
    if (!isStrictPhase(workflowTask)) return;
    return { result: {
      output: `Blocked: Jev ${workflowTask} is strictly read-only. Use /jev-implement or /jev-auto first.`,
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
    if (!canUseTool(workflowTask, event.toolName)) {
      return { block: true, reason: `Jev ${workflowTask} is read-only. Use /jev-implement or /jev-auto before modifying files or running commands.` };
    }
    const settings = readConfig();
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
      ]);
      if (!selected) return;
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
  pi.registerCommand("jev-auto", {
    description: "Leave explicit task phase and restore automatic Jev routing / tools",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle?.();
      changeWorkflow(undefined);
      pi.appendEntry(WORKFLOW_ENTRY, { task: null });
      if (ctx.hasUI) ctx.ui.setStatus("jev-workflow", undefined);
      ctx.ui.notify("Jev AUTO mode restored; explicit task intent cleared and original tools restored.", "info");
    },
  });

  pi.registerCommand("jev-on", {
    description: "Enable and activate Jev virtual routing for the current Pi session",
    handler: async (_args, ctx) => { await activateJev(pi, ctx); },
  });

  pi.registerCommand("jev-status", {
    description: "Show routing status and latest Jev selection",
    handler: async (_args, ctx) => {
      const config = readConfig();
      const d = lastDecision;
      ctx.ui.notify(
        `Jev routing ${isRoutingActive(config, ctx) ? "ACTIVE" : "INACTIVE"} · configured ${config.enabled ? "ON" : "OFF"} · mode ${config.mode}` +
        `\nPi selected model: ${ctx.model ? keyOf(ctx.model) : "unknown"}` +
        `\nWorkflow phase: ${workflowTask ?? "auto"}${isStrictPhase(workflowTask) ? " [READ ONLY]" : ""}` +
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
