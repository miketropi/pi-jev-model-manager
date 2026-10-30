import type {Message} from "@earendil-works/pi-ai";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {Config,ManagedModel} from "../core/config.ts";
const MAX_PROMPT_CHARS=10_000;
export function keyOf(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}
export function physicalCandidates(config: Config, ctx: ExtensionContext): ManagedModel[] {
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
export function resolveModel(ctx: ExtensionContext, key: string) {
  const split = key.indexOf("/");
  if (split < 1) return undefined;
  return ctx.modelRegistry.find(key.slice(0, split), key.slice(split + 1));
}
export function fallbackModel(candidates: ManagedModel[], config: Config): ManagedModel {
  const chosen = candidates.find((m) => m.key === config.fallback);
  // No unconfigured or inaccessible models are ever selected.
  return chosen || candidates[0];
}
export function lastUserText(messages: readonly Message[]): string {
  const content = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  if (typeof content === "string") return content.slice(0, MAX_PROMPT_CHARS);
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .slice(0, MAX_PROMPT_CHARS);
}

