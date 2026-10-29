import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Pi retries fail over after provider outage and keep tool continuations sticky", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-health-extension-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const models = ["fast","strong","backup"].map(id => ({
    key: "test/" + id, label: id, enabled: true, specialty: id, avoid: "",
    cost: "balanced", thinking: "medium",
  }));
  const config = {
    version: 1, enabled: true, mode: "auto", minProbability: 0.43, fallback: "test/fast",
    classifier: { provider: "typesafe", model: "jev-latest" },
    nineRouter: { baseUrl: "http://127.0.0.1:20128/v1", apiKeyEnv: "NINEROUTER_API_KEY" },
    models, subagentRouting: true,
  };
  let route!: (request: any, ctx: any) => Promise<any>;
  const handlers: Record<string, Function> = {};
  const commands: Record<string, any> = {};
  const catalog = models.map(m => ({ provider: "test", id: m.key.slice(5), api: "openai-completions" }));
  let pickFirst = false;
  const ctx: any = {
    hasUI: false, scopedModels: [], ui: { setStatus() {}, notify() {} },
    modelRegistry: {
      getAvailable: () => catalog,
      find: (p: string, id: string) => catalog.find(x => x.provider === p && x.id === id),
      findOfType: () => ({ id: "jev-latest" }),
      classify: async () => ({ stopReason: "stop", answers: {
        task: { type: "choice", choice: "implement", probabilities: { implement: 0.99 } },
        selected_model: { type: "choice", choice: pickFirst ? "m0" : "m1", probabilities: { m0: 0.99, m1: 0.99 } },
      }}),
    },
  };
  try {
    writeFileSync(join(dir, "jev-model-manager.json"), JSON.stringify(config));
    const { default: extension } = await import("../index.ts");
    extension({
      registerProvider() {}, unregisterProvider() {}, registerCommand(name: string, cmd: any) { commands[name] = cmd; },
      registerVirtualModel: (model: any) => { route = model.route; },
      on: (name: string, handler: Function) => { handlers[name] = handler; },
    } as any);
    assert.equal(typeof handlers.message_end, "function");
    const chosen = await route({ reason: "user", messages: [{ role: "user", content: "Implement a feature" }] }, ctx);
    assert.equal(chosen.model.id, "strong");
    assert.deepEqual(chosen.state.attempted, ["test/strong"]);
    await handlers.message_end({ message: {
      role: "assistant", provider: "test", model: "strong",
      stopReason: "error", errorMessage: "503 Service Unavailable (Antigravity offline)",
    }}, ctx);
    const firstRetry = await route({ reason: "retry",
      failed: { model: chosen.model, thinkingLevel: "medium", message: { stopReason: "error", errorMessage: "503 Service Unavailable" } },
      state: chosen.state,
    }, ctx);
    assert.equal(firstRetry.model.id, "fast", "prefer configured healthy fallback on outage");
    assert.deepEqual(firstRetry.state.attempted, ["test/strong", "test/fast"]);
    const secondRetry = await route({ reason: "retry",
      failed: { model: firstRetry.model, thinkingLevel: "medium", message: { stopReason: "error", errorMessage: "HTTP 429 rate limit" } },
      state: firstRetry.state,
    }, ctx);
    assert.equal(secondRetry.model.id, "backup", "do not ping-pong between failed models");
    const nextUser = await route({ reason: "user", messages: [{ role: "user", content: "Implement another feature" }] }, ctx);
    assert.notEqual(nextUser.model.id, "strong", "exclude down model from new choices");
    const sticky = await route({ reason: "continuation", previous: { model: firstRetry.model, thinkingLevel: "medium" } }, ctx);
    assert.equal(sticky.model.id, "fast", "never switch on tool continuation");
    const sub: any = { agent: "builder", task: "Implement a module" };
    await handlers.tool_call({ toolName: "agent_spawn", input: sub }, ctx);
    assert.equal(sub.model, "test/backup", "subagent excludes unhealthy alternatives");
    await handlers.message_end({ message: {
      role: "assistant", provider: "test", model: "strong",
      stopReason: "stop",
    }}, ctx);
    pickFirst = true;
    const restored = await route({ reason: "user", messages: [{ role: "user", content: "Implement new feature" }] }, ctx);
    assert.equal(restored.model.id, "strong", "real successful provider response restores health");
    assert.equal(typeof commands["jev-health"]?.handler, "function");
    let probes = 0;
    let notices: string[] = [];
    let menuCalls = 0;
    ctx.modelRegistry.complete = async (m: any, prompt: any, options: any) => {
      probes++;
      assert.equal(m.id, "strong");
      assert.equal(prompt.messages[0].content[0].text, "Reply OK.");
      assert.equal(options.maxTokens, 8);
      return { stopReason: "stop" };
    };
    await commands["jev-health"].handler("", {
      ...ctx, hasUI: true,
      ui: {
        setStatus() {},
        notify: (message: string) => notices.push(message),
        input: async () => "strong",
        confirm: async () => true,
        select: async (title: string, options: string[]) => {
          if (title === "Jev · Model health & failover") return menuCalls++ === 0 ? "Test one model now (uses a few tokens)" : "Back";
          if (title.startsWith("Run live model check")) return "test/strong";
          throw new Error("Unexpected menu " + title);
        },
      },
    });
    assert.equal(probes, 1);
    assert.ok(notices.some(x => x.includes("responded successfully")));
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
