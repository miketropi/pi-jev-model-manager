import test from "node:test";
import assert from "node:assert/strict";
import {planSteps,newProgress,changeProgress,latestProgress,progressLines,progressWindow,PROGRESS_ENTRY} from "../progress.ts";
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

test("live checklist viewport follows tasks beyond #6 without growing into the conversation",()=>{
 const md=["## Implementation",...Array.from({length:12},(_,i)=>
  (i+1)+". Task "+(i+1)+" implements a meaningful feature and verifies it")].join("\n");
 let p=newProgress(md,7);
 assert.equal(p.steps.length,12);
 assert.deepEqual(p.steps.map(s=>s.id),Array.from({length:12},(_,i)=>i+1));
 for(const next of [1,2,5,6,7,9,12]){
  p=changeProgress(p,next,"active","Currently implementing task");
  const view=progressWindow(p);
  const rows=progressLines(p);
  assert.ok(rows.some(row=>row.startsWith("◉ "+next+".")),
    "active #"+next+" must appear in live widget");
  assert.ok(view.start<=next-1 && view.end>=next);
  assert.ok(rows.length<=8,"widget always compact regardless of task count");
  assert.match(rows[0],new RegExp("#"+next+"/12"));
  assert.match(rows.at(-1)??"",/\/jev-progress/);
 }
 const far=progressLines(p).join(" ");
 assert.match(far,/↑ 7 earlier/);
 assert.equal(far.includes("Task 1 implements"),false,
  "do not pin the first six tasks when agent is at #12");
 const full=progressLines(p,24).join("\n");
 assert.match(full,/☐ 11\./);
 assert.match(full,/◉ 12\./);
 assert.doesNotMatch(full,/earlier|next ·/);
});
test("widget tracks blockers, next unfinished work, paused status and custom 16-step checklist",()=>{
 let p=newProgress("## Implementation\n1. Create the first feature\n2. Create the second feature",2);
 p={...p,steps:Array.from({length:16},(_,i)=>({
  id:i+1,title:"Work item "+(i+1)+" has acceptance checks",
  status:(i<7?"done":"pending") as "done"|"pending"
 }))};
 assert.equal(progressWindow(p).focusId,8,"first pending is focus if no active");
 assert.match(progressLines(p).join(" "),/☐ 8\./);
 p={...p,steps:p.steps.map(s=>s.id===14?{...s,status:"blocked"}:s)};
 assert.equal(progressWindow(p).focusId,14,"blocker takes priority if no active");
 assert.match(progressLines(p)[0],/! 1 blocked/);
 assert.ok(progressLines(p).some(x=>x.startsWith("! 14.")));
 p={...p,stage:"paused"};
 assert.match(progressLines(p)[0],/PAUSED/);
 p={...p,steps:p.steps.map(s=>s.id===10?{...s,status:"active"}:s)};
 assert.equal(progressWindow(p).focusId,10,"active takes priority over blockers");
 assert.ok(progressLines(p).some(x=>x.startsWith("◉ 10.")));
 assert.ok(progressLines(p).some(x=>x.includes("↑ ")&&x.includes("↓ ")),
  "show hidden items on both sides");
 assert.equal(progressWindow(p,40).start,0);
 assert.equal(progressWindow(p,40).end,16);
 assert.equal(progressWindow({...p,steps:[]}).focusId,undefined);
});
