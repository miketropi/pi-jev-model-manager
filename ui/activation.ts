import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, saveConfig } from "../core/config.ts";
import { physicalCandidates } from "../routing/selectors.ts";
import { choose } from "../routing/choose.ts";
import { isJevSelected, updateJevling } from "./mascot-controller.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export async function activateJev(pi: ExtensionAPI, ctx: ExtensionContext,
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

export async function deactivateJev(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
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

