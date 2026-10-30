import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {defaultTaskRules} from "../task-routing.ts";
import {PIPELINE_ENTRY} from "../auto-pipeline.ts";

test("Auto Implement -> QA -> Review advances only after verified tool results",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-auto-flow-"));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const models=["planner","builder","tester","reviewer"].map(id=>({provider:"test",id,api:"openai-completions"}));
 const virt={provider:"jev-manager",id:"auto",api:"pi-virtual"};
 const rules=defaultTaskRules();
 for(const [task,id] of [["plan","planner"],["implement","builder"],["qa","tester"],["review","reviewer"]])
  rules[task]={mode:"force",model:"test/"+id};
 const cfg={version:1,enabled:true,mode:"auto",fallback:"test/planner",minProbability:0.4,
  models:models.map(m=>({key:"test/"+m.id,label:m.id,enabled:true,specialty:"coding",avoid:"",cost:"balanced",thinking:"medium"})),
  taskRules:rules};
 const events={},commands={},entries=[],sent=[],widgets=[],tools={},statuses=[],notices=[];
 let model=models[0], active=["read","write","edit","bash","grep","find","ls"];
 let choice="Auto Implement → QA → Review (approve plan)";
 const ctx={mode:"tui",hasUI:true,scopedModels:[],
  get model(){return model;},
  sessionManager:{getBranch:()=>entries,getSessionId:()=>"jev-autopipeline-session"},
  ui:{select:async()=>choice,editor:async()=>undefined,notify:(...a)=>notices.push(a),
   setWidget:(...a)=>widgets.push(a),setStatus:(...a)=>statuses.push(a)},
  modelRegistry:{getAvailable:()=>models,find:(p,id)=>p==="jev-manager"?virt:models.find(m=>m.provider===p&&m.id===id)},
  waitForIdle:async()=>{},
 };
 const pi={
  registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
  registerTool:(t)=>tools[t.name]=t, registerCommand:(n,c)=>commands[n]=c,
  on:(n,fn)=>events[n]=fn,
  getActiveTools:()=>active,setActiveTools:(x)=>{active=x},
  getAllTools:()=>Object.values(tools),
  appendEntry:(type,data)=>entries.push({type:"custom",customType:type,data}),
  sendUserMessage:(txt)=>sent.push(txt),sendMessage(){},
  setModel:async(m)=>{model=m;return true},
 };
 const latest=()=>entries.filter(x=>x.customType===PIPELINE_ENTRY).at(-1)?.data;
 try{
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(cfg));
  const {default:ext}=await import("../index.ts");ext(pi);
  tools.subagent={name:"subagent"};
  const delegatedCalls=[];
  ctx.executeTool=async(name,args,options)=>{
    delegatedCalls.push({name,args,options});
    return {content:[{type:"text",text:"Builders changed scoped files and ran focused tests."}],
      details:{results:[{exitCode:0}]}};
  };
  await events.session_start({},ctx);
  await commands["jev-plan"].handler("Plan a Gutenberg charity donation block",ctx);
  await events.agent_start({},ctx);
  const plan="# Approved plan"+String.fromCharCode(10)+"## Implementation Steps"+
   String.fromCharCode(10)+"1. Add payment validation"+
   String.fromCharCode(10)+"2. Test donation behavior"+
   String.fromCharCode(10)+"## Verification"+String.fromCharCode(10)+"Run tests. ".repeat(12);
  await events.agent_end({messages:[{role:"assistant",stopReason:"stop",content:[{type:"text",text:plan}]}]},ctx);
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"implement");
  assert.equal(latest().status,"running");
  assert.equal(sent.length,2,"first user request and approved implementation");
  assert.ok(active.includes("jev_progress"));
  assert.ok(active.includes("jev_delegate"));
  assert.ok(active.includes("subagent"));
  const delegation=await tools.jev_delegate.execute("delegate-plan",{
    action:"plan",tasks:[
      {stepId:1,files:["src/api/donation.ts"],dependsOn:[],effort:"medium"},
      {stepId:2,files:["src/blocks/donate.ts"],dependsOn:[],effort:"medium"}
    ]
  },undefined,undefined,ctx);
  assert.equal(delegation.isError,undefined);
  const premature=await tools.jev_progress.execute("premature",{
    action:"update",stepId:1,status:"done",note:"Not yet delegated"
  },undefined,undefined,ctx);
  assert.equal(premature.isError,true);
  const directCall=await events.tool_call({toolName:"subagent",input:{agent:"worker",task:"x"}},ctx);
  assert.equal(directCall?.block,true,"bypassing Jev's safe concurrency is blocked");
  const delegated=await tools.jev_delegate.execute("run-wave",{action:"run"},undefined,undefined,ctx);
  assert.equal(delegated.isError,false);
  assert.equal(delegatedCalls.length,1);
  assert.equal(delegatedCalls[0].name,"subagent");
  assert.equal(delegatedCalls[0].args.tasks.length,2);
  assert.equal(delegatedCalls[0].args.agentScope,"user");
  const repeated=await tools.jev_delegate.execute("repeat-wave",{action:"run"},undefined,undefined,ctx);
  assert.equal(repeated.isError,true,"cannot spawn duplicate wave before Lead verification");
  // Do not advance with unverified implementation steps.
  await events.agent_start({},ctx);
  await events.agent_settled({},ctx);
  assert.equal(latest().status,"paused");
  assert.equal(latest().phase,"implement");
  assert.equal(sent.length,2,"no unverified QA run");
  await commands["jev-pipeline-resume"].handler("",ctx);
  assert.equal(latest().status,"running");
  await events.agent_start({},ctx);
  for(const id of [1,2]){
   const result=await tools.jev_progress.execute("s"+id,{
     action:"update",stepId:id,status:"done",note:"Verified donation flow and regression tests for step "+id
   },undefined,undefined,ctx);
   assert.equal(result.isError,undefined);
  }
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"qa");
  assert.equal(latest().status,"running");
  assert.ok(active.includes("jev_quality_gate"));
  assert.match(sent.at(-1),/JEV AUTO PIPELINE — QA/);
  assert.match(events.before_agent_start({systemPrompt:"",systemPromptOptions:{skills:[]}},ctx).systemPrompt,
    /JEV AUTO QUALITY GATE/);
  // QA without evidence stays in QA. Both outcomes are explicit model tool calls.
  const gate=await tools.jev_quality_gate.execute("q1",{
    outcome:"pass",evidence:"Ran unit tests and donation acceptance cases successfully"
  },undefined,undefined,ctx);
  assert.equal(gate.isError,undefined);
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"review");
  assert.ok(active.includes("jev_quality_gate"));
  assert.ok(!active.includes("write"),"Review enforces read-only tools");
  assert.match(sent.at(-1),/JEV AUTO PIPELINE — REVIEW/);
  const finished=await tools.jev_quality_gate.execute("r1",{
    outcome:"pass",evidence:"Read code and inspected security, diff and error handling"
  },undefined,undefined,ctx);
  assert.equal(finished.isError,undefined);
  await events.agent_settled({},ctx);
  assert.equal(latest().status,"completed");
  assert.equal(latest().phase,"completed");
  assert.equal(sent.length,5,"no duplicate runs after Review pass");
  await events.agent_settled({},ctx);
  assert.equal(sent.length,5,"completed pipeline must be idempotent");
  // A second explicit Auto approval starts a fresh run of the same plan.
  await commands["jev-plan-open"].handler("",ctx);
  assert.equal(latest().phase,"implement");
  for(const id of [1,2])
    await tools.jev_progress.execute("again"+id,{
      action:"update",stepId:id,status:"done",note:"Verified acceptance of rerun task "+id
    },undefined,undefined,ctx);
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"qa");
  const beforeFailure=sent.length;
  const failure=await tools.jev_quality_gate.execute("qa-failed",{
    outcome:"fail",evidence:"Integration tests failed for payment API timeout",
    issues:[{
      location:"src/api/donation.ts:120",
      observed:"HTTP timeout handling regressed on timed-out payment requests",
      expected:"Timed-out payment requests should return retryable errors",
      evidence:"Focused payment API regression test returns an uncaught timeout",
      suggestedFix:"Catch the timeout and emit a retryable error response"
    }]
  },undefined,undefined,ctx);
  assert.equal(failure.isError,undefined);
  await events.agent_settled({},ctx);
  assert.equal(latest().status,"running");
  assert.equal(latest().phase,"implement","QA fail must return to writable Lead");
  assert.ok(active.includes("write"),"Lead remediation is writable");
  assert.ok(active.includes("jev_qa_triage"));
  assert.ok(active.includes("jev_qa_fix"));
  assert.equal(latest().qaRecovery?.stage,"triage");
  assert.equal(latest().qaRecovery?.issues[0].id,"QA1");
  assert.equal(sent.length,beforeFailure+1,"QA fail schedules exactly one Lead turn");
  assert.match(sent.at(-1),/JEV AUTO QA REMEDIATION/);
  assert.match(sent.at(-1),/HTTP timeout handling regressed/);
  const prematureQaFix=await tools.jev_qa_fix.execute("premature-fix",{
    changedFiles:["src/api/donation.ts"],issueIds:["QA1"],
    evidence:"Updated timeout handling logic of payment integration.",
    verification:"Ran timeout regression tests and checked the exact diff."},
    undefined,undefined,ctx);
  assert.equal(prematureQaFix.isError,true,"Lead cannot skip QA feedback assessment");
  const triage=await tools.jev_qa_triage.execute("triage",{
    decisions:[{issueId:"QA1",disposition:"fix",
      rationale:"Timeout handling violates the API contract requirements.",
      evidence:"Reproduced timeout in focused payment API regression test."}]
  },undefined,undefined,ctx);
  assert.equal(triage.isError,undefined);
  assert.equal(latest().qaRecovery.stage,"fixing");
  const fixed=await tools.jev_qa_fix.execute("fix",{
    changedFiles:["src/api/donation.ts"],issueIds:["QA1"],
    evidence:"Adjusted payment timeout handling and retryable API error response.",
    verification:"Ran focused payment timeout tests and inspected the changed diff."
  },undefined,undefined,ctx);
  assert.equal(fixed.isError,undefined);
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"qa");
  assert.equal(latest().qa,undefined,"old fail is not the new QA verdict");
  assert.equal(latest().qaRecovery.fixRounds,1);
  assert.ok(!active.includes("write"),"QA is read-only again");
  assert.match(sent.at(-1),/Prior QA correction attempts/);
  const qaPass=await tools.jev_quality_gate.execute("qa-retry-pass",{
    outcome:"pass",evidence:"Payment timeout and API response regression tests passed."
  },undefined,undefined,ctx);
  assert.equal(qaPass.isError,undefined);
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"review");
  const reviewPass=await tools.jev_quality_gate.execute("review-retry-pass",{
    outcome:"pass",evidence:"Inspected timeout handling, changed diff and regression coverage."
  },undefined,undefined,ctx);
  assert.equal(reviewPass.isError,undefined);
  await events.agent_settled({},ctx);
  assert.equal(latest().status,"completed");
  await commands["jev-pipeline-stop"].handler("",ctx);
  assert.equal(latest().status,"completed");
  // Starting another approved plan with no Pi subagent must not fake a spawn.
  await commands["jev-plan-open"].handler("",ctx);
  delete tools.subagent;
  const noBackend=await tools.jev_delegate.execute("missing-plan",{action:"plan",
    tasks:[{stepId:1,files:["src/api/donation.ts"],dependsOn:[],effort:"large"}]
  },undefined,undefined,ctx);
  assert.equal(noBackend.isError,undefined);
  const beforeMissing=delegatedCalls.length;
  const noSpawn=await tools.jev_delegate.execute("missing-run",{action:"run"},
    undefined,undefined,ctx);
  assert.equal(noSpawn.isError,undefined,"Prefer strategy should support audited Lead execution");
  assert.match(noSpawn.content[0].text,/Lead task/);
  assert.equal(delegatedCalls.length,beforeMissing,"unavailable native subagent was never invoked");
  const fallbackEntries=()=>entries.filter(e=>e.customType==="jev-implementation-delegation").at(-1)?.data;
  assert.equal(fallbackEntries().waves[0].execution,"lead");
  assert.equal(fallbackEntries().runs,undefined,"no Builder success was fabricated");
  assert.ok(fallbackEntries().fallbacks[0].reason.includes("unavailable"));
  const shortNote=await tools.jev_progress.execute("short-evidence",{
    action:"update",stepId:1,status:"done",note:"ok"
  },undefined,undefined,ctx);
  assert.equal(shortNote.isError,true,"fallback requires meaningful completion evidence");
  const completed=await tools.jev_progress.execute("lead-verified",{
    action:"update",stepId:1,status:"done",
    note:"Lead inspected donation validation, ran tests and verified the changes."
  },undefined,undefined,ctx);
  assert.equal(completed.isError,undefined);
  // Registered subagent tools may still fail to spawn. That failure must not
  // be recorded as a Builder success, even if returned with nonempty text.
  tools.subagent={name:"subagent"};
  ctx.executeTool=async()=>({isError:true,content:[{type:"text",text:"NO Builder was spawned"}]});
  const blocked=await tools.jev_progress.execute("blocked",{
    action:"update",stepId:2,status:"blocked",note:"Agent unavailable"
  },undefined,undefined,ctx);
  assert.equal(blocked.isError,undefined);
  const remaining=await tools.jev_delegate.execute("subagent-plan",{
    action:"plan",tasks:[{stepId:2,files:["src/blocks/donate.ts"],dependsOn:[1],effort:"large"}]
  },undefined,undefined,ctx);
  assert.equal(remaining.isError,undefined);
  assert.equal(remaining.details.schedule.waves[0].execution,"builder");
  const unspawned=await tools.jev_delegate.execute("no-builder-result",{action:"run"},
    undefined,undefined,ctx);
  assert.equal(unspawned.isError,undefined);
  assert.match(unspawned.content[0].text,/NO Builder was spawned/);
  assert.equal(fallbackEntries().waves[0].execution,"lead");
  assert.equal(fallbackEntries().runs,undefined,"a textual no-spawn failure is not a Builder run");
  const leadResult=await tools.jev_progress.execute("lead-step-2",{
    action:"update",stepId:2,status:"done",
    note:"Lead verified the completed donation UI with focused regression tests."
  },undefined,undefined,ctx);
  assert.equal(leadResult.isError,undefined,"blocked steps may be verified after Lead fallback");
  assert.equal(leadResult.details.stage,"complete");
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"qa","finished Lead fallback must allow Auto QA");
  await tools.jev_quality_gate.execute("lead-qa",{
    outcome:"pass",evidence:"QA ran donation acceptance tests after Lead fallback"
  },undefined,undefined,ctx);
  await events.agent_settled({},ctx);
  assert.equal(latest().phase,"review");
  await tools.jev_quality_gate.execute("lead-review",{
    outcome:"pass",evidence:"Review inspected final diff, scope and security checks"
  },undefined,undefined,ctx);
  await events.agent_settled({},ctx);
  assert.equal(latest().status,"completed");
 }finally{
  if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=previous;
  rmSync(dir,{recursive:true,force:true});
 }
});
