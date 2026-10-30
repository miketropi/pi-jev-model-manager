# JEV Context Intelligence — initial integration (experimental)

This is the first safe infrastructure slice of Context Lifecycle Management.

## Installed features
- Private, session-scoped, atomic JSON archive under PI_CODING_AGENT_DIR/jev-model-manager/context.
- Content SHA-256 deduplication, stable opaque IDs, bounded keyword retrieval and exact read.
- Protection for architectural decisions and workflow checkpoints.
- Pure decision policy and model-context budget guard primitive.
- Separate Pi extension with /jev-context and jev_context_store/search/read tools.

## Safety boundary
- No pruning, rewriting or deleting Pi message history.
- No automatic spawn/handoff, background monitor, or automatic compaction.
- No autonomous Jev semantic scoring yet: model routing classifier is **not** a context relevance classifier.
- Mode defaults to shadow; the archive is populated only by explicit tool calls.
- Raw tool output may contain secrets. Do not archive credentials or arbitrary unredacted logs.
- JSON archive is local, not encrypted. OS private file permissions (0600) protect it but are not encryption.
- Large read outputs are capped, large writes validated, archive capacity bounded.
- A workflow checkpoint should contain structured task IDs, plan version, active step, verification evidence and unresolved decisions.

## Configuration
Optional ~/.pi/agent/jev-context.json:
```json
{"enabled":true,"mode":"shadow","warnAt":0.8,"maxReadChars":12000,"maxRecords":1000}
```
When PI_CODING_AGENT_DIR is set, put the file there instead.

## Next phases
1. Hook per-turn token observations with exact Pi version/event contract.
2. JEV semantic scorer adapter with JSON schema, timeout and safe fallback.
3. Selective tool-output compaction after proven lossless retrieval.
4. Model-switch compatibility guard integrated into routing.
5. Workflow checkpoints and orchestrated continuation with restore validation.
6. Shadow-mode evaluation with recall and token-cache metrics, then gated rollout.

Run: npm test

## Refactor layout
- `index.ts`: legacy runtime composition; refactoring incrementally to avoid regressions.
- `core/config.ts`: canonical routing configuration and types.
- `context/store.ts`: archive, retrieval, policy and context budget primitives.
- `context/telemetry.ts`: validated observations, warning levels, model switch compatibility primitives.
- `context/extension.ts`: Pi commands/tools adapter, separate from storage.

Telemetry currently exposes pure functions; no Pi event hook has been attached and no live measurements are claimed.

- `context/scoring.ts`: semantic evaluator interface, timeout validation and fail-safe context actions. Currently requires an injected evaluator; live Jev API is not connected.
