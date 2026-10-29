import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialSource, readSecrets, resolveSecret, secretFilePath, writeSecrets } from "../secrets.ts";
import { maskedInput, normalizeSecretInput } from "../config-ui.ts";

test("secure local store enforces 0600, supports rotation and env priority", () => {
  const home = mkdtempSync(join(tmpdir(), "jev-keys-"));
  const path = join(home, "jev-model-manager.secrets.json");
  try {
    writeSecrets({ nineRouter: "local-router-key", jev: "local-jev-key" }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readSecrets(path).jev, "local-jev-key");
    assert.equal(credentialSource("nineRouter", "NINEROUTER_API_KEY", {}, { nineRouter: "saved" }), "stored");
    assert.equal(resolveSecret("nineRouter", "NINEROUTER_API_KEY", { NINEROUTER_API_KEY: "env" }, { nineRouter: "saved" }), "env");
    assert.equal(credentialSource("jev", "TYPESAFE_API_KEY", { TYPESAFE_API_KEY: "env" }, { jev: "saved" }), "env");
    assert.equal(resolveSecret("jev", "TYPESAFE_API_KEY", {}, { jev: "saved" }), "saved");
    writeSecrets({ nineRouter: "rotated" }, path);
    assert.equal(readSecrets(path).nineRouter, "rotated");
    assert.equal(readSecrets(path).jev, undefined);
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      assert.throws(() => readSecrets(path), /chmod 600/);
      assert.throws(() => writeSecrets({ nineRouter: "unsafe" }, path), /chmod 600/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("masked input never displays the credential and supports editing and cancel", async () => {
  const rendered: string[][] = [];
  const secret = await maskedInput({
    mode: "tui",
    ui: { custom: async (factory: any) => {
      let answer: string | undefined;
      const widget = factory({requestRender: () => {}}, {fg: (_name: string, text: string) => text},
        {matches: (data: string, key: string) => (key === "tui.select.confirm" && data === "\r") || (key === "tui.select.cancel" && data === "\x1b")},
        (result: string | undefined) => { answer = result; });
      widget.handleInput("some-super-secret");
      rendered.push(widget.render(120));
      widget.handleInput("\x7f");
      widget.handleInput("!");
      widget.handleInput("\r");
      return answer;
    } },
  } as any, "API token");
  assert.equal(secret, "some-super-secre!");
  assert.equal(rendered.flat().join(" ").includes("some-super-secret"), false);
  const noRpc = await maskedInput({mode: "rpc", ui: {notify() {}, custom() { throw Error("should not call"); }}} as any,"key");
  assert.equal(noRpc, undefined);
});

test("terminal Cmd+V bracketed paste accepts long keys without displaying them", async () => {
  const pastedKey = "sk-" + "Ab3_".repeat(150);
  let renders: string[][] = [];
  const result = await maskedInput({
    mode: "tui",
    ui: { custom: async (factory: any) => {
      let submitted: string | undefined;
      const widget = factory({ requestRender() {} }, { fg: (_color: string, v: string) => v },
        { matches: (data: string, key: string) => (key === "tui.select.confirm" && data === "\r") || (key === "tui.select.cancel" && data === "\x1b") },
        (answer: string | undefined) => { submitted = answer; });
      // Mirrors Pi's real stdin buffering: a bracketed paste can arrive in chunks.
      widget.handleInput("\x1b[200~" + pastedKey.slice(0, 80));
      widget.handleInput(pastedKey.slice(80) + "\n\x1b[201~");
      renders.push(widget.render(100));
      widget.handleInput("\r");
      return submitted;
    } },
  } as any, "Paste API key");
  assert.equal(result, pastedKey);
  assert.ok(!renders.flat().join(" ").includes(pastedKey));
  assert.ok(!renders.flat().join(" ").includes(pastedKey.slice(0, 32)));
});

test("Ctrl+V clipboard paste stays masked and cancel cannot save a pending paste", async () => {
  const key = "proxy-test-key-" + "xyz".repeat(50);
  let release!: (text: string) => void;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  const testHarness = async (factory: any, events: string[], onInput?: (widget: any) => void) => {
    let submitted: string | undefined;
    const widget = factory({ requestRender() {} }, { fg: (_color: string, v: string) => v },
      { matches: (data: string, name: string) => (name === "tui.select.confirm" && data === "\r") || (name === "tui.select.cancel" && data === "\x1b") },
      (answer: string | undefined) => { submitted = answer; });
    for (const event of events) widget.handleInput(event);
    onInput?.(widget);
    await new Promise((r) => setImmediate(r));
    return { widget, get submitted() { return submitted; } };
  };
  let output: string[] = [];
  const result = await maskedInput({ mode: "tui", ui: { custom: async (factory: any) => {
    const h = await testHarness(factory, ["\x16"]);
    // Paste completion is asynchronous; no value exposed while loading.
    assert.equal(h.submitted, undefined);
    release(key);
    await new Promise((r) => setImmediate(r));
    output = h.widget.render(120);
    h.widget.handleInput("\r");
    return h.submitted;
  } } } as any, "Secret", () => pending);
  assert.equal(result, key);
  assert.ok(!output.join(" ").includes(key));

  let canceled: string | undefined = "not-finished";
  await maskedInput({ mode: "tui", ui: { custom: async (factory: any) => {
    const h = await testHarness(factory, ["\x16", "\x1b"]);
    canceled = h.submitted;
    return h.submitted;
  } } } as any, "Secret", async () => key);
  assert.equal(canceled, undefined);
});

test("invalid pasted multiline, blank and oversized clipboard values are rejected", async () => {
  assert.throws(() => normalizeSecretInput("line1\nline2"), /single-line/);
  assert.throws(() => normalizeSecretInput("   "), /single-line/);
  assert.throws(() => normalizeSecretInput("a".repeat(8193)), /maximum/);
  assert.equal(normalizeSecretInput("  sk-sample-key\n"), "sk-sample-key");
  const sent = "\x1b[200~first\nsecond\x1b[201~";
  let status: string[] = [];
  const result = await maskedInput({ mode: "tui", ui: { custom: async (factory: any) => {
    let submitted: string | undefined;
    const widget = factory({ requestRender() {} }, { fg: (_color: string, v: string) => v },
      { matches: (data: string, name: string) => (name === "tui.select.confirm" && data === "\r") || (name === "tui.select.cancel" && data === "\x1b") },
      (answer: string | undefined) => { submitted = answer; });
    widget.handleInput(sent);
    status = widget.render(120);
    widget.handleInput("\x1b");
    return submitted;
  } } } as any, "Secret");
  assert.equal(result, undefined);
  assert.ok(status.join(" ").includes("single-line"));
  assert.ok(!status.join(" ").includes("first"));
});

test("/jev-config saves credentials separately from policy and registers TypeSafe provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-config-flow-"));
  const original = {
    dir: process.env.PI_CODING_AGENT_DIR,
    key9: process.env.NINEROUTER_API_KEY,
    keyJ: process.env.TYPESAFE_API_KEY,
    url: process.env.NINEROUTER_BASE_URL,
  };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.NINEROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.NINEROUTER_BASE_URL;
  try {
    const { default: extension } = await import("../index.ts");
    const commands: Record<string, any> = {};
    const providers: Record<string, any> = {};
    extension({
      registerProvider: (name: string, def: any) => { providers[name] = def; },
      unregisterProvider: (name: string) => { delete providers[name]; },
      registerVirtualModel() {},
      registerCommand: (name: string, handler: any) => { commands[name] = handler; },
    } as any);
    assert.ok(commands["jev-config"]);
    let n = 0;
    const steps = ["9Router endpoint:", "9Router key:", "Set / replace securely", "Jev key:", "Set / replace securely", "Routing & classifier options", "Enabled:", "Back", "Done"];
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        select: async (_title: string, options: string[]) => {
          const wanted = steps[n++];
          const chosen = options.find((s) => s.startsWith(wanted));
          if (wanted === "Set / replace securely") {
            assert.ok(options.includes("Paste from system clipboard"), "Clipboard fallback missing from key settings");
          }
          assert.ok(chosen, `Expected choice ${wanted} in ${options.join(", ")}`);
          return chosen;
        },
        input: async () => "https://router.example/v1",
        custom: async (_factory: any) => n < 4 ? "my-private-router-key" : "my-private-jev-key",
        notify() {},
        confirm: async () => true,
      },
    };
    await commands["jev-config"].handler("", ctx);
    const policy = readFileSync(join(dir,"jev-model-manager.json"), "utf8");
    assert.ok(!policy.includes("my-private-router-key") && !policy.includes("my-private-jev-key"));
    assert.equal(JSON.parse(policy).nineRouter.baseUrl, "https://router.example/v1");
    assert.equal(JSON.parse(policy).enabled, true);
    const secrets = readSecrets(secretFilePath());
    assert.equal(secrets.nineRouter, "my-private-router-key");
    assert.equal(secrets.jev, "my-private-jev-key");
    assert.equal(providers.typesafe.apiKey, "my-private-jev-key");
  } finally {
    if (original.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original.dir;
    if (original.key9 === undefined) delete process.env.NINEROUTER_API_KEY; else process.env.NINEROUTER_API_KEY = original.key9;
    if (original.keyJ === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = original.keyJ;
    if (original.url === undefined) delete process.env.NINEROUTER_BASE_URL; else process.env.NINEROUTER_BASE_URL = original.url;
    rmSync(dir, {recursive:true, force:true});
  }
});
