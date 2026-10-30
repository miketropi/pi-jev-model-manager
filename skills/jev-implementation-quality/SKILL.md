---
name: jev-implementation-quality
description: Use in Jev Implementation Mode to carry out an approved plan with small verified changes and clear progress.
---
# Jev implementation quality gate

1. Read the latest approved plan and confirm assumptions. If no plan is approved, ask before large irreversible changes.
2. **Prefer Builder subagents:** Before implementing substantial steps directly, use jev_delegate(action=plan) to assign each checklist step an exact file scope, dependency list and effort rating. Call jev_delegate(action=run) to execute ready Builder waves through Pi's native subagent extension. Run no more than 2 independent file-disjoint Builders concurrently. Small changes may remain with Lead; unknown scopes and overlapping paths stay sequential.
3. In Prefer Subagents, missing or non-spawning native subagent results convert to audited **Lead fallback** through jev_delegate. For an already scheduled or failed wave, call `jev_delegate(action=lead, reason="...")` if needed, inspect partial changes, and implement directly. Never simulate a Builder run or silently mark completion; Always Delegate requires a strategy change before fallback.
   **Silent or crashed Builder recovery:** If jev_delegate reports a Builder error with no text/exception, the failed wave may already have partial edits. In Prefer Subagents, Jev records a real error and transfers only that wave to Lead. Inspect files, verify sources/test outcomes and finish missing work before jev_progress marks done. In an older paused session, use jev_delegate(action=lead,wave=N,reason="...") to recover the failed wave, where N is the wave index from jev_delegate status. Never invent a successful Builder run or treat HTTP 200 alone as proof of a completed verification.
4. Inspect each Builder result, changed files and test evidence. The Lead alone updates jev_progress with factual verification notes. A spawned process completing is not itself a pass; do not invoke the next wave before its dependencies are checked.
5. Work in small testable units; use TDD or project testing conventions where feasible.
6. Preserve existing behavior and project styles; verify changed interfaces and failure paths.
7. Run focused tests, inspect diff, report commands actually run and results.
8. Check scope against plan; document deviations without silently changing architectural decisions.
9. Stop and ask before deployment, destructive operations, publish, external payment, or other irreversible actions.
10. **Auto QA remediation:** When Jev returns failed QA feedback to Implementation, act as Lead, NOT QA. Inspect real files and approved acceptance criteria. For each QA issue call jev_qa_triage with a supported decision (fix/reject/needs_user), rationale and evidence. Only implement actionable, supported fixes. After actual edits, run verification and call jev_qa_fix with addressed issue IDs, changed file paths, fixes and evidence. The system reruns read-only QA; do not approve QA yourself. Never restart the original approved checklist or the whole build for a small QA correction.
11. Stop rather than loop when the same failures persist, a fix cannot be verified, feedback is unsupported, or user judgment is required. Jev caps auto-remediation to three correction rounds.
