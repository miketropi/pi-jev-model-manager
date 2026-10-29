import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
 const events={},commands={},entries=[],messages=[],sent=[],status=[],menus=[];
 let model=models[0],active=["read","write","bash","edit","grep","find","ls"];
 let option="Keep plan for later",edits=0;
 const ctx={mode:"tui",hasUI:true,scopedModels:[],
   get model(){return model;},
   sessionManager:{getBranch:()=>entries},
   ui:{
    notify(){},setWidget(...x){status.push(x)},setStatus(){},
    select:async(title,choices)=>{menus.push(title);return option},
    editor:async()=>{edits++;return "# Updated Plan\n\n"+"This plan now includes acceptance tests. ".repeat(5)},
   },
   modelRegistry:{getAvailable:()=>models,find:(p,id)=>p==="jev-manager"?virt:models.find(x=>x.provider===p&&x.id===id)}
 };
 const pi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
    registerCommand:(n,c)=>commands[n]=c,on:(n,cb)=>events[n]=cb,
    getActiveTools:()=>active,setActiveTools:(x)=>{active=x},getAllTools:()=>[],
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
  await events.session_start({reason:"reload"},ctx);
  assert.ok(status.some(x=>x[0]==="jev-plan-summary" && x[1]?.[0]?.includes("JEV PLAN")));
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
  assert.ok(entries.some(x=>x.customType==="jev-plan-document"&&x.data.status==="approved"));
  assert.equal(active.includes("write"),true);
  assert.ok(sent.at(-1).includes("approved Jev plan"));
  assert.ok(sent.at(-1).includes("acceptance tests"));
  assert.equal(entries.at(-1).data.task,"implement");
 }finally{
   if(prev===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=prev;
   rmSync(dir,{recursive:true,force:true});
 }
});
