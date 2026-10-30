/**
 * Explicit Jev phases: durable task intent and conservative Plan Mode guardrails.
 * Not a security sandbox; external processes/plugins can execute independently.
 */
import { applyTaskRule, type TaskType, type TaskRules } from "./task-routing.ts";
import {grantForPhase,grantsToolCall,toolGrants,type ToolGrant} from "./tool-capabilities.ts";

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
/** Compatibility export: capabilities, not membership in this list, gate strict calls. */
export const READONLY_TOOLS=new Set([
  ...toolGrants().map(x=>x.tool),"bash"
]);
export const WORKFLOW_ENTRY = "jev-workflow-phase";
export const STRICT_PHASES = new Set<TaskType>(["plan", "qa", "review"]);

// Deliberately fail closed for shell control operators and effectful flags.
// Agents should use jev_web_fetch for HTTPS research instead of shell curl.
/** Limited Herdr CLI introspection in Plan, not arbitrary Herdr terminal control.
 * Interactive agent prompts use jev_herdr with shell-free argv instead.
 */
export function isReadOnlyHerdrShell(command:string):boolean {
 const s=command.trim();
 if(!s||s.length>260||/[\r\n;|&><`$\\'"(){}]/.test(s))return false;
 const args=s.split(/\s+/);
 if(args[0]!=="herdr")return false;
 if(args.length===3&&args[1]==="agent"&&args[2]==="list")return true;
 if(args.length===3&&args[1]==="status"&&args[2]==="server")return true;
 if(args[1]!=="agent"||args.length<4||
   !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(args[3]))return false;
 if(args.length===4&&args[2]==="get")return true;
 if(args[2]==="read"){
   const tail=args.slice(4);
   if(!tail.length)return true;
   if(tail.length===2&&tail[0]==="--lines"&&/^(?:[1-9]\d?|1[0-5]\d|160)$/.test(tail[1]))return true;
 }
 if(args[2]==="wait"){
   const tail=args.slice(4);
   return tail.length===2&&tail[0]==="--timeout"&&
     /^\d{4,5}$/.test(tail[1])&&Number(tail[1])>=1000&&Number(tail[1])<=30000;
 }
 return false;
}

export function isReadOnlyShell(command: string): boolean {
  const s = command.trim();
  if (!s || s.length > 3500 || /[\r\n;|&><`$\\]/.test(s)) return false;
  // Avoid command execution or output-file flags hidden in strings/arguments.
  if (/--(?:output|exec|delete|ok|create|apply|write|file|config|ext-diff|textconv|paginate|pre(?:-glob)?)(?:=|\b)|(?:^|\s)-[co]\b/i.test(s)) return false;
  const words = s.split(/\s+/);
  const first = words[0];
  if (first === "pwd") return words.length === 1;
  if(first==="herdr")return isReadOnlyHerdrShell(s);
  if (["ls", "rg", "grep", "cat", "head", "tail", "wc"].includes(first)) {
    return words.slice(1).every(w => !/^(?:-.*(?:delete|exec|output)|--color=always)$/.test(w));
  }
  if (first === "git" && words.length >= 2) {
    return ["status", "log", "diff", "show"].includes(words[1])
      && !words.slice(2).some(w => /^--(?:output|ext-diff|textconv|exec|config)|^-c$/.test(w));
  }
  return false;
}

/** QA may run explicitly bounded test commands, unlike Plan/Review. Test
 * scripts can have side effects; this is policy-level separation, not a sandbox.
 */
export function isQaVerificationShell(command:string):boolean {
 const s=command.trim();
 if(isReadOnlyShell(s))return true;
 if(!s||s.length>400||/[\r\n;|&><`$\\]/.test(s))return false;
 if(/^(?:npm|pnpm|yarn) (?:test|run test)(?: --(?:runInBand|watch=false))?$/.test(s))return true;
 if(/^node --test(?: [a-zA-Z0-9_./*-]+)*$/.test(s))return true;
 if(/^pytest(?: [a-zA-Z0-9_./*-]+)*$/.test(s))return true;
 if(/^go test(?: [a-zA-Z0-9_./*-]+)*$/.test(s))return true;
 if(/^cargo test(?: [a-zA-Z0-9_./*-]+)*$/.test(s))return true;
 return false;
}

export function isStrictPhase(task: TaskType | undefined): boolean {
  return task != null && STRICT_PHASES.has(task);
}

export function toolsForPhase(active:readonly string[],task:TaskType,
 configured:readonly ToolGrant[]=[]):string[]{
 if(!isStrictPhase(task))return [...active];
 return active.filter(tool=>tool==="bash" ||
   !!grantForPhase(tool,task as "plan"|"qa"|"review",configured));
}
export function canUseTool(task:TaskType|undefined,toolName:string,
 input?:unknown,configured:readonly ToolGrant[]=[]):boolean {
 if(!isStrictPhase(task))return true;
 const phase=task as "plan"|"qa"|"review";
 if(toolName==="bash"){
  const command=input&&typeof input==="object"&&"command" in input
    ?(input as {command?:unknown}).command:undefined;
  return typeof command==="string" && (phase==="qa"
    ?isQaVerificationShell(command):isReadOnlyShell(command));
 }
 return grantsToolCall(toolName,phase,input,configured);
}

export function instructionsForTask(task: TaskType): string {
  const headers: Record<TaskType, string> = {
    plan: "PLAN MODE (STRICT READ ONLY)",
    implement: "IMPLEMENTATION MODE",
    debug: "DEBUG MODE",
    review: "CODE REVIEW MODE (READ ONLY)",
    qa: "QUALITY ASSURANCE MODE (NO DELIVERABLE EDITS)",
    research: "RESEARCH MODE",
    write: "WRITING & CONTENT MODE",
    explain: "EXPLANATION MODE",
  };
  const bodies: Record<TaskType, string> = {
    plan: [
      "Analyze the user's request and relevant files, investigate constraints, propose alternatives and a numbered plan.",
      "Do not implement, edit/create/delete files, run tests, install dependencies, invoke mutating tools or delegate changes.",
      "You MAY inspect source using read/search and tightly restricted read-only bash (git log, git diff, rg, cat), and MUST research fresh facts with jev_web_fetch or an available read-only web search tool. Do not guess dates, releases or versions.",
      "For any trusted agent orchestrator, use a registered read/communication capability tool. Unknown tools are denied until the user explicitly configures scoped toolGrants in Jev config; no agent may change its own permissions during Plan.",
      "When running inside Herdr, you MAY collaborate with existing agents using jev_herdr (list, get, read, wait, prompt) for read-only research, architectural critique, and independent plan review. Never ask peer agents to edit files, run tests/commands, implement, or spawn other agents. Inspect and verify peer conclusions before incorporating them.",
      "Plain Herdr agent list/get/read/wait introspection via bash is allowed in Plan; send agent prompts only with jev_herdr, not unrestricted Herdr CLI/shell commands.",
      "When comparing alternatives or requiring a decision, CALL jev_ask_user with 2–8 concrete options and short descriptions. Do not dump A/B/C in prose expecting the user to type a reply.",
      "Finish with a concise implementation checklist. Wait for an explicit /jev-implement before editing files.",
    ].join("\n"),
    implement: "Implement the request or previously approved plan. Inspect code, make necessary changes, run focused tests, validate results, and summarize changed files. Do not claim tests were run if they were not.",
    debug: "Reproduce and identify the root cause, make a focused fix if necessary, test the affected behavior, and explain the regression risk.",
    review: "Review existing code critically, including correctness, security and tests. You may read source, inspect git diff/log and research via read-only HTTPS tools. Do not modify files or run tests. Use jev_ask_user when a choice is necessary. Report actionable findings.",
    qa: "Run read-only source/acceptance checks and explicitly allowed test commands. Do not edit project deliverables or claim a pass without evidence. Record actionable failed checks for Lead in Implementation mode.",
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
