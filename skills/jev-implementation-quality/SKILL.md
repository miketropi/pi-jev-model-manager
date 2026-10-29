---
name: jev-implementation-quality
description: Use in Jev Implementation Mode to carry out an approved plan with small verified changes and clear progress.
---
# Jev implementation quality gate

1. Read the latest approved plan and confirm assumptions. If no plan is approved, ask before large irreversible changes.
2. **Prefer Builder subagents:** Before implementing substantial steps directly, use jev_delegate(action=plan) to assign each checklist step an exact file scope, dependency list and effort rating. Call jev_delegate(action=run) to execute ready Builder waves through Pi's native subagent extension. Run no more than 2 independent file-disjoint Builders concurrently. Small changes may remain with Lead; unknown scopes and overlapping paths stay sequential.
3. If Pi native subagent is unavailable, explain that no Builder was spawned and carry out the task directly (or ask the user to install it). Do not simulate a delegation result.
4. Inspect each Builder result, changed files and test evidence. The Lead alone updates jev_progress with factual verification notes. A spawned process completing is not itself a pass; do not invoke the next wave before its dependencies are checked.
5. Work in small testable units; use TDD or project testing conventions where feasible.
6. Preserve existing behavior and project styles; verify changed interfaces and failure paths.
7. Run focused tests, inspect diff, report commands actually run and results.
8. Check scope against plan; document deviations without silently changing architectural decisions.
9. Stop and ask before deployment, destructive operations, publish, external payment, or other irreversible actions.
