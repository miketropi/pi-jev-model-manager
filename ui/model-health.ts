import { filterModels } from "../task-routing.ts";
import { ModelHealth } from "../health.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveConfig, type Config } from "../core/config.ts";
import { resolveModel } from "../routing/selectors.ts";
import { choose } from "../routing/choose.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export async function probeModelHealth(ctx: ExtensionContext, config: Config, health: ModelHealth): Promise<void> {
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

export async function configureHealthOptions(ctx: ExtensionContext, config: Config, health: ModelHealth): Promise<void> {
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
