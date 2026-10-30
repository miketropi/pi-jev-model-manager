import type {Config,ManagedModel} from "../core/config.ts";
import type {DiscoveredModel} from "../nine-router.ts";
import {NINE_ROUTER_PROVIDER} from "../nine-router.ts";
import {effectiveModelProfile} from "../model-profiles.ts";
export function newNineRouterManagedModel(remote: DiscoveredModel): ManagedModel {
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
export function importNineRouterModel(config: Config, remote: DiscoveredModel): ManagedModel {
  const key = `${NINE_ROUTER_PROVIDER}/${remote.id}`;
  const existing = config.models.find((m) => m.key === key);
  if (existing) return existing;
  const model = newNineRouterManagedModel(remote);
  const hints = effectiveModelProfile(model);
  model.specialty = hints.specialty;
  model.avoid = hints.avoid;
  config.models.push(model);
  if (!config.fallback) config.fallback = model.key;
  return model;
}

