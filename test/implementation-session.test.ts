import test from "node:test";
import assert from "node:assert/strict";
import { createOrigin,latestSessionOrigin,latestSessionLaunch,handoffTitle,
  SESSION_ORIGIN_ENTRY, SESSION_LAUNCH_ENTRY } from "../implementation-session.ts";
const plan={markdown:"# Gutenberg charity donation block\n\n1. Build block",version:2,
 createdAt:"2026-10-28",updatedAt:"2026-10-29",status:"approved",
 request:"Build a donation plugin"};
test("fresh Implementation Session gets only approved plan metadata",()=>{
 const parent="/home/user/.pi/agent/sessions/project/plan.jsonl";
 const origin=createOrigin(parent,plan,"auto",new Date("2026-10-29T09:00:00Z"));
 assert.equal(origin.parentSession,parent);assert.equal(origin.mode,"auto");
 assert.equal(origin.planVersion,2);
 assert.match(handoffTitle(plan),/^Jev Implement · Gutenberg/);
 const branch=[{type:"custom",customType:SESSION_ORIGIN_ENTRY,data:origin}];
 assert.deepEqual(latestSessionOrigin(branch),origin);
});
test("cannot launch a child session without approved plan and persisted parent",()=>{
 assert.throws(()=>createOrigin("",plan,"manual"),/persistent/);
 assert.throws(()=>createOrigin("/parent",{...plan,status:"draft"},"auto"),/approved/);
 const launch={planVersion:2,mode:"auto",status:"requested"};
 assert.deepEqual(latestSessionLaunch([{type:"custom",
  customType:SESSION_LAUNCH_ENTRY,data:launch}],2),launch);
 assert.equal(latestSessionLaunch([],2),undefined);
});
