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
  qa: "jev-qa",
  research: "jev-research",
  write: "jev-write",
  explain: "jev-explain",
} as const satisfies Record<TaskType, string>;

// Agent can investigate in Plan/Review: project read tools, read-only shell,
// the Jev HTTPS reader, interactive decisions and independently reviewed web tools.
export const READONLY_TOOLS = new Set([
  "read", "grep", "find", "ls", "bash", "jev_web_fetch", "jev_ask_user",
  "web_search", "web_fetch", "search_web", "fetch_url",
]);
export const WORKFLOW_ENTRY = "jev-workflow-phase";
export const STRICT_PHASES = new Set<TaskType>(["plan", "review"]);

// Deliberately fail closed for shell control operators and effectful flags.
// Agents should use jev_web_fetch for HTTPS research instead of shell curl.
export function isReadOnlyShell(command: string): boolean {
  const s = command.trim();
  if (!s || s.length > 3500 || /[\r\n;|&><`$\\]/.test(s)) return false;
  // Avoid command execution or output-file flags hidden in strings/arguments.
  if (/--(?:output|exec|delete|ok|create|apply|write|file|config|ext-diff|textconv|paginate|pre(?:-glob)?)(?:=|\b)|(?:^|\s)-[co]\b/i.test(s)) return false;
  const words = s.split(/\s+/);
  const first = words[0];
  if (first === "pwd") return words.length === 1;
  if (["ls", "rg", "grep", "cat", "head", "tail", "wc"].includes(first)) {
    return words.slice(1).every(w => !/^(?:-.*(?:delete|exec|output)|--color=always)$/.test(w));
  }
  if (first === "git" && words.length >= 2) {
    return ["status", "log", "diff", "show"].includes(words[1])
      && !words.slice(2).some(w => /^--(?:output|ext-diff|textconv|exec|config)|^-c$/.test(w));
  }
  return false;
}

export function isStrictPhase(task: TaskType | undefined): boolean {
  return task != null && STRICT_PHASES.has(task);
}

export function toolsForPhase(active: readonly string[], task: TaskType): string[] {
  return isStrictPhase(task) ? active.filter(x => READONLY_TOOLS.has(x)) : [...active];
}

export function canUseTool(task: TaskType | undefined, toolName: string, input?: unknown): boolean {
  if (!isStrictPhase(task)) return true;
  if (!READONLY_TOOLS.has(toolName)) return false;
  if (toolName === "bash") {
    const command = input && typeof input === "object" && "command" in input
      ? (input as { command?: unknown }).command : undefined;
    return typeof command === "string" && isReadOnlyShell(command);
  }
  return true;
}

export function instructionsForTask(task: TaskType): string {
  const headers: Record<TaskType, string> = {
    plan: "PLAN MODE (STRICT READ ONLY)",
    implement: "IMPLEMENTATION MODE",
    debug: "DEBUG MODE",
    review: "CODE REVIEW MODE (READ ONLY)",
    qa: "QUALITY ASSURANCE MODE",
    research: "RESEARCH MODE",
    write: "WRITING & CONTENT MODE",
    explain: "EXPLANATION MODE",
  };
  const bodies: Record<TaskType, string> = {
    plan: [
      "Analyze the user's request and relevant files, investigate constraints, propose alternatives and a numbered plan.",
      "Do not implement, edit/create/delete files, run tests, install dependencies, invoke mutating tools or delegate changes.",
      "You MAY inspect source using read/search and tightly restricted read-only bash (git log, git diff, rg, cat), and MUST research fresh facts with jev_web_fetch or an available read-only web search tool. Do not guess dates, releases or versions.",
      "When comparing alternatives or requiring a decision, CALL jev_ask_user with 2–8 concrete options and short descriptions. Do not dump A/B/C in prose expecting the user to type a reply.",
      "Finish with a concise implementation checklist. Wait for an explicit /jev-implement before editing files.",
    ].join("\n"),
    implement: "Implement the request or previously approved plan. Inspect code, make necessary changes, run focused tests, validate results, and summarize changed files. Do not claim tests were run if they were not.",
    debug: "Reproduce and identify the root cause, make a focused fix if necessary, test the affected behavior, and explain the regression risk.",
    review: "Review existing code critically, including correctness, security and tests. You may read source, inspect git diff/log and research via read-only HTTPS tools. Do not modify files or run tests. Use jev_ask_user when a choice is necessary. Report actionable findings.",
    qa: "Inspect acceptance criteria and risks, run tests and acceptance checks, document actual pass/fail evidence. Do not introduce feature changes unless explicitly requested.",
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
