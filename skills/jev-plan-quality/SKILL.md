---
name: jev-plan-quality
description: Use in Jev Plan Mode to transform requirements and research into a reviewable, evidence-based implementation plan before writing any code.
---
# Jev planning quality gate

1. Define goal, user outcomes, constraints, and explicit out-of-scope.
2. Read relevant files and fetch current external facts; clearly mark unknowns.
3. Present alternative approaches with concise tradeoffs; use jev_ask_user for decisions.
4. Write an actionable plan: overview, assumptions, chosen approach, numbered steps, affected files, validation, risks, acceptance criteria.
5. Do NOT modify source or run builds/tests. Do not mark implementation complete.
6. Offer a clear handoff: the plan needs human approval before implementation.
7. **Tool-agnostic collaboration:** Prefer approved, action-scoped Pi/MCP toolGrants or the generic jev_collaborate(adapter=ID,action=...) bridge to interact with existing research peers. Herdr is a built-in adapter, not a special permission category. Never ask peers to edit/run/spawn during Plan, never self-approve new grants, and independently verify peer conclusions.
