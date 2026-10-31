import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {defaultTaskRules,normalizeTaskRules,type TaskRules} from "../task-routing.ts";
import {DEFAULT_NINE_ROUTER_URL,DEFAULT_NINE_ROUTER_KEY_ENV,type NineRouterSettings} from "../nine-router.ts";
import {DEFAULT_DELEGATION,normalizeDelegation,type DelegationSettings} from "../delegation.ts";
import {DEFAULT_HEALTH,normalizeHealthSettings,type HealthSettings} from "../health.ts";
import {normalizeMascotStyle,type MascotStyle} from "../mascot.ts";
import {normalizeToolGrants,type ToolGrant} from "../tool-capabilities.ts";
import {normalizePeerAdapters,type PeerCliAdapter} from "../collaboration-adapters.ts";

export const CONFIG_PATH = join(
  process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
  "jev-model-manager.json",
);
export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING)[number];
export type CostTier = "budget" | "balanced" | "premium";

export interface ManagedModel {
  key: string; // provider/modelId; always maps to Pi's physical model catalog
  label: string;
  enabled: boolean;
  specialty: string;
  avoid: string;
  cost: CostTier;
  thinking: Thinking;
  // These optional fields are used for models registered via the 9Router proxy.
  reasoning?: boolean;
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}
export interface Config {
  version: 1;
  enabled: boolean;
  mode: "auto" | "observe";
  classifier: { provider: string; model: string };
  fallback: string;
  minProbability: number;
  nineRouter: NineRouterSettings;
  models: ManagedModel[];
  taskRules: TaskRules;
  subagentRouting: boolean;
  delegation: DelegationSettings;
  health: HealthSettings;
  mascot: MascotStyle;
  robotMotion: boolean;
  toolGrants:ToolGrant[];
  peerAdapters:PeerCliAdapter[];
}
const defaults = (): Config => ({
  version: 1,
  enabled: false, // privacy-safe: explicit opt-in before sending prompts to Jev
  mode: "auto",
  classifier: { provider: "typesafe", model: "jev-latest" },
  fallback: "",
  minProbability: 0.43,
  nineRouter: { baseUrl: DEFAULT_NINE_ROUTER_URL, apiKeyEnv: DEFAULT_NINE_ROUTER_KEY_ENV },
  models: [],
  taskRules: defaultTaskRules(),
  subagentRouting: false, // external third-party model override remains opt-in
  delegation: { ...DEFAULT_DELEGATION },
  health: { ...DEFAULT_HEALTH },
  mascot: "mascot",
  robotMotion: true,
  toolGrants:[],
  peerAdapters:[],
});

export function readConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return defaults();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    const d = defaults();
    return {
      ...d,
      ...raw,
      classifier: { ...d.classifier, ...raw.classifier },
      nineRouter: { ...d.nineRouter, ...raw.nineRouter },
      models: Array.isArray(raw.models) ? raw.models.filter((m) => typeof m?.key === "string") : [],
      taskRules: normalizeTaskRules(raw.taskRules),
      subagentRouting: raw.subagentRouting === true,
      delegation: normalizeDelegation(raw.delegation),
      health: normalizeHealthSettings(raw.health),
      mascot: normalizeMascotStyle(raw.mascot),
      robotMotion: raw.robotMotion !== false,
      toolGrants:normalizeToolGrants(raw.toolGrants),
      peerAdapters:normalizePeerAdapters(raw.peerAdapters),
    };
  } catch (e) {
    throw new Error(`Invalid config ${CONFIG_PATH}: ${String(e)}`);
  }
}

export function saveConfig(config: Config): void {
  const parent = dirname(CONFIG_PATH);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, CONFIG_PATH);
}

