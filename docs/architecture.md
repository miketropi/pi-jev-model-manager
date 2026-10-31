# Runtime and module architecture

Pi loads `index.ts` as the stable entrypoint; implementation lives under `runtime/`.

- `runtime/orchestrator.ts`: minimal composition, creates live session state, assembles workflow tools, lifecycle events and command adapters
- `runtime/workflow-controller.ts`: plan review and approval, checklist, QA pipeline handoff, session creation and explicit workflow transitions
- `runtime/tool-handlers.ts`: Pi tools for progress, delegation, quality gate and actions, separate from session lifecycle
- `runtime/lifecycle.ts`: Pi startup, resume, shutdown, provider and tool call hooks
- `runtime/contracts.ts`: strongly typed live-state bridge between components
- `commands/register.ts`: user-facing slash command registrations
- `routing/choose.ts`: Jev classification and deterministic fallback; `routing/selectors.ts`: physical candidate and prompt-selection helpers
- `integrations/nine-router-models.ts` and `integrations/nine-router-provider.ts`: model import and provider registration
- `ui/activation.ts`, `ui/credentials.ts`, `ui/routing-settings.ts`, `ui/model-health.ts`, `ui/model-admin.ts`, `ui/configuration.ts`, `ui/mascot-controller.ts`: interactive options, provider keys, health, model editing and Jevling
- `core/config.ts`: compatible config schema; preserves the existing user config path
- `context/`: archive, semantic scoring contract, telemetry and Pi context tools

## Boundaries and compatibility
The runtime deliberately does not persist state in the working repository. Session metadata remains in Pi entries. Commands and other modules receive a live-state adapter, not a snapshot, to prevent stale plan/checklist state. The extension still exposes the same `./index.ts` package entry.

## Verification
Use `node scripts/check-quality.mjs`, `node --experimental-strip-types --test test/*.test.ts`, `node scripts/package-release.mjs`, and verify archive content and staged entrypoint import. CI performs syntax, regressions and packaging on Node 22/24. All commands should be tested after adding new hooks.
