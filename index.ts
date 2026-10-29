/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API. No proxy and no MCP server.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
import type { Message } from "@earendil-works/pi-ai";
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
          instructions: "Classify the primary software engineering task in the user's prompt.",
          criteria: {
            plan: "Design, architecture, investigation, or tradeoffs",
            implement: "Write or change application code",
            debug: "Diagnose and fix a defect",
            review: "Review existing code, tests, or security",
            research: "Investigate unfamiliar APIs, concepts, or libraries",
            explain: "Explain a concept without editing code",
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
    if (probability < config.minProbability) {
      return { model: base.key, suggested: picked.key, task, probability, reason: "low confidence fallback" };
    }
    return { model: picked.key, task, probability, reason: "jev choice" };
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
    if (choice.startsWith("Enabled:")) config.enabled = !config.enabled;
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

/** Central, extensible configuration screen, accessible via /jev-config and /jev-models. */
async function configureAddon(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
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
      "Routing & classifier options",
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
      const candidates = physicalCandidates(config, ctx);
      if (!candidates.length) {
        throw new Error("Jev Manager: no eligible authenticated physical models. Run /jev-models.");
      }
      const base = fallbackModel(candidates, config);
      // Preserve tool follow-ups and retries; otherwise cache and tool signatures can break.
      if (request.reason === "continuation" || request.reason === "retry") {
        const sticky = request.failed ?? request.previous;
        if (sticky && candidates.some((m) => m.key === keyOf(sticky.model))) {
          return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
        }
      }
      if (request.reason === "direct") {
        return { model: resolveModel(ctx, base.key)!, thinkingLevel: base.thinking };
      }
      const prompt = lastUserText(request.messages);
      const decision = prompt
        ? await choose(prompt, config, candidates, ctx, request.signal)
        : { model: base.key, task: "unknown", probability: 0, reason: "empty text prompt" };
      lastDecision = decision;
      const selected = config.mode === "observe" ? base : candidates.find((m) => m.key === decision.model) ?? base;
      const physical = resolveModel(ctx, selected.key);
      if (!physical) throw new Error(`Jev Manager: ${selected.key} missing from model registry`);
      if (ctx.hasUI) {
        ctx.ui.setStatus("jev-manager", `Jev ${config.mode}: ${selected.label} · ${decision.task}`);
      }
      return { model: physical, thinkingLevel: selected.thinking, state: { last: decision } };
    },
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
          `9Router settings: ${resolveNineRouterBaseUrl(config.nineRouter)}${process.env[NINE_ROUTER_BASE_URL_ENV]?.trim() ? " [env]" : ""}`,
          "Scan 9Router models",
          ...names, "Done",
        ]);
        if (!choice || choice === "Done") break;
        if (choice.startsWith("Routing:")) config.enabled = !config.enabled;
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
          await configureAddon(pi, ctx);
          config = readConfig();
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

  pi.registerCommand("jev-status", {
    description: "Show routing status and latest Jev selection",
    handler: async (_args, ctx) => {
      const config = readConfig();
      const d = lastDecision;
      ctx.ui.notify(
        `Jev ${config.enabled ? "enabled" : "disabled"} (${config.mode}), ` +
        `${config.models.length} models, fallback=${config.fallback || "unset"}` +
        (d ? `\nLast: ${d.task} → ${d.model}, p=${d.probability.toFixed(2)} (${d.reason})` : ""),
        "info",
      );
    },
  });

  pi.registerCommand("jev-test", {
    description: "Dry-run a prompt through Jev, without changing the active model",
    handler: async (args, ctx) => {
      const config = readConfig();
      const candidates = physicalCandidates(config, ctx);
      if (!candidates.length) return ctx.ui.notify("No eligible models. Run /jev-models.", "warning");
      const prompt = args.trim() || (ctx.hasUI ? await ctx.ui.input("Test task") : "") || "";
      if (!prompt) return;
      const d = await choose(prompt, { ...config, enabled: true }, candidates, ctx);
      ctx.ui.notify(`${d.task} → ${d.model} (p=${d.probability.toFixed(2)})\n${d.reason}`, "info");
    },
  });
}
