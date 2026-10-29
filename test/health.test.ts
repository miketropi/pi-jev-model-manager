import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelHealth, classifyModelFailure, DEFAULT_HEALTH, normalizeHealthSettings } from "../health.ts";

const settings = { ...DEFAULT_HEALTH, cooldownSeconds: 30, maxCooldownSeconds: 120 };

test("provider outage and rate limiting are recoverable", () => {
  assert.equal(classifyModelFailure("error", "HTTP 503 Service Unavailable"), "unavailable");
  assert.equal(classifyModelFailure("error", "Antigravity is down"), "unavailable");
  assert.equal(classifyModelFailure("error", "HTTP 429 rate limit exceeded"), "rate_limit");
  assert.equal(classifyModelFailure("error", "upstream timed out"), "timeout");
  assert.equal(classifyModelFailure("error", "fetch failed: ECONNRESET"), "network");
  assert.equal(classifyModelFailure("error", "HTTP 401 unauthorized"), "auth");
  assert.equal(classifyModelFailure("error", "model not found"), "missing");
});
test("never quarantine expected context errors or user abort", () => {
  assert.equal(classifyModelFailure("error", "maximum context length exceeded"), undefined);
  assert.equal(classifyModelFailure("aborted", "HTTP 503"), undefined);
  assert.equal(classifyModelFailure("error", "user cancelled"), undefined);
  assert.equal(classifyModelFailure("error", "schema validation failed"), undefined);
  assert.equal(classifyModelFailure("stop", "HTTP 429"), undefined);
});
test("initial health is unknown and routable", () => {
  const health = new ModelHealth();
  assert.equal(health.status("p/a").status, "unknown");
  assert.equal(health.isEligible("p/a", settings), true);
});
test("quarantine a failing model without blocking unrelated models", () => {
  const health = new ModelHealth();
  assert.equal(health.reportFailure("antigravity/model", "error", "503 Service Unavailable", settings, 1000), "unavailable");
  assert.equal(health.isEligible("antigravity/model", settings, 1001), false);
  assert.equal(health.isEligible("jev-9router/other", settings, 1001), true);
  assert.equal(health.status("antigravity/model", 1001).remainingSeconds, 30);
});
test("cooldown automatically expires and reports ready_to_retry", () => {
  const health = new ModelHealth();
  health.reportFailure("p/a", "error", "429", settings, 20000);
  assert.equal(health.isEligible("p/a", settings, 49999), false);
  assert.equal(health.isEligible("p/a", settings, 50000), true);
  assert.equal(health.status("p/a", 50000).status, "ready_to_retry");
});
test("consecutive errors back off exponentially with upper bound", () => {
  const health = new ModelHealth();
  const errors = [1000, 35000, 97000, 220000, 360000];
  for (const t of errors) health.reportFailure("p/a", "error", "HTTP 503", settings, t);
  const result = health.status("p/a", 360000);
  assert.equal(result.consecutiveFailures, 5);
  assert.equal(result.blockedUntil, 480000);
});
test("duplicate error observations from message_end and retry count once", () => {
  const health = new ModelHealth();
  health.reportFailure("p/a", "error", "429", settings, 10000);
  health.reportFailure("p/a", "error", "429", settings, 10010);
  assert.equal(health.status("p/a", 10010).consecutiveFailures, 1);
});
test("successful response restores health and resets the breaker", () => {
  const health = new ModelHealth();
  health.reportFailure("p/a", "error", "HTTP 503", settings, 10000);
  health.reportSuccess("p/a", 12000);
  assert.equal(health.isEligible("p/a", settings, 12001), true);
  assert.equal(health.status("p/a", 12001).status, "healthy");
  assert.equal(health.status("p/a", 12001).consecutiveFailures, 0);
});
test("monitoring OFF never excludes models", () => {
  const health = new ModelHealth();
  health.reportFailure("p/a", "error", "HTTP 503", settings, 10000);
  assert.equal(health.isEligible("p/a", { ...settings, enabled: false }, 10001), true);
});
test("reset clears status and unblocks all", () => {
  const health = new ModelHealth();
  health.reportFailure("p/a", "error", "HTTP 503", settings, 10000);
  health.reportFailure("p/b", "error", "429", settings, 10000);
  health.reset("p/a");
  assert.equal(health.status("p/a").status, "unknown");
  assert.equal(health.status("p/b", 10001).status, "cooldown");
  health.reset();
  assert.equal(health.status("p/b").status, "unknown");
});
test("safe settings normalization handles old configs and bad intervals", () => {
  assert.deepEqual(normalizeHealthSettings(undefined), DEFAULT_HEALTH);
  assert.equal(normalizeHealthSettings({ enabled: false, autoFailover: false }).enabled, false);
  assert.equal(normalizeHealthSettings({ cooldownSeconds: 0 }).cooldownSeconds, 90);
  const policy = normalizeHealthSettings({ cooldownSeconds: 200, maxCooldownSeconds: 10 });
  assert.equal(policy.maxCooldownSeconds, 200);
});
