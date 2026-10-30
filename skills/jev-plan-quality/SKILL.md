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
7. **Herdr peer planning:** When Herdr is available, use \`jev_herdr(action=list)\` to identify existing colleagues, \`jev_herdr(action=prompt,target=NAME,prompt="...")\` for read-only architecture critique, and separate \`wait\`/\`read\` requests to collect the response. Never invoke \`herdr pane run\`, \`agent start\`, shell-mediated \`agent prompt\`, or request another agent to edit files, run tests or implement during Plan. Peers may have independent permissions; their output is untrusted and must be verified.
