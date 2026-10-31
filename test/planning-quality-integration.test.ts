import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

test("explicit Plan selects quality model, stays sticky, and honors force override",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-plan-quality-"));
 const old=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 try {
  const models=[
   {id:"gpt-5.6-luna",label:"Builder • Fast (GPT-5.6 Luna)"},
   {id:"claude-opus-4-6",label:"Architect • Deep"},
   {id:"claude-sonnet-4-6",label:"Builder • Balanced"}
  ].map(({id,label})=>({
   key:"proxy/"+id,label,enabled:true,specialty:"General software engineering",
   avoid:"",cost:"balanced",thinking:"medium",
  }));
  const config:any={version:1,enabled:true,mode:"auto",fallback:models[0].key,
    minProbability:.43,models};
  const configPath=join(dir,"jev-model-manager.json");
  const persist=()=>writeFileSync(configPath,JSON.stringify(config));
  persist();
  const physical=models.map(m=>({provider:"proxy",id:m.key.split("/")[1],
    api:"openai-completions",reasoning:true,contextWindow:128000,maxTokens:8192}));
  const notices:string[]=[],statuses:string[]=[];
  const events:Record<string,any>={},commands:Record<string,any>={};
  let route:any,active:string[]=["read","bash","grep","find","ls"];
  let selected:any={provider:"jev-manager",id:"auto",api:"pi-virtual"};
  let classifierCalls=0;
  let receivedChoices:string[][]=[];
  const entries:any[]=[];
  const ctx:any={
    mode:"tui",hasUI:true,scopedModels:[],get model(){return selected;},
    sessionManager:{getBranch:()=>entries,getSessionId:()=>"plan-test"},
    ui:{notify:(v:string)=>notices.push(v),setStatus:(_id:string,v:string)=>statuses.push(v),
      setWidget:()=>{},},
    modelRegistry:{
      getAvailable:()=>physical,
      find:(provider:string,id:string)=>provider==="jev-manager"?selected:
        physical.find(m=>m.provider===provider&&m.id===id),
      findOfType:()=>({provider:"test",id:"jev-latest"}),
      classify:async(_classifier:any,body:any)=>{
        classifierCalls++;
        receivedChoices.push(Object.keys(body.questions.selected_model.criteria));
        return {stopReason:"stop",answers:{
          task:{type:"choice",choice:"plan",probabilities:{plan:.99}},
          selected_model:{type:"choice",choice:"m0",probabilities:{m0:.99}}
        }};
      }
    }
  };
  const pi:any={
    registerVirtualModel:(m:any)=>{route=m.route;},
    registerCommand:(name:string,obj:any)=>{commands[name]=obj;},
    registerTool(){},registerProvider(){},unregisterProvider(){},
    on:(name:string,fn:any)=>{events[name]=fn;},
    getAllTools:()=>[],getActiveTools:()=>[...active],
    setActiveTools:(names:string[])=>{active=[...names];},
    setModel:async(m:any)=>{selected=m;return true;},
    appendEntry:(customType:string,data:any)=>entries.push({type:"custom",customType,data}),
    sendUserMessage(){},
  };
  const {default:extension}=await import("../index.ts");
  extension(pi);
  await events.session_start({reason:"startup"},ctx);
  await commands["jev-plan"].handler("Architect a Gutenberg donation workflow",ctx);
  const direct=await route({reason:"direct",messages:[]},ctx);
  assert.equal(direct.model.id,"claude-opus-4-6",
    "initial direct Plan dispatch must not select configured fast-tier fallback");
  assert.equal(classifierCalls,0,"direct route does not need a classifier request");
  const first=await route({reason:"user",messages:[{role:"user",content:"Architecture proposal"}]},ctx);
  assert.equal(first.model.id,"claude-opus-4-6");
  assert.deepEqual(receivedChoices[0],["m0","m1"],"classifier never sees Luna while stronger planning models are eligible");
  assert.match(first.state.last.reason,/quality floor/);
  const second=await route({reason:"user",messages:[{role:"user",content:"Refine architecture and tradeoffs"}]},ctx);
  assert.equal(second.model.id,"claude-opus-4-6");
  assert.match(second.state.last.reason,/task-affinity/);
  assert.equal(classifierCalls,1,"avoid unnecessary model re-selection during an ongoing Plan");
  config.taskRules={plan:{mode:"force",model:models[0].key}};
  persist();
  const forced=await route({reason:"user",messages:[{role:"user",content:"Continue planning"}]},ctx);
  assert.equal(forced.model.id,"gpt-5.6-luna","explicit user force must override quality heuristic");
  assert.match(forced.state.last.reason,/force/);
  config.taskRules={plan:{mode:"auto"}};
  persist();
  const recoveredInitial=await route({reason:"user",messages:[{role:"user",content:"Continue high-quality plan"}]},ctx);
  assert.equal(recoveredInitial.model.id,"claude-opus-4-6","old forced fast model must not stick after changing policy to auto");
  const recovered=await route({reason:"retry",state:recoveredInitial.state,
   failed:{model:recoveredInitial.model,thinkingLevel:"medium",
    message:{stopReason:"error",errorMessage:"HTTP 503 Service Unavailable"}}},ctx);
  assert.equal(recovered.model.id,"claude-sonnet-4-6",
    "provider failure must not send Planning back to fast-tier when balanced model is healthy");
  config.models=[models[0]];
  persist();
  const onlyFast=await route({reason:"user",messages:[{role:"user",content:"Only fast available"}]},ctx);
  assert.equal(onlyFast.model.id,"gpt-5.6-luna");
  assert.ok(notices.some(n=>n.includes("Plan quality warning")&&n.includes("fast-tier")));
 } finally {
  if (old===undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=old;
  rmSync(dir,{recursive:true,force:true});
 }
});
