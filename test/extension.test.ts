import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("/jev-scan imports a proxy model as a usable Pi provider and preserves its policy on rescan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-jev-models-test-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldKey = process.env.NINEROUTER_API_KEY;
  const oldUrl = process.env.NINEROUTER_BASE_URL;
  const oldFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.NINEROUTER_API_KEY = "test-key";
  process.env.NINEROUTER_BASE_URL = "https://custom-gateway.example/api";
  let pass = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    assert.equal(url, "https://custom-gateway.example/api/v1/models");
    pass++;
    return new Response(JSON.stringify({ data: [
      { id: "cc/claude-sonnet-4-6", name: pass === 1 ? "Claude Test" : "Renamed upstream", context_window: 200000, max_tokens: 16000 },
    ] }), { status: 200 });
  }) as typeof fetch;

  try {
    // Import after the temp config path is known.
    const { default: extension } = await import("../index.ts");
    const providers: Record<string, any> = {};
    const commands: Record<string, any> = {};
    extension({
      registerProvider: (name: string, config: unknown) => { providers[name] = config; },
      unregisterProvider: (name: string) => { delete providers[name]; },
      registerVirtualModel: () => {},
      registerCommand: (name: string, command: unknown) => { commands[name] = command; },
    } as any);

    let selections = 0;
    const ctx = {
      hasUI: true,
      ui: {
        select: async (prompt: string, options: string[]) => {
          if (prompt.startsWith("Manage ")) return "Back";
          if (prompt.startsWith("9Router ·")) {
            selections++;
            return selections === 1 ? options.find((x) => x.startsWith("+ cc/")) : "Back";
          }
          throw new Error(`Unexpected menu: ${prompt}`);
        },
        input: async () => undefined,
        editor: async () => undefined,
        confirm: async () => false,
        notify: () => {},
      },
    };
    await commands["jev-scan"].handler("", ctx);
    const savedPath = join(dir, "jev-model-manager.json");
    const first = JSON.parse(readFileSync(savedPath, "utf8"));
    assert.equal(first.models.length, 1);
    assert.equal(first.models[0].key, "jev-9router/cc/claude-sonnet-4-6");
    assert.equal(first.models[0].contextWindow, 200000);
    assert.equal(first.models[0].reasoning, false);
    assert.match(first.models[0].specialty,/Production coding/);
    assert.match(first.models[0].avoid,/trivial/);
    assert.equal(first.fallback, "jev-9router/cc/claude-sonnet-4-6");
    assert.equal(providers["jev-9router"].models[0].id, "cc/claude-sonnet-4-6");
    assert.equal(providers["jev-9router"].baseUrl, "https://custom-gateway.example/api/v1");
    assert.equal(first.nineRouter.baseUrl, "http://127.0.0.1:20128/v1"); // override does not get persisted
    assert.equal(providers["jev-9router"].apiKey, "$NINEROUTER_API_KEY");
    assert.equal(providers["jev-9router"].api, "openai-completions");
    assert.equal(JSON.stringify(first).includes("test-key"), false);

    first.models[0].specialty = "User-defined security review policy";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(savedPath, JSON.stringify(first));
    selections = 0;
    await commands["jev-scan"].handler("", {
      ...ctx,
      ui: {
        ...ctx.ui,
        select: async () => "Back", // Scan only, no new import
      },
    });
    const afterRescan = JSON.parse(readFileSync(savedPath, "utf8"));
    assert.equal(afterRescan.models[0].specialty, "User-defined security review policy");
    assert.equal(afterRescan.models.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldKey === undefined) delete process.env.NINEROUTER_API_KEY;
    else process.env.NINEROUTER_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.NINEROUTER_BASE_URL;
    else process.env.NINEROUTER_BASE_URL = oldUrl;
    rmSync(dir, { recursive: true, force: true });
  }
});
