# JEV Team Spawn Controller

## Purpose
Team roles PM, Dev, QA, Reviewer and Researcher are separate from the parent
Plan Mode. The controller actually invokes a trusted spawn adapter rather
than merely suggesting CLI flags. Herdr is the first supported adapter; future
orchestrators can register their own implementation of SpawnAdapter.

## Human setup
1. Update/reload the JEV extension; configure per-role models through /jev-tasks.
2. Launch a Herdr session and create empty shell panes; Herdr agent start
   requires an existing idle shell pane and does not create layouts.
3. In interactive Pi/OMP, run /jev-team-spawn-on and confirm the side effects.
4. Leave strict Plan/Review/QA mode before spawning write-capable workers.
5. Ask orchestrator to use jev_team_spawn, not a shell-command shortcut.
6. Inspect status with /jev-team-spawn-status and check the actual child
   model and execution mode in its UI before assigning significant work.
7. Run /jev-team-spawn-off to stop new launches; existing agents keep running.

## Tool request
Example arguments for jev_team_spawn:

    {
      "action": "spawn",
      "adapter": "herdr",
      "requestId": "project-dev-001",
      "name": "dev",
      "paneId": "w1:p2",
      "role": "dev",
      "difficulty": "normal",
      "platform": "omp"
    }

Request ID must be stable across retries. The caller must supply a REAL
existing empty pane ID returned from Herdr, not an invented value.
To inspect a running/uncertain child, use action=status with its name.
A previous request with the same requestId is never respawned.

The Herdr adapter calls herdr agent get before and after the launch and
executes herdr agent start with fixed argv (never a shell string). It pins the
child physical model and thinking level. OMP non-PM workers receive an
absolute --config overlay preventing inherited Plan startup mode.

## Config and limits
The default config in jev-model-manager.json:

    "teamSpawn": {
      "enabled": false,
      "maxAgents": 5,
      "maxConcurrentStarts": 2,
      "maxPremiumAgents": 1,
      "maxCostUsdPerAgent": 0
    }

The interactive enable command requires human confirmation. Per-session
receipts live in the existing Pi session journal across reloads.
Relative model cost comes from the operator-configured budget/balanced/premium
tiers, NOT verified provider prices. For OMP only, a positive
maxCostUsdPerAgent adds --max-cost to each child CLI; a request in flight may
still exceed this cap. Pi spawns are refused if a dollar cap is requested
because JEV cannot enforce it with the supported Pi CLI.

## TypeSafe Jev
If a caller supplies difficulty explicitly, it wins. Otherwise, when
JEV routing is enabled and taskSummary (12-1200 chars) is supplied, the
TypeSafe classifier can return a typed small/normal/hard decision.
Only confidence >= 0.72 is accepted; missing/low-confidence results degrade
safely to normal. TaskSummary is sent to the configured external classifier;
do not put secrets or private code in it. No raw file output or session
history is sent automatically.

## Failure and verification
The current process must be attached to Herdr with HERDR_ENV=1 and a valid
HERDR_PANE_ID and pass a read-only list probe. An unrelated server on the
computer is insufficient. Unknown/occupied names are not overwritten.
After an uncertain timeout, the controller NEVER retries agent start:
requestId is reserved; inspect with status first. Herdr startup success
confirms name/pane identity, not the backend model in the child.
The receipt always has modelVerified=false.

Strict Plan/Review/QA phases refuse spawns, and the controller checks this
itself in addition to Pi tool permissions. Missing optional Herdr service
returns a neutral message and never exposes raw socket diagnostics.

## Extensibility
A trusted new adapter can implement SpawnAdapter lookup/start and be
registered in registerTeamSpawnTools. It must implement its own safety
and lifecycle verification. Arbitrary model-generated executable commands
and unreviewed shell templates are not supported.

## Verification scope
Unit and integration tests cover CLI argv, model routing, human opt-in,
limits, concurrent starts, duplicate prevention, timeout, restore,
and TypeSafe fallback. A live Herdr/OMP/provider end-to-end test was not
possible in CI; verify on a real Herdr server with empty panes.
See https://herdr.dev/tui/docs/agent-automation/ for CLI lifecycle semantics.
