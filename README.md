# Pi Jev Model Manager — MVP

A reference Pi extension for automatic model choice via TypeSafe Jev with a native management UI.

## Features
- A native virtual model: `jev-manager/auto`, selectable from `/model`.
- Jev typed decisions via `ctx.modelRegistry.classify()`; 9Router discovery uses the built-in `fetch()` API (no extra SDK).
- Interactive Pi TUI model registry at `/jev-models`: add, enable/disable, describe capabilities, set preferred thinking, relative cost, fallback, and confidence threshold.
- `/jev-test <task>` dry-run, `/jev-status`.
- `/jev-scan` to discover models from a 9Router OpenAI-compatible API and import **selected** model IDs.
- Native `/jev-models` menu contains **9Router settings** and **Scan 9Router models**.
- Imported 9Router models become physical Pi models under `jev-9router/<original-model-id>` (e.g. `jev-9router/cc/claude-opus-...`), available immediately without overwriting an existing `9router` provider.
- Re-scanning is non-destructive: preserves manually configured specialties, model settings and fallback. Import is explicit; missing upstream IDs are never silently removed.
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

## 9Router model discovery (new in v0.2)

9Router documents `GET /v1/models` using an API key, returning a JSON object with a `data` array. Both a local gateway and a remote HTTPS instance can work.

1. Ensure 9Router is running and create an API key in its dashboard. Set the key **in the Pi process environment**, not in the JSON config:

   ```bash
   export NINEROUTER_API_KEY="your-9router-api-key"
   curl -fsS http://127.0.0.1:20128/v1/models -H "Authorization: Bearer $NINEROUTER_API_KEY"
   ```

2. Start Pi with the extension and run `/jev-models` → **9Router settings**. Use `http://127.0.0.1:20128/v1` for local 9Router, or your remote **HTTPS** endpoint. Configure the **environment variable name**, not its value. Default is `NINEROUTER_API_KEY`.
3. Run `/jev-scan` (or **Scan 9Router models** inside `/jev-models`). Filter by provider prefix or name, and select individual models; batch import requires confirmation and is capped at 30 new models per scan filter.
4. Configure each imported model's specialty, avoidance criteria, cost tier (relative preference, **not** 9Router billing), reasoning/vision support and context/output token limits. Unverified metadata defaults to text-only and reasoning off. Set the correct capabilities before relying on them.
5. Enable routing and select the virtual model `jev-manager/auto` from `/model`, or run `/jev-test your task` before switching.

A 9Router model `cx/deepseek-chat` is **not** registered as `cx` provider. It becomes `jev-9router/cx/deepseek-chat`; this preserves 9Router's original model ID while keeping the Pi provider namespace separate. 9Router routes generation requests to its OpenAI-compatible `/v1/chat/completions` endpoint.

**Important:** `/v1/models` is a discovery endpoint, **not** a proof that the model currently has quota, valid credentials, chat capability, tool-calling support, image support or accurate pricing. Some 9Router versions may expose every upstream model rather than only the manually curated dashboard list. Always select models deliberately and validate them with a real Pi test task. Jev only considers imported models that Pi reports as available and authenticated.

**Security:** Remote endpoints should use HTTPS. The scanner sends `Authorization: Bearer` exclusively to the configured endpoint, rejects redirects, has a 10-second timeout and never saves keys. A 401 means the router rejected the configured key. If 9Router runs in Docker or on a VPS, `localhost` must refer to an address reachable **from the Pi process**, not the router's container. The Pi virtual-model router still sends your task text to Jev when routing is enabled.

**When Pi already uses 9Router:** the extension intentionally registers the scanned/imported models under `jev-9router` instead of overwriting the existing Pi provider `9router`. Both may appear in `/model`; only the models you enable in `/jev-models` are Jev candidates.

### Configuration example

```json
{
  "nineRouter": {
    "baseUrl": "http://127.0.0.1:20128/v1",
    "apiKeyEnv": "NINEROUTER_API_KEY"
  }
}
```

This is an excerpt; the full configuration also includes `version`, `classifier`, `models` and the routing policy. Use the accompanying `jev-model-manager.example.json` for a complete example.

## Configuration

The extension reads and writes:

`$PI_CODING_AGENT_DIR/jev-model-manager.json` or `~/.pi/agent/jev-model-manager.json`.

Use `jev-model-manager.example.json` only if the model IDs are present in your Pi catalog **and** authenticated. The example starts with routing disabled to avoid unexpectedly transmitting user prompts to Jev. `jev-test` deliberately sends its supplied test prompt.

The chosen candidate must be listed by `ctx.modelRegistry.getAvailable()` and, when set, `ctx.scopedModels`. No other models can be selected.

## Known MVP limitations
- Not runtime-tested with the end user's Pi installation. The TypeScript is intended for the **latest** Pi APIs; older versions may differ.
- 9Router discovery tested with offline mocked OpenAI-compatible responses, **not** a live user router; integration with your real 9Router and Pi still needs validation.
- Only `openai-completions` is registered for imported 9Router models. Non-chat IDs reported by `/v1/models` should not be imported until a matching transport is implemented. The scanner cannot validate tool use or reasoning support.
- Built-in UI uses Pi select/input/editor dialogs; full-screen searchable TUI and graphs are planned, not implemented.
- Routing uses the **last user text** (up to 10,000 chars), not full repository context. Multimodal inputs are not assessed; these fall back to the configured model.
- Budget tiers are descriptive, not a billing enforcement mechanism.
- Model changes happen at new user turns; follow-up tool responses and retries use the same model. This deliberately favors correctness and cache reuse over micro-routing every LLM request.
- Classifier requests may incur provider charges. Prompt text is sent to TypeSafe. Never include secrets in test prompts; observe your data governance requirements.
- A failed generation request is retried on the same model; implementing failover for provider outages is a later milestone.
- A low-confidence selection uses the configured fallback. Relative cost descriptions can influence Jev but aren't proof of live pricing or actual quality.
- Do not run alongside another extension that auto-switches models unless you've designed precedence rules.

## Tests

On Node.js 22+, from the project directory:

```bash
npm test
```

The tests use simulated 9Router responses and a mock Pi extension API, not live credentials or network services.

## Further reading
- https://pi.dev/docs/latest/virtual-models
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/tui
- https://pi.dev/docs/latest/models
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts

- https://github.com/decolua/9router/blob/master/README.md
