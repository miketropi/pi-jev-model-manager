/**
 * Dispatch guards. Pi owns actual compaction and provider request formatting.
 * Only reject a switch when an observed token count and trustworthy target limits exist.
 */
import type {ManagedModel} from "../core/config.ts";
export interface PhysicalCapabilities {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}
export interface Capacity {
  window?: number;
  output?: number;
  provenance: "reported" | "manual" | "assumed" | "unknown";
  warnings: string[];
}
const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export function modelCapacity(config: ManagedModel, physical?: PhysicalCapabilities): Capacity {
  const windows = [config.contextWindow,physical?.contextWindow].filter(valid);
  const outputs = [config.maxTokens,physical?.maxTokens].filter(valid);
  const window = windows.length ? Math.min(...windows) : undefined;
  const output = outputs.length ? Math.min(...outputs) : undefined;
  const proxy = config.key.startsWith("jev-9router/");
  const provenance = proxy
    ? config.metadataSource === "reported" ? "reported" : config.metadataSource === "manual" ? "manual" : "assumed"
    : physical?.contextWindow !== undefined ? "reported" : "unknown";
  const warnings: string[] = [];
  if (provenance === "manual") warnings.push("Manually configured model limits may differ from provider limits");
  else if (provenance !== "reported") warnings.push("Model context/output limits have not been verified against the provider");
  if (window !== undefined && output !== undefined && output >= window)
    warnings.push("Output limit must be below the context window");
  if (config.thinking !== "off" && (config.reasoning === false || physical?.reasoning === false))
    warnings.push("Reasoning effort is configured although this model declares reasoning unsupported");
  return {window,output,provenance,warnings};
}
export function safeThinking(config: ManagedModel, physical?: PhysicalCapabilities): "off" | "low" | "medium" | "high" | "xhigh" {
  if (config.reasoning === false || physical?.reasoning === false) return "off";
  if (config.thinking === "minimal") return "low";
  if (config.thinking === "max") return "xhigh";
  return config.thinking;
}
/** Only authoritative observed usage can exclude a model; never estimate from raw chars. */
export function canDispatch(usedTokens: number | null | undefined, capacity: Capacity): boolean {
  if (!Number.isFinite(usedTokens) || usedTokens == null || usedTokens < 0) return true;
  if (!["reported","manual"].includes(capacity.provenance) || !valid(capacity.window)) return true;
  const reserve = capacity.output && valid(capacity.output) ? capacity.output : 4096;
  const headroom = Math.max(2048, Math.ceil(capacity.window * 0.05));
  return usedTokens + reserve + headroom <= capacity.window;
}
export function allowedCandidates<T extends ManagedModel>(
  candidates: readonly T[],
  resolve: (model: T) => PhysicalCapabilities | undefined,
  observedTokens: number | null | undefined,
): {models:T[]; excluded:string[]; unverified:string[]} {
  const safe: T[] = [], excluded:string[] = [], unverified:string[] = [];
  for (const candidate of candidates) {
    const c=modelCapacity(candidate,resolve(candidate));
    if (c.provenance !== "reported") unverified.push(candidate.key);
    if (canDispatch(observedTokens,c)) safe.push(candidate);
    else excluded.push(candidate.key);
  }
  // If no model fits, let Pi perform its native compaction; don't deadlock the task.
  return {models:safe.length ? safe : [...candidates],excluded,unverified};
}
