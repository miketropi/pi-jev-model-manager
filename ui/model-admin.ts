import {chooseList,chooseListOption,matchedItems} from "./list-picker.ts";
import { knownModelProfile } from "../model-profiles.ts";
import { resolveSecret } from "../secrets.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NINE_ROUTER_PROVIDER, scanNineRouter, type DiscoveredModel } from "../nine-router.ts";
import { saveConfig, type Config, type ManagedModel, type Thinking, type CostTier, THINKING } from "../core/config.ts";
import { syncNineRouterProvider } from "../integrations/nine-router-provider.ts";
import { importNineRouterModel } from "../integrations/nine-router-models.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export async function scanAndImportNineRouter(pi: ExtensionAPI, ctx: ExtensionContext, config: Config): Promise<void> {
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
    const imported = new Set(config.models.map(m => m.key));
    let remote: DiscoveredModel | undefined;
    let bulkQuery = filter;
    let bulk = false;
    if (discovered.length <= 12 && !(ctx.mode === "tui" && typeof ctx.ui.custom === "function")) {
      const matches = discovered.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(filter.toLowerCase()));
      const unseen = matches.filter(m => !imported.has(`${NINE_ROUTER_PROVIDER}/${m.id}`));
      const labels = matches.map((m,i) =>
        `${imported.has(`${NINE_ROUTER_PROVIDER}/${m.id}`) ? "✓" : "+"} ${m.id} [${i+1}]`);
      const choice = await ctx.ui.select(`9Router · ${matches.length} matching · ${unseen.length} new`, [
        `Filter: ${filter || "all"}`,
        `Import all ${unseen.length} new matching models (max 30)`,
        ...labels, "Back",
      ]);
      if (!choice || choice === "Back") return;
      if (choice.startsWith("Filter:")) {
        const next = await ctx.ui.input("Filter by model name or ID (blank = all)", filter);
        if (next !== undefined) filter = next.trim();
        continue;
      }
      bulk = choice.startsWith("Import all ");
      if (!bulk) remote = matches[labels.indexOf(choice)];
    } else {
      const result = await chooseList(ctx, {
        title: "9Router · model catalog",
        initialQuery: filter,
        items: discovered.map(m => ({
          id: m.id,
          label: `${imported.has(`${NINE_ROUTER_PROVIDER}/${m.id}`) ? "✓" : "+"} ${m.id}`,
          searchText: m.name,
        })),
        actions: [{id:"@bulk",label:"Import matching new models (max 30)"}],
      });
      if (!result) return;
      filter = result.query;
      bulkQuery = result.query;
      bulk = result.id === "@bulk";
      if (!bulk) remote = discovered.find(m => m.id === result.id);
    }
    if (bulk) {
      const matches = matchedItems(discovered.map(m=>({id:m.id,label:m.id,searchText:m.name})),bulkQuery);
      const wanted = new Set(matches.map(m=>m.id));
      const unseen = discovered.filter(m=>wanted.has(m.id) && !imported.has(`${NINE_ROUTER_PROVIDER}/${m.id}`));
      if (!unseen.length) {
        ctx.ui.notify("No new models matching the filter", "info");
      } else if (unseen.length > 30) {
        ctx.ui.notify("Narrow the filter to 30 or fewer models before importing a batch.", "warning");
      } else if (await ctx.ui.confirm("Import models?", `Add ${unseen.length} model(s) to Jev. You can edit capabilities later.`)) {
        for (const m of unseen) importNineRouterModel(config, m);
        saveConfig(config);
        syncNineRouterProvider(pi, config);
        ctx.ui.notify(`Imported ${unseen.length} model(s). Use /jev-models to edit strengths and costs.`, "info");
      }
    } else {
      if (!remote) continue;
      const model = importNineRouterModel(config, remote);
      saveConfig(config);
      syncNineRouterProvider(pi, config);
      await configureModel(ctx, config, model);
      syncNineRouterProvider(pi, config);
    }
  }
}

export async function configureModel(ctx: ExtensionContext, config: Config, model: ManagedModel): Promise<boolean> {
  while (true) {
    const known = knownModelProfile(model.key);
    const choice = await chooseListOption(ctx, `Manage ${model.label}`, [
      `Enabled: ${model.enabled ? "yes" : "no"}`,
      `Display name: ${model.label}`,
      `Specialty: ${model.specialty || "—"}`,
      `Avoid: ${model.avoid || "—"}`,
      ...(known ? ["Curated profile: " + known.family + " / " + known.variant] : []),
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
    if (choice.startsWith("Curated profile:") && known) {
      ctx.ui.notify("Jev curated hint (" + known.family + ", " + known.tier + "):\n" +
        "Suitable: " + known.specialty + "\nCaution: " + known.avoid +
        "\nCustom Specialty/Avoid fields override these hints; this is not a benchmark.", "info");
      continue;
    }
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
        if (Number.isSafeInteger(n) && n > 0 && n <= 10_000_000 && n >= (model.maxTokens ?? 8192)) { model.contextWindow = n; model.metadataSource = "manual"; }
        else ctx.ui.notify("Must be a positive integer at least as large as max output tokens (max 10M)", "warning");
      }
    }
    if (choice.startsWith("Max output tokens:")) {
      const value = await ctx.ui.input("Max output tokens", String(model.maxTokens ?? 8192));
      if (value != null) {
        const n = Number(value);
        if (Number.isSafeInteger(n) && n > 0 && n <= (model.contextWindow ?? 128000)) { model.maxTokens = n; model.metadataSource = "manual"; }
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

