import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

test("Jev classifier receives five families of hints for existing models without config migration",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-profile-routing-"));
 const prev=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=dir;
 const ids=["claude-sonnet-4-6","gpt-6.1-sol","deepseek-v4-flash",
  "MiniMax-M2.5","kimi-k2.5","my-unlisted-model"];
 const physical=ids.map(id=>({provider:"proxy",id,api:"openai-completions"}));
 const config={version:1,enabled:true,mode:"auto",fallback:"proxy/claude-sonnet-4-6",
  minProbability:.4,models:ids.map(id=>({
   key:"proxy/"+id,label:id,enabled:true,
   specialty:"General software engineering (edit capabilities after import)",
   avoid:"",cost:"balanced",thinking:"medium"
  }))};
 const path=join(dir,"jev-model-manager.json");
 try{
  writeFileSync(path,JSON.stringify(config));
  const {default:extension}=await import("../index.ts");
  let route,seen;
  const pi={registerProvider(){},unregisterProvider(){},registerTool(){},
   registerCommand(){},registerVirtualModel:virtual=>route=virtual.route,
   on(){}};
  extension(pi);
  const ctx={scopedModels:[],hasUI:false,mode:"rpc",
   modelRegistry:{
    getAvailable:()=>physical,
    find:(provider,id)=>physical.find(m=>m.provider===provider&&m.id===id),
    findOfType:()=>({provider:"test",id:"classifier"}),
    classify:async(_classifier,body)=>{
     seen=body;
     return {stopReason:"stop",answers:{
       task:{type:"choice",choice:"implement",probabilities:{implement:.98}},
       selected_model:{type:"choice",choice:"m4",probabilities:{m4:.95}}
     }};
    }
   }};
  const result=await route({reason:"user",messages:[{role:"user",
   content:"Implement a complex WordPress Gutenberg block"}]},ctx);
  assert.equal(result.model.id,"kimi-k2.5");
  const criteria=seen.questions.selected_model.criteria;
  assert.deepEqual(Object.keys(criteria),["m0","m1","m2","m3","m4","m5"]);
  for(const [i,family] of ["Claude","OpenAI","DeepSeek","MiniMax","Kimi"].entries()){
   assert.match(criteria["m"+i],new RegExp("Curated family context: "+family));
   assert.match(criteria["m"+i],/Best suited for:/);
   assert.match(criteria["m"+i],/Avoid for:/);
  }
  assert.doesNotMatch(criteria.m5,/Curated family context/);
  assert.equal(readFileSync(path,"utf8"),JSON.stringify(config),
   "existing user configuration must not be silently migrated or overwritten");
 }finally{
  if(prev===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=prev;
  rmSync(dir,{recursive:true,force:true});
 }
});
