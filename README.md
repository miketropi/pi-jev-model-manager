# Pi Jev Model Manager — MVP

![Jev Model Manager — intelligent routing for Pi](https://pub-0645c3b9d3674132af6b362484df0f3c.r2.dev/jev-model-manager.png)

A reference Pi extension for automatic model choice via TypeSafe Jev with a native management UI.

## Features
- Plan/Review can perform read-only web research and open native user-choice menus without editing files.
- Jevling robot: a compact three-line TUI companion with subtle cancellable eye/antenna animation during active agent turns.
- A native virtual model: `jev-manager/auto`, activated using `/jev-on` or selected from `/model`; saved ON restores on future Pi/Herdr launches.
- Jev typed decisions via `ctx.modelRegistry.classify()`; 9Router discovery uses the built-in `fetch()` API (no extra SDK).
- Interactive Pi TUI model registry at `/jev-models`: add, enable/disable, describe capabilities, set preferred thinking, relative cost, fallback, and confidence threshold.
- Explicit `/jev-plan`, `/jev-implement`, `/jev-qa`, `/jev-debug`, `/jev-review`, `/jev-research`, `/jev-write`, `/jev-explain` and `/jev-auto` commands with mode-specific model assignment and read-only planning safeguards.
- `/jev-test <task>` dry-run, `/jev-status`, `/jev-health`, `/jev-on`, `/jev-off`, and `/jev-mascot` for routing, health and TUI display controls.
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
- Configure the TypeSafe Jev key using `/jev-config`, or provide `TYPESAFE_API_KEY` in Pi's launch environment.
- Node.js compatible with your installed Pi build.

## Quick Setup with AI Agent

Paste this prompt into Pi, OMP, or another coding agent to install and configure the extension:

```text
Install and configure Pi Jev Model Manager:
https://github.com/miketropi/pi-jev-model-manager

- Read the README and follow the latest setup instructions.
- Reuse my existing 9Router proxy and TypeSafe Jev credentials securely.
- Scan available models, configure routing profiles and a fallback.
- Enable jev-manager/auto and verify with real tests.
- Preserve my Pi settings and avoid duplicate installations.

Work autonomously where safe. Ask only when credentials or important decisions are required. Report the setup status and any remaining issues.
```

## Quick configuration (/jev-config)

Once the extension is loaded in Pi, run:

```text
/jev-config
```

Use the in-terminal menu to set the **9Router endpoint**, securely enter/replace/remove the **9Router API key** and **TypeSafe Jev API key**, configure **routing mode, fallback, confidence and classifier**, or **test 9Router connectivity**. API key entry is masked in Pi TUI (not available in RPC/print mode).

**Paste API keys:** Open /jev-config → 9Router key or Jev key. Choose **Set / replace securely**, then use **Cmd+V** (macOS terminal paste) or **Ctrl+V** (read the OS clipboard) in the masked input. If your terminal does not forward paste, choose **Paste from system clipboard** directly from the key menu and confirm; only the key length is shown. Pasted credentials must be a single line (trailing clipboard newlines are stripped). Never paste keys into the normal Pi chat editor. The addon does not automatically clear the system clipboard after saving.

Keys entered here are stored separately at `~/.pi/agent/jev-model-manager.secrets.json` (or under `PI_CODING_AGENT_DIR`) with file permissions `0600`, **not** in the routing JSON or Git repository. This is a local plaintext file protected by filesystem permissions, not an OS keychain. Shell-provided keys take precedence; a shell-provided endpoint can be overridden explicitly by choosing a custom URL in the menu. Environment-only configuration still works and is recommended for CI/headless use. Avoid storing keys on shared/untrusted machines.

Then run `/jev-scan` to import models and `/model` to select `jev-manager/auto`. Use `/jev-models` for detailed model capability editing. `/jev-test <task>` checks routing decisions without switching the active model.

## Task routing & searchable model picker (v0.4)

Run `/jev-tasks` (also available in `/jev-config` and `/jev-models`) to configure **Planning, Implementation, Debugging, Code Review, Research, and Explanation** independently. Each task supports **Auto** (Jev chooses), **Prefer** (use the selected eligible model), or **Force** (pin that model; if unavailable, use the configured fallback). Task overrides require sufficiently confident classification. Observe mode always executes the fallback.

Choose **Search models** to filter by provider, model ID, or display name. The picker shows a maximum of 50 results at a time even when you have hundreds of configured models. Cancel leaves the previous rule unchanged. First import or add models via `/jev-scan` or `/jev-models`.

### Subagent-aware routing (opt-in)

In `/jev-config`, toggle **Subagent auto-routing: ON**. When main routing is ON in auto mode, the extension can fill an *unset* `model` argument in compatible spawning tools: `Agent` (pi-subagents-hub), `agent_spawn`, `spawn_agent`, and `subagent_spawn`. Explicit model assignments are never replaced. Known roles such as `planner`, `builder`, `reviewer`, `Plan`, and `Explore` map to task policies; other prompts are classified by Jev. The selected physical model stays fixed through the child run.

**Limits:** Pi has no universal subagent spawn hook. The official example `subagent` tool has no model argument, so this addon does not change it. Compatibility depends on each third-party extension's model-override behavior. Children using `jev-9router/...` require the provider to be loaded in their own process (usually by installing this addon globally). A separate child may not inherit the parent runtime's in-memory credentials or extensions; test your subagent setup. Subagent routing defaults to **OFF**.

## Runtime Model Health & Failover (v0.5)

Pi's model catalog indicates configured/credentialed models, **not live provider availability**. Jev Model Manager now uses observed provider outcomes to avoid repeatedly selecting broken models.

- **Passive monitoring (default ON):** watches real Pi assistant responses for recognizable outage/availability errors (HTTP 429, 5xx, connection failures, timeouts, invalid credentials or retired model IDs). It does not introduce network polling, token usage or a background service.
- **Circuit breaker:** temporarily excludes a failing model from new-task routing, subagent auto-selection and dry-run recommendations. Default cooldown: **90 seconds**, exponentially increasing on repeated failures up to **15 minutes**. Models are eligible again after cooldown, and a successful response resets the failure counter.
- **Retry recovery (default ON):** when Pi invokes the virtual router for a failed request with a recognizable provider error, it prefers the configured **healthy fallback**, then another healthy candidate. Attempted models are tracked per turn to prevent model ping-pong.
- **Tool safety:** normal tool continuations remain pinned to their previous model. Context-window errors and user cancellations are not treated as service outages.
- **Interactive controls:** use `/jev-health`, or `/jev-config` → **Model health & failover** to view observed status, toggle monitoring/failover, edit cooldowns, and clear quarantines.
- **Active manual check:** `/jev-health` → **Test one model now** sends a short (maximum eight output tokens) live request to that model using Pi credentials, **only after confirmation**. It may incur provider usage. It does not include your current project files.

**Example:** When an Antigravity model responds with an outage/HTTP 503, the addon records the failure and avoids that model during the cooldown. If Pi invokes its normal `retry` route and a healthy alternative exists, the retry switches to that model instead of blindly retrying Antigravity. Force/Prefer task targets that are cooling down become unavailable candidates and follow the existing fallback policy.

**Limitations:** This is **observed, not guaranteed real-time availability**. Before a model has been called, its status is `unknown`; remote providers do not expose a universal free availability API. Automatic failover only happens at Pi's supported retry boundary, not after an arbitrary partially completed tool action. It cannot guarantee that the backup provider is healthy. Health history is in-memory and resets when Pi restarts or `/reload` runs. Independent Pi child processes have separate health caches unless a shared runner integration is added.

## Jevling — Terminal Mascot (v0.5.1)

Meet **Jevling**, a small, original terminal companion for Jev Model Manager. It lives in a dedicated widget **above Pi's editor**, without replacing the built-in header/footer or changing the agent's execution.

```text
  ╭─◇─╮   JEV  ◆ ROUTING
  │•ᴗ•│   implement · your-selected-model
  ╰─┬─╯   /jev-mascot · change display
```

The mascot changes its expression and label across **ready**, **routing**, **provider failover** and **standby** states. It returns to ready when the agent turn finishes. It shows the last selected model, not real-time token-stream telemetry.

In Pi, run `/jev-mascot` or choose **TUI mascot** in `/jev-config` to select:

- **Mascot (default):** the compact three-line character shown above.
- **Compact:** one-line badge (for small terminals).
- **Off:** hides the widget entirely.

The preference is saved in `jev-model-manager.json` and survives restarts. Jevling requires Pi **TUI mode**; it does not render in RPC, JSON or print mode. From v0.7.1 it supports subtle eye/antenna motion during agent turns, with cancellable timers; no extra network calls, model tokens or prompts. Motion is configurable in /jev-mascot.

## Activate routing in your Pi session (v0.5.2)

**Important:** Loading this extension, configuring keys, enabling Routing in the settings, or seeing the Jevling mascot **does not route until the virtual model is selected**. After a saved /jev-on, future Pi processes restore that selection on startup.

The easiest activation workflow inside Pi is:

```text
/jev-config     # configure credentials, models and task rules
/jev-on         # enable now, remember ON for future Pi/Herdr launches
/jev-status     # must report "Jev routing ACTIVE" and "Pi selected model: jev-manager/auto"
```

Alternatively, use `/model` to select `jev-manager/auto` manually and ensure **Routing = ON**, **Mode = auto** in `/jev-config`. If the selected model remains a provider model (such as `anthropic/...` or `jev-9router/...`), Jev task routing is **INACTIVE** even if the saved routing flag is ON.

`/jev-on` validates that at least one enabled/authenticated physical model is eligible, then selects `jev-manager/auto` using `pi.setModel()`. **It now persists the user's ON preference** in global Jev config. Future Pi process launches, including headless Pi instances spawned by Herdr CLI, restore the virtual model on `session_start`. The Pi global default model is not changed.

Auto restoration requires saved `enabled: true` and `mode: auto`. First install remains OFF. Selection occurs only at session startup: changing model manually in an active session is not immediately overridden. Use `/jev-off` to persist OFF and switch to the configured physical fallback. Observe mode is preserved.

For a single Pi/Herdr child that should keep its own selected model, set `JEV_AUTO_ACTIVATE=0` in that process environment. This skips restoration without erasing saved ON; explicit `/jev-on` still activates Jev. Parent and child must use the same Pi agent config directory (`~/.pi/agent` by default, or the same `PI_CODING_AGENT_DIR`). If no compatible authenticated model is available, Jev leaves the current Pi model selected and keeps saved ON for a later retry.

Jevling now reports **STANDBY / Inactive · run /jev-on** when the extension is loaded but Pi has selected a physical model, instead of misleadingly showing READY. `/jev-status` shows **ACTIVE/INACTIVE**, the selected Pi model, eligible candidate count and last routing decision.

**Content creation:** `/jev-tasks` now includes **Writing & Content**, in addition to Planning, Implementation, Debugging, Code Review, Research and Explanation. This covers prompts such as `Plan gen một bài blog nói về lỗi PHP vừa rồi`. Jev classifies the task before routing; when a task category is uncertain, the standard confidence/fallback policy still applies.

If `/jev-on` reports no eligible models, import or enable models using `/jev-scan` or `/jev-models`. If your Pi build cannot programmatically select the virtual model, use `/model` directly.

## Explicit Task Commands & Research-Friendly Plan Mode (v0.6.2)

Choose the workflow phase intentionally, without relying on Jev to guess a task from free-form prose. Commands activate the `jev-manager/auto` virtual model for the current Pi session, and use the matching rule in `/jev-tasks`.

| Command | Behavior |
|---|---|
| `/jev-plan [task]` | **Strict read-only planning**: analyze, explore, compare, create a numbered plan; never implement |
| `/jev-implement [task]` | Implement code or execute a previously agreed plan; normal tools restored |
| `/jev-debug [task]` | Diagnose and fix defects, then verify |
| `/jev-review [task]` | **Read-only code review**: may research and inspect git; no writes or subagent execution |
| `/jev-research [task]` | Gather evidence and compare approaches |
| `/jev-write [task]` | Draft a blog post, documentation or other content |
| `/jev-explain [task]` | Explain a concept without unnecessary modifications |
| `/jev-auto` | Exit explicit task phase, restore prior tools, and return to automatic Jev classification |

### Recommended two-step workflow

```text
/jev-plan Design a donation Gutenberg block with Stripe integration
# Jev selects the Planning model, investigates existing files, produces a plan,
# but cannot write files or run code.
/jev-status
# Workflow phase: plan [READ ONLY]

/jev-implement Implement the plan we just agreed on
# Jev selects the Implementation model and restores your previous active tools.
# The agent can now edit files and run tests.

/jev-review Review the change for regressions and security issues
# Read-only review model and tool policy.
/jev-auto
# Return to Jev automatic classification.
```

**Plan Mode enforces no-project-writes at the tool layer**, but allows useful research:

- **Read source:** `read`, `grep`, `find`, `ls` plus tightly restricted `bash` for read-only commands such as `git log`, `git diff`, `rg` and `cat`. Shell operators, redirects, tests, package installs and modifying commands remain blocked.
- **Live web research:** `jev_web_fetch` performs public HTTPS **GET only** with checked redirects, text/JSON processing and size/time limits. Reviewed read-only web tools (`web_search`, `web_fetch`, `search_web`, `fetch_url`) can also remain available when installed. For recent Coolify releases, use `https://api.github.com/repos/coollabsio/coolify/releases?per_page=3` and cite dated sources.
- **Interactive decisions:** `jev_ask_user` shows a native Pi choice menu with 2–8 alternatives, descriptions, keyboard navigation and an optional custom answer. The chosen option returns directly to the agent in the same tool-call. The model must call this tool; plain-text A/B/C suggestions are not automatically converted.
- **Still blocked:** edit, write, build, test, install, Git mutations and subagent spawn. Plan/Review cannot implement changes.

This is a workflow guard rather than an OS/network sandbox. Public URL validation cannot guarantee protection against DNS rebinding. In noninteractive Pi mode, interactive choices require a textual fallback.

**This is a workflow guard, not an OS sandbox.** It cannot prevent independent external processes, uncooperative extensions performing direct filesystem writes outside Pi's tool-call hooks, or manually modifying files outside Pi.

**Phase persists** across follow-up user messages and session reloads/resumes using private Pi session metadata. Calling a different explicit task command changes the phase; `/jev-auto` resets it. The previous active tools are restored when leaving Plan/Review. No task phase leaks into unrelated Pi sessions.

**No arguments?** Running `/jev-plan` alone enters read-only planning mode; your next normal message is treated as a planning request. Likewise, `/jev-implement` without arguments switches to implementation mode without sending a new prompt. With arguments, the command submits the task to Pi as a user turn. These names are deliberately prefixed (`/jev-plan` rather than `/plan`) to avoid conflicts with other Pi extensions and prompt templates.

**Routing policy:** For explicit `Prefer` or `Force` rules, Jev chooses the configured eligible model without classifying the task again. For `Auto` rules, Jev can still select the physical model, but the chosen workflow phase remains explicit. Use `/jev-tasks` to assign different models to Planning, Implementation, Review, Writing and more.

## Skills & Approved Plan Handoff (v0.7.0)

### Reuse the skills you already installed in Pi

Jev **reuses Pi's own global, project-local and Pi-package skills**. It examines the skills Pi actually loaded for the current turn and suggests a small phase-matched set: no reinstallation, no copying into another directory, no automatic third-party downloads. The model loads relevant `SKILL.md` instructions on demand through the existing read tool, just like normal Pi skills.

Suggested high-quality matches (when they are **already installed**) include the [Superpowers](https://github.com/obra/superpowers) workflow skills:

| Jev command | Reused installed skills (examples) | Built-in fallback |
|---|---|---|
| `/jev-plan` | brainstorming, writing-plans | jev-plan-quality |
| `/jev-implement` | executing-plans, test-driven-development, verification-before-completion | jev-implementation-quality |
| `/jev-qa` | verification-before-completion, test-driven-development, playwright | jev-qa-quality |
| `/jev-review` | requesting-code-review, code-review, security-review | jev-review-quality |
| `/jev-debug` | systematic-debugging, verification-before-completion | Jev debugging instructions |

Four **original** Jev quality-gate skills are bundled in this package at `skills/jev-*/SKILL.md`. They contain concise planning, execution, test and review checklists, not copied third-party skills. When this repo is installed as a Pi package (`pi install git:github.com/miketropi/pi-jev-model-manager`), Pi auto-discovers them from the package manifest (`pi.skills`). Existing global skills still take priority in Jev's recommendations. If you manually copy individual extension files instead, also install the `skills/` folder or rely on your already-installed global skills.

Use `/jev-skills` to inspect which appropriate skills Pi has actually loaded for each phase. Optional external skill library: `pi install git:github.com/obra/superpowers`, then `/reload`. This is an optional **user action**, not a hidden install performed by Jev.

### Plan is now a real session artifact

After `/jev-plan [task]` completes and Pi has **settled** (including any retries), Jev:

1. Collects the final planning response as formatted Markdown and saves it as a versioned, **session-scoped** document via Pi session entries (without editing project files).
2. Publishes the Markdown in the Pi conversation and shows a small plan summary above the editor.
3. Opens a native decision menu: **View / edit full plan**, **Implement now (approve plan)**, **Refine with AI**, **Keep plan for later**, **Cancel**.
4. Full-plan review/edit opens Pi's multi-line editor. Saving a change increments the plan version. **Implement now** marks that version approved, changes to `implement` phase, restores writable tools and submits the complete approved plan as the next task.
5. **Refine with AI** stays in strict read-only Plan Mode and creates a new draft for review. **Keep for later** and **Cancel** never start implementation.

Reopen the saved plan at any time with `/jev-plan-open`, including after `/reload` or resuming the same session. You can change phases manually via `/jev-qa` and `/jev-review` after implementation. Plans are stored in the Pi session, **not silently written to the repository**.

```text
/jev-tasks         # Assign Plan / Implement / QA / Review models
/jev-skills        # Inspect which global and bundled skills Pi loaded
/jev-plan Design a Gutenberg donation block, with validation criteria
# Pi researches, asks questions if needed, returns a Markdown plan.
# Jev shows plan and action menu after the agent settles.

# Choose: View / edit full plan
# Choose: Implement now (approve plan)
# Pi switches to Implementation and executes the approved plan.

/jev-qa Verify the donation block, run tests and report evidence
/jev-review Review changes, risks and regression coverage
/jev-plan-open     # Review or revise the latest plan again
```

**Important limits:** The final plan is based on the model's Markdown response; Jev cannot guarantee every heading is present, but provides a structured planning contract. The plan-action menu requires Pi interactive UI. In noninteractive modes, the plan is saved but not approved automatically. Skill matching is advisory — it does not guarantee the model followed a skill. Avoid adopting untrusted third-party skill packs without reviewing their instructions.

## Reliable Plan Handoff & Robot Motion (v0.7.1)

### Implement now executes the approved deliverable

When you select **Implement now**, Jev now:
- Marks the plan approved and stops presenting it as a fresh planning message.
- Restores write/build tools and switches the explicit workflow to **Implementation** before submitting the next user turn.
- Sends a direct execution contract: **do not rewrite, review or expand the plan as the deliverable**. For content tasks, produce the finished blog/article; for code tasks, implement and verify the code.
- Preserves the **original user request** alongside the plan so the Implementation model can distinguish "plan a blog" from "write the blog".
- Injects a clear Implementation handoff instruction into the next model request.
- Clears the plan summary after handoff and once the implementation turn has fully settled.

This reduces accidental re-planning. No prompt-level guard can guarantee every model follows instructions perfectly; verify the resulting code/content and `/jev-status` if a provider behaves unexpectedly.

### Plan summary is dismissible

The permanent multi-line plan widget has been replaced with a **small three-line summary** (title, version/status and actions).

- **Implement now**, **Keep plan for later**, and **Cancel** dismiss the widget.
- `/jev-plan-hide` explicitly hides the widget **without deleting the saved plan**.
- `/jev-plan-open` reopens the saved plan and its review/edit/approve menu.
- Hidden state survives `/reload` and session resume; completed implementation does not resurrect a previously approved plan.
- `/jev-auto` clears the plan widget when leaving the explicit workflow.

### Robot animation (subtle, optional)

Jevling stays the **original robot**, not the duck. While an agent is running, it occasionally shifts its eyes, blinks or changes the antenna diamond **without shifting task/model columns**. Each motion frame is brief; pauses are intentionally longer to avoid jitter. Animation stops after Pi's final `agent_settled` event, when switching sessions, or on shutdown. There is no new LLM/API use.

Use `/jev-mascot` → **Robot animation: ON/OFF**, or `/jev-config` → **Robot animation**. Motion defaults to ON; Compact and Off mascot styles remain static.

## Live Implementation Checklist & Clean Plan Storage (v0.8.0)

### A checklist that tracks actual implementation work

After `/jev-plan` finishes, choose **Implement now**. Jev extracts up to 12 numbered or checkbox tasks from the approved Markdown and displays a dedicated **TUI checklist above the editor**, independent of the robot:

```text
JEV IMPLEMENT · 2/4 · RUNNING
☑ 1. Research current APIs
☑ 2. Implement Gutenberg block
◉ 3. Test Stripe and error handling
☐ 4. Review and document changes
/jev-progress · details | /jev-progress-clear · dismiss
```

The progress widget distinguishes **☑ verified**, **◉ current**, **☐ pending**, and **! blocked**. If the plan has no extractable steps it begins with one generic task; the agent can replace the list with precise steps before anything is marked done.

A new model-callable `jev_progress` tool updates the checklist during Implementation. The agent should call it before working on a new step and after verifying a completed step, supplying a factual completion note. **Jev never guesses completion from tool activity or the final assistant message.** If the agent stops with unfinished steps, the widget says **PAUSED**, preserving the current step across follow-ups and `/reload`. If the model fails to call the tool, the checklist will not progress automatically.

- `/jev-progress` — inspect all steps and their verification notes or hide the widget.
- `/jev-progress-clear` — stop/dismiss tracking and clean the temporary plan file.
- `/jev-auto` — exit explicit workflow, dismiss checklist, clean temporary plan data.

When all steps are verified, Jev closes the checklist automatically but keeps the session progress history.

### Plan Markdown lives outside the project

The **canonical plan is saved in Pi's existing session JSONL**, not inside the source repository. When an auxiliary physical Markdown file is needed, Jev creates an ephemeral mirror in:

```text
~/.pi/agent/jev-model-manager/plans/<session-hash>.md
```

The location respects `PI_CODING_AGENT_DIR`. Each file is privately permissioned (0600) and named using a hash of the session ID; never `ctx.cwd`. Jev deletes **only its own temporary mirror** when implementation settles, completes, the user cancels/keeps the plan for later, exits the workflow, or closes/reloads the Pi session. On later continuation the file can be regenerated from the session plan. Stale mirrors from crashes are pruned on startup after 24 hours.

Planning instructions now explicitly tell the agent **not to write any auxiliary plan.md/plan-*.md file into the repository**. Existing files a previous agent wrote into the project are not silently deleted, because they may contain user data. Review them and remove them manually if unwanted. A third-party extension or model tool could still write files on its own; Jev's plan-mode tool guard and explicit instructions limit, but cannot prevent, every possible external write.

## Web Research Reliability & Diagnostics (v0.8.1)

When planning current events, releases or documentation, Jev's `jev_web_fetch` first attempts Node's native `fetch()`. If **the transport throws** (for example, DNS lookup, TLS/certificate verification, proxy or connection timeout), Jev now automatically retries the **same validated public HTTPS URL** using the system's `curl` CLI. This is useful on macOS and Linux where system curl may honor `HTTPS_PROXY` and native system certificates while Node fetch cannot reach the same site.

The fallback is strictly a **read-only GET**, launched with arguments (never shell string interpolation); it ignores local `.curlrc`, does not auto-follow redirects, enforces time/response limits and rejects nonpublic / non-HTTPS redirect targets. It never writes to the working directory. Regular HTTP responses such as 403/404/500 are **not** retried as a network failure. The fetched result reports `transport: node-fetch` or `transport: curl` to clarify what worked.

### Verify connectivity from the Pi runtime

```text
/jev-web-check https://wordpress.org/news/2026/10/wordpress-7-1-4/
```

The command reports the final source URL, HTTP code, transport and fetched text length. With no URL it checks that WordPress article by default. During planning, `jev_web_fetch` returns diagnostic errors such as:

```text
Node fetch failed (ENOTFOUND: fetch failed);
curl fallback failed (curl exited 60: SSL certificate problem).
Check DNS, HTTPS_PROXY and TLS certificates.
```

If both methods fail, verify the machine's network/DNS, proxy configuration and certificate store. The addon cannot bypass a firewall or a site's rate limit. System curl must be installed for the fallback; you can disable it with `JEV_WEB_FETCH_CURL=0`. Do not disable TLS validation to work around certificate problems. Proxy credentials are not copied into logs intentionally, and the CLI uses an argument array without shell execution. Private-host validation is not a complete DNS-rebinding defense; do not treat Jev's web reader as a hardened general-purpose browser.

## Automated Quality Checks & GitHub Releases

Two GitHub Actions workflows automate validation and releases:

| Workflow | Trigger | Behavior |
|---|---|---|
| [Quality Checks](https://github.com/miketropi/pi-jev-model-manager/actions/workflows/quality.yml) | Push to `main`, pull requests, manual runs, or reusable call | Node 22/24 syntax + hygiene checks, full regression tests, release bundle smoke tests, SHA-256 checksums and `actionlint` validation |
| [Release Package](https://github.com/miketropi/pi-jev-model-manager/actions/workflows/release.yml) | Push version tag such as `v0.8.2` | Reuses quality checks, verifies the tag matches `package.json`, builds archives and publishes a GitHub Release |

Release assets include `pi-jev-model-manager-vX.Y.Z.zip`, `pi-jev-model-manager-vX.Y.Z.tar.gz` and `SHA256SUMS`. Both archives contain a single `pi-jev-model-manager/` directory with runtime TypeScript files, `package.json`, bundled `skills/`, README and bundled assets. Packaging excludes tests, credentials, local `.env` files, `node_modules` and build output. It does **not** publish to npm; the repository remains `"private": true`.

### Create a release tag

Update `package.json` to the intended release version, commit and push, then tag that **same commit**:

```bash
# Example: package.json has "version": "0.8.2"
npm run check
git add package.json
git commit -m "chore: release v0.8.2"
git push origin main
git tag v0.8.2
git push origin v0.8.2
```

Release requires a tag that matches `v` + `package.json.version` exactly. Failed tests or a mismatch stop the workflow **before** publishing a release. The release job uses GitHub's scoped `GITHUB_TOKEN` with `contents: write`; no personal access token is necessary. A tag is not created automatically by configuring these workflows.

### Local checks

```bash
npm run lint             # TS/JS syntax, merge markers and Pi manifest structure
npm test                 # Node regression suite
npm run check            # both quality checks
npm run release:package  # dist/*.zip, dist/*.tar.gz, dist/SHA256SUMS
RELEASE_TAG=v0.8.1 npm run release:verify
```

The initial `lint` step is a dependency-free syntax/structure gate, **not** complete semantic TypeScript type checking or full ESLint rules. That requires a compatible Pi SDK/TypeScript configuration and locked development dependencies.

## Optional Auto Implement → QA → Review (v0.9.0)

When a Jev plan has finished, the native Plan approval menu now offers **two different paths**, chosen once before execution:

- **Implement now (approve plan)** — Manual mode. Runs Implementation only. QA and Review remain opt-in slash commands and **do not start automatically**.
- **Auto Implement → QA → Review (approve plan)** — User explicitly authorizes the whole three-stage pipeline. Jev runs Implementation, then QA, then read-only Review, using the task-specific model and installed skills selected for each phase.

Other choices remain: **View/edit plan**, **Refine with AI**, **Keep for later**, and **Cancel**.

### Safety and phase transitions

```text
APPROVED PLAN
  ├─ Implement now          → IMPLEMENT only (manual)
  └─ Auto Implement → QA → Review
       IMPLEMENT  (all checklist tasks verified)
            ↓
       QA  (jev_quality_gate: pass + evidence)
            ↓
       REVIEW  (read-only; jev_quality_gate: pass + evidence)
            ↓
       COMPLETE
```

Automatic continuation is **strictly gated**. Implementation must have every `jev_progress` checklist step marked done with a factual verification note before QA starts. QA and Review must call the new `jev_quality_gate` tool with a `pass` or `fail` verdict and evidence of checks performed before Jev advances. If a run is aborted, a result is missing, or a phase fails, Jev pauses/stops **without launching later phases**. It never silently assumes that an agent's final paragraph means the work was verified. There are no automatic fix/retry loops.

If the agent forgets to update a checklist or gate, the pipeline intentionally pauses; use the following controls:

- `/jev-pipeline-status` — Show stage, status, checks and stop reason.
- `/jev-pipeline-resume` — Resume a **paused**, still-authorized phase (no implicit re-run after session reload).
- `/jev-pipeline-stop` — Stop auto transitions immediately; retain session plan, completed checklist and QA/Review findings.
- `/jev-auto` or a manual phase command — Leave/cancel automatic pipeline behavior.

Pipeline decisions and results are stored in the **current Pi session**, so state can be examined after `/reload`. On session reload an in-flight pipeline is paused rather than automatically launching work. The QA phase can run tests; Review stays under the strict read-only tool guard, but can still call `jev_quality_gate` to record its verdict. Task routing continues to honor the user's per-phase model settings.

**Limitations:** A tool-reported `pass` is an agent-provided declaration with a note, not independent proof of correctness. Verify important changes personally. The option and phase transitions are integration-tested with a mocked Pi extension runtime; live Pi TUI behavior depends on the installed Pi build. This version remains within the same Pi session rather than creating isolated sessions.

## Linked Implementation Sessions (v0.9.1)

Each approved plan can now start its own **clean, linked Pi Implementation Session**. Unlike a fork, Pi's `newSession()` does not copy brainstorming history. The new session receives only the approved Markdown plan, original user request, version, implementation checklist, and a link to the Planning Session file. The model selection is set to Jev's virtual `jev-manager/auto` so the existing per-phase routing can continue.

### Plan approval menu

The first two choices are **recommended**:

- **Implement now · New session (recommended)** — New linked Implementation Session; QA/Review remain manual.
- **Auto Implement → QA → Review · New session** — New linked Implementation Session; QA and Review run in the same child after verified Implementation completion.
- **Implement now (approve plan)** — Keep the existing same-session manual workflow.
- **Auto Implement → QA → Review (approve plan)** — Keep the existing same-session automatic workflow.
- **View/edit**, **Refine**, **Keep**, and **Cancel** remain available.

### Important Pi API constraint

Pi's `ctx.newSession()` is only available to slash-command handlers, **not** to `agent_settled` event handlers. Jev does not circumvent this restriction:

- When the plan menu is opened from `/jev-plan-open` (command context), choosing a New Session option creates and opens the child immediately.
- When the plan menu appears automatically as the planning agent settles, choosing a New Session option **prepares `/jev-implement-session manual` or `/jev-implement-session auto` in the Pi editor**; press **Enter once** to safely complete the transition.

This one extra Enter is required by Pi's command-only session replacement API, not an extra model approval step. The selected plan is already saved. The child session is named `Jev Implement · <plan title>` and includes a `parentSession` header reference. Open existing child sessions via Pi's native `/resume` rather than creating duplicate sessions. If a previous launch attempt is recorded for a plan, Jev prompts for explicit confirmation before starting another.

### Commands and lifecycle

```text
/jev-implement-session manual  # Launch approved plan in a clean child session
/jev-implement-session auto    # Launch with auto Implement -> QA -> Review
/jev-session-origin            # Show linked Planning Session path/version
/jev-pipeline-status           # In child: inspect Auto QA/Review progress
/jev-pipeline-resume           # Resume a paused Auto phase after /reload
```

After a child session starts, its own session JSONL stores the approved plan and checklist. **QA and Review stay inside that child session**. Reloading or resuming pauses any running automatic pipeline until explicit `/jev-pipeline-resume`. The parent Planning Session is retained independently.

**Scope:** Session isolation separates *conversation context*, not working-tree files. Both sessions still work in the same project directory; this does not create a Git worktree or branch. A child session can be revisited via Pi's native `/resume`. The feature uses the documented Pi session API and has mocked end-to-end tests, but has not yet been executed on your local Pi build.

## Fix: Jev Routing Stays ON in New Implementation Sessions (v0.9.2)

A newly created Pi session could show **JEV ○ standby · Inactive** because `appendModelChange("jev-manager","auto")` writes session history, but may not select Pi's **active runtime model**. That caused an approved Auto Implementation to start with the wrong model and never enter Jev's intended pipeline.

Now, **only for an explicitly linked new Jev Implementation Session** (not ordinary Pi sessions), the replacement extension's async `session_start` handler calls Pi's `setModel(jev-manager/auto)` and restores the Jev ON/auto routing configuration. It updates the robot using the selected virtual model instead of the stale pre-switch session context. The first implementation prompt is sent **only after** the new-session runtime confirms Jev routing is active.

If Pi cannot select the virtual model (missing provider/credentials or incompatible Pi build), the new session remains open but **no implementation starts**. In Auto mode, the pipeline is marked paused with a reason. Resolve the model issue with `/jev-on`, then run `/jev-pipeline-resume`; for manual mode use `/jev-plan-open` or `/jev-implement` with an explicit task. This prevents unexpectedly spending tokens on a different model.

The normal `/jev-auto` and manual physical-model selections remain respected in unrelated Pi sessions; the new activation applies to the new child created by an approved Jev plan. No user interaction is required during a successful new-session handoff. Regression tests cover child startup on a physical model and in observe mode, plus fail-closed behavior when Pi rejects `setModel()`.

## Subagent-First Implementation (v0.10.0)

Jev now defaults to **Prefer Subagents**, with at most **2 concurrent Builders**. The main Implementation Session is the **Lead / Orchestrator**; Jev reuses Pi's native `subagent` extension instead of creating its own process-spawning engine. Every Builder launched by Pi has an independent agent context. The Lead keeps the canonical approved plan and checklist.

### Required Pi subagent setup

**The native `subagent` extension is optional and is not bundled by Jev.** Install/enable the official Pi example from [Pi's subagent extension](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) following its upstream README. Ensure a user-level agent profile named `worker` exists at `~/.pi/agent/agents/worker.md`, or select a different installed user-level agent in `/jev-config`. Pi's subagent extension uses user-level agents by default; Jev explicitly sends `agentScope: "user"` to avoid loading untrusted project-local agent definitions. The worker profile controls its model and tools.

Use `/reload` after installing the Pi subagent extension. Run `/jev-delegation` to verify that the native tool is available. In **Prefer Subagents**, if the native subagent is unavailable or explicitly reports **NO Builder was spawned**, Jev automatically records an **audited Lead fallback** for unfinished Builder waves. A completed Lead task can then be marked `done` with factual verification evidence (minimum 12 characters), without fabricating a Builder result. Native execution is only available on Pi builds supporting nested tool invocation via `ctx.executeTool`.

### Configuration

In `/jev-config` select Implementation execution strategy, Max concurrent Builders and Builder agent profile:

- **Prefer Subagents** (default): delegate medium/large scoped tasks; small edits stay with Lead
- **Always Delegate**: prefer delegation even for small scoped tasks
- **Direct**: Lead implements without spawning
- **Max concurrent Builders**: 1 or 2 (default 2)
- **Builder agent profile**: user-level Pi agent name (default `worker`)

The settings are saved under `delegation` in Jev's global config and are separate from the older optional `subagentRouting` switch (which only routes models for certain third-party spawn tools).

### Actual delegation workflow

```text
APPROVED PLAN → Implementation Session (Lead)
    │
    ├─ jev_progress(action=list)                    # real checklist IDs
    ├─ jev_delegate(action=plan, tasks=[...])       # files + dependencies + effort
    │       ├─ small/unscoped task → Lead
    │       └─ medium/large scoped task → Builder
    ├─ jev_delegate(action=run)                     # real Pi native subagent call
    │       ├─ Builder A (isolated context)
    │       └─ Builder B (isolated context, disjoint files only)
    ├─ Lead inspects diff + tests                   # mandatory verification
    ├─ jev_progress(action=update, status=done, note="...")
    └─ next verified-ready wave → ... → optional Auto QA → Review
```

Jev's `jev_delegate` tool invokes the native Pi tool through `ctx.executeTool("subagent", ...)`. Execution can be a single Builder or a parallel batch of at most two. The scheduler rejects invalid paths, duplicate step IDs, unresolved dependencies and cycles; it serializes overlapping directories and unknown file scopes. A running wave is recorded in the Pi session (including an abbreviated result), and **cannot be retried silently**. A later wave cannot launch until previous dependencies have been marked done with verification by Lead. Parent `jev_progress` rejects marking a delegated step done if the subagent tool did not return a non-error result. Even a non-error response **does not automatically mark anything done**.

Use `/jev-delegation` to inspect strategy, native tool availability and scheduled waves. The normal `/jev-pipeline-status` and `/jev-pipeline-resume` remain valid for Auto QA/Review. Restarting a completed implementation clears the old delegation record.

### Recover a blocked checklist after Builder could not spawn (v0.10.1)

A previous schedule can contain Builder-assigned steps when Pi has no working subagent. After updating and running `/reload`, stay in `/jev-implement` and call `jev_delegate(action=run)`; **Prefer Subagents** now converts unfinished Builder waves into Lead tasks instead of permanently blocking `jev_progress`. Alternatively, call the **model-facing tool** `jev_delegate(action=lead, reason="Native Pi reported NO Builder was spawned; Lead inspected files and tests")` for audited manual recovery. It also supports failed Builder tool calls after inspecting any partial changes.

Fallback changes task ownership and records the reason in the Pi session. It **never marks a step done automatically**. Lead must call `jev_progress(action=update, stepId=N, status=done, note="Verified changes and focused tests...")` with factual evidence for each completed step, including formerly `blocked` steps. Auto QA begins only when every step is verified. Review follows only after QA passes.

**Always Delegate** refuses automatic Lead fallback; switch strategy to Prefer or Direct if direct execution is acceptable. A real reported Builder run cannot be silently overwritten.



**Isolation limits:** Each Pi Builder gets its own conversation context, but children still share the same repository working tree. The file scopes in task prompts are policy instructions, **not filesystem sandbox permissions**; subagents could modify files outside the declared scope. Always review the git diff and test results. For strong write isolation use separate Git worktrees. Pi may impose additional limits on concurrency and model availability. A spawned process may also consume extra tokens; Jev mainly reduces the Lead's context pressure rather than guaranteeing cost savings.

**Verification:** The Jev nested-tool workflow is tested using a Pi runtime mock with a real tool-call interface, but actual provider-backed Pi subprocess spawning on your machine has not been tested yet.

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
cp index.ts nine-router.ts secrets.ts config-ui.ts ~/.pi/agent/extensions/jev-model-manager/
```

Start Pi normally, or use `/reload` if Pi is already open. Use **one installation method at a time** to avoid loading the same extension twice. When updating an existing global copy, update that copy too; `git pull` in a separate source checkout does not update the global installation automatically.

> The extension is a TypeScript Pi extension, not a standalone CLI application. You do not need to run `npm install` for the extension itself; `npm test` uses the built-in Node.js test runner.

### 3. Configure 9Router and Jev credentials

**Recommended:** open `/jev-config` inside Pi and set your endpoint plus both API keys with the secure TUI. Alternatively, set all three variables **in the same shell/environment that starts Pi**:

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

For interactive use, `/jev-config` removes the need to write your own `.env` file. The file `.env.example` is a reference only. **Pi does not automatically load `.env`.** Export the variables or source your local file before starting Pi. Never commit actual keys to Git.

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
| `/jev-config` | Configure endpoint, masked API keys, routing settings, classifier and connection check |
| `/jev-models` | Edit models and model-specific capabilities |
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
| `Missing NINEROUTER_API_KEY` | Run `/jev-config` and enter the key securely, or export it before starting Pi |
| 9Router HTTP `401` | Verify the key, endpoint and access permissions; test with `curl` above |
| Cannot reach 9Router / scan timeout | Verify `NINEROUTER_BASE_URL`, reachability, HTTPS/TLS and reverse-proxy path. `localhost` inside Docker or on a remote VPS may not be the same host as Pi |
| 9Router URL in TUI won't change | In `/jev-config`, choose **Use a custom URL (override environment)**; otherwise the environment variable wins |
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
- Not runtime-tested with the end user's Pi installation. The TypeScript is intended for the **latest** Pi APIs; older versions may differ. Live health probes and cross-provider retry behavior still require validation on actual Pi + 9Router + upstream services.
- 9Router discovery tested with offline mocked OpenAI-compatible responses, **not** a live user router; integration with your real 9Router and Pi still needs validation.
- Only `openai-completions` is registered for imported 9Router models. Non-chat IDs reported by `/v1/models` should not be imported until a matching transport is implemented. The scanner cannot validate tool use or reasoning support.
- Built-in UI uses Pi select/input/editor dialogs; full-screen searchable TUI and graphs are planned, not implemented.
- Routing uses the **last user text** (up to 10,000 chars), not full repository context. Multimodal inputs are not assessed; these fall back to the configured model.
- Budget tiers are descriptive, not a billing enforcement mechanism.
- Model changes happen at new user turns; follow-up tool responses and retries use the same model. This deliberately favors correctness and cache reuse over micro-routing every LLM request.
- Classifier requests may incur provider charges. Prompt text is sent to TypeSafe. Never include secrets in test prompts; observe your data governance requirements.
- Recognized provider outages now trigger a health cooldown and alternate routing **if Pi retries the failed request**. A mid-turn tool continuation still remains on its original model; this is not a universal replay/failover layer.
- A low-confidence selection uses the configured fallback. Relative cost descriptions can influence Jev but aren't proof of live pricing or actual quality.
- Do not run alongside another extension that auto-switches models unless you've designed precedence rules.

## Built-in model routing profiles (v0.10.3)

Jev includes **conservative, curated routing descriptions** for common model families. These hints are passed to the existing typed Jev classifier during model selection; they do not spawn additional model calls, download a live benchmark database, or create new models.

| Family | Typical model names (match actual configured model IDs) | Jev routing guidance |
| --- | --- | --- |
| Claude | Opus / Fable / Mythos, Sonnet, Haiku | Complex architecture/long agent tasks → deep; production coding and review → balanced; quick extraction and small tasks → fast |
| OpenAI / GPT | GPT-6 Astra, GPT-6 Sol / GPT-5.6 Sol, GPT-6 Luna, Codex | Hard reasoning and architecture → flagship; normal engineering → balanced; efficient short tasks → fast; Codex → repository coding |
| DeepSeek | V4 Pro, V4 Flash / V4.1 Flash, legacy V3/R1 | Pro for complex implementation/review; Flash for faster coding and tool-use loops; legacy IDs require availability checks |
| MiniMax | M2.5, M2.7, M3, M2.1 | Multi-step coding, workflow orchestration, refactoring, and economical day-to-day coding depending on variant |
| Kimi | K2.5, K2.6, K2.7 Code, K3, K2 Thinking | Long-horizon tool-assisted work, code generation, and visual context where supported by the actual API |

Profiles are **heuristics, not universal benchmark rankings or live API pricing**. Exact capabilities and costs can differ by provider/proxy. The configured **relative cost** and explicit task-model rules keep their existing precedence. Jev never selects an unconfigured or unavailable model just because a profile exists.

- **Already-imported models:** Jev applies known profiles at classification time, including older entries with generic descriptions; no re-import or config overwrite.
- **New Pi-catalog/9Router imports:** Jev seeds the editable \`Specialty\` and \`Avoid\` fields for recognized model IDs.
- **Custom descriptions:** Specific user-written \`Specialty\` and \`Avoid\` always take priority over default hints. In \`/jev-models\`, choose an imported model and open **Curated profile** to inspect the matching hint.
- **Unknown model IDs:** No speculative profile is invented; existing metadata drives routing.

**Reference documentation (reviewed 2026-10-30):** [Anthropic model documentation](https://docs.anthropic.com/en/docs/about-claude/models/overview), [OpenAI API pricing/model families](https://platform.openai.com/pricing), [DeepSeek API updates](https://api-docs.deepseek.com/updates/), [MiniMax M2.5](https://www.minimax.io/models/text), [MiniMax M2.7](https://www.minimax.io/news/minimax-m27-en), [Kimi K2.5](https://github.com/MoonshotAI/Kimi-K2.5). Model capabilities and names evolve; edit descriptions as you gather evaluation results for your real workload.

## Tests

On Node.js 22+, from the project directory:

```bash
npm test
```

The tests use simulated 9Router responses and a mock Pi extension API, not live credentials or network services. Explicit workflow tests cover Plan → Review → Implement → Auto, tool blocking and restoration, persistent session phase and explicit model selection.

## Further reading
- https://pi.dev/docs/latest/virtual-models
- https://pi.dev/docs/latest/extensions
- https://pi.dev/docs/latest/tui
- https://pi.dev/docs/latest/models
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/jev-router.ts

- https://github.com/decolua/9router/blob/master/README.md
