import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,existsSync,readFileSync,rmSync,statSync,utimesSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
test("plan Markdown mirror never appears in project cwd and deletes on cleanup",async()=>{
 const base=mkdtempSync(join(tmpdir(),"jev-cache-test-"));
 const old=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=join(base,"pi-agent");
 try{
  const {planMirrorPath,savePlanMirror,cleanPlanMirror}=await import("../plan-cache.ts");
  const session="session/../unsafe", plan=["# Source plan","1. Build app"].join(String.fromCharCode(10));
  const path=savePlanMirror(session,plan);
  assert.ok(path?.startsWith(join(base,"pi-agent","jev-model-manager","plans")));
  assert.ok(!path.includes("unsafe.md"));
  assert.equal(readFileSync(path,"utf8"),plan);
  assert.equal(statSync(path).mode & 0o777,0o600);
  assert.equal(planMirrorPath(session),path);
  assert.ok(!path.startsWith(process.cwd()));
  cleanPlanMirror(session);assert.equal(existsSync(path),false);
  cleanPlanMirror(session);
  const stale=savePlanMirror("old-session",plan);
  const oldTime=new Date(Date.now()-3*86400000);
  utimesSync(stale,oldTime,oldTime);
  const {pruneOldPlanMirrors}=await import("../plan-cache.ts");
  assert.equal(pruneOldPlanMirrors(),1);
  assert.equal(existsSync(stale),false);
  assert.equal(planMirrorPath(undefined),undefined);
 }finally{
  if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=old;
  rmSync(base,{recursive:true,force:true});
 }
});
