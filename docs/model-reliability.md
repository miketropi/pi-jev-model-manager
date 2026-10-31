# JEV Model Reliability — staged improvement

This package is an opt-in Jev router with a compatibility guard for model switches and an on-demand diagnostics command.

## Model capacity
- `ctx.getContextUsage()?.tokens` is the Pi-observed context usage. The router only evaluates capacity when actual observations are available; it never pretends text-character counts are authoritative tokens.
- A target model with **reported or manually configured** context limits must accommodate the observed tokens, output reservation, and an additional safety margin. Smaller targets are excluded when a fitting alternative exists.
- Metadata provided by the 9Router scan is labeled `reported` **only if both context and maximum output fields were returned**. Defaults and legacy imports are `assumed`, not verified and therefore cannot justify a hard rejection.
- **Important:** this guard reduces risky model switches but cannot guarantee acceptance by a provider. Account-specific limits, hidden system prompts, provider token accounting and proxy translations can differ. Pi owns actual request formatting and native compaction.
- If no configured model meets known context requirements, the router deliberately allows Pi native compaction instead of deadlocking the session.

## Quality continuity
- Explicit multi-turn Implementation, Debug, QA, and Review phases keep the prior model while it remains healthy and eligible. A new task phase can select a different model. Tool continuations stay sticky per Pi behavior.
- If a provider reports a recoverable outage or rate limit, routing falls back to an eligible model, subject to context compatibility checks.
- Unsupported request parameter errors stop blind retry and direct the user to diagnostics. They never quarantine the model as a provider outage.
- A physical model declaring `reasoning:false` receives thinking `off`, and unsupported virtual values like `minimal` and `max` are mapped to `low` and `xhigh`.

## Diagnostics
Run `/jev-diagnose` to see the last selected model, routing reason, observed context, declared model limits, metadata provenance, effective thinking, and last provider error category. Raw provider error messages (which may contain credentials or prompts) are intentionally never displayed.

For unknown or assumed limits, use `/jev-models` to verify actual provider metadata. Manual values are treated as user declarations, not as independent provider verification.

## Boundaries
This feature is independent from the 9Router list picker UX fixes and automatic semantic context compaction. It does not modify session history or silently change configuration files.
