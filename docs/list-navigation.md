# List Navigation UX — Pi JEV

## Why this change
The old 9Router scan rendered only the first 60 matching models and relied on a native
selector without reliable scroll behavior in constrained terminals. Additional model
selectors and status screens suffered from the same potential problem.

## Shared picker
\`ui/list-picker.ts\` supplies a bounded overlay for Pi TUI builds supporting \`ui.custom\`.
No model is dropped. The overlay keeps one keyboard focus, a visible search query,
the number of matches, the current selection range and the total count.

- **Up / Down:** move selection one item
- **Page Up / Page Down:** navigate a screen at a time
- **Home / End:** jump to first / last item (9Router's batch-import action is at the end)
- **Type:** incrementally filter by name, ID, or additional search terms
- **Backspace / Ctrl+U:** delete one character / clear search
- **Enter:** select; **Esc / Ctrl+C:** cancel without changing configuration

When a custom UI isn't available, the same picker uses native menus with explicit
Next / Previous controls and optional filter. For very short legacy menus, native
selection is preserved. Search is optional, not required to discover distant items.

## Screen audit
| View | Treatment |
|---|---|
| 9Router Scan | Full catalog, keyboard scroll, in-view query, explicit bulk import |
| /jev-models catalog | Scrollable model list; static actions remain reachable |
| Add from Pi catalog | Full available catalog |
| Fallback model | Full enabled catalog, both routes |
| Task Routing model chooser | Shared picker in TUI; legacy searchable selector when custom UI is unavailable |
| Model Health probe/results | Full eligible list and status rows; no 50/70-item cap |
| /jev-config | Long settings menu scrolls, instead of clipped selector |
| Model editor | Long option list scrolls |
| Implementation checklist | Already uses dedicated scrollable viewer; unchanged |
| Plan Review | Already uses dedicated scrollable plan viewer; unchanged |
| Other prompts | All have small/validated option counts; native selection retained |

## Safety and compatibility
Picker items use stable IDs (never rely on similarly named model labels), and
querying the catalog has no side effects. Batch import still requires explicit confirmation
and is limited to 30 models. Pi native pagination is the fallback for older clients.
The extension's entrypoint, provider credentials, config format and routing logic are unchanged.

## Testing
Run \`node --experimental-strip-types --test test/list-picker.test.ts test/list-integration.test.ts\`
for 250-item keyboard navigation, native paging, zero matches, stable IDs, small screens,
and 135-model 9Router import integration. CI also runs the existing regression suite.
