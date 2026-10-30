import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {defaultTaskRules} from "../task-routing.ts";
import {PIPELINE_ENTRY} from "../auto-pipeline.ts";
import {DELEGATION_ENTRY} from "../delegation.ts";

test("Builder empty text and thrown error recover only affected waves, then QA/Review",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-silent-builder-"));
 const prior=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 const models=["planner","builder","tester","reviewer"].map(id=>({provider:"test",id,api:"openai-completions"}));
 const virtual={provider:"jev-manager",id:"auto",api:"pi-virtual"};
 const rules=defaultTaskRules();
 for(const [task,id] of [["plan","planner"],["implement","builder"],["qa","tester"],["review","reviewer"]])
   rules[task]={mode:"force",model:"test/"+id};
 const config={version:1,enabled:true,mode:"auto",fallback:"test/planner",
   models:models.map(m=>({key:"test/"+m.id,label:m.id,enabled:true,specialty:"coding",
     avoid:"",cost:"balanced",thinking:"medium"})),taskRules:rules};
 const tools={},commands={},events={},entries=[],sent=[];
 let model=models[0],active=["read","write","edit","bash","grep","find","ls"];
 const ctx={mode:"tui",hasUI:true,scopedModels:[],
   get model(){return model;},
   sessionManager:{getBranch:()=>entries,getSessionId:()=>"silent-builder-test"},
   modelRegistry:{getAvailable:()=>models,
     find:(provider,id)=>provider==="jev-manager"?virtual:models.find(m=>m.provider===provider&&m.id===id)},
   ui:{select:async()=>"Auto Implement → QA → Review (approve plan)",
     editor:async()=>undefined,setWidget(){},setStatus(){},notify(){}},
   waitForIdle:async()=>{}
 };
 const pi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
   registerTool:t=>tools[t.name]=t,registerCommand:(n,c)=>commands[n]=c,
   on:(n,cb)=>events[n]=cb,
   getActiveTools:()=>active,setActiveTools:a=>active=a,getAllTools:()=>Object.values(tools),
   appendEntry:(type,data)=>entries.push({type:"custom",customType:type,data}),
   sendUserMessage:(msg)=>sent.push(msg),sendMessage(){},
   setModel:async(m)=>{model=m;return true}};
 const schedule=()=>entries.filter(e=>e.customType===DELEGATION_ENTRY).at(-1)?.data;
 const pipeline=()=>entries.filter(e=>e.customType===PIPELINE_ENTRY).at(-1)?.data;
 const params=(stepId,status,note)=>({action:"update",stepId,status,note});
 try {
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(config));
  const {default:extension}=await import("../index.ts");
  extension(pi);
  tools.subagent={name:"subagent"};
  let spawned=0;
  ctx.executeTool=async()=>{
   spawned++;
   if(spawned===3)return {content:[],details:{results:[{exitCode:0}]}};
   if(spawned===4)throw Error("subprocess stream closed before final report");
   return {content:[{type:"text",text:"Builder delivered file edits and a report."}]};
  };
  await events.session_start({},ctx);
  await commands["jev-plan"].handler("Check DeepSeek sources in an article",ctx);
  await events.agent_start({},ctx);
  const plan="# Approved Plan\n## Implementation Steps\n"+
    "1. Check GitHub\n2. Check Hugging Face\n3. Check DeepSeek Platform and API docs\n"+
    "4. Verify citation dates\n5. Final article check\n## Verification\n"+"Verify official citations. ".repeat(14);
  await events.agent_end({messages:[{role:"assistant",stopReason:"stop",
    content:[{type:"text",text:plan}]}]},ctx);
  await events.agent_settled({},ctx);
  assert.equal(pipeline().phase,"implement");
  const tasks=[1,2,3,4,5].map(i=>({
    stepId:i,files:["posts/step"+i+".md"],dependsOn:i===1?[]:[i-1],effort:"large"
  }));
  const proposed=await tools.jev_delegate.execute("plan",{action:"plan",tasks},undefined,undefined,ctx);
  assert.equal(proposed.isError,undefined);
  assert.deepEqual(schedule().waves.map(w=>w.execution),["builder","builder","builder","builder","builder"]);
  for(const n of [1,2]){
   const outcome=await tools.jev_delegate.execute("wave"+n,{action:"run"},undefined,undefined,ctx);
   assert.equal(outcome.details.status,"reported");
   const done=await tools.jev_progress.execute("step"+n,params(n,"done",
      "Lead checked real source evidence and verified the article references."),
      undefined,undefined,ctx);
   assert.equal(done.isError,undefined);
  }
  const blocked=await tools.jev_progress.execute("premature",params(3,"done",
    "Lead checked endpoints by HTTP 200"),undefined,undefined,ctx);
  assert.equal(blocked.isError,true,"Builder wave must not be marked done before a report");
  const silent=await tools.jev_delegate.execute("wave3",{action:"run"},undefined,undefined,ctx);
  assert.equal(silent.isError,undefined,"Jev handled missing report via an explicit recovery result");
  assert.equal(silent.details.status,"lead-verification-required");
  assert.match(silent.content[0].text,/Builder wave 3 ERROR/);
  assert.match(silent.content[0].text,/No step was marked done automatically|NO checklist step auto-completed/);
  assert.equal(schedule().runs[2].status,"error","failed Builder run must remain an error");
  assert.deepEqual(schedule().waves.map(w=>w.execution),["builder","builder","lead","builder","builder"],
    "later healthy Builder wave must remain delegated");
  assert.equal(schedule().fallbacks[0].wave,2);
  const inspect=await tools.jev_delegate.execute("check-status",{action:"status"},
    undefined,undefined,ctx);
  assert.equal(inspect.isError,undefined);
  assert.match(inspect.content[0].text,/Wave 3.*LEAD.*error/);
  assert.match(inspect.content[0].text,/Wave 4.*BUILDER.*not dispatched/);
  const tooShort=await tools.jev_progress.execute("short",params(3,"done","HTTP 200"),
    undefined,undefined,ctx);
  assert.equal(tooShort.isError,true);
  const verified=await tools.jev_progress.execute("verified",params(3,"done",
    "Lead directly checked official docs, date context, cited statements and final article."),
    undefined,undefined,ctx);
  assert.equal(verified.isError,undefined);
  assert.notEqual(verified.details.stage,"complete");
  const exception=await tools.jev_delegate.execute("wave4",{action:"run"},undefined,undefined,ctx);
  assert.equal(exception.isError,undefined);
  assert.equal(exception.details.status,"lead-verification-required");
  assert.match(exception.content[0].text,/Subagent tool threw/);
  assert.equal(schedule().runs[3].status,"error");
  assert.deepEqual(schedule().waves.map(w=>w.execution),
    ["builder","builder","lead","lead","builder"]);
  const corrected=await tools.jev_progress.execute("step4",params(4,"done",
    "Lead checked the file edits and confirmed the dated citations manually."),
    undefined,undefined,ctx);
  assert.equal(corrected.isError,undefined);
  const later=await tools.jev_delegate.execute("wave5",{action:"run"},undefined,undefined,ctx);
  assert.equal(later.details.status,"reported","later Builder waves still run normally");
  const last=await tools.jev_progress.execute("step5",params(5,"done",
    "Lead reviewed the final article and verified sources and cited dates."),
    undefined,undefined,ctx);
  assert.equal(last.details.stage,"complete");
  assert.equal(spawned,5,"no duplicate spawn after empty or thrown Builder result");
  await events.agent_start({},ctx);await events.agent_settled({},ctx);
  assert.equal(pipeline().phase,"qa");
  await tools.jev_quality_gate.execute("qa",{outcome:"pass",
    evidence:"QA checked every official URL, article citation, and date."},
    undefined,undefined,ctx);
  await events.agent_settled({},ctx);
  assert.equal(pipeline().phase,"review");
  await tools.jev_quality_gate.execute("review",{outcome:"pass",
    evidence:"Review verified source attribution and final changes."},
    undefined,undefined,ctx);
  await events.agent_settled({},ctx);
  assert.equal(pipeline().status,"completed");
 }finally{
  if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=prior;
  rmSync(dir,{recursive:true,force:true});
 }
});
