import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Jev only routes after /jev-on activates virtual model; blog prompts use write task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-activation-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const physical = ["fast", "writer"].map(id => ({ provider: "test", id, api: "openai-completions" }));
  const virtual = { provider: "jev-manager", id: "auto", api: "pi-virtual" };
  const configured = {
    version: 1, enabled: true, mode: "auto",
    classifier: { provider: "typesafe", model: "jev-latest" },
    nineRouter: { baseUrl: "http://127.0.0.1:20128/v1", apiKeyEnv: "NINEROUTER_API_KEY" },
    fallback: "test/fast", minProbability: 0.43,
    models: physical.map(m => ({ key: "test/" + m.id, label: m.id, enabled: true,
      specialty: "general", avoid: "", cost: "balanced", thinking: "medium" })),
    taskRules: { write: { mode: "force", model: "test/writer" } },
  };
  const commands: Record<string, any> = {};
  const handlers: Record<string, Function> = {};
  const notices: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  let selected: any = physical[0];
  let route: Function;
  let switches = 0;
  const ctx: any = {
    mode: "tui", hasUI: true, scopedModels: [],
    get model() { return selected; },
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus() {},
      setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
    },
    modelRegistry: {
      getAvailable: () => [...physical],
      find: (provider: string, id: string) =>
        provider === "jev-manager" && id === "auto" ? virtual :
        physical.find(m => m.provider === provider && m.id === id),
      findOfType: () => ({ id: "jev-latest" }),
      classify: async () => ({ stopReason: "stop", answers: {
        task: { type: "choice", choice: "write", probabilities: { write: 0.98 } },
        selected_model: { type: "choice", choice: "m0", probabilities: { m0: 0.96 } },
      }}),
    },
  };
  try {
    writeFileSync(join(dir, "jev-model-manager.json"), JSON.stringify(configured));
    const { default: ext } = await import("../index.ts");
    const pi: any = {
      registerProvider() {}, unregisterProvider() {},
      registerCommand: (name: string, cmd: any) => { commands[name] = cmd; },
      registerVirtualModel: (v: any) => { route = v.route; },
      on: (name: string, cb: Function) => { handlers[name] = cb; },
      setModel: async (model: any) => {
        switches++;
        const old = selected;
        selected = model;
        await handlers.model_select({ model, previousModel: old, source: "set" }, ctx);
        return true;
      },
    };
    ext(pi);
    await handlers.session_start({ reason: "startup" }, ctx);
    assert.equal(switches, 0, "loading Jev never overrides Pi's selected model");
    assert.ok(widgets.at(-1)?.join("\n").includes("STANDBY"));
    assert.ok(widgets.at(-1)?.join("\n").includes("/jev-on"));
    assert.ok(notices.some(n => n.includes("INACTIVE")));
    await commands["jev-status"].handler("", ctx);
    assert.ok(notices.at(-1)?.includes("INACTIVE"));
    await commands["jev-on"].handler("", ctx);
    assert.equal(switches, 1);
    assert.equal(selected.id, "auto");
    assert.equal(JSON.parse(readFileSync(join(dir, "jev-model-manager.json"),"utf8")).enabled, true);
    assert.ok(widgets.at(-1)?.join("\n").includes("READY"));
    await commands["jev-status"].handler("", ctx);
    assert.ok(notices.at(-1)?.includes("routing ACTIVE"));
    const decision = await route!({ reason: "user",
      messages: [{ role: "user", content: "Plan gen một bài blog nói về lỗi php vừa rồi" }] }, ctx);
    assert.equal(decision.model.id, "writer");
    assert.equal(decision.state.last.task, "write");
    const old = selected;
    selected = physical[0];
    await handlers.model_select({ model: selected, previousModel: old, source: "set" }, ctx);
    await commands["jev-status"].handler("", ctx);
    assert.ok(notices.at(-1)?.includes("INACTIVE"));
    assert.ok(widgets.at(-1)?.join("\n").includes("STANDBY"));
    const disabledConfig = { ...configured, models: [], enabled: false };
    writeFileSync(join(dir, "jev-model-manager.json"), JSON.stringify(disabledConfig));
    await commands["jev-on"].handler("", ctx);
    assert.equal(switches, 1, "must never switch without eligible physical models");
    assert.ok(notices.at(-1)?.includes("no enabled/authenticated models"));
    const refused = { ...configured, enabled: false };
    writeFileSync(join(dir, "jev-model-manager.json"), JSON.stringify(refused));
    pi.setModel = async () => false;
    await commands["jev-on"].handler("", ctx);
    assert.equal(JSON.parse(readFileSync(join(dir, "jev-model-manager.json"), "utf8")).enabled, false,
      "must not persist routing=ON if Pi rejects model selection");
    assert.ok(notices.at(-1)?.includes("refused"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
