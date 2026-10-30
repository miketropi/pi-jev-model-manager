import {test} from "node:test";
import {strict as assert} from "node:assert";
import {existsSync,readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname,join} from "node:path";
const root=dirname(dirname(fileURLToPath(import.meta.url)));
test("entrypoint is stable and thin",()=>{
 const index=readFileSync(join(root,"index.ts"),"utf8");
 assert.ok(index.split("\n").length<15);
 assert.match(index,/runtime\/orchestrator\.ts/);
});
test("domain boundaries are explicit and release includes modules",()=>{
 for(const name of ["core/config.ts","commands/register.ts","runtime/orchestrator.ts",
  "runtime/workflow-controller.ts","runtime/lifecycle.ts","runtime/tool-handlers.ts",
  "context/store.ts","ui/activation.ts","ui/model-admin.ts"])
   assert.equal(existsSync(join(root,name)),true,name);
 const pack=readFileSync(join(root,"scripts/package-release.mjs"),"utf8");
 for(const dir of ["commands","ui","runtime","context","routing","core","integrations"])
   assert.match(pack,new RegExp('"' + dir + '"'));
});
