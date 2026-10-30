import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveConfig, type Config } from "../core/config.ts";
import { isJevSelected } from "./mascot-controller.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export async function configureRoutingOptions(ctx: ExtensionContext, config: Config): Promise<void> {
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
