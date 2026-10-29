---
name: jev-review-quality
description: Use for Jev Review mode to inspect changes against requirements, security, maintainability and tests without modifying files.
---
# Jev code review quality gate

1. Identify the intended behavior and compare to the latest agreed plan.
2. Read relevant diffs, tests and surrounding interfaces before judging.
3. Look for correctness, security, race conditions, performance and regression risks.
4. Verify claims from source or read-only research; do not edit files or run destructive actions.
5. Report findings in descending severity with precise file/line references and fixes to consider.
6. Explicitly state when no relevant findings were identified and what remains unverified.
