/** 9Router discovery, deliberately separate from Pi so it can be tested offline. */
export const NINE_ROUTER_PROVIDER = "jev-9router";
export const DEFAULT_NINE_ROUTER_URL = "http://127.0.0.1:20128/v1";
export const DEFAULT_NINE_ROUTER_KEY_ENV = "NINEROUTER_API_KEY";

export interface NineRouterSettings {
  baseUrl: string;
  apiKeyEnv: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function validateEnvName(envName: string): string {
  const trimmed = envName.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
    throw new Error("API key environment variable must be a valid name (example: NINEROUTER_API_KEY)");
  }
  return trimmed;
}

export function normalizeNineRouterBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("Invalid 9Router URL; expected http(s)://host:port/v1"); }
  if (!(["http:", "https:"].includes(url.protocol))) {
    throw new Error("9Router URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("9Router URL must not contain credentials, query parameters, or fragments");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1/models")) pathname = pathname.slice(0, -"/models".length);
  else if (!pathname.endsWith("/v1")) {
    // A user may paste an instance root (or reverse-proxy prefix).
    if (/\/(chat\/completions|responses|models)$/.test(pathname)) {
      throw new Error("Enter the 9Router server root or /v1 URL, not a specific API endpoint");
    }
    pathname += "/v1";
  }
  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

export async function scanNineRouter(
  settings: NineRouterSettings,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const baseUrl = normalizeNineRouterBaseUrl(settings.baseUrl);
  const envName = validateEnvName(settings.apiKeyEnv);
  const apiKey = process.env[envName];
  if (!apiKey) throw new Error(`Missing ${envName}. Set it in the environment before starting Pi.`);

  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error", // never forward an API key to a redirected host
    });
  } catch (error) {
    // Avoid echoing fetch errors that may contain URLs or credentials.
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("9Router model scan timed out (10s)");
    throw new Error("Cannot reach 9Router /v1/models; check URL, network, and TLS");
  }
  if (!response.ok) throw new Error(`9Router /v1/models returned HTTP ${response.status} (check API key and access)`);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error("9Router /v1/models did not return JSON"); }
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("9Router /v1/models response is missing an OpenAI-compatible data array");
  }
  const raw = (payload as { data: unknown[] }).data;
  if (raw.length > 5_000) throw new Error("9Router returned too many models (over 5,000); narrow the proxy catalog");
  const seen = new Set<string>();
  const found: DiscoveredModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || id.length > 200 || /[\x00-\x20\x7f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 200) : id;
    const contextWindow = positiveInt(r.context_window) ?? positiveInt(r.context_length);
    const reportedMax = positiveInt(r.max_tokens) ?? positiveInt(r.max_output_tokens);
    const maxTokens = reportedMax && contextWindow ? Math.min(reportedMax, contextWindow) : reportedMax;
    found.push({ id, name, ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}) });
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
