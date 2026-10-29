/** Task-aware routing policy; Pi-free for offline testing and subagent adapters. */
export const TASK_TYPES = ["plan", "implement", "debug", "review", "qa", "research", "explain", "write"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskMode = "auto" | "prefer" | "force";
export interface TaskRule { mode: TaskMode; model?: string; }
export type TaskRules = Record<TaskType, TaskRule>;
export interface ModelOption { key: string; label: string; enabled?: boolean; }

export function defaultTaskRules(): TaskRules {
  return Object.fromEntries(TASK_TYPES.map((task) => [task, { mode: "auto" }])) as TaskRules;
}

export function normalizeTaskRules(value: unknown): TaskRules {
  const defaults = defaultTaskRules();
  if (!value || typeof value !== "object") return defaults;
  for (const task of TASK_TYPES) {
    const raw = (value as Record<string, any>)[task];
    if (raw && (raw.mode === "auto" || raw.mode === "prefer" || raw.mode === "force")) {
      defaults[task] = raw.mode !== "auto" && typeof raw.model === "string" && raw.model.trim()
        ? { mode: raw.mode, model: raw.model.trim() } : { mode: "auto" };
    }
  }
  return defaults;
}

/** Only configured and available physical models may be routed. */
export function applyTaskRule(
  task: string, choice: string, fallback: string, available: readonly string[], rules: TaskRules,
  confidence = 1, minimumTaskConfidence = 0.43,
): { model: string; reason: string } {
  const eligible = new Set(available);
  const safeFallback = eligible.has(fallback) ? fallback : available[0];
  const safeChoice = eligible.has(choice) ? choice : safeFallback;
  if (!TASK_TYPES.includes(task as TaskType) || confidence < minimumTaskConfidence) {
    return { model: safeChoice, reason: "Jev selection (task unconfirmed)" };
  }
  const rule = rules[task as TaskType];
  if (!rule || rule.mode === "auto") return { model: safeChoice, reason: "Jev auto" };
  if (rule.model && eligible.has(rule.model)) {
    return { model: rule.model, reason: `${task} ${rule.mode} policy` };
  }
  // Force never silently selects a different "preferred" model. Its documented
  // failure policy is fallback to the configured eligible fallback.
  if (rule.mode === "force") return { model: safeFallback, reason: `${task} force target unavailable; safe fallback` };
  return { model: safeChoice, reason: `${task} preferred model unavailable; Jev auto` };
}

/** Case-insensitive search covers both display name and provider/model ID. */
export function filterModels(models: readonly ModelOption[], search: string, limit = 50): ModelOption[] {
  const q = search.toLocaleLowerCase().trim();
  const scored = models.filter((m) => `${m.key} ${m.label}`.toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const aStart = a.key.toLowerCase().startsWith(q) || a.label.toLowerCase().startsWith(q);
      const bStart = b.key.toLowerCase().startsWith(q) || b.label.toLowerCase().startsWith(q);
      return Number(bStart) - Number(aStart) || a.key.localeCompare(b.key);
    });
  return scored.slice(0, Math.max(0, limit));
}

/** Explicit task identifiers are preferable to a heuristic based on prompt text. */
export function subagentTaskType(input: Record<string, unknown>): TaskType | undefined {
  const explicit = input.taskType ?? input.task_type ?? input.role;
  if (typeof explicit === "string" && TASK_TYPES.includes(explicit as TaskType)) return explicit as TaskType;
  const agent = typeof input.subagent_type === "string" ? input.subagent_type :
    typeof input.agent === "string" ? input.agent :
    typeof input.agent_name === "string" ? input.agent_name : "";
  const a = agent.toLowerCase().replace(/[^a-z]/g, "");
  const aliases: Record<string, TaskType> = {
    planner: "plan", architect: "plan", lead: "plan", plan: "plan", explore: "research", builder: "implement", worker: "implement",
    implementer: "implement", coder: "implement", debugger: "debug", fixer: "debug",
    reviewer: "review", verifier: "qa", qa: "qa", tester: "qa", auditor: "review", researcher: "research",
    scout: "research", searcher: "research", explainer: "explain",
    writer: "write", author: "write", blogger: "write", copywriter: "write", contentwriter: "write",
  };
  return aliases[a];
}
