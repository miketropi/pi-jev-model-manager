import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_TYPES, defaultTaskRules, filterModels, type ModelOption, type TaskRules, type TaskType } from "./task-routing.ts";

export const TASK_LABELS: Record<TaskType, string> = {
  plan: "Planning & Architecture", implement: "Implementation", debug: "Debugging",
  review: "Code Review", research: "Research", explain: "Explanation",
};

/** A bounded searchable chooser instead of a potentially huge Pi select() list. */
export async function chooseSearchableModel(
  ctx: Pick<ExtensionContext, "ui">, models: readonly ModelOption[], initial = "",
): Promise<string | undefined> {
  let query = initial;
  while (true) {
    const matches = filterModels(models, query, 50);
    const menu = [
      `Search models${query ? `: ${query}` : " (type to filter)"}`,
      ...matches.map((m) => `${m.label}  [${m.key}]`),
      "Cancel",
    ];
    const selection = await ctx.ui.select(`Select model · ${matches.length} shown of ${models.length}`, menu);
    if (!selection || selection === "Cancel") return undefined;
    if (selection.startsWith("Search models")) {
      const next = await ctx.ui.input("Search model name, provider or ID", query);
      if (next !== undefined) query = next;
      continue;
    }
    const picked = matches.find((m) => selection.endsWith(`[${m.key}]`));
    if (picked) return picked.key;
  }
}

export async function configureTaskRules(
  ctx: Pick<ExtensionContext, "ui">, rules: TaskRules, models: readonly ModelOption[],
  save: () => void,
): Promise<void> {
  while (true) {
    const options = TASK_TYPES.map((task) => {
      const rule = rules[task];
      return `${TASK_LABELS[task]}: ${rule.mode}${rule.model ? ` · ${rule.model}` : ""}`;
    });
    const choice = await ctx.ui.select("Jev · Task Routing", [...options, "Back"]);
    if (!choice || choice === "Back") return;
    const task = TASK_TYPES.find((t) => choice.startsWith(`${TASK_LABELS[t]}:`));
    if (!task) continue;
    const mode = await ctx.ui.select(`${TASK_LABELS[task]} · routing policy`, ["Auto (Jev chooses)", "Prefer a model", "Force a model", "Back"]);
    if (!mode || mode === "Back") continue;
    if (mode.startsWith("Auto")) {
      rules[task] = { mode: "auto" };
      save();
      continue;
    }
    if (!models.length) {
      ctx.ui.notify("No imported and enabled models yet. Use /jev-scan or /jev-models first.", "warning");
      continue;
    }
    const selected = await chooseSearchableModel(ctx, models, rules[task].model);
    if (!selected) continue; // Cancel must not destroy the existing policy.
    rules[task] = { mode: mode.startsWith("Prefer") ? "prefer" : "force", model: selected };
    save();
  }
}
