import { maskedInput, normalizeSecretInput, readSystemClipboardText } from "../config-ui.ts";
import { credentialSource, readSecrets, resolveSecret, writeSecrets, type SecretKind } from "../secrets.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NINE_ROUTER_BASE_URL_ENV, normalizeNineRouterBaseUrl, validateEnvName } from "../nine-router.ts";
import { saveConfig, type Config } from "../core/config.ts";
import { syncNineRouterProvider } from "../integrations/nine-router-provider.ts";
/**
 * Pi Jev Model Manager — reference MVP.
 * Uses Pi native virtual models and classifier API; integrates with an existing 9Router proxy.
 *
 * Requires a recent @earendil-works/pi-coding-agent with virtual model support.
 * TypeSafe classifier credentials: TYPESAFE_API_KEY.
 */
const ROUTER_PROVIDER = "jev-manager";
const ROUTER_ID = "auto";
export async function configureNineRouterSettings(ctx: ExtensionContext, config: Config): Promise<boolean> {
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
export function syncJevCredentials(pi: ExtensionAPI, config: Config): void {
  if (credentialSource("jev", "TYPESAFE_API_KEY") === "stored" && config.classifier.provider === "typesafe") {
    pi.registerProvider("typesafe", { apiKey: resolveSecret("jev", "TYPESAFE_API_KEY")! });
  }
}

export async function configureStoredKey(
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

