# Team Role Router: cost-aware model assignment

## Root cause and boundary

Team roles PM, Dev, QA and Reviewer are independent from Pi/OMP Plan Mode.
Herdr agent start launches an independent CLI process and does not implicitly
apply JEV's current task-based model policy inside the new process.
JEV's original opt-in subagentRouting supported only known structured spawn
tools with a model argument; external shell/Herdr CLI spawns bypass that hook.
The exact user's case requires inspecting actual CLI flags and child settings
to know whether Plan Mode was inherited, requested or configured by default.

## Added

- Command /jev-team previews per-role model assignments for enabled physical
  models available through Pi.
- Read-only tool jev_team_route accepts role (orchestrator, pm, dev, qa,
  reviewer, researcher), difficulty (small, normal, hard), and platform
  (pi, omp), returning physical model, relative cost, safe thinking effort,
  and concrete CLI arguments for independent worker launch.
- Explicit Force/Prefer choices in /jev-tasks override heuristics.
  Missing Force targets stop with a clear error instead of silently
  substituting expensive premium models.
- For JEV-compatible structured spawn tools, role metadata is routed
  before classification, preventing an explicitly declared Dev/QA child
  from being treated as a parent Planning task. Explicit model fields
  are never overwritten; routing stays opt-in.
- Routine team work chooses configured balanced/fast models by role;
  deep-tier escalation for hard PM/architecture/review. These are
  heuristic model-family hints and operator-assigned relative costs,
  not actual dollar estimates or guaranteed model quality.

## Herdr example

Herdr accepts arguments after -- in agent start as arguments to the
agent executable (see https://herdr.dev/docs/agent-automation/).

    herdr agent start dev --kind omp --pane PANE_ID -- --model provider/efficient-coder --thinking medium

This is an illustration; get actual model, effort and CLI args from
jev_team_route, and a real pane ID from Herdr. Use a fresh independent
worker session; do not launch workers in Plan Mode. Verify the worker's
model and mode before assigning substantial work.

A different orchestrator may consume the same structured role route
(model, thinking, cliArgs) without depending on Herdr.

## Safety and limitations

- The read-only jev_team_route tool can run in strict Plan Mode, but
  launching write-capable workers cannot. Leave Plan Mode before spawning
  an implementation team.
- The role routing contract has to be consumed by the external launcher.
  JEV cannot retroactively change a Herdr/Pi/OMP process that launches
  without these model arguments or that overrides them with local settings.
- Automatic child-cost enforcement is possible only for known structured
  spawn tools with a documented model field and opt-in subagentRouting.
- Model tiers and cost are heuristics/configured relative labels;
  to verify savings measure all child tokens, cost, and quality separately.
- For high-risk reviews and complex tests, pass difficulty=hard
  or explicitly Force a suitable strong model.
