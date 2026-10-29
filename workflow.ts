/**
 * Explicit Jev phases: durable task intent and conservative Plan Mode guardrails.
 * Not a security sandbox; external processes/plugins can execute independently.
 */
import { applyTaskRule, type TaskType, type TaskRules } from "./task-routing.ts";

export const WORKFLOW_COMMANDS = {
  plan: "jev-plan",
  implement: "jev-implement",
  debug: "jev-debug",
  review: "jev-review",
  research: "jev-research",
  write: "jev-write",
  explain: "jev-explain",
} as const satisfies Record<TaskType, string>;

export const READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const WORKFLOW_ENTRY = "jev-workflow-phase";
export const STRICT_PHASES = new Set<TaskType>(["plan", "review"]);

export function isStrictPhase(task: TaskType | undefined): boolean {
  return task != null && STRICT_PHASES.has(task);
}

export function toolsForPhase(active: readonly string[], task: TaskType): string[] {
  return isStrictPhase(task) ? active.filter(x => READONLY_TOOLS.has(x)) : [...active];
}
export function canUseTool(task: TaskType | undefined, toolName: string): boolean {
  return !isStrictPhase(task) || READONLY_TOOLS.has(toolName);
}

export function instructionsForTask(task: TaskType): string {
  const headers: Record<TaskType, string> = {
    plan: "PLAN MODE (STRICT READ ONLY)",
    implement: "IMPLEMENTATION MODE",
    debug: "DEBUG MODE",
    review: "CODE REVIEW MODE (READ ONLY)",
    research: "RESEARCH MODE",
    write: "WRITING & CONTENT MODE",
    explain: "EXPLANATION MODE",
  };
  const bodies: Record<TaskType, string> = {
    plan: [
      "Analyze the user's request and relevant files, investigate constraints, propose alternatives and a numbered plan.",
      "Do not implement any part of the plan, edit/create/delete files, execute shell commands, run tests, install dependencies, call write-capable tools or delegate modifications.",
      "Read/search tools only; no subagents or shell tools. Do not claim any files were modified.",
      "Conclude with a clear implementation checklist and wait until the user explicitly selects /jev-implement.",
    ].join("\n"),
    implement: "Implement the request or previously approved plan. Inspect code, make necessary changes, run focused tests, validate results, and summarize changed files. Do not claim tests were run if they were not.",
    debug: "Reproduce and identify the root cause, make a focused fix if necessary, test the affected behavior, and explain the regression risk.",
    review: "Review existing code critically, including correctness, security and tests. Do not edit files or execute commands. Report actionable findings by priority and file/line where available.",
    research: "Investigate available evidence, APIs and tradeoffs. Cite reliable sources when applicable and distinguish confirmed facts from assumptions.",
    write: "Draft the requested article, documentation or creative content. Keep the requested audience, tone and output format. Do not edit project files unless explicitly requested.",
    explain: "Explain the subject accurately, use clear examples and do not modify code or files unless specifically requested.",
  };
  return `[JEV EXPLICIT WORKFLOW: ${task.toUpperCase()}]\n${headers[task]}\n${bodies[task]}\nThis task phase remains active until another /jev-* task command or /jev-auto is used.`;
}

/** Explicitly configured task rules take priority even if Jev is unavailable. */
export function selectExplicitModel(
  task: TaskType, autoChoice: string, fallback: string, eligible: readonly string[], rules: TaskRules,
): {model: string; reason: string} {
  const chosen = applyTaskRule(task, autoChoice, fallback, eligible, rules, 1, 0);
  return {model: chosen.model, reason: `explicit ${chosen.reason}`};
}
