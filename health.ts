/**
 * Runtime health tracking for physical Pi models.
 * Never probes endpoints, guesses account quota, or stores credentials.
 */
export type FailureKind = "rate_limit" | "unavailable" | "network" | "timeout" | "auth" | "missing";
export type ModelHealthStatus = "unknown" | "healthy" | "cooldown" | "ready_to_retry";

export interface HealthSettings {
  enabled: boolean;
  autoFailover: boolean;
  cooldownSeconds: number;
  maxCooldownSeconds: number;
}
export interface HealthEntry {
  key: string;
  status: ModelHealthStatus;
  consecutiveFailures: number;
  reason?: FailureKind;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  blockedUntil?: number;
  remainingSeconds: number;
}
interface RecordState {
  consecutiveFailures: number;
  reason?: FailureKind;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  blockedUntil?: number;
}

export const DEFAULT_HEALTH: HealthSettings = {
  enabled: true,
  autoFailover: true,
  cooldownSeconds: 90,
  maxCooldownSeconds: 900,
};
export function normalizeHealthSettings(value: unknown): HealthSettings {
  const x = value && typeof value === "object" ? value as Partial<HealthSettings> : {};
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 5 && v <= 86400 ? v : fallback;
  const cooldownSeconds = num(x.cooldownSeconds, DEFAULT_HEALTH.cooldownSeconds);
  return {
    enabled: x.enabled !== false,
    autoFailover: x.autoFailover !== false,
    cooldownSeconds,
    maxCooldownSeconds: Math.max(cooldownSeconds, num(x.maxCooldownSeconds, DEFAULT_HEALTH.maxCooldownSeconds)),
  };
}
/**
 * Classify only recoverable/provider availability errors.
 * Never quarantine a model for an aborted request, context overflow,
 * generic validation errors, or normal tool failures.
 */
export function classifyModelFailure(
  stopReason: string | undefined,
  message: string | undefined,
): FailureKind | undefined {
  if (stopReason && stopReason !== "error") return;
  if (!message) return;
  const s = message.toLowerCase();
  if (/aborted|user cancelled|user canceled|cancelled by user|canceled by user|context.length|context.window|maximum context|context overflow|too many tokens|exceed.*token limit|compaction/.test(s)) return;
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid.api.key|authentication.failed|permission.denied|forbidden/.test(s)) return "auth";
  if (/\b429\b|rate.limit|quota.exceed|resource.exhaust|too.many.requests/.test(s)) return "rate_limit";
  if (/\b(?:500|502|503|504|521|522|523|524)\b|service.unavailable|upstream.*(?:down|unavailable|error)|provider.*(?:down|unavailable)|overload|temporarily.unavailable|bad.gateway|gateway.timeout|internal.server.error|antigravity.*(?:down|unavailable|offline|error)/.test(s)) return "unavailable";
  if (/\b(?:408|timeout|timed.out|deadline.exceeded|etimedout)\b/.test(s)) return "timeout";
  if (/econnreset|econnrefused|enotfound|ehostunreach|network.error|fetch.failed|connection.refused|connection.reset|connection.error|socket.hang.up|dns/.test(s)) return "network";
  if (/\b404\b.*model|model.*\b404\b|model.not.found|model.*(?:does.not.exist|not.available|not.found|deprecated|no.longer.supported)/.test(s)) return "missing";
}

export type DispatchIssueKind = "parameter" | "context" | "authentication" |
  "rate_limit" | "provider_outage" | "network" | "model_missing" | "unknown";
export interface DispatchIssue {model: string; kind: DispatchIssueKind; action: string; at: number;}
/** Never expose provider error bodies: errors can contain prompts, auth headers or customer data. */
export function describeDispatchIssue(message: string | undefined): Pick<DispatchIssue,"kind"|"action"> {
  const s=(message || "").toLowerCase();
  if (/context[ ._-]*(length|window|size|overflow)|maximum context|input.*too (long|large)|exceed.*context|prompt.*too long/.test(s))
    return {kind:"context",action:"Use /compact, reduce loaded context, or choose a verified larger context window"};
  if (/\b(?:400|422)\b|invalid.parameter|invalid.request|unsupported.*(parameter|thinking|reasoning|max_tokens|max_output_tokens)|max_tokens.*(invalid|exceed|must)|parameter.*(unsupported|invalid)/.test(s))
    return {kind:"parameter",action:"Verify 9Router model context/output limits and reasoning settings in /jev-models"};
  if (/\b(?:401|403)\b|unauthori[sz]ed|invalid.api.key|authentication.failed|permission.denied|forbidden/.test(s))
    return {kind:"authentication",action:"Check provider credentials and permissions"};
  if (/\b429\b|rate.limit|quota.exceed|resource.exhaust/.test(s))
    return {kind:"rate_limit",action:"Check rate limits and quota; use a healthy compatible model"};
  if (/\b(?:500|502|503|504|521|522|523|524)\b|unavailable|overload|upstream.*error/.test(s))
    return {kind:"provider_outage",action:"Check provider status or use a compatible fallback"};
  if (/timeout|timed.out|deadline.exceeded|network|econnreset|econnrefused|enotfound|dns|fetch.failed/.test(s))
    return {kind:"network",action:"Check proxy connectivity and retry when available"};
  if (/\b404\b.*model|model.not.found|model.*does.not.exist/.test(s))
    return {kind:"model_missing",action:"Scan 9Router or update the configured model ID"};
  return {kind:"unknown",action:"Inspect sanitized Pi provider diagnostics and model metadata"};
}

export class ModelHealth {
  private entries = new Map<string, RecordState>();
  private lastIssue?: DispatchIssue;
  private lastError = new Map<string, { reason: FailureKind; at: number }>();

  reportFailure(
    key: string, stopReason: string | undefined, error: string | undefined,
    policy: HealthSettings, now = Date.now(),
  ): FailureKind | undefined {
    if (stopReason === "error" && key) {
      this.lastIssue = {model:key,...describeDispatchIssue(error),at:now};
    }
    const reason = classifyModelFailure(stopReason, error);
    if (!reason || !policy.enabled || !key) return;
    const last = this.lastError.get(key);
    // A failed assistant message is observable via both message_end and retry.
    // Treat same-category reports in a short interval as one failure.
    if (last?.reason === reason && now - last.at >= 0 && now - last.at < 1500) return reason;
    this.lastError.set(key, { reason, at: now });
    const item = this.entries.get(key) ?? { consecutiveFailures: 0 };
    item.consecutiveFailures += 1;
    item.lastFailureAt = now;
    item.reason = reason;
    const exponent = Math.min(item.consecutiveFailures - 1, 8);
    const seconds = Math.min(policy.maxCooldownSeconds, policy.cooldownSeconds * 2 ** exponent);
    item.blockedUntil = now + seconds * 1000;
    this.entries.set(key, item);
    return reason;
  }

  reportSuccess(key: string, now = Date.now()): void {
    if (!key) return;
    this.entries.set(key, { consecutiveFailures: 0, lastSuccessAt: now });
    this.lastError.delete(key);
  }

  isEligible(key: string, policy: HealthSettings, now = Date.now()): boolean {
    if (!policy.enabled) return true;
    return (this.entries.get(key)?.blockedUntil ?? 0) <= now;
  }

  status(key: string, now = Date.now()): HealthEntry {
    const item = this.entries.get(key);
    const until = item?.blockedUntil ?? 0;
    const status: ModelHealthStatus = !item ? "unknown"
      : until > now ? "cooldown"
      : item.consecutiveFailures > 0 ? "ready_to_retry" : "healthy";
    return {
      key, status, consecutiveFailures: item?.consecutiveFailures ?? 0,
      reason: item?.reason, lastFailureAt: item?.lastFailureAt,
      lastSuccessAt: item?.lastSuccessAt, blockedUntil: item?.blockedUntil,
      remainingSeconds: Math.max(0, Math.ceil((until - now) / 1000)),
    };
  }

  list(keys: readonly string[], now = Date.now()): HealthEntry[] {
    return keys.map(k => this.status(k, now));
  }

  lastDispatchIssue(): DispatchIssue | undefined { return this.lastIssue; }

  reset(key?: string): void {
    if (key) {
      if (this.lastIssue?.model === key) this.lastIssue = undefined;
      this.entries.delete(key);
      this.lastError.delete(key);
    } else {
      this.lastIssue = undefined;
      this.entries.clear();
      this.lastError.clear();
    }
  }
}
