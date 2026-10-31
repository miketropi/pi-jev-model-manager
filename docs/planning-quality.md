# Planning Quality Guard

JEV prioritizes correctness over cheap/fast inference during architecture and Plan tasks.

## Behavior
- For **explicit** workflows (`/jev-plan`) with `/jev-tasks → Planning & Architecture → Auto`, JEV passes only eligible **deep** and **balanced** candidates to the classifier when at least one such curated model exists. A fast-tier fallback cannot silently override the quality floor.
- The currently selected model remains stable on subsequent user turns in the same explicit Plan phase, while it is healthy, eligible, and still satisfies the quality floor.
- The provider-error recovery route also prefers an available deep/balanced candidate over fast-tier models; existing context budget and availability checks still apply.
- For **automatically inferred** Planning tasks, if the classifier chooses a fast-tier model and a qualified alternative is available, JEV applies the planning quality guard before dispatch.
- **Explicit Prefer/Force rules take priority** over heuristic quality guard. To override the automatic choices: `/jev-tasks` → Planning & Architecture → Force a model.
- If all eligible models are unknown-tier or fast-tier, JEV does **not** block the task: it uses the best available candidates and warns that Planning quality may be degraded. A model with unknown capabilities is not advertised as proven strong.
- In `observe` mode, model selection remains advisory. The configured physical fallback is used, even if it is fast-tier; the UI warns when applicable.

## Model metadata and limitations
- Model tiers are **heuristics**, based on curated model family/model ID patterns, not benchmark scores or measured reasoning capability. In particular, GPT-5.6 Luna and explicitly labeled Fast profiles are fast-tier hints, and are not the default choice for complex Planning when a recognized deep/balanced option is eligible.
- User-defined model names cannot make an unknown model into a verified deep-thinking model. Unknown models can be manually assigned to a Plan rule.
- Actual account availability, quota, thinking support and context compatibility remain separately validated by Pi/JEV. This change does not override a direct OMP Plan model role or force a physical model when `jev-manager/auto` is not selected.
- `/jev-status` displays the latest decision reason; `/jev-diagnose` displays the selected model and heuristic Planning tier.

## Regression coverage
See `test/planning-quality.test.ts` and `test/planning-quality-integration.test.ts` for Luna selection, quality floor, unknown/fast-only degradation, explicit Force, Planning affinity, and retry failover.
