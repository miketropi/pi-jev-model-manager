import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import type {Config} from "../core/config.ts";
import {NINE_ROUTER_PROVIDER,resolveNineRouterBaseUrl,validateEnvName} from "../nine-router.ts";
import {credentialSource,resolveSecret} from "../secrets.ts";
export function syncNineRouterProvider(pi: ExtensionAPI, config: Config): void {
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

