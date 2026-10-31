/**
 * Accessible shared TUI picker for large Jev catalogs.
 * Custom scroll/filter when available, bounded native pagination otherwise.
 * Never truncates the underlying list or confuses display labels with identities.
 */
import { reviewHeight } from "../plan-review-ui.ts";

export interface PickerItem {
  id: string;
  label: string;
  searchText?: string;
}
export interface PickerChoice { id: string; query: string }
export interface PickerOptions {
  title: string;
  items: readonly PickerItem[];
  actions?: readonly PickerItem[];
  initialQuery?: string;
  pageSize?: number;
}
type UI = {
  select: (title: string, choices: string[]) => Promise<string | undefined>;
  input?: (title: string, initial?: string) => Promise<string | undefined>;
  custom?: (factory: any, options?: any) => Promise<PickerChoice | undefined>;
};
type Theme = { fg: (color: string, value: string) => string };
type Libs = {
  truncateToWidth: (value: string, width: number, ellipsis?: string) => string;
  visibleWidth: (value: string) => number;
  matchesKey: (data: string, key: string) => boolean;
  Key: { pageUp: string; pageDown: string; ctrl: (key: string) => string };
};
export function matchedItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...items];
  return items.filter(item => {
    const text = (item.label + " " + (item.searchText ?? "")).toLocaleLowerCase();
    return terms.every(word => text.includes(word));
  });
}
export function createListPickerComponent(
  options: PickerOptions,
  tui: { terminal: { rows: number }; requestRender: () => void },
  theme: Theme,
  keys: (data: string, key: string) => boolean,
  truncate: Libs["truncateToWidth"],
  visibleWidth: Libs["visibleWidth"],
  done: (choice: PickerChoice | undefined) => void,
) {
  let query = options.initialQuery ?? "";
  let selected = 0;
  let scroll = 0;
  let viewport = 1;
  const actions = options.actions ?? [];
  const results = () => [...matchedItems(options.items, query), ...actions];
  function layout() {
    const all = results();
    const height = reviewHeight(tui.terminal.rows);
    viewport = Math.max(1, height - (height < 10 ? 5 : 6));
    selected = Math.max(0, Math.min(selected, all.length - 1));
    scroll = Math.max(0, Math.min(scroll, Math.max(0, all.length - viewport)));
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + viewport) scroll = selected - viewport + 1;
    return { total: all.length, matching: all.length - actions.length, selected, scroll, viewport,
      start: all.length ? scroll + 1 : 0, end: Math.min(all.length, scroll + viewport) };
  }
  const repaint = () => { layout(); tui.requestRender(); };
  return {
    getLayout: layout,
    getQuery: () => query,
    render(width: number) {
      const w = Math.max(20, Math.floor(width));
      const inner = w - 4;
      const l = layout();
      const clip = (str: string) => {
        const safe = truncate(str, inner, "");
        return safe + " ".repeat(Math.max(0, inner - visibleWidth(safe)));
      };
      const border = (a: string, b: string) => theme.fg("border", a + "─".repeat(w - 2) + b);
      const row = (text: string) => theme.fg("border", "│ ") + clip(text) + theme.fg("border", " │");
      const lines = [
        border("╭", "╮"),
        row(theme.fg("accent", options.title)),
        row(theme.fg("muted", "Search: " + (query || "type to filter") +
          "  ·  " + l.matching + "/" + options.items.length + " matches")),
      ];
      if (reviewHeight(tui.terminal.rows) >= 10)
        lines.push(row(theme.fg("muted", "Showing " + l.start + "–" + l.end + " / " + l.total +
          (actions.length ? " · actions at end" : ""))));
      const all = results();
      for (let i = 0; i < viewport; i++) {
        const index = scroll + i;
        const item = all[index];
        lines.push(row(item
          ? (selected === index ? theme.fg("accent", "▶ ") : "  ") +
            (index >= l.matching ? theme.fg("accent", "◆ ") : "") + item.label
          : ""));
      }
      lines.push(row(theme.fg("muted", "↑↓ · PgUp/PgDn · Home/End · Enter · Type search · ⌫ · Ctrl+U · Esc")));
      lines.push(border("╰", "╯"));
      return lines.map(line => truncate(line, w, ""));
    },
    handleInput(data: string) {
      if (keys(data, "escape") || keys(data, "ctrl+c")) { done(undefined); return; }
      const all = results();
      if (keys(data, "enter")) {
        if (all.length) done({ id: all[selected].id, query });
        return;
      }
      if (keys(data, "backspace")) {
        query = Array.from(query).slice(0, -1).join("");
        selected = 0; scroll = 0; repaint(); return;
      }
      if (keys(data, "ctrl+u")) {
        query = ""; selected = 0; scroll = 0; repaint(); return;
      }
      const delta = keys(data, "up") ? -1 : keys(data, "down") ? 1 :
        keys(data, "pageup") ? -viewport : keys(data, "pagedown") ? viewport : 0;
      if (delta || keys(data, "home") || keys(data, "end")) {
        selected = keys(data, "home") ? 0 : keys(data, "end") ? Math.max(0, all.length - 1)
          : Math.max(0, Math.min(all.length - 1, selected + delta));
        repaint(); return;
      }
      // Paste and Unicode are allowed, but terminal control sequences are never treated as search text.
      if (typeof data === "string" && data.length > 0 && data.length <= 128 &&
          !/[\x00-\x1f\x7f]/u.test(data) && query.length + data.length <= 128) {
        query += data;
        selected = 0; scroll = 0; repaint();
      }
    },
    invalidate() {},
  };
}
async function defaultLibs(): Promise<Libs> {
  const tui = await import("@earendil-works/pi-tui");
  return { truncateToWidth: tui.truncateToWidth, visibleWidth: tui.visibleWidth,
    matchesKey: tui.matchesKey, Key: tui.Key };
}
export async function chooseList(
  ctx: { mode?: string; ui: UI },
  options: PickerOptions,
  load: () => Promise<Libs> = defaultLibs,
): Promise<PickerChoice | undefined> {
  const ids = [...options.items, ...(options.actions ?? [])].map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("List picker requires unique item IDs");
  if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    try {
      const lib = await load();
      return await ctx.ui.custom((tui: any, theme: Theme, _keys: unknown,
        done: (value: PickerChoice | undefined) => void) => createListPickerComponent(
          options, tui, theme,
          (data, name) => {
            const key = name === "pageup" ? lib.Key.pageUp :
              name === "pagedown" ? lib.Key.pageDown :
              name === "ctrl+c" ? lib.Key.ctrl("c") :
              name === "ctrl+u" ? lib.Key.ctrl("u") : name;
            return lib.matchesKey(data, key);
          },
          lib.truncateToWidth, lib.visibleWidth, done,
        ), { overlay: true, overlayOptions: {
          anchor: "center", width: "96%", maxHeight: "90%", margin: 1,
        }});
    } catch {
      // Older Pi builds: use native pagination. Never silently drop entries.
    }
  }
  let query = options.initialQuery ?? "";
  let page = 0;
  const pageSize = Math.max(3, Math.min(options.pageSize ?? 9, 15));
  while (true) {
    const matched = matchedItems(options.items, query);
    const maxPage = Math.max(0, Math.ceil(matched.length / pageSize) - 1);
    page = Math.min(page, maxPage);
    const visible = matched.slice(page * pageSize, (page + 1) * pageSize);
    if (!options.actions?.length && !query && matched.length <= pageSize) {
      const picked = await ctx.ui.select(options.title, visible.map(v => v.label));
      const item = visible.find(v => v.label === picked);
      return item ? { id: item.id, query } : undefined;
    }
    const menu = [
      ...visible.map((v, index) => (page * pageSize + index + 1) + ". " + v.label),
      ...(page > 0 ? ["◀ Previous page"] : []),
      ...((page < maxPage) ? ["Next page ▶"] : []),
      ...(options.actions ?? []).map(v => "◆ " + v.label),
      "Filter: " + (query || "all"),
      "Back",
    ];
    const selectedLabel = await ctx.ui.select(options.title + " · " +
      (matched.length ? page * pageSize + 1 : 0) + "–" +
      Math.min(matched.length, (page + 1) * pageSize) + "/" + matched.length, menu);
    if (!selectedLabel || selectedLabel === "Back") return;
    if (selectedLabel === "Next page ▶") { page++; continue; }
    if (selectedLabel === "◀ Previous page") { page--; continue; }
    if (selectedLabel.startsWith("Filter: ")) {
      if (!ctx.ui.input) continue;
      const next = await ctx.ui.input("Filter items (empty for all)", query);
      if (next !== undefined) { query = next; page = 0; }
      continue;
    }
    const action = (options.actions ?? []).find(v => "◆ " + v.label === selectedLabel);
    if (action) return { id: action.id, query };
    const item = visible.find((v, i) => selectedLabel === (page * pageSize + i + 1) + ". " + v.label);
    if (item) return { id: item.id, query };
  }
}
export async function chooseListOption(
  ctx: {mode?:string;ui:UI}, title: string, labels: readonly string[],
): Promise<string | undefined> {
  // Preserve the native experience for small menus, including mock/legacy Pi clients.
  if (labels.length <= 12) return ctx.ui.select(title, [...labels]);
  const picked = await chooseList(ctx, {title, items: labels.map((label,i)=>({id:String(i),label}))});
  return picked ? labels[Number(picked.id)] : undefined;
}
