---
name: jev-implementation-quality
description: Use in Jev Implementation Mode to carry out an approved plan with small verified changes and clear progress.
---
# Jev implementation quality gate

1. Read the latest approved plan and confirm assumptions. If no plan is approved, ask before large irreversible changes.
2. Work in small testable units; use TDD or project testing conventions where feasible.
3. Preserve existing behavior and project styles; verify changed interfaces and failure paths.
4. Run focused tests, inspect diff, report commands actually run and results.
5. Check scope against plan; document deviations without silently changing architectural decisions.
6. Stop and ask before deployment, destructive operations, publish, external payment, or other irreversible actions.
