#!/usr/bin/env node
/**
 * Dependency-free repository quality gate.
 * Syntax validation, source hygiene and Pi package manifest structure.
 * Full semantic TypeScript checking requires a separate SDK-aware tsconfig.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const errors = [];
function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" ||
        entry.name === ".git" || entry.name === "coverage") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
const files = walk(root);
const sourceFiles = files.filter(p => /\.(ts|mjs|js)$/.test(p));
if (!sourceFiles.some(p => p.endsWith("/index.ts"))) errors.push("Missing Pi extension index.ts.");
for (const file of sourceFiles) {
  const args = file.endsWith(".ts")
    ? ["--experimental-strip-types", "--check", file] : ["--check", file];
  const check = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (check.status !== 0) errors.push("Syntax: " + relative(root, file) + "\n" +
    (check.stderr || check.stdout).slice(0, 1400));
}
// Validate the static import graph: syntax-only checks do not resolve files.
for (const file of sourceFiles.filter(file => file.endsWith(".ts"))) {
  const body = readFileSync(file, "utf8");
  const dependencies = body.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g);
  for (const dep of dependencies) {
    const target = resolve(file, "..", dep[1] || dep[2]);
    if (!target.startsWith(root + "/") || !existsSync(target)) {
      errors.push("Unresolved relative import: " + relative(root, file) + " -> " + (dep[1] || dep[2]));
    }
  }
}
for (const file of files.filter(p => /\.(ts|mjs|js|yml|yaml|json)$/.test(p))) {
  const body = readFileSync(file, "utf8");
  if (/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(body))
    errors.push("Merge conflict markers in " + relative(root, file));
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version))
  errors.push("package.json.version must be a valid semver.");
if (!Array.isArray(pkg.pi?.extensions) || !pkg.pi.extensions.includes("./index.ts"))
  errors.push("Pi package must expose ./index.ts under pi.extensions.");
for (const dir of pkg.pi?.skills ?? []) {
  const where = resolve(root, dir);
  if (!where.startsWith(root + "/") || !existsSync(where))
    errors.push("Missing or unsafe pi.skills directory: " + dir);
}
if (errors.length) {
  console.error("Quality checks failed:\n" + errors.map(x => "- " + x).join("\n"));
  process.exit(1);
}
console.log("Quality OK: " + sourceFiles.length +
  " TS/JS syntax checks, package manifest, and repository hygiene.");
