/**
 * Curated Jev routing hints for common public model families.
 *
 * Heuristics, NOT live benchmarks, prices, guaranteed capabilities or
 * availability. Match the real model slug (including nested proxy IDs);
 * never infer a provider family from an unrelated display label alone.
 * Explicit user model policies always take precedence.
 */
export type ModelTier = "deep" | "balanced" | "fast";
export interface ModelProfile {
  family: "Claude" | "OpenAI" | "DeepSeek" | "MiniMax" | "Kimi";
  variant: string;
  tier: ModelTier;
  specialty: string;
  avoid: string;
}
const profile = (family:ModelProfile["family"], variant:string, tier:ModelTier,
  specialty:string, avoid:string):ModelProfile =>
  ({family,variant,tier,specialty,avoid});

/** Only examine the last path segment; intermediaries often nest IDs. */
export function knownModelProfile(key:string):ModelProfile|undefined {
  if(typeof key!=="string"||!key.trim())return undefined;
  const slug=(key.split("/").at(-1)??"").trim().toLowerCase().replaceAll("_","-");
  // Do not associate random product names with an LLM just because they
  // contain "opus", "sonnet", "flash" or another generic word.
  if (/^claude[-.]/.test(slug)) {
    if (/\b(?:opus|fable|mythos)\b/.test(slug))
      return profile("Claude","deep-reasoning/agent", "deep",
        "Complex architecture, difficult debugging, multi-file coding, security/code review, careful long-horizon agent planning.",
        "High-volume simple classification, repetitive formatting, trivial edits when cheaper/faster models suffice.");
    if (/\bsonnet\b/.test(slug))
      return profile("Claude","balanced coding/agent","balanced",
        "Production coding, refactoring, front-end implementation, code review, tool calling, writing and day-to-day agent workflows.",
        "Spending premium reasoning budget on trivial batch tasks; the hardest multi-stage investigations may benefit from a deep-tier model.");
    if (/\bhaiku\b/.test(slug))
      return profile("Claude","fast/general","fast",
        "Quick explanations, extraction, classification, test summaries, simple bug fixes, low-latency agent subtasks.",
        "High-stakes architecture and large-scale multi-file refactors without stronger verification.");
  }
  if (/^(?:gpt[-.]|chatgpt[-.]|o[134](?:[-.]|$))/.test(slug)) {
    if (/^gpt-6-(?:astra|pro)(?:[-.]|$)|^gpt-5(?:[.-]\d+)?-pro\b/.test(slug))
      return profile("OpenAI","flagship/deep","deep",
        "Hard reasoning, architecture tradeoffs, complex debugging, broad code review and long-running agentic work.",
        "Routine formatting and low-risk repetitive edits when inexpensive models suffice.");
    if (/^gpt-6(?:[.-]\d+)?-(?:luna|mini|nano)\b|^gpt-4o-mini\b|^gpt-5(?:[.-]\d+)?-(?:luna|mini|nano)\b/.test(slug))
      return profile("OpenAI","fast/efficient","fast",
        "Fast classification, extraction, summarization, small code changes, simple explanations and repetitive assistant tasks.",
        "Security-critical review and large complex implementations without independent verification.");
    if (/codex/.test(slug))
      return profile("OpenAI","coding-specialist","balanced",
        "Repository-level coding, iterative bug fixes, refactors, tool-using implementation, tests and code review.",
        "Unrelated non-coding bulk transformations where a cheap general model is adequate.");
    if (/^gpt-6(?:[.-]|$)|^gpt-5(?:[.-]|$)|^gpt-4o(?:[-.]|$)|^chatgpt[-.]/.test(slug))
      return profile("OpenAI","balanced/general-reasoning","balanced",
        "General development, planning, reasoning, code generation, analysis, documentation and multi-step assistance.",
        "Very low-complexity high-volume requests where a fast tier meets the quality target.");
  }
  if (/^deepseek[-.]/.test(slug)) {
    if (/v4(?:[.-]1)?[-.]?(?:pro|reasoner)\b|^deepseek-reasoner$/.test(slug))
      return profile("DeepSeek","pro/deep-coding","deep",
        "Multi-step reasoning, challenging coding, debugging, architecture, agent planning and careful code review.",
        "Tiny, latency-sensitive classification or single-line edits where a flash tier suffices.");
    if (/v4(?:[.-]1)?[-.]?flash|^deepseek-chat$/.test(slug))
      return profile("DeepSeek","flash/efficient-coding","fast",
        "Fast coding iterations, agentic tool execution, routine debugging, tests, explanations and cost-aware development.",
        "Highest-stakes design/security choices without extra validation; legacy deepseek-chat alias may be retired upstream.");
    if (/v3|r1|coder/.test(slug))
      return profile("DeepSeek","legacy/reasoning-and-code","balanced",
        "Coding, reasoning, debugging and software assistance where the deployed legacy version remains available.",
        "Assuming legacy API IDs or capabilities are still supported; confirm availability with the actual provider.");
  }
  if (/^minimax[-.]m\d/.test(slug)) {
    if (/^minimax[-.]m(?:2[.-]?7|3)(?:[-.]|$)/.test(slug))
      return profile("MiniMax","advanced coding/agent","deep",
        "Multi-file software engineering, tool-using agents, complex refactoring, debugging and long-horizon coding tasks.",
        "Trivial classification or repetitive small transformations where simpler models may be faster.");
    if (/^minimax[-.]m2[.-]5(?:[-.]|$)/.test(slug))
      return profile("MiniMax","efficient coding/agent","balanced",
        "Practical full-stack coding, structured planning, tests, refactors, multi-step automation and documentation.",
        "Treating one model benchmark as a guarantee for security-critical work; use independent tests.");
    if (/^minimax[-.]m2[.-]?(?:1)?(?:[-.]|$)/.test(slug))
      return profile("MiniMax","general coding","balanced",
        "Routine coding, feature work, multilingual programming, tooling and agent subtasks.",
        "Unverified deep security/architecture decisions or assumptions about newer MiniMax features.");
  }
  if (/^kimi[-.]k\d/.test(slug)) {
    if (/^kimi[-.]k(?:3|2[.-]7[-.]code)(?:[-.]|$)/.test(slug))
      return profile("Kimi","deep/long-horizon coding","deep",
        "Extended agentic coding, repo-wide refactoring, research with tools, long documents and complex reasoning.",
        "Tiny low-latency routine tasks where lightweight options are sufficient.");
    if (/^kimi[-.]k2[.-]6(?:[-.]|$)|^kimi[-.]k2[.-]5(?:[-.]|$)/.test(slug))
      return profile("Kimi","multimodal coding/agent","balanced",
        "Coding from specifications, visual-context analysis where enabled, multi-step tool use, research and long-form reasoning.",
        "Assuming vision or thinking controls work identically across proxy providers; verify actual deployed capabilities.");
    if (/^kimi[-.]k2[-.]thinking(?:[-.]|$)|^kimi[-.]k2[-.]instruct(?:[-.]|$)/.test(slug))
      return profile("Kimi","agent/reasoning","balanced",
        "Agentic research, tool-based reasoning, coding, long-context synthesis and complex information tasks.",
        "Simple latency-sensitive requests when deep thinking is unnecessary.");
  }
}

/** Preserve non-placeholder descriptions written by the user. */
export function effectiveModelProfile(model:{
  key:string; specialty?:string; avoid?:string
}):{specialty:string;avoid:string;profile?:ModelProfile} {
 const hint=knownModelProfile(model.key);
 const specialty=(model.specialty??"").trim();
 const avoid=(model.avoid??"").trim();
 const defaultSpecialty=!specialty ||
  /^general software engineering(?: \(edit capabilities after import\))?$/i.test(specialty);
 return {
  specialty:defaultSpecialty && hint?hint.specialty:specialty || "General software engineering",
  avoid:avoid || hint?.avoid || "",
  profile:hint,
 };
}

/** Concise classifier context. Curated profile is auxiliary; user policy wins. */
export function classifierModelGuidance(model:{
 key:string; label:string; specialty?:string; avoid?:string; cost:string
}):string {
 const resolved=effectiveModelProfile(model);
 return [
  "Model: "+model.label+" ("+model.key+").",
  "Best suited for: "+resolved.specialty+".",
  "Avoid for: "+(resolved.avoid||"none specified")+".",
  ...(resolved.profile?["Curated family context: "+resolved.profile.family+
    " / "+resolved.profile.variant+" / "+resolved.profile.tier+
    " tier (heuristic; not a verified benchmark). User-defined specialty/avoid take priority."]:[]),
  "User-configured relative cost: "+model.cost+".",
  "Prefer lower cost when capabilities are comparable; favor correctness for critical tasks.",
 ].join(" ");
}
