import test from "node:test";
import assert from "node:assert/strict";
import {createDelegationSchedule,normalizeDelegation,subagentReady,
 nextDelegationWave,recordDelegationRun,fallbackDelegationToLead,delegatePrompt,
 latestDelegation,DELEGATION_ENTRY} from "../delegation.ts";
import {newProgress,changeProgress} from "../progress.ts";
const progress=newProgress("## Implementation Steps\n1. Implement REST endpoint\n2. Build frontend block\n3. Wire controller and view\n4. Add smoke tests",1);
const cfg={strategy:"prefer" as const,maxConcurrentBuilders:2,builderAgent:"worker"};
const job=(stepId:number,files:string[],dependsOn:number[]=[],effort:"small"|"medium"|"large"="medium")=>({stepId,files,dependsOn,effort});
test("Prefer Subagents with capped concurrency and validated agent name",()=>{
 assert.deepEqual(normalizeDelegation(undefined),cfg);
 assert.equal(normalizeDelegation({strategy:"always",maxConcurrentBuilders:10,builderAgent:"../../agent"}).maxConcurrentBuilders,2);
 assert.equal(normalizeDelegation({strategy:"always",maxConcurrentBuilders:10,builderAgent:"../../agent"}).builderAgent,"worker");
 assert.equal(subagentReady(["read","subagent"]),true);
 assert.equal(subagentReady(["read"]),false);
});
test("two independent file scopes share a wave, dependencies remain sequential",()=>{
 const plan=createDelegationSchedule(progress,[
 job(1,["src/api/donations.ts"]),job(2,["src/blocks/donate.ts"]),
 job(3,["src/api/donations.ts","src/blocks/donate.ts"],[1,2]),
 job(4,["test/donations.test.ts"],[3],"small")],cfg);
 assert.deepEqual(plan.waves.map(w=>[w.execution,w.tasks.map(t=>t.stepId)]),
 [["builder",[1,2]],["builder",[3]],["lead",[4]]]);
 assert.equal(nextDelegationWave(plan,progress)?.index,0);
 const reported=recordDelegationRun(plan,0,"reported","Native Pi returned Builder output");
 assert.throws(()=>nextDelegationWave(reported,progress),/already dispatched/);
 let verified=changeProgress(progress,1,"done","Reviewed REST endpoint and tests");
 verified=changeProgress(verified,2,"done","Reviewed Gutenberg UI and tests");
 assert.equal(nextDelegationWave(reported,verified)?.index,1);
 assert.match(delegatePrompt(plan.waves[0].tasks[0],"Approved plan"),/Do not call jev_progress/);
 assert.deepEqual(latestDelegation([{type:"custom",customType:DELEGATION_ENTRY,data:plan}]),plan);
});
test("shared directories and unscoped tasks cannot execute in parallel",()=>{
 const plan=createDelegationSchedule(progress,[
 job(1,["src/api"]),job(2,["src/api/donations.ts"]),job(3,[])],cfg);
 assert.ok(plan.waves.every(w=>w.tasks.length===1));
});
test("unsafe scopes and cyclic dependencies are rejected",()=>{
 const suspicious=[String.fromCharCode(47)+"root"+String.fromCharCode(47)+"file",
  ["..","private"].join(String.fromCharCode(47)),"src/*.ts"];
 for(const file of suspicious)
  assert.throws(()=>createDelegationSchedule(progress,[job(1,[file])],cfg),/scope/);
 assert.throws(()=>createDelegationSchedule(progress,[
  job(1,["src/a.ts"],[2]),job(2,["src/b.ts"],[1])],cfg),/Circular/);
});

test("Prefer gracefully converts missing Builder to audited Lead with no fake run",()=>{
 const original=createDelegationSchedule(progress,[
  job(1,["src/a.ts"]),job(2,["src/b.ts"])],cfg);
 const fallback=fallbackDelegationToLead(original,progress,
  "Native Pi subagent unavailable; NO Builder was spawned.",{},new Date("2026-10-30T00:00:00Z"));
 assert.deepEqual(original.waves.map(w=>w.execution),["builder"]);
 assert.deepEqual(fallback.waves.map(w=>w.execution),["lead"]);
 assert.equal(fallback.runs,undefined);
 assert.equal(fallback.fallbacks?.[0].wave,0);
 assert.equal(fallback.fallbacks?.[0].at,"2026-10-30T00:00:00.000Z");
 assert.match(fallback.waves[0].tasks[0].reason,/Lead fallback/);
 const verified=changeProgress(progress,1,"done","Lead verified focused REST tests.");
 assert.deepEqual(nextDelegationWave(fallback,verified)?.wave.tasks.map(t=>t.stepId),[2],
  "partial Lead waves must resume only remaining tasks");
 assert.equal(fallbackDelegationToLead(fallback,verified,"No new Builder to spawn."),fallback,
  "recovery is idempotent");
});

test("Always Delegate and previously reported Builder results cannot be silently bypassed",()=>{
 const always=createDelegationSchedule(progress,[job(1,["src/a.ts"])],
  {...cfg,strategy:"always"});
 assert.throws(()=>fallbackDelegationToLead(always,progress,
  "No Builder could be spawned."),/Always Delegate/);
 const changedPolicy=fallbackDelegationToLead(always,progress,
  "User explicitly changed strategy to Prefer after Builder failed",
  {allowStrategyChange:true});
 assert.equal(changedPolicy.waves[0].execution,"lead");
 const schedule=createDelegationSchedule(progress,[job(1,["src/a.ts"])],cfg);
 const reported=recordDelegationRun(schedule,0,"reported","Real Builder completed work");
 assert.throws(()=>fallbackDelegationToLead(reported,progress,
  "Lead would like to skip Builder"),/already reported output/);
 const error=recordDelegationRun(schedule,0,"error","Builder returned an execution error");
 assert.throws(()=>fallbackDelegationToLead(error,progress,
  "No Builder was spawned."),/inspect possible partial changes/);
 const manual=fallbackDelegationToLead(error,progress,
  "Lead inspected possible changes, will verify directly",{allowErroredRun:true});
 assert.equal(manual.waves[0].execution,"lead");
 assert.equal(nextDelegationWave(manual,progress)?.wave.tasks[0].stepId,1);
 assert.throws(()=>fallbackDelegationToLead(schedule,progress,"too short"),/factual reason/);
});
