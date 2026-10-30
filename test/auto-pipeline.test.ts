import test from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_ENTRY,startPipeline,advancePipeline,reportGate,
  latestPipelineFromBranch,pipelineLines,nextPhasePrompt,
  triageQaFeedback,recordQaFix,MAX_QA_FIX_ROUNDS,formatQaIssues,
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
 assert.equal(fail.status,"running");assert.equal(fail.phase,"implement");
 assert.equal(fail.qaRecovery?.stage,"triage");
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


test("QA Lead triage validates all feedback and records verified changes before fresh QA",()=>{
 const qa=advancePipeline(startPipeline(7),{implementationCompleted:true});
 assert.throws(()=>reportGate("qa","fail","One issue failed",[]),/actionable findings/);
 const first=advancePipeline(qa,{result:reportGate("qa","fail",
   "Article exceeds accepted 600-word limit by 138 words.",
   ["Word count is 738, while approved plan requires 600 max; remove 138+ words."])});
 assert.equal(first.phase,"implement");
 assert.equal(first.qaRecovery?.issues[0].id,"QA1");
 assert.equal(advancePipeline(first,{implementationCompleted:true}).status,"paused",
   "never pass QA just because preexisting implementation checklist is complete");
 assert.throws(()=>triageQaFeedback(first,[]),/EVERY/);
 const decided=triageQaFeedback(first,[{
   issueId:"QA1",disposition:"fix",rationale:"The signed-off limit is 600 words.",
   evidence:"Counted 738 words in the current generated article."
 }]);
 assert.equal(decided.qaRecovery?.stage,"fixing");
 assert.throws(()=>recordQaFix(decided,{
   changedFiles:[],issueIds:["QA1"],evidence:"Removed some words in article file.",
   verification:"Recounted and checked the output length."}),/files/);
 const fixed=recordQaFix(decided,{
   changedFiles:["posts/deepseek-article.md"],issueIds:["QA1"],
   evidence:"Removed 160 redundant words while preserving cited facts and chronology.",
   verification:"Counted 578 words and checked all official-source citations."
 });
 assert.equal(fixed.qaRecovery?.fixRounds,1);
 const rerun=advancePipeline(fixed,{implementationCompleted:true});
 assert.equal(rerun.phase,"qa");
 assert.equal(rerun.qa,undefined,"a past fail cannot stand in for a fresh QA result");
 assert.match(nextPhasePrompt("qa","# Plan","Write article",rerun.qaRecovery),/Prior QA correction/);
 const review=advancePipeline(rerun,{
   result:reportGate("qa","pass","Recounted 578 words, links validated, citation dates checked")
 });
 assert.equal(review.phase,"review");
 assert.equal(review.qaRecovery?.fixRounds,1);
});

test("QA retry guards stop exact repeated findings and exhaustion, without auto-approving reviews",()=>{
 let qa=advancePipeline(startPipeline(8),{implementationCompleted:true});
 const issue=(n:number)=>reportGate("qa","fail","Measured article word count at "+n,
  ["Word count is "+n+"; plan requires no more than 600 words, must shorten article."]);
 const fix=(state:typeof qa)=> {
   const pending=advancePipeline(state,{result:issue(700-state.qaRecovery!.fixRounds*10)});
   const decided=triageQaFeedback(pending,[{issueId:"QA1",disposition:"fix",
     rationale:"Approved project requirements include strict word cap.",
     evidence:"Counted actual document words, above allowed maximum."}]);
   return advancePipeline(recordQaFix(decided,{changedFiles:["post.md"],issueIds:["QA1"],
     evidence:"Cut redundant wording from article and preserved all source citations.",
     verification:"Ran a current word count and rechecked the markdown article."}),
     {implementationCompleted:true});
 };
 let first=advancePipeline(qa,{result:issue(700)});
 assert.equal(triageQaFeedback(first,[{issueId:"QA1",disposition:"needs_user",
  rationale:"The requested 600-word limit conflicts with minimum legal copy.",
  evidence:"Existing acceptance rules specify mandatory warning paragraph."}]).status,"paused");
 const d=triageQaFeedback(first,[{issueId:"QA1",disposition:"fix",
  rationale:"The limit is explicit in the accepted plan.",
  evidence:"Counted 700 words in the article on disk."}]);
 qa=advancePipeline(recordQaFix(d,{changedFiles:["post.md"],issueIds:["QA1"],
  evidence:"Removed repetition and preserved all the factual source citations.",
  verification:"Counted article and reviewed all citations for completeness."}),{implementationCompleted:true});
 const identical=advancePipeline(qa,{result:issue(700)});
 assert.equal(identical.status,"paused");
 assert.match(identical.reason??"",/Repeated identical/);
 // Distinct successive findings are allowed only for MAX_QA_FIX_ROUNDS fixes.
 qa=advancePipeline(startPipeline(10),{implementationCompleted:true});
 for(let n=0;n<MAX_QA_FIX_ROUNDS;n++){
   const failed=advancePipeline(qa,{result:issue(700-n*10)});
   const decided=triageQaFeedback(failed,[{issueId:"QA1",disposition:"fix",
    rationale:"Article exceeds contract word limit and needs correction.",
    evidence:"Counted actual words and confirmed the accepted limit."}]);
   qa=advancePipeline(recordQaFix(decided,{changedFiles:["post.md"],issueIds:["QA1"],
    evidence:"Revised article to eliminate duplicate sentences and unnecessary prose.",
    verification:"Recounted content and reviewed citation integrity afterwards."}),
    {implementationCompleted:true});
 }
 const stopped=advancePipeline(qa,{result:issue(640)});
 assert.equal(stopped.status,"paused");
 assert.match(stopped.reason??"",/budget exhausted/);
 const review=advancePipeline(qa,{result:reportGate("qa","pass","All source links and word limits checked")});
 const failedReview=advancePipeline(review,{result:reportGate("review","fail",
  "Security audit found unescaped input in WordPress block",["Stored input may include HTML"])});
 assert.equal(failedReview.status,"failed","Review fail must not silently bypass its gate");
});


test("structured QA issues require grounded observed/expected/evidence and produce actionable Lead feedback",()=>{
 const details=formatQaIssues([{location:"posts/deepseek.md:paragraph-3",
   observed:"Current article length is 738 words",
   expected:"Approved article is at most 600 words",
   evidence:"Verified actual word count using wc on the finished markdown article",
   suggestedFix:"Remove at least 138 words of redundant explanation while preserving factual citations"}]);
 assert.match(details[0],/Location: posts\/deepseek.md/);
 assert.match(details[0],/Observed: Current article length is 738 words/);
 assert.match(details[0],/Expected: Approved article is at most 600 words/);
 assert.match(details[0],/Evidence: Verified actual word count/);
 assert.match(details[0],/Suggested fix: Remove at least 138 words/);
 const qa=advancePipeline(startPipeline(15),{implementationCompleted:true});
 const failed=advancePipeline(qa,{result:reportGate("qa","fail",
   "QA checked actual word count and documented violation.",details)});
 assert.equal(failed.qaRecovery?.issues[0].text,details[0]);
 assert.throws(()=>formatQaIssues([{location:"",observed:"no",
   expected:"test",evidence:"",suggestedFix:""}]),/needs location/);
});
