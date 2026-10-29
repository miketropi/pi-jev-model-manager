import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Each Node test file is isolated in its own process, so CONFIG_PATH import is stable.
test("Jev task policy routes main turns and opt-in subagent spawns without overriding explicit models", async () => {
  const path=mkdtempSync(join(tmpdir(),"jev-subagent-test-"));
  const old=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=path;
  const rules={plan:{mode:"force",model:"test/strong"}, implement:{mode:"auto"},
    debug:{mode:"auto"},review:{mode:"force",model:"test/strong"},research:{mode:"auto"},explain:{mode:"auto"}};
  const settings={
    version:1,enabled:true,mode:"auto",fallback:"test/fast",minProbability:0.43,
    classifier:{provider:"typesafe",model:"jev-latest"},
    nineRouter:{baseUrl:"http://127.0.0.1:20128/v1",apiKeyEnv:"NINEROUTER_API_KEY"},
    models:[
      {key:"test/fast",label:"Fast",enabled:true,specialty:"coding",avoid:"",cost:"budget",thinking:"low"},
      {key:"test/strong",label:"Strong",enabled:true,specialty:"review",avoid:"",cost:"premium",thinking:"high"},
    ],taskRules:rules,subagentRouting:true,
  };
  const mockModels=settings.models.map(m=>({provider:"test",id:m.key.slice(5),api:"openai-completions"}));
  let classifierCalls=0;
  const ctx:any={
    scopedModels:[],hasUI:false,
    ui:{setStatus() {}},
    modelRegistry:{
      getAvailable:()=>mockModels,
      find:(p:string,id:string)=>mockModels.find(m=>m.provider===p && m.id===id),
      findOfType:()=>({id:"jev-latest"}),
      classify:async()=>{
        classifierCalls++;
        return {stopReason:"stop",answers:{
          task:{type:"choice",choice:"review",probabilities:{review:.97}},
          selected_model:{type:"choice",choice:"m0",probabilities:{m0:.97}},
        }};
      },
    },
  };
  const handlers:Record<string,Function>={};
  let route!: (request:any,ctx:any)=>Promise<any>;
  try {
    writeFileSync(join(path,"jev-model-manager.json"),JSON.stringify(settings));
    const {default: extension}=await import("../index.ts");
    extension({
      registerProvider() {},unregisterProvider() {},registerCommand() {},
      registerVirtualModel:(model:any)=>{route=model.route;},
      on:(name:string,handler:Function)=>{handlers[name]=handler;},
    } as any);
    const chosen=await route({reason:"prompt",messages:[{role:"user",content:"Review the authentication implementation"}]},ctx);
    assert.equal(chosen.model.id,"strong");
    assert.equal(chosen.thinkingLevel,"high");
    assert.equal(chosen.state.last.task,"review");
    assert.match(chosen.state.last.reason,/force policy/);
    const resumed=await route({reason:"continuation",previous:{model:chosen.model,thinkingLevel:"high"}},ctx);
    assert.equal(resumed.model.id,"strong");
    assert.equal(classifierCalls,1,"must not reroute tool continuations");
    assert.equal(typeof handlers.tool_call,"function");
    const input:any={agent:"reviewer",task:"Review pull request"};
    await handlers.tool_call({toolName:"agent_spawn",input},ctx);
    assert.equal(input.model,"test/strong");
    const hub:any={subagent_type:"Plan",prompt:"Analyze dependency migration",description:"Plan migration"};
    await handlers.tool_call({toolName:"Agent",input:hub},ctx);
    assert.equal(hub.model,"test/strong","Pi subagents-hub Plan role should follow plan policy");
    const manual:any={agent:"reviewer",task:"Review PR",model:"test/fast"};
    await handlers.tool_call({toolName:"agent_spawn",input:manual},ctx);
    assert.equal(manual.model,"test/fast","explicit model must never be overwritten");
    const official:any={agent:"reviewer",task:"Review PR"};
    await handlers.tool_call({toolName:"subagent",input:official},ctx);
    assert.equal(official.model,undefined,"unsupported tool parameters must not be injected");
    const unknown:any={agent:"reviewer",task:"Review PR"};
    await handlers.tool_call({toolName:"some_random_tool",input:unknown},ctx);
    assert.equal(unknown.model,undefined);
    settings.subagentRouting=false;
    writeFileSync(join(path,"jev-model-manager.json"),JSON.stringify(settings));
    const optOut:any={agent:"reviewer",task:"Review PR"};
    await handlers.tool_call({toolName:"agent_spawn",input:optOut},ctx);
    assert.equal(optOut.model,undefined,"opt-in cannot route when disabled");
  } finally {
    if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR=old;
    rmSync(path,{recursive:true,force:true});
  }
});
