import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ContextKind = "decision" | "research" | "tool-output" | "checkpoint" | "code-reference";
export type ContextAction = "keep" | "store" | "compress" | "discard";
export interface ContextRecord {
  id: string;
  session: string;
  kind: ContextKind;
  summary: string;
  text: string;
  tags: string[];
  protected: boolean;
  createdAt: string;
  contentHash: string;
}
export interface ContextConfig {
  enabled: boolean;
  mode: "shadow" | "manual";
  warnAt: number;
  maxReadChars: number;
  maxRecords: number;
}
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  enabled: true, mode: "shadow", warnAt: 0.8, maxReadChars: 12000, maxRecords: 1000,
};
const root = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "jev-model-manager", "context");
export function normalizeContextConfig(raw: Partial<ContextConfig> = {}): ContextConfig {
  return {
    enabled: raw.enabled !== false,
    mode: raw.mode === "manual" ? "manual" : "shadow",
    warnAt: typeof raw.warnAt === "number" && raw.warnAt >= 0.5 && raw.warnAt <= 0.95 ? raw.warnAt : 0.8,
    maxReadChars: Number.isSafeInteger(raw.maxReadChars) && (raw.maxReadChars as number) >= 500 && (raw.maxReadChars as number) <= 50000 ? raw.maxReadChars! : 12000,
    maxRecords: Number.isSafeInteger(raw.maxRecords) && (raw.maxRecords as number) >= 10 && (raw.maxRecords as number) <= 10000 ? raw.maxRecords! : 1000,
  };
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function sessionKey(session: string): string {
  if (!session || session.length > 4096) throw new Error("Invalid session");
  return hash(session).slice(0, 40);
}
export function contextPath(session: string): string { return join(root, sessionKey(session) + ".json"); }
function validateRecord(value: unknown): value is ContextRecord {
  const v = value as ContextRecord;
  return !!v && typeof v.id === "string" && /^[a-f0-9]{24}$/.test(v.id)
    && typeof v.summary === "string" && typeof v.text === "string"
    && typeof v.session === "string" && Array.isArray(v.tags) && typeof v.protected === "boolean";
}
export function loadContext(session: string): ContextRecord[] {
  const file = contextPath(session);
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data)) throw new Error("Invalid context archive");
  return data.filter(validateRecord);
}
function atomicSave(session: string, rows: ContextRecord[]): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = contextPath(session), temp = file + "." + randomBytes(6).toString("hex") + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(rows, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) { try { unlinkSync(temp); } catch {} }
  }
}
const protectedKinds = new Set<ContextKind>(["checkpoint", "decision"]);
export function archiveContext(session: string, input: {kind: ContextKind; text: string; summary: string; tags?: string[]; protected?: boolean}, config: ContextConfig = DEFAULT_CONTEXT_CONFIG): ContextRecord {
  if (!config.enabled) throw new Error("Context intelligence disabled");
  if (!input.text.trim() || input.text.length > 2_000_000) throw new Error("Invalid context content");
  if (!input.summary.trim() || input.summary.length > 1000) throw new Error("Invalid summary");
  const rows = loadContext(session), contentHash = hash(input.text);
  const existing = rows.find(row => row.contentHash === contentHash);
  if (existing) return existing;
  const record: ContextRecord = {
    id: randomBytes(12).toString("hex"), session: sessionKey(session), kind: input.kind,
    summary: input.summary, text: input.text,
    tags: (input.tags || []).filter(t => typeof t === "string").slice(0, 16).map(t => t.slice(0, 60)),
    protected: protectedKinds.has(input.kind) || input.protected === true,
    contentHash, createdAt: new Date().toISOString(),
  };
  rows.push(record);
  // Never evict protected evidence automatically.
  while (rows.length > config.maxRecords) {
    const i = rows.findIndex(row => !row.protected);
    if (i < 0) throw new Error("Archive capacity reached: protected records cannot be evicted");
    rows.splice(i, 1);
  }
  atomicSave(session, rows);
  return record;
}
function terms(query: string): string[] { return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])]; }
export function searchContext(session: string, query: string, limit = 8): Array<{record: ContextRecord; score: number}> {
  const words = terms(query);
  if (!words.length) return [];
  return loadContext(session).map(record => {
    const title = (record.summary + " " + record.tags.join(" ")).toLowerCase();
    const body = record.text.toLowerCase();
    const score = words.reduce((sum, term) => sum + (title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
    return {record,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score || b.record.createdAt.localeCompare(a.record.createdAt)).slice(0,Math.min(20,Math.max(1,limit)));
}
export function readContext(session: string, id: string, maxChars = 12000): ContextRecord | undefined {
  const record = loadContext(session).find(row => row.id === id);
  if (!record) return;
  return {...record, text: record.text.slice(0,Math.max(500,Math.min(50000,maxChars)))};
}
export function decideContextAction(input: {kind: ContextKind; protected?: boolean; isActive?: boolean; duplicate?: boolean; relevance?: number}): ContextAction {
  if (input.protected || protectedKinds.has(input.kind) || input.isActive) return "keep";
  if (input.duplicate) return "discard";
  if (input.relevance === undefined) return "store"; // missing semantic assessment must never cause deletion
  if (input.relevance >= 0.75) return "keep";
  if (input.relevance >= 0.3) return "compress";
  return "store"; // retained externally even at low relevance
}
export function contextBudget(used: number, window: number, reserve: number): {ratio: number; usable: number; overflow: boolean} {
  const usable=Math.max(0,window-Math.max(0,reserve));
  const ratio=usable ? used/usable : Infinity;
  return {ratio, usable, overflow: used>usable};
}
