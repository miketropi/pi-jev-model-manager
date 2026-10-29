import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version;
function verify(tag) {
  return spawnSync(process.execPath,[join(root,"scripts","verify-tag.mjs")],
    {cwd:root,encoding:"utf8",env:{...process.env,RELEASE_TAG:tag}});
}
test("release tag must match package.json version exactly",()=>{
  const correct = verify("v"+version);
  assert.equal(correct.status,0,correct.stderr);
  for(const tag of ["v0.0.0","bad-version","v"+version+"-extra"]) {
    const wrong=verify(tag);
    assert.notEqual(wrong.status,0,tag+" must not publish");
    assert.match(wrong.stderr,/Invalid release tag/);
  }
});
