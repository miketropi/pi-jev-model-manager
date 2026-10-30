import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WORKFLOW_COMMANDS, toolsForPhase, canUseTool, instructionsForTask, selectExplicitModel,
} from "../workflow.ts";
import { defaultTaskRules } from "../task-routing.ts";

test("explicit commands and strict read-only policy", () => {
  assert.deepEqual(Object.values(WORKFLOW_COMMANDS).sort(), [
    "jev-debug","jev-explain","jev-implement","jev-plan","jev-qa","jev-research","jev-review","jev-write",
  ]);
  assert.deepEqual(toolsForPhase(["read","bash","grep","edit","write","ls","Agent"],"plan"),
    ["read","bash","grep","ls"]);
  for (const name of ["bash","write","edit","Agent","mcp"]) assert.equal(canUseTool("plan",name),false);
  assert.equal(canUseTool("plan","read"),true);
  assert.equal(canUseTool("plan","bash",{command:"git log --oneline -8"}),true);
  assert.equal(canUseTool("plan","bash",{command:"rg Coolify README.md"}),true);
  assert.equal(canUseTool("plan","bash",{command:"npm install"}),false);
  assert.equal(canUseTool("plan","bash",{command:"git status; touch x"}),false);
  assert.equal(canUseTool("plan","bash",{command:"rg --pre=sh foo"}),false);
  assert.equal(canUseTool("plan","jev_web_fetch",{url:"https://github.com"}),true);
  assert.equal(canUseTool("plan","jev_ask_user",{}),true);
  assert.equal(canUseTool("review","edit"),false);
  assert.equal(canUseTool("implement","edit"),true);
  assert.equal(canUseTool("qa","bash",{command:"npm test"}),true);
  assert.equal(canUseTool("qa","write"),false);
  assert.equal(canUseTool("qa","edit"),false);
  assert.equal(canUseTool("qa","bash",{command:"npm install"}),false);
  assert.equal(canUseTool("qa","bash",{command:"echo changed > post.md"}),false);
  assert.equal(canUseTool("qa","bash",{command:"wc -w post.md"}),true);
  assert.deepEqual(toolsForPhase(["read","bash","write","edit","jev_quality_gate"],"qa"),
    ["read","bash","jev_quality_gate"]);
  assert.match(instructionsForTask("plan"),/Do not implement/);
  const rules=defaultTaskRules();
  rules.plan={mode:"force",model:"test/planner"};
  assert.equal(selectExplicitModel("plan","test/coder","test/coder",
    ["test/planner","test/coder"],rules).model,"test/planner");
});

test("Pi commands enforce planning restrictions and route explicit intent", async () => {
  const dir=mkdtempSync(join(tmpdir(),"jev-workflow-"));
  const previous=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=dir;
  const phys=["planner","builder","fallback"].map(id=>({provider:"test",id,api:"openai-completions"}));
  const virt={provider:"jev-manager",id:"auto",api:"pi-virtual"};
  const models=phys.map(m=>({key:"test/"+m.id,label:m.id,enabled:true,
    specialty:"general",avoid:"",cost:"balanced",thinking:"medium"}));
  const taskRules=defaultTaskRules();
  taskRules.plan={mode:"force",model:"test/planner"};
  taskRules.implement={mode:"force",model:"test/builder"};
  taskRules.review={mode:"force",model:"test/planner"};
  const cfg={version:1,enabled:false,mode:"auto",fallback:"test/fallback",minProbability:.43,
    classifier:{provider:"typesafe",model:"jev-latest"},
    nineRouter:{baseUrl:"http://127.0.0.1:20128/v1",apiKeyEnv:"NINEROUTER_API_KEY"},
    models,taskRules};
  let selected=phys[0],active=["read","bash","grep","write","edit","find","ls","Agent"];
  const original=[...active],cmds={},events={},entries=[],prompts=[],registered=[];
  let route,classifierCalls=0;
  const ctx={mode:"tui",hasUI:true,scopedModels:[],
    get model(){return selected;},
    sessionManager:{getBranch:()=>entries},
    ui:{notify(){},setStatus(){},setWidget(){}},
    modelRegistry:{
      getAvailable:()=>phys,
      find:(provider,id)=>provider==="jev-manager"?virt:phys.find(m=>m.provider===provider&&m.id===id),
      findOfType:()=>({id:"jev-latest"}),
      classify:async()=>{classifierCalls++;return {stopReason:"stop",answers:{
        task:{type:"choice",choice:"implement",probabilities:{implement:.99}},
        selected_model:{type:"choice",choice:"m2",probabilities:{m2:.99}},
      }};},
    },
  };
  const pi={
    registerProvider(){},unregisterProvider(){},
    registerTool:(tool)=>{registered.push(tool);},
    getAllTools:()=>registered,
    registerVirtualModel(m){route=m.route;},
    registerCommand(name,c){cmds[name]=c;},
    on(name,handler){events[name]=handler;},
    getActiveTools:()=>[...active],
    setActiveTools:(tools)=>{active=[...tools];},
    appendEntry:(customType,data)=>entries.push({type:"custom",customType,data}),
    sendUserMessage:(content,options)=>{
      prompts.push(content);assert.equal(options.deliverAs,"followUp");
    },
    setModel:async(model)=>{selected=model;return true;},
  };
  try {
    writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(cfg));
    const {default:extension}=await import("../index.ts");
    extension(pi);
    await events.session_start({},ctx);
    await cmds["jev-plan"].handler("Plan a Gutenberg donation block",ctx);
    assert.equal(prompts.at(-1),"Plan a Gutenberg donation block");
    assert.equal(selected.id,"auto");
    assert.deepEqual(active,["read","bash","grep","find","ls","jev_web_fetch","jev_ask_user","jev_herdr"]);
    assert.equal(entries.at(-1).data.task,"plan");
    assert.ok(registered.find(t=>t.name==="jev_ask_user"));
    assert.ok(registered.find(t=>t.name==="jev_web_fetch"));
    assert.ok(registered.find(t=>t.name==="jev_herdr"));
    assert.equal((await events.tool_call({toolName:"jev_herdr",input:{action:"list"}},ctx))?.block,undefined);
    assert.equal((await events.tool_call({toolName:"bash",input:{command:"herdr agent list"}},ctx))?.block,undefined);
    assert.equal(events.user_bash({command:"herdr agent get researcher"}),undefined);
    assert.equal((await events.tool_call({toolName:"bash",input:{command:"herdr agent prompt researcher hello"}},ctx))?.block,true);
    assert.equal(events.user_bash({command:"herdr pane run w1:p1 touch file"}).result.exitCode,1);
    assert.equal((await events.tool_call({toolName:"jev_ask_user",input:{}},ctx))?.block,undefined);
    assert.equal((await events.tool_call({toolName:"jev_web_fetch",input:{}},ctx))?.block,undefined);
    const injected=events.before_agent_start({systemPrompt:"Original Pi instructions"},ctx);
    assert.match(injected.systemPrompt,/PLAN MODE/);
    assert.match(injected.systemPrompt,/Do not implement/);
    for(const toolName of ["write","edit","bash","Agent","mcp"]){
      const blocked=await events.tool_call({toolName,input:{}},ctx);
      assert.equal(blocked.block,true);
    }
    assert.equal((await events.tool_call({toolName:"read",input:{path:"x.ts"}},ctx))?.block,undefined);
    assert.equal(events.user_bash({command:"touch x"},ctx).result.exitCode,1);
    assert.equal(events.user_bash({command:"git log --oneline -5"},ctx),undefined);
    assert.equal((await events.tool_call({toolName:"bash",input:{command:"git diff --stat"}},ctx))?.block,undefined);
    const plan=await route({reason:"user",messages:[{role:"user",content:"Implement the whole plugin immediately"}]},ctx);
    assert.equal(plan.model.id,"planner");
    assert.equal(plan.state.last.task,"plan");
    assert.equal(classifierCalls,0,"force routing bypasses classifier");

    await cmds["jev-review"].handler("Review existing code",ctx);
    assert.deepEqual(active,["read","bash","grep","find","ls","jev_web_fetch","jev_ask_user"]);
    assert.equal((await events.tool_call({toolName:"jev_herdr",input:{action:"list"}},ctx))?.block,true);
    await cmds["jev-implement"].handler("Implement approved donation block",ctx);
    assert.deepEqual(active,[...original,"jev_delegate","jev_progress"]);
    assert.equal((await events.tool_call({toolName:"write",input:{path:"x.ts"}},ctx))?.block,undefined);
    assert.equal(events.user_bash({command:"echo ok"},ctx),undefined);
    const impl=await route({reason:"user",messages:[{role:"user",content:"Plan but do not code"}]},ctx);
    assert.equal(impl.model.id,"builder");
    assert.equal(impl.state.last.task,"implement");
    assert.equal(classifierCalls,0);

    await cmds["jev-plan"].handler("",ctx);
    assert.deepEqual(active,["read","bash","grep","find","ls","jev_web_fetch","jev_ask_user","jev_herdr"]);
    assert.equal(prompts.length,3,"no-argument commands should not start turns");
    await events.session_start({reason:"reload"},ctx);
    assert.deepEqual(active,["read","bash","grep","find","ls","jev_web_fetch","jev_ask_user","jev_herdr"]);
    await cmds["jev-auto"].handler("",ctx);
    assert.deepEqual(active,original);
    assert.equal(entries.at(-1).data.task,null);
    assert.equal(events.before_agent_start({systemPrompt:"original"},ctx),undefined);
    await cmds["jev-debug"].handler("Fix unit tests",ctx);
    assert.equal(entries.at(-1).data.task,"debug");
    await cmds["jev-auto"].handler("",ctx);
  } finally {
    if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});
