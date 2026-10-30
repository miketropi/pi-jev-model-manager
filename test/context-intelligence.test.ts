import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const tmp=mkdtempSync(join(tmpdir(),"jev-context-test-"));
process.env.PI_CODING_AGENT_DIR=tmp;
const m=await import("../context-intelligence.ts");
test("protected context is never discarded by policy",()=>{
 assert.equal(m.decideContextAction({kind:"checkpoint",duplicate:true,relevance:0}),"keep");
 assert.equal(m.decideContextAction({kind:"tool-output",protected:true,duplicate:true}),"keep");
 assert.equal(m.decideContextAction({kind:"tool-output",relevance:undefined}),"store");
});
test("archive deduplicates and retrieves by session",()=>{
 const a=m.archiveContext("alpha",{kind:"decision",summary:"Use SQLite database",text:"Use SQLite for local persistence",tags:["architecture"]});
 const b=m.archiveContext("alpha",{kind:"decision",summary:"Duplicate",text:"Use SQLite for local persistence"});
 assert.equal(a.id,b.id);
 assert.equal(m.searchContext("alpha","SQLite")[0].record.id,a.id);
 assert.equal(m.readContext("beta",a.id),undefined);
 assert.equal(m.loadContext("alpha")[0].protected,true);
});
test("model switching budget reserves output headroom",()=>{
 assert.equal(m.contextBudget(125000,128000,16000).overflow,true);
 assert.equal(m.contextBudget(50000,128000,16000).overflow,false);
});
test("archive capacity never evicts protected evidence",()=>{
 const c={...m.DEFAULT_CONTEXT_CONFIG,maxRecords:1};
 m.archiveContext("cap",{kind:"decision",summary:"First",text:"First protected"},c);
 assert.throws(()=>m.archiveContext("cap",{kind:"checkpoint",summary:"Second",text:"Second protected"},c),/protected/);
 assert.equal(m.loadContext("cap").length,1);
});
test("cleanup",()=>rmSync(tmp,{recursive:true,force:true}));
