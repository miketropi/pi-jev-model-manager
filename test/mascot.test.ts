import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  mascotLines, normalizeMascotStyle, cleanMascotText, MASCOT_WIDGET_KEY,
} from "../mascot.ts";

test("Jevling renders an original three-line mascot, compact glyph and disabled view", () => {
  const ready = mascotLines("mascot", { mood: "ready" });
  assert.equal(ready.length, 3);
  assert.match(ready[0], /JEV.*READY/);
  assert.match(ready[1], /•ᴗ•/);
  const recovery = mascotLines("mascot", { mood: "recovery", model: "Test Model" });
  assert.match(recovery[0], /RECOVERING/);
  assert.match(recovery[1], /•﹏•/);
  assert.match(recovery[1], /Test Model/);
  assert.equal(mascotLines("compact", { mood: "routing", task: "implement", model: "DeepSeek" }).length, 1);
  assert.match(mascotLines("compact", { mood: "routing" })[0], /^◇ JEV/);
  assert.deepEqual(mascotLines("off", { mood: "routing" }), []);
});
test("mascot has safe defaults and strips terminal escape/control characters", () => {
  assert.equal(normalizeMascotStyle(undefined), "mascot");
  assert.equal(normalizeMascotStyle("invalid"), "mascot");
  assert.equal(normalizeMascotStyle("off"), "off");
  assert.equal(cleanMascotText("alpha\n\x1b[31munsafe\x1b[0m"), "alpha [31munsafe [0m");
  const giant = "model-" + "a".repeat(200);
  const text = mascotLines("mascot", { mood: "routing", model: giant }).join("\n");
  assert.ok(text.includes("…"));
  assert.ok(!text.includes("a".repeat(80)));
});
test("Pi TUI shows mascot on session start; toggle modes persist, don't replace Pi UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-mascot-test-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const widgets: Array<[string, string[] | undefined]> = [];
  const cmds: Record<string, any> = {};
  const events: Record<string, Function> = {};
  let style = "Compact (1 line)";
  let route: Function;
  try {
    const { default: extension } = await import("../index.ts");
    extension({
      registerProvider() {}, unregisterProvider() {},
      registerCommand(name: string, command: any) { cmds[name] = command; },
      registerVirtualModel(v: any) { route = v.route; },
      on(name: string, cb: Function) { events[name] = cb; },
    } as any);
    const ctx: any = {
      mode: "tui", hasUI: true, scopedModels: [],
      ui: {
        setWidget(key: string, lines: string[] | undefined) { widgets.push([key, lines]); },
        select: async () => style,
        notify() {}, setStatus() {},
      },
    };
    await events.session_start({}, ctx);
    assert.equal(widgets.at(-1)?.[0], MASCOT_WIDGET_KEY);
    assert.equal(widgets.at(-1)?.[1]?.length, 3);
    await cmds["jev-mascot"].handler("", ctx);
    assert.equal(widgets.at(-1)?.[1]?.length, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, "jev-model-manager.json"), "utf8")).mascot, "compact");
    style = "Off (hidden)";
    await cmds["jev-mascot"].handler("", ctx);
    assert.equal(widgets.at(-1)?.[1], undefined);
    style = "Mascot (3 lines)";
    await cmds["jev-mascot"].handler("", ctx);
    assert.equal(widgets.at(-1)?.[1]?.length, 3);
    style = "Robot animation: ON";
    await cmds["jev-mascot"].handler("", ctx);
    const current = JSON.parse(readFileSync(join(dir,"jev-model-manager.json"),"utf8"));
    assert.equal(current.robotMotion,false,"motion can be disabled without hiding robot");
    assert.equal(current.mascot,"mascot");
    assert.equal(widgets.at(-1)?.[1]?.length,3);

    const before = widgets.length;
    await events.session_start({}, { ...ctx, mode: "rpc" });
    assert.equal(widgets.length, before, "never draws terminal widget in RPC");
    await events.agent_end({}, ctx);
    assert.match(widgets.at(-1)?.[1]?.[0] ?? "", /STANDBY/);
    assert.equal(typeof route, "function");
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
