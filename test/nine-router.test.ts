import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNineRouterBaseUrl,
  scanNineRouter,
  validateEnvName,
} from "../nine-router.ts";

const settings = { baseUrl: "http://localhost:20128/v1", apiKeyEnv: "NINEROUTER_TEST_KEY" };

test("normalizes root URL, /v1 URL, and /v1/models", () => {
  assert.equal(normalizeNineRouterBaseUrl("http://localhost:20128"), "http://localhost:20128/v1");
  assert.equal(normalizeNineRouterBaseUrl("https://gateway.example/proxy/v1/"), "https://gateway.example/proxy/v1");
  assert.equal(normalizeNineRouterBaseUrl("https://gateway.example/v1/models"), "https://gateway.example/v1");
  assert.throws(() => normalizeNineRouterBaseUrl("https://user:pass@example.com/v1"), /credentials/);
  assert.throws(() => normalizeNineRouterBaseUrl("file:///etc/passwd"), /HTTP/);
  assert.throws(() => normalizeNineRouterBaseUrl("https://gateway.example/v1?token=secret"), /credentials/);
});

test("rejects invalid key variable names", () => {
  assert.equal(validateEnvName(" NINEROUTER_API_KEY "), "NINEROUTER_API_KEY");
  assert.throws(() => validateEnvName("bad-key"), /valid name/);
});

test("scan includes prefixed model IDs, filters invalid IDs, removes duplicates and never discloses key", async () => {
  process.env.NINEROUTER_TEST_KEY = "super-secret";
  let called = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    called = true;
    assert.equal(input, "http://localhost:20128/v1/models");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer super-secret");
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({ data: [
      { id: "cc/claude-opus", name: "Claude Opus", context_window: 200000, max_tokens: 8192 },
      { id: "cx/deepseek-chat", context_length: 64000 },
      { id: "cc/claude-opus", name: "dupe" },
      { id: " with whitespace " },
      { id: null },
    ] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const models = await scanNineRouter(settings, fetcher);
  assert.equal(called, true);
  assert.deepEqual(models, [
    { id: "cc/claude-opus", name: "Claude Opus", contextWindow: 200000, maxTokens: 8192 },
    { id: "cx/deepseek-chat", name: "cx/deepseek-chat", contextWindow: 64000 },
  ]);
});

test("missing key, unauthorized response, and invalid JSON fail safely", async () => {
  delete process.env.NINEROUTER_TEST_KEY;
  await assert.rejects(() => scanNineRouter(settings, fetch), /Missing NINEROUTER_TEST_KEY/);
  process.env.NINEROUTER_TEST_KEY = "secret";
  await assert.rejects(() => scanNineRouter(settings, (async () => new Response("unauthorized", { status: 401 })) as typeof fetch), /HTTP 401/);
  await assert.rejects(() => scanNineRouter(settings, (async () => new Response("<html>nope</html>")) as typeof fetch), /did not return JSON/);
  await assert.rejects(() => scanNineRouter(settings, (async () => new Response(JSON.stringify({ models: [] }))) as typeof fetch), /data array/);
});
