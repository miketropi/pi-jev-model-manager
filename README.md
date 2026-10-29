# Pi Jev Model Manager — MVP

![Jev Model Manager — intelligent routing for Pi](https://pub-0645c3b9d3674132af6b362484df0f3c.r2.dev/jev-model-manager.png)

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

## How to use

This guide follows the actual Pi extension UI and is recommended for first-time users running Pi with a **9Router proxy**. No separate MCP server is required.

### 1. Prerequisites

You need:

- A recent version of **Pi** with extension, virtual-model, and classifier support.
- **9Router** running locally or at a reachable HTTPS URL, plus a working 9Router API key.
- A **TypeSafe API key** for Jev-based task classification.
- Node.js **22+** if you want to run the included offline tests.

If your Pi already uses 9Router as a provider, leave that configuration in place. The extension registers imported models separately as `jev-9router/...` and does **not** overwrite your existing `9router` provider.

### 2. Install and launch the extension

Clone the repository:

```bash
git clone git@github.com:miketropi/pi-jev-model-manager.git
cd pi-jev-model-manager
```

**Option A — Run directly from this project (best for evaluation):**

```bash
pi -e ./index.ts
```

**Option B — Install for regular Pi sessions:**

```bash
mkdir -p ~/.pi/agent/extensions/jev-model-manager
cp index.ts nine-router.ts ~/.pi/agent/extensions/jev-model-manager/
```

Start Pi normally, or use `/reload` if Pi is already open. Use **one installation method at a time** to avoid loading the same extension twice. When updating an existing global copy, update that copy too; `git pull` in a separate source checkout does not update the global installation automatically.

> The extension is a TypeScript Pi extension, not a standalone CLI application. You do not need to run `npm install` for the extension itself; `npm test` uses the built-in Node.js test runner.

### 3. Set the 9Router and Jev environment variables

Set all three variables **in the same shell/environment that starts Pi**:

```bash
export NINEROUTER_BASE_URL="http://127.0.0.1:20128/v1"
export NINEROUTER_API_KEY="your-9router-api-key"
export TYPESAFE_API_KEY="your-typesafe-api-key"

pi -e ./index.ts
```

For a remote reverse proxy, use its HTTPS base URL instead:

```bash
export NINEROUTER_BASE_URL="https://your-router.example.com/v1"
```

The endpoint can be given as the server root, `/v1` or `/v1/models`; the addon normalizes it to a `/v1` base URL. `NINEROUTER_BASE_URL` is used for **both scanning models and generating responses**.

Endpoint precedence is:

1. Nonempty `NINEROUTER_BASE_URL` environment variable
2. `nineRouter.baseUrl` in the saved JSON configuration
3. Built-in default `http://127.0.0.1:20128/v1`

In `/jev-models` the active URL is marked `[env]` when an environment override is set. To change the endpoint in that case, change the environment variable and **restart Pi**; editing the saved URL does not override it.

The file `.env.example` is a reference only. **Pi does not automatically load `.env`.** Export the variables or source your local file before starting Pi. Never commit actual keys to Git.

#### Check 9Router before opening Pi

```bash
curl -fsS \
  -H "Authorization: Bearer $NINEROUTER_API_KEY" \
  "$NINEROUTER_BASE_URL/models"
```

Expected response shape (illustrative):

```json
{
  "data": [
    { "id": "cc/example-model", "object": "model" }
  ]
}
```

A successful model listing confirms that discovery is reachable; it **does not guarantee** that each model supports chat, tools, vision, or has remaining quota. If you use a different API key environment variable name, change it via `/jev-models` → **9Router settings**; the default is `NINEROUTER_API_KEY`.

### 4. Scan and import models from 9Router

With the extension loaded in Pi:

1. Enter `/jev-scan`, or open `/jev-models` → **Scan 9Router models**.
2. Use **Filter** to search by model name or model ID, such as `claude`, `deepseek` or a provider prefix.
3. Select individual models to import **or** choose **Import all ... new matching models** (up to **30** new models per filtered batch; confirmation required).
4. In the per-model editor, review the settings before leaving. Repeat for the models you actually want Jev to choose between.

The scan UI shows at most 60 matching entries at a time; narrow the filter to find the ones you need. Re-running `/jev-scan` **preserves** your imported models and customized policies; it does not delete models missing from the next response.

9Router model IDs keep their original model ID under a separate Pi provider:

| 9Router model ID | Imported Pi model key |
| --- | --- |
| `cc/example-model` | `jev-9router/cc/example-model` |
| `cx/deepseek-chat` | `jev-9router/cx/deepseek-chat` |

Importing a model does **not** make it the active Pi model; you must configure routing and then select the virtual model in step 6.

### 5. Define model capabilities and routing policy

Open `/jev-models`. Each imported model has an editable profile:

| Field | Purpose |
| --- | --- |
| **Enabled** | Include or exclude this model from Jev routing candidates |
| **Display name** | Friendly label in the manager |
| **Specialty** | Tasks this model is good at, e.g. routine implementation, architecture, code review |
| **Avoid** | Tasks that should generally go to another model |
| **Cost** | Relative `budget` / `balanced` / `premium` preference, **not live 9Router prices** |
| **Thinking** | Preferred Pi thinking effort for this model |
| **Reasoning / Vision** | Actual capabilities for imported 9Router models; verify them yourself |
| **Context / Output limits** | Model-specific limits for imported 9Router models; avoid guessing |

For example, you could keep one model for straightforward coding, one for complex debugging, and one for architecture. Use realistic strengths and exclusions rather than declaring every model “best at everything.”

In the **main** `/jev-models` menu:

1. Set **Fallback** to an enabled model that Pi can actually access.
2. Set **Minimum probability** (default **0.43**, range `0`–`1`). Below this threshold, Jev uses the fallback.
3. Change **Routing** from `OFF` to `ON` (it starts OFF deliberately).
4. Choose **Mode**:
   - `auto`: Jev's eligible, sufficiently confident selection is used for execution.
   - `observe`: Jev still evaluates the task, but Pi executes it with the **fallback model**. This is useful for evaluating decisions safely.

Only **enabled, available and authenticated** Pi models in scope are eligible. If no eligible model exists, the virtual model cannot route. Candidate lists should remain focused; importing everything is usually counterproductive.

### 6. Activate automatic model selection

In Pi:

1. Run `/model`.
2. Select **Jev • Auto Model Manager** (key: `jev-manager/auto`).
3. Submit a normal task, for example:

   `Implement a Gutenberg custom block with inspector controls and tests.`

If **Routing = ON** and **Mode = auto**, the extension classifies the task through Jev and dispatches the next user turn to a matching physical model. Tool continuations and retries keep the same selected model instead of switching mid-turn.

If you leave Pi on an ordinary physical model in `/model`, the Jev virtual router is **not** active even when Routing is ON.

### 7. Test and inspect your routing decisions

| Command | What it does |
| --- | --- |
| `/jev-models` | Edit models, 9Router settings, fallback, confidence and routing mode |
| `/jev-scan` | List/filter/import models from 9Router |
| `/jev-test <task>` | Ask Jev for a **dry-run** decision; does not change the active Pi model |
| `/jev-status` | Show enabled/mode state, candidate count, fallback and latest real routing decision |
| `/model` | Select the virtual `jev-manager/auto` model |
| `/reload` | Reload a globally installed extension after updating the extension files |

Try a few different tasks:

```text
/jev-test Fix a button alignment issue in CSS
/jev-test Design a multi-tenant GraphRAG architecture
/jev-test Review the authentication flow for security problems
/jev-status
```

The reported probability is Jev's choice confidence, not a measured accuracy guarantee. The dry run may call TypeSafe even when automatic routing is currently OFF. It never switches the active Pi model by itself.

### 8. Daily workflow

After initial setup, the typical flow is:

```text
Start Pi
   ↓
/model → jev-manager/auto
   ↓
Submit your coding task
   ↓
Jev categorizes the task and suggests an eligible model
   ↓
Policy checks availability + confidence + fallback
   ↓
Pi runs that model for the turn (sticky through tool continuations)
   ↓
/jev-status to inspect the last decision
```

Re-run `/jev-scan` only when you want to discover newly added 9Router models. To tune selection quality, edit the models' **Specialty**, **Avoid**, **Cost**, and **Fallback** in `/jev-models`. You can switch to `observe` to assess routing choices before enabling full automatic dispatch.

### Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| `/jev-models` or `/jev-scan` is unknown | Confirm `pi -e ./index.ts` launched successfully, or that the extension is installed globally and reloaded |
| `Missing NINEROUTER_API_KEY` | Export the key in the same environment that launches Pi; see `.env.example` |
| 9Router HTTP `401` | Verify the key, endpoint and access permissions; test with `curl` above |
| Cannot reach 9Router / scan timeout | Verify `NINEROUTER_BASE_URL`, reachability, HTTPS/TLS and reverse-proxy path. `localhost` inside Docker or on a remote VPS may not be the same host as Pi |
| 9Router URL in TUI won't change | `NINEROUTER_BASE_URL` overrides the JSON setting; change the environment variable and restart Pi |
| Model appears in the scan but calls fail | `/v1/models` does not prove the selected model is functional, within quota, chat-capable or tool-capable; test the physical model directly |
| Jev selects fallback every time | Check Routing is ON, at least two enabled/available candidates, `TYPESAFE_API_KEY`, classifier availability, and Minimum probability |
| `/jev-test` works but tasks do not auto-route | Use `/model` and choose `jev-manager/auto`; confirm **Mode = auto** rather than `observe` |
| No eligible authenticated physical models | Check Pi provider login / credentials, imported model registration, model Enabled switches and scope filters |
| Model list after rescanning looks unchanged | Scanning is non-destructive: it does not remove imported models or reset their profiles |

**Privacy and limits:** Jev receives task text when classification runs. The extension currently classifies the **last user text** (not the entire repository), and does not autonomously switch models for sub-tasks during a single turn. The current 9Router transport is `openai-completions`; verify capability/format support before importing unusual upstream model IDs. Generation failures do not automatically fail over to a different model.

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
