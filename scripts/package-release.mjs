#!/usr/bin/env node
/** Build a standalone GitHub Release bundle installable as a Pi package folder. */
import { readdirSync, existsSync, mkdirSync, rmSync, cpSync,
         readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const folderName = "pi-jev-model-manager";
const archiveName = folderName + "-v" + pkg.version;
const dist = join(root, "dist");
const stage = join(dist, folderName);
// Include module directories as a whole. Previously only root TS files were
// packaged, which silently broke the extension after modularization.
const runtimeDirs = ["core", "routing", "integrations", "context", "runtime", "commands", "ui"];
const paths = ["package.json", "README.md",
  "jev-model-manager.example.json", "assets", "skills", "docs", ...runtimeDirs,
  ...readdirSync(root).filter(p => p.endsWith(".ts") &&
    !p.endsWith(".test.ts"))];
if (!paths.includes("index.ts") || !paths.includes("skills"))
  throw Error("Missing Pi runtime entrypoint or bundled skills.");
mkdirSync(dist, { recursive: true });
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
for (const path of paths) {
  const src = join(root, path);
  if (!existsSync(src)) throw Error("Required release input missing: " + path);
  cpSync(src, join(stage, path), { recursive: true });
}
// Smoke test the actual staged artifact, not just the source tree.
execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
  'const m=await import("./index.ts"); if(typeof m.default!=="function") throw Error("Invalid Pi entrypoint");'],
  { cwd: stage, stdio: "pipe", timeout: 30_000 });

const zip = archiveName + ".zip";
const tgz = archiveName + ".tar.gz";
for (const file of [zip, tgz, "SHA256SUMS"])
  rmSync(join(dist, file), { force: true });
execFileSync("tar", ["-czf", tgz, folderName], { cwd: dist, stdio: "inherit" });
execFileSync("zip", ["-X", "-qr", zip, folderName], { cwd: dist, stdio: "inherit" });
const checkContents = (paths) => {
  for (const path of paths) {
    if (!path.startsWith(folderName + "/")) throw Error("Unexpected archive root " + path);
    if (/(?:^|\/)(?:test|node_modules|coverage|dist)(?:\/|$)/.test(path) ||
        /(?:^|\/)(?:\.env(?:\.|$)|jev-model-manager\.secrets\.json$)/.test(path))
      throw Error("Unsafe file in release archive: " + path);
  }
  for (const required of ["package.json", "index.ts", "README.md",
    "skills/jev-plan-quality/SKILL.md",
    "runtime/orchestrator.ts", "runtime/workflow-controller.ts",
    "runtime/tool-handlers.ts", "runtime/lifecycle.ts",
    "commands/register.ts", "core/config.ts", "ui/configuration.ts",
    "context/extension.ts", "context/store.ts", "docs/architecture.md"]) {
    if (!paths.includes(folderName + "/" + required))
      throw Error("Missing from release archive: " + required);
  }
};
checkContents(execFileSync("tar", ["-tzf", tgz], { cwd: dist,
  encoding: "utf8" }).trim().split("\n"));
checkContents(execFileSync("unzip", ["-Z", "-1", zip], { cwd: dist,
  encoding: "utf8" }).trim().split("\n"));
const sums = [zip, tgz].map(name => {
  const sha = createHash("sha256").update(readFileSync(join(dist, name))).digest("hex");
  return sha + "  " + name;
}).join("\n") + "\n";
writeFileSync(join(dist, "SHA256SUMS"), sums);
console.log("Release package ready:", zip, tgz, "SHA256SUMS");
