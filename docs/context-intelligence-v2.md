# JEV Context Intelligence v2

## Runtime improvements
- /jev-context-report: profiler with observed native Pi token count/window, categorized tool-result CHARACTER totals, model switches, system prompt size, and compaction events. Tool contents are never persisted by the profiler.
- /jev-context-opt on|observe|off: controls safe in-memory projection of historical read/search/bash results. Default optimize applies only at >=70% of Pi-observed context with >=12,000 characters reclaimable, keeping newest four tool results intact. Errors, images, unfamiliar tools, active results and the underlying Pi session history stay unchanged. Re-read source to restore omitted details.
- session_before_compact: append protected minimal metadata checkpoint (phase, plan version/status, checklist step IDs and statuses) into Pi's existing session journal. Let Pi perform its native compaction and summarization without replacement.
- Implementation: bounded Builder prompt uses relevant plan excerpt rather than 12k characters of every plan; Builder result passed to Lead is <=7,500 characters with warning to verify source and tests. Long delegation schedule no longer embeds huge native-tool JSON in system instructions.
- /jev-context-strategy TASK: optional TypeSafe Jev typed judgments on the explicitly supplied task summary to suggest direct, read-only scout via existing peers, or scoped Builder waves. Decisions in code require >=0.75 confidence and never auto-spawn agents.

## Constraints and data safety
- Pi/OMP native compaction should remain enabled; this augmentation is not a replacement.
- Existing jev_context_store is manual. No raw data is auto-archived outside Pi.
- Only the explicitly provided strategy task summary is sent to the configured Jev classifier. Profiler telemetry is local, in memory and does not send data.
- Planning subagents are not spawned by default: current Pi native child execution has no guaranteed enforced read-only sandbox. Use existing trusted jev_collaborate read-only peer capability to perform independent research, and keep Lead as final decision maker.
- Implementation delegates only disjoint file scopes, <=2 Builders; the Lead verifies diffs/tests and cannot mark a failed wave done without evidence.
- Model classification, context usage, and tokens billed to child agents are separate metrics. Reduction in Lead context does not imply total cost saving.
- Original Pi session messages are never rewritten by projection; the older-model-view outputs are truncated only in context hook.
- Context breakdown is approximate CHARACTERS of tool outputs. Pi getContextUsage provides actual current context observations, not per-category token metering.

## Evaluation
Run 'npm run benchmark:context' for deterministic *synthetic* output projection metrics; it is not a measured benchmark against OMP.
For real A/B: run 10-15 tasks, same repo version, model and workload. Track peak Lead context, total billed tokens across all agents, compaction events, fallback errors, elapsed time, passed tests, independent review verdict and requirement retention after compaction.

## Remaining research
Automatic Jev semantic pruning needs an explicit privacy policy, batch scoring rate limits and false-negative evaluation before enabling. Real isolated Planning spawn requires an enforced read-only child tool sandbox (prompt restrictions are insufficient). Native OMP mid-turn/pruning strategies require harness implementation beyond an extension; JEV currently uses supported Pi context and compaction lifecycle hooks.
