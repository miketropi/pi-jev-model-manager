# Optional peer capability discovery

## Problem and policy
A CLI being installed or a Pi tool being registered does not mean a peer
service is active. Standalone Plan must never generate alarming Herdr socket
errors just because an optional integration is not in use.

- On entering or restoring Plan, JEV checks current runtime attachment and
  runs a read-only list probe with a 1.7s timeout. Unavailable integrations
  are skipped silently, without daemon startup or blocking local Planning.
- Herdr is eligible only if the current process has HERDR_ENV=1 and a valid
  HERDR_PANE_ID; a Herdr server running in an unrelated terminal is NOT enough.
  Official Herdr environment reference: https://herdr.dev/docs/cli-reference/
- Custom CLI adapters follow the same read-only list probe. Optionally add
  activation.environment and activation.equals to require a runtime marker.
- Both the generic jev_collaborate and the older jev_herdr alias are activated
  only when a matching peer is ready. Structured JSON CLI errors (even exit 0)
  count as unavailable.
- Offline/disconnected peer services are normal: show a neutral fallback
  response only if explicitly invoked, never raw stderr or socket paths.
  Invalid adapters/requests remain genuine configuration errors.
- Status cache: 30 seconds for ordinary lookups; Plan entry and
  /jev-peers-refresh recheck actively. The refresh command updates active
  Plan tools after a peer starts, but does not spawn or start services.
- Strict Plan Mode forbids direct Herdr CLI via bash: it bypasses runtime
  capability checks. Use only tools explicitly enabled after discovery.
- Existing separate toolGrants for externally installed Pi/MCP tools remain
  independent; their availability cannot be inferred without documented
  read-only health probes.

## Example custom adapter

In the peerAdapters configuration:

    {
      "id": "my_peer",
      "executable": "my-peer",
      "activation": {"environment": "MY_PEER_SESSION", "equals": "active"},
      "commands": {
        "list": ["agents", "list"],
        "get": ["agents", "get", "{target}"],
        "prompt": ["agents", "ask", "{target}", "{prompt}"]
      }
    }

The attachment marker is optional for explicitly configured adapters.
The safe list command is required for automatic discovery.

## Troubleshooting
Use /jev-peers-refresh only when you want to inspect or refresh statuses.
States: ready, unavailable, not_attached, unverified.
Standalone Plan continues normally even if none are available.

Regression tests exercise server_not_running responses, stale sessions,
healthy peers, failed probes, runtime attachment, disconnected peers,
and invalid requests. Discovery never creates a subagent process.
