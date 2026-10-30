import { configureTaskRules } from "../task-ui.ts";
import { normalizeDelegation } from "../delegation.ts";
import { ModelHealth } from "../health.ts";
import { credentialSource, resolveSecret } from "../secrets.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NINE_ROUTER_BASE_URL_ENV, normalizeNineRouterBaseUrl, resolveNineRouterBaseUrl, scanNineRouter, validateEnvName } from "../nine-router.ts";
import { readConfig, saveConfig } from "../core/config.ts";
import { keyOf } from "../routing/selectors.ts";
import { syncNineRouterProvider } from "../integrations/nine-router-provider.ts";
import { isJevSelected, isRoutingActive, updateJevling } from "./mascot-controller.ts";
import { configureStoredKey, syncJevCredentials } from "./credentials.ts";
import { configureRoutingOptions } from "./routing-settings.ts";
import { activateJev } from "./activation.ts";
import { configureHealthOptions } from "./model-health.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export async function configureAddon(pi: ExtensionAPI, ctx: ExtensionContext, health: ModelHealth): Promise<void> {
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

