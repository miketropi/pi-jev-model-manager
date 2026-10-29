import test from "node:test";
import assert from "node:assert/strict";
import {planSteps,newProgress,changeProgress,latestProgress,progressLines,PROGRESS_ENTRY} from "../progress.ts";
test("extracts checklist tasks and numbered deliverables without confusing headings",()=>{
 const md=["# Build Block","## Goal","Provide donations","## Implementation Steps","1. Inspect Gutenberg setup","2. Build block controls","3. Run regression tests"].join(String.fromCharCode(10));
 assert.deepEqual(planSteps(md),["Inspect Gutenberg setup","Build block controls","Run regression tests"]);
 assert.deepEqual(planSteps("# Research blog"),["Complete the approved deliverable and verify the result"]);
 const bulletPlan=["## Goal","- Explain donation flow","## Implementation",
   "- Create donation block UI","- Connect the payment API","## Risks","- Rate limiting"].join(String.fromCharCode(10));
 assert.deepEqual(planSteps(bulletPlan),["Create donation block UI","Connect the payment API"]);
});
test("shows current, pending, verified and blocked with explicit evidence",()=>{
 let p=newProgress(["1. Read source","2. Build the block","3. Verify tests"].join(String.fromCharCode(10)),3);
 assert.equal(p.steps[0].status,"active");assert.equal(p.steps[1].status,"pending");
 assert.throws(()=>changeProgress(p,1,"done"),/verification/);
 p=changeProgress(p,1,"done","Reviewed existing block files");
 assert.equal(p.steps[0].status,"done");assert.equal(p.steps[1].status,"active");
 p=changeProgress(p,2,"blocked","Missing test endpoint");
 assert.match(progressLines(p).join(" "),/Missing|blocked|!/i);
 assert.equal(p.stage,"running");
 assert.equal(latestProgress([{type:"custom",customType:PROGRESS_ENTRY,data:p}])?.steps[0].status,"done");
 assert.throws(()=>changeProgress(p,1,"active"),/reopen/);
});
