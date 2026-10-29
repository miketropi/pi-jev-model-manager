# Pi Jev Model Manager — MVP

A reference Pi extension for automatic model choice via TypeSafe Jev with a native management UI.

## Features
- A native virtual model: `jev-manager/auto`, selectable from `/model`.
- Jev typed decisions via `ctx.modelRegistry.classify()`; no extra HTTP client/SDK required.
- Interactive Pi TUI model registry at `/jev-models`: add, enable/disable, describe capabilities, set preferred thinking, relative cost, fallback, and confidence threshold.
- `/jev-test <task>` dry-run, `/jev-status`.
- Available-model and current session-scope checks; deterministic fallback if Jev fails.
- Sticky dispatch across tool continuations and retries to protect prompt caching and tool/thinking coherence.
- Global JSON configuration; no secrets persisted.

## Requirements
- Recent Pi from `@earendil-works/pi-coding-agent` with **virtual model** and **classifier** APIs. Pi 1.0 docs describe these APIs.
- Configure a generation provider in Pi using `/login` (or environment credentials).
- Set `TYPESAFE_API_KEY` in the environment used to launch Pi, for example `export TYPESAFE_API_KEY=...`.
- Node.js compatible with your installed Pi build.

## Local install / quick test

```bash
pi -e /absolute/path/to/pi-jev-model-manager/index.ts
```

In Pi TUI:

1. `/jev-models`: select **Add a model from Pi catalog** and enter meaningful specialties/avoid cases. Add at least two models, select fallback, toggle routing ON.
2. `/model` -> select `jev-manager/auto`.
3. `/jev-test Implement a Gutenberg custom block with inspector controls`.
4. Submit a real task; inspect the footer, `/jev-status` and `/session`.

To enable global auto-discovery instead, copy the directory to `~/.pi/agent/extensions/jev-model-manager/`, and run `/reload`.

## Configuration

The extension reads and writes:

`$PI_CODING_AGENT_DIR/jev-model-manager.json` or `~/.pi/agent/jev-model-manager.json`.

Use `jev-model-manager.example.json` only if the model IDs are present in your Pi catalog **and** authenticated. The example starts with routing disabled to avoid unexpectedly transmitting user prompts to Jev. `jev-test` deliberately sends its supplied test prompt.

The chosen candidate must be listed by `ctx.modelRegistry.getAvailable()` and, when set, `ctx.scopedModels`. No other models can be selected.

## Known MVP limitations
- Not runtime-tested with the end user's Pi installation. The TypeScript is intended for the **latest** Pi APIs; older versions may differ.
- Built-in UI uses Pi select/input/editor dialogs; full-screen searchable TUI and graphs are planned, not implemented.
- Routing uses the **last user text** (up to 10,000 chars), not full repository context. Multimodal inputs are not assessed; these fall back to the configured model.
- Budget tiers are descriptive, not a billing enforcement mechanism.
- Model changes happen at new user turns; follow-up tool responses and retries use the same model. This deliberately favors correctness and cache reuse over micro-routing every LLM request.
- Classifier requests may incur provider charges. Prompt text is sent to TypeSafe. Never include secrets in test prompts; observe your data governance requirements.
- A failed generation request is retried on the same model; implementing failover for provider outages is a later milestone.
- A low-confidence selection uses the configured fallback. Relative cost descriptions can influence Jev but aren't proof of live pricing or actual quality.
- Do not run alongside another extension that auto-switches models unless you've designed precedence rules.

## Further reading
- https://pi.dev/docs/latest/virtual-models
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/tui
- https://pi.dev/docs/latest/models
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts
