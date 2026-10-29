#!/usr/bin/env node
/** Block wrong tag releases before publishing any assets. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const actual = process.env.RELEASE_TAG ?? process.argv[2];
const expected = "v" + pkg.version;
if (!actual || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(actual) || actual !== expected) {
  console.error("Invalid release tag: " + (actual || "<missing>") +
    ". Expected exactly " + expected + " from package.json.");
  process.exit(1);
}
console.log("Release tag verified:", actual);
