import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
test("routing avoids smaller window, diagnoses provider parameter errors without exposing messages", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-reliability-"));
 const prev=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 try {
  const models=["tiny","large"].map(id=>({
    key:"test/"+id,label:id,enabled:true,specialty:"production coding",
    avoid:"",thinking:"high",cost:"balanced",
    contextWindow:id==="tiny"?40000:128000,maxTokens:8192,
  }));
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify({
    version:1,enabled:true,mode:"auto",models,fallback:"test/tiny",minProbability:.4,
    health:{enabled:true,autoFailover:true,cooldownSeconds:90,maxCooldownSeconds:900}
  }));
  const catalog=models.map(m=>({provider:"test",id:m.key.split("/")[1],
    api:"openai-completions",contextWindow:m.contextWindow,maxTokens:m.maxTokens,reasoning:false}));
  const cmds:Record<string,any>={},handlers:Record<string,any>={};
  let route:any;
  const pi:any={
    registerVirtualModel:(m:any)=>route=m.route,
    registerCommand:(name:string,cmd:any)=>cmds[name]=cmd,
    registerTool(){}, registerProvider(){}, unregisterProvider(){},
    on:(name:string,handler:any)=>handlers[name]=handler,
  };
  const {default:extension}=await import("../index.ts");
  extension(pi);
  const notices:string[]=[];
  const ctx:any={
    hasUI:false,mode:"rpc",scopedModels:[],
    getContextUsage:()=>({tokens:36000,contextWindow:128000,percent:28}),
    ui:{notify:(text:string)=>notices.push(text),setStatus(){}},
    modelRegistry:{
      getAvailable:()=>catalog,
      find:(p:string,id:string)=>catalog.find(m=>m.provider===p&&m.id===id),
      findOfType:()=>({provider:"typesafe",id:"jev-latest"}),
      classify:async()=>({stopReason:"stop",answers:{
        task:{type:"choice",choice:"implement",probabilities:{implement:.99}},
        selected_model:{type:"choice",choice:"m0",probabilities:{m0:.99}},
      }})
    }
  };
  const chosen=await route({reason:"user",messages:[{role:"user",content:"Implement feature"}]},ctx);
  assert.equal(chosen.model.id,"large");
  assert.equal(chosen.thinkingLevel,"off");
  const secret="API_KEY=super-secret";
  await handlers.message_end({message:{role:"assistant",provider:"test",model:"large",
     stopReason:"error",errorMessage:"HTTP 400 unsupported reasoning "+secret}},ctx);
  await cmds["jev-diagnose"].handler("",ctx);
  const notice=notices.join("\n");
  assert.match(notice,/Selected: test\/large/);
  assert.match(notice,/Last provider error: parameter/);
  assert.doesNotMatch(notice,/super-secret|API_KEY/);
  await assert.rejects(route({reason:"retry",failed:{
    model:chosen.model,thinkingLevel:"high",
    message:{stopReason:"error",errorMessage:"HTTP 400 unsupported reasoning"}
   },state:chosen.state},ctx),/invalid provider model parameters/);
 }finally{
  if(prev===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=prev;
  rmSync(dir,{recursive:true,force:true});
 }
});
