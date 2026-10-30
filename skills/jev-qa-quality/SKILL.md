---
name: jev-qa-quality
description: Use for Jev QA mode, regression checks, acceptance testing, and evidence-based verification after implementation.
---
# Jev QA quality gate

1. Translate user acceptance criteria into observable tests and prioritized risk areas.
2. Select unit, integration, smoke and negative cases appropriate for the repository.
3. Execute tests when permitted; distinguish observed results from assumptions.
4. Record repro steps for any failure with clear expected/actual behavior.
5. Audit regressions, accessibility, error handling and security-sensitive edges.
6. Report pass/fail matrix and remaining blockers; do not claim success from code inspection alone.
7. In Auto QA, never modify the deliverable. Report EVERY failed check through jev_quality_gate with structured issues: location (file/section), observed, expected, evidence (actual command/count/source), and suggestedFix. A vague complaint such as "needs improvement" is not sufficient.
8. If the previous attempt included Lead fixes, independently re-verify both original acceptance criteria and previously failing checks. A Lead self-report is not proof of QA pass.
