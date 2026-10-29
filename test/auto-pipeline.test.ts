import test from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_ENTRY,startPipeline,advancePipeline,reportGate,
  latestPipelineFromBranch,pipelineLines,nextPhasePrompt,
} from "../auto-pipeline.ts";
test("Auto mode is initially Implementation only; missing steps prevent QA",()=>{
 const initial=startPipeline(3);
 assert.deepEqual(initial,{planVersion:3,phase:"implement",status:"running"});
 const paused=advancePipeline(initial,{implementationCompleted:false});
 assert.equal(paused.status,"paused");assert.equal(paused.phase,"implement");
 assert.equal(advancePipeline(paused,{implementationCompleted:true}).phase,"implement");
 const qa=advancePipeline(initial,{implementationCompleted:true});
 assert.equal(qa.phase,"qa");assert.equal(qa.status,"running");
 assert.deepEqual(latestPipelineFromBranch([{type:"custom",customType:PIPELINE_ENTRY,data:qa}]),qa);
});
test("QA and Review require explicit evidence; failures and aborts stop safely",()=>{
 let qa=advancePipeline(startPipeline(1),{implementationCompleted:true});
 assert.equal(advancePipeline(qa,{}).status,"paused");
 assert.equal(advancePipeline(qa,{aborted:true}).status,"paused");
 assert.throws(()=>reportGate("qa","pass","too short"),/evidence/);
 const fail=advancePipeline(qa,{result:reportGate("qa","fail","Regression tests fail in payment flow",["500 response"])});
 assert.equal(fail.status,"failed");assert.equal(fail.phase,"qa");
 const review=advancePipeline(qa,{result:reportGate("qa","pass","Unit tests passed with 56 assertions")});
 assert.equal(review.phase,"review");assert.equal(review.qa?.outcome,"pass");
 assert.equal(advancePipeline(review,{}).status,"paused");
 const complete=advancePipeline(review,{result:reportGate("review","pass",
   "Reviewed auth, loading states and changed file diff")});
 assert.equal(complete.status,"completed");assert.equal(complete.phase,"completed");
 assert.equal(complete.review?.outcome,"pass");
 assert.match(pipelineLines(complete).join(" "),/COMPLETED/);
});
test("QA/Review phase prompts instruct real checks and require gate calls",()=>{
 const qa=nextPhasePrompt("qa","# Approved Plan","Build a Gutenberg charity block");
 const review=nextPhasePrompt("review","# Approved Plan");
 assert.match(qa,/jev_quality_gate/);assert.match(qa,/functional/);
 assert.match(review,/read-only/);assert.match(review,/security/);
});
