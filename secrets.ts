/** Private credential storage for interactive Pi setup. Never import secrets into policy JSON. */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SecretKind = "nineRouter" | "jev";
export type SecretMap = Partial<Record<SecretKind, string>>;

export function secretFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "jev-model-manager.secrets.json");
}

export function readSecrets(path = secretFilePath()): SecretMap {
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Jev credentials path must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Jev credentials file is accessible by other users: run chmod 600 on it");
  }
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid Jev credentials file");
  const obj = data as Record<string, unknown>;
  const secrets: SecretMap = {};
  for (const kind of ["nineRouter", "jev"] as const) {
    if (typeof obj[kind] === "string" && obj[kind]) secrets[kind] = obj[kind];
  }
  return secrets;
}

export function writeSecrets(secrets: SecretMap, path = secretFilePath()): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (existsSync(path)) readSecrets(path); // Reject existing symlinks and insecure permissions.
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  // Atomic replace; temp creation uses 0600 even if umask is permissive.
  writeFileSync(temp, JSON.stringify(secrets, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

/** Shell-provided credentials win; otherwise use the in-app private store. */
export function resolveSecret(kind: SecretKind, envName: string, env: NodeJS.ProcessEnv = process.env, secrets?: SecretMap): string | undefined {
  if (env[envName]?.trim()) return env[envName];
  return (secrets ?? readSecrets())[kind];
}

export function credentialSource(kind: SecretKind, envName: string, env: NodeJS.ProcessEnv = process.env, secrets?: SecretMap): "env" | "stored" | "missing" {
  if (env[envName]?.trim()) return "env";
  return (secrets ?? readSecrets())[kind] ? "stored" : "missing";
}
