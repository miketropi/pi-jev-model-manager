import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {defaultTaskRules} from "../task-routing.ts";
test("third-party action-granted Pi/MCP tool is usable only in Plan and survives reload",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-capability-flow-"));
 const previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 const models=["planner","builder"].map(id=>({provider:"test",id,api:"openai-completions"}));
 const virt={provider:"jev-manager",id:"auto",api:"pi-virtual"};
 const rules=defaultTaskRules();
 rules.plan={mode:"force",model:"test/planner"};
 rules.review={mode:"force",model:"test/planner"};
 const config={version:1,enabled:true,mode:"auto",fallback:"test/planner",
   models:models.map(m=>({key:"test/"+m.id,label:m.id,enabled:true,
     specialty:"coding",avoid:"",cost:"balanced",thinking:"medium"})),
   taskRules:rules,
   toolGrants:[{tool:"paseo_peer",capability:"delegate_research",
     phases:["plan"],actionField:"operation",allowedActions:["ask_peer","status"]}],
   peerAdapters:[{id:"another_backend",executable:"peer-runtime",
     commands:{list:["peers","ls"],prompt:["peers","ask","{target}","{prompt}"]}}]};
 let selected=models[0],active=["read","write","edit","bash","find","ls"];
 const original=[...active],tools={},events={},commands={},entries=[];
 const ctx={mode:"tui",hasUI:true,scopedModels:[],
   get model(){return selected;},
   sessionManager:{getBranch:()=>entries,getSessionId:()=>"capability-test"},
   modelRegistry:{getAvailable:()=>models,
     find:(p,id)=>p==="jev-manager"?virt:models.find(m=>m.provider===p&&m.id===id)},
   ui:{notify(){},setStatus(){},setWidget(){}},waitForIdle:async()=>{}};
 const pi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
   registerTool:(x)=>tools[x.name]=x,registerCommand:(x,y)=>commands[x]=y,
   on:(n,cb)=>events[n]=cb,
   getActiveTools:()=>active,setActiveTools:x=>active=[...x],
   getAllTools:()=>Object.values(tools),
   appendEntry:(type,data)=>entries.push({type:"custom",customType:type,data}),
   sendUserMessage(){},sendMessage(){},setModel:async(x)=>{selected=x;return true}};
 try {
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(config));
  const {default:extension}=await import("../index.ts");
  extension(pi);
  tools.paseo_peer={name:"paseo_peer"};
  await events.session_start({},ctx);
  await commands["jev-plan"].handler("",ctx);
  assert.ok(active.includes("paseo_peer"),"trusted external tool is visible in Plan");
  assert.ok(!active.includes("jev_collaborate"),"optional unverified peer should not appear in Plan");
  assert.equal((await events.tool_call({toolName:"paseo_peer",
    input:{operation:"ask_peer",target:"architect"}},ctx))?.block,undefined);
  assert.equal((await events.tool_call({toolName:"paseo_peer",
    input:{operation:"spawn_agent"}},ctx))?.block,true);
  assert.equal((await events.tool_call({toolName:"other_peer",
    input:{operation:"ask_peer"}},ctx))?.block,true);
  assert.equal((await events.tool_call({toolName:"write",input:{path:"x"}},ctx))?.block,true);
  await commands["jev-review"].handler("",ctx);
  assert.ok(!active.includes("paseo_peer"),"Plan-only grant doesn't leak to Review");
  assert.ok(!active.includes("jev_collaborate"),"generic collaboration does not leak to Review");
  assert.equal((await events.tool_call({toolName:"paseo_peer",
    input:{operation:"ask_peer"}},ctx))?.block,true);
  await commands["jev-plan"].handler("",ctx);
  assert.ok(active.includes("paseo_peer"));
  await events.session_start({reason:"reload"},ctx);
  assert.ok(active.includes("paseo_peer"),"granted tool survives Pi session reload");
  assert.ok(!active.includes("jev_collaborate"),"optional unverified peer should not appear in Plan");
  await commands["jev-auto"].handler("",ctx);
  assert.deepEqual(active,original,"original tools restored, no Plan-only tools leaked");
 }finally{
  if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=previous;
  rmSync(dir,{recursive:true,force:true});
 }
});
