import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
test("context extension projects outputs without modifying Pi history; checkpoint is session-only",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-context-v2-"));
 const saved=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 try {
  writeFileSync(join(dir,"jev-context-v2.json"),JSON.stringify({mode:"optimize"}));
  const handlers:any={},commands:any={};const entries:any[]=[];
  const pi:any={registerCommand:(name:string,v:any)=>commands[name]=v,
   registerTool(){},on:(name:string,fn:any)=>handlers[name]=fn,
   appendEntry:(name:string,data:any)=>entries.push({type:"custom",customType:name,data})};
  const {registerContextRuntime:install}=await import("../context/runtime-extension.ts");
  install(pi);
  let notice="";
  const ctx:any={getContextUsage:()=>({tokens:96000,contextWindow:128000}),
   sessionManager:{getBranch:()=>entries,getSessionId:()=>"test"},
   ui:{notify:(x:string)=>notice=x},modelRegistry:{}};
  handlers.session_start({},ctx);
  entries.push({type:"custom",customType:"jev-workflow-phase",data:{task:"implement"}});
  entries.push({type:"custom",customType:"jev-implementation-progress",
   data:{steps:[{id:1,status:"active",note:"secret"}]}});
  const messages=Array.from({length:8},(_,i)=>({role:"toolResult",toolName:"read",
   content:[{type:"text",text:String(i).repeat(24000)}]}));
  const original=JSON.stringify(messages);
  const result=handlers.context({messages},ctx);
  assert.equal(JSON.stringify(messages),original);
  assert.ok(result.messages[0].content[0].text.length<5000);
  assert.equal(result.messages.at(-1).content[0].text.length,24000);
  handlers.tool_result({toolName:"read",content:[{type:"text",text:"sensitive file content"}]},ctx);
  await commands["jev-context-report"].handler("",ctx);
  assert.match(notice,/Context Profiler/);
  assert.doesNotMatch(notice,/sensitive file content/);
  handlers.session_before_compact({},ctx);
  const checkpoint=entries.at(-1);
  assert.equal(checkpoint.customType,"jev-context-protected-checkpoint");
  assert.deepEqual(checkpoint.data.checklist,[{id:1,status:"active"}]);
  assert.doesNotMatch(JSON.stringify(checkpoint),/secret/);
  handlers.session_before_compact({},ctx);
  assert.equal(entries.filter(e=>e.customType==="jev-context-protected-checkpoint").length,1);
  handlers.session_compact({},ctx);
  await commands["jev-context-opt"].handler("off",ctx);
  assert.equal(handlers.context({messages},ctx),undefined);
 }finally{
  if(saved===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=saved;
  rmSync(dir,{recursive:true,force:true});
 }
});
