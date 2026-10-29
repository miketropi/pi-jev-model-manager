import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultTaskRules } from "../task-routing.ts";

test("plan completes into reviewable Markdown; edit then approve and implement in same session",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-planflow-"));
 const prev=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const models=["planner","builder"].map(id=>({provider:"test",id,api:"openai-completions"}));
 const virt={provider:"jev-manager",id:"auto",api:"pi-virtual"};
 const rules=defaultTaskRules();
 rules.plan={mode:"force",model:"test/planner"};rules.implement={mode:"force",model:"test/builder"};
 const config={version:1,enabled:true,mode:"auto",fallback:"test/planner",minProbability:.43,
  models:models.map(m=>({key:"test/"+m.id,label:m.id,enabled:true,specialty:"coding",avoid:"",cost:"balanced",thinking:"medium"})),
  taskRules:rules};
 const events={},commands={},entries=[],messages=[],sent=[],status=[],menus=[],tools={};
 let model=models[0],active=["read","write","bash","edit","grep","find","ls"];
 let option="Keep plan for later",edits=0;
 const ctx={mode:"tui",hasUI:true,scopedModels:[],
   get model(){return model;},
   sessionManager:{getBranch:()=>entries,getSessionId:()=>"jev-test-session-01"},
   ui:{
    notify(){},setWidget(...x){status.push(x)},setStatus(){},
    select:async(title,choices)=>{menus.push(title);return option},
    editor:async()=>{edits++;return "# Updated Plan\n\n"+"This plan now includes acceptance tests. ".repeat(5)},
   },
   modelRegistry:{getAvailable:()=>models,find:(p,id)=>p==="jev-manager"?virt:models.find(x=>x.provider===p&&x.id===id)}
 };
 const pi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
    registerTool:(t)=>tools[t.name]=t,
    registerCommand:(n,c)=>commands[n]=c,on:(n,cb)=>events[n]=cb,
    getActiveTools:()=>active,setActiveTools:(x)=>{active=x},
    getAllTools:()=>tools.jev_progress?[tools.jev_progress]:[],
    appendEntry:(type,data)=>entries.push({type:"custom",customType:type,data}),
    sendUserMessage:(txt)=>sent.push(txt),sendMessage:(m)=>messages.push(m),
    setModel:async(m)=>{model=m;return true},
 };
 try{
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(config));
  const {default:ext}=await import("../index.ts");ext(pi);
  await events.session_start({},ctx);
  await commands["jev-plan"].handler("Plan a Gutenberg donation block",ctx);
  assert.deepEqual(active,["read","bash","grep","find","ls"]);
  await events.agent_start({},ctx);
  const longPlan="# Donation Block Plan\n\n"+"1. Inspect the donation API and existing Gutenberg block files.\n".repeat(7);
  await events.agent_end({messages:[{role:"assistant",stopReason:"stop",content:[{type:"text",text:longPlan}]}]},ctx);
  await events.agent_settled({},ctx);
  assert.ok(entries.some(x=>x.customType==="jev-plan-document"));
  assert.ok(messages.some(x=>x.customType==="jev-plan-preview"&&x.display===true));
  assert.equal(model.id,"auto");
  option="Cancel";
  const beforeCancel=sent.length;
  await commands["jev-plan-open"].handler("",ctx);
  assert.equal(sent.length,beforeCancel,"Cancel must never trigger execution");
  assert.equal(status.filter(x=>x[0]==="jev-plan-summary").at(-1)?.[1],undefined,
    "Cancel must dismiss the plan widget");
  await events.session_start({reason:"reload"},ctx);
  assert.equal(status.filter(x=>x[0]==="jev-plan-summary").at(-1)?.[1],undefined,
    "Cancel must stay dismissed across reloads");
  option="Keep plan for later";
  assert.equal(active.includes("write"),false,"Plan cannot write");
  assert.equal(sent.length,1,"Keep later doesn't auto-implement");
  option="View / edit full plan";
  // Editor returns an edit; follow-up menu closes safely on next iteration.
  let calls=0;ctx.ui.select=async()=>++calls===1?"View / edit full plan":"Keep plan for later";
  await commands["jev-plan-open"].handler("",ctx);
  assert.equal(edits,1);
  assert.ok(entries.filter(x=>x.customType==="jev-plan-document").length>=2);
  option="Implement now (approve plan)";
  ctx.ui.select=async()=>option;
  await commands["jev-plan-open"].handler("",ctx);
  const {planMirrorPath}=await import("../plan-cache.ts");
  const tempPlan=planMirrorPath("jev-test-session-01");
  assert.ok(tempPlan && existsSync(tempPlan),"approved plan mirror is outside project");
  assert.ok(entries.some(x=>x.customType==="jev-plan-document"&&x.data.status==="approved"));
  assert.equal(active.includes("write"),true);
  assert.ok(tools.jev_progress,"LLM progress tool is registered");
  assert.ok(active.includes("jev_progress"),"Implementation enables progress reporting");
  assert.match(status.filter(x=>x[0]==="jev-implementation-checklist").at(-1)?.[1]?.[0]??"",/JEV IMPLEMENT/);
  assert.match(sent.at(-1), /IMPLEMENTATION REQUIRED/);
  assert.match(sent.at(-1), /produce the finished article\/content/);
  assert.ok(sent.at(-1).includes("acceptance tests"));
  assert.equal(entries.at(-1).data.task,"implement");
  assert.equal(entries.some(x=>x.customType==="jev-auto-pipeline"),false,
    "manual Implement now must not start automatic QA/Review");
  assert.equal(status.filter(x=>x[0]==="jev-plan-summary").at(-1)?.[1],undefined,
    "approved plan widget must disappear on handoff");
  assert.equal(messages.filter(x=>x.customType==="jev-plan-preview").length,2,
    "approval must not reinject another planning message");
  const nextPrompt = events.before_agent_start({systemPrompt:"Original system prompt"},ctx);
  assert.match(nextPrompt.systemPrompt,/CRITICAL APPROVAL HANDOFF/);
  assert.match(nextPrompt.systemPrompt,/Do NOT update\/rewrite the plan/);
  assert.doesNotMatch(nextPrompt.systemPrompt,/PLAN DOCUMENT REQUIREMENT/);
  await events.agent_start({},ctx);
  await events.agent_end({messages:[{role:"assistant",stopReason:"stop",
    content:[{type:"text",text:"Finished delivery."}]}]},ctx);
  await events.agent_settled({},ctx);
  assert.equal(existsSync(tempPlan),false,"temporary file cleaned after implementation turn");
  assert.equal(entries.filter(x=>x.customType==="jev-implementation-progress").at(-1)?.data.stage,"paused",
    "unverified steps remain paused rather than silently completed");
  assert.match(status.filter(x=>x[0]==="jev-implementation-checklist").at(-1)?.[1]?.[0]??"",/PAUSED/);
  await events.session_start({reason:"reload"},ctx);
  assert.match(status.filter(x=>x[0]==="jev-implementation-checklist").at(-1)?.[1]?.[0]??"",/PAUSED/,
    "checklist should recover after /reload");
  assert.equal(status.filter(x=>x[0]==="jev-plan-summary").at(-1)?.[1],undefined,
    "plan widget stays dismissed after implementation finishes");
  await events.agent_start({},ctx);
  assert.equal(existsSync(tempPlan),true,"temporary file restored outside repo when resuming");
  const bad=await tools.jev_progress.execute("p1",
    {action:"update",stepId:1,status:"done"},undefined,undefined,ctx);
  assert.equal(bad.isError,true,"cannot claim completion without verification");
  const good=await tools.jev_progress.execute("p2",
    {action:"update",stepId:1,status:"done",note:"Verified final deliverable and acceptance checks"},
    undefined,undefined,ctx);
  assert.equal(good.details.stage,"complete");
  assert.equal(existsSync(tempPlan),false,"verified completion removes temporary Markdown");
  assert.equal(status.filter(x=>x[0]==="jev-implementation-checklist").at(-1)?.[1],undefined);
  await events.agent_settled({},ctx);
  await events.session_start({reason:"reload"},ctx);
  assert.equal(status.filter(x=>x[0]==="jev-plan-summary").at(-1)?.[1],undefined,
    "approved plan widget stays hidden on /reload");
  await commands["jev-plan-hide"].handler("",ctx);
  assert.equal(status.filter(x=>x[0]==="jev-plan-summary").at(-1)?.[1],undefined);
 }finally{
   if(prev===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prev;
   rmSync(dir,{recursive:true,force:true});
 }
});
