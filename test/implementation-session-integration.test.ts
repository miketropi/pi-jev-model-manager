import test, {after} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {defaultTaskRules} from "../task-routing.ts";
import {SESSION_ORIGIN_ENTRY} from "../implementation-session.ts";
import {PIPELINE_ENTRY} from "../auto-pipeline.ts";
const sharedDir=mkdtempSync(join(tmpdir(),"jev-child-session-shared-"));
after(()=>rmSync(sharedDir,{recursive:true,force:true}));
for(const rejectModel of [false,true])test(
  "Plan handoff "+(rejectModel?"blocks kickoff on model rejection":"activates Jev before kickoff"),
  async()=>{
 const dir=sharedDir;
 const prior=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const models=["planner","builder","tester","reviewer"].map(id=>({provider:"test",id,api:"openai-completions"}));
 const virt={provider:"jev-manager",id:"auto",api:"pi-virtual"};
 const rules=defaultTaskRules();
 for(const task of ["plan","implement","qa","review"])
  rules[task]={mode:"force",model:"test/"+({plan:"planner",implement:"builder",qa:"tester",review:"reviewer"}[task])};
 const cfg={version:1,enabled:true,mode:"auto",fallback:"test/planner",minProbability:0.42,
   models:models.map(m=>({key:"test/"+m.id,label:m.id,enabled:true,specialty:"coding",avoid:"",cost:"balanced",thinking:"medium"})),
   taskRules:rules};
 const originalEntries=[],parentEvents={},parentCommands={},parentTools={},parentSent=[],uiText=[];
 const parentPath="/home/user/.pi/agent/sessions/plan.jsonl";
 const modelRegistry={getAvailable:()=>models,find:(provider,id)=>provider==="jev-manager"?virt:models.find(m=>m.provider===provider&&m.id===id)};
 let parentActive=["read","write","bash","edit","grep","find","ls"],parentModel=models[0];
 const parentCtx={mode:"tui",hasUI:true,scopedModels:[],get model(){return parentModel;},
  modelRegistry,waitForIdle:async()=>{},
  sessionManager:{getBranch:()=>originalEntries,getSessionId:()=>"parent-id",getSessionFile:()=>parentPath},
  ui:{setWidget(){},setStatus(){},notify(){},setEditorText:x=>uiText.push(x),
   select:async()=>"Auto Implement → QA → Review · New session",editor:async()=>undefined}
 };
 let childState;
 const {default:ext}=await import("../index.ts");
 const pi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
  registerTool:t=>parentTools[t.name]=t,registerCommand:(n,c)=>parentCommands[n]=c,
  on:(n,h)=>parentEvents[n]=h,getActiveTools:()=>parentActive,
  setActiveTools:x=>parentActive=x,getAllTools:()=>Object.values(parentTools),
  appendEntry:(type,data)=>originalEntries.push({type:"custom",customType:type,data}),
  sendUserMessage:x=>parentSent.push(x),sendMessage(){},
  setModel:async m=>{parentModel=m;return true}};
 try{
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(cfg));
  ext(pi);
  await parentEvents.session_start({reason:"resume"},parentCtx);
  await parentCommands["jev-plan"].handler("Plan charity donation block",parentCtx);
  await parentEvents.agent_start({},parentCtx);
  const markdown="# Donation Block\n\n## Implementation Steps\n1. Build donation form\n2. Test payment gateway\n\nImplementation acceptance criteria and notes for a complete delivery.";
  await parentEvents.agent_end({messages:[{role:"assistant",stopReason:"stop",
     content:[{type:"text",text:markdown}]}]},parentCtx);
  await parentEvents.agent_settled({},parentCtx);
  assert.equal(uiText.at(-1),"/jev-implement-session auto");
  assert.equal(parentSent.length,1,"No implementation is launched by the event");
  // Only slash-command context can call ctx.newSession().
  parentCtx.newSession=async options=>{
   assert.equal(options.parentSession,parentPath);
   const entries=[],modelsChanged=[],names=[];
   const sm={appendCustomEntry:(type,data)=>entries.push({type:"custom",customType:type,data}),
    appendModelChange:(provider,id)=>modelsChanged.push([provider,id]),
    appendSessionInfo:name=>names.push(name)};
   await options.setup(sm);
   assert.deepEqual(modelsChanged,[["jev-manager","auto"]]);
   assert.match(names[0],/Jev Implement/);
   assert.equal(entries.length,5,"Only handoff metadata, no brainstorming history");
   const origin=entries.find(e=>e.customType===SESSION_ORIGIN_ENTRY)?.data;
   assert.equal(origin.parentSession,parentPath);
   assert.equal(origin.mode,"auto");
   assert.equal(entries.find(e=>e.customType===PIPELINE_ENTRY)?.data.phase,"implement");
   const childEvents={},childCommands={},childTools={};
   const childNotices=[],childWidgets=[],modelSelections=[];
   let childActive=["read","write","bash","edit","grep","find","ls"];
   const childPi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
    registerTool:t=>childTools[t.name]=t,registerCommand:(n,c)=>childCommands[n]=c,
    on:(n,h)=>childEvents[n]=h,getActiveTools:()=>childActive,
    setActiveTools:x=>childActive=x,getAllTools:()=>Object.values(childTools),
    appendEntry:(type,data)=>entries.push({type:"custom",customType:type,data}),
    sendUserMessage(){throw Error("Use fresh session context, never stale Pi");},
    sendMessage(){},setModel:async m=>{
      modelSelections.push(m.provider+"/"+m.id);
      if(rejectModel)return false;
      childCtx.model=m;
      return true;
    }};
   const childCtx={mode:"tui",hasUI:true,model:models[0],modelRegistry,scopedModels:[],
    sessionManager:{getBranch:()=>entries,getSessionId:()=>"child-id",
      getSessionFile:()=>"/home/user/.pi/agent/sessions/child.jsonl"},
    ui:{setWidget:(...x)=>childWidgets.push(x),setStatus(){},
      notify:(...x)=>childNotices.push(x)}
   };
   // Simulate inherited standby / observe configuration at the moment
   // Pi switches from Planning into the new Implementation runtime.
   writeFileSync(join(dir,"jev-model-manager.json"),
     JSON.stringify({...cfg,enabled:false,mode:"observe"}));
   ext(childPi);
   await childEvents.session_start({reason:"new"},childCtx);
   assert.deepEqual(modelSelections,["jev-manager/auto"]);
   if(!rejectModel){
     assert.equal(childCtx.model.provider,"jev-manager",
       "runtime model must change, not just session JSONL");
     const activated=JSON.parse(readFileSync(join(dir,"jev-model-manager.json"),"utf8"));
     assert.equal(activated.enabled,true,"new child must enable routing");
     assert.equal(activated.mode,"auto","new child must leave observe mode");
     assert.ok(childWidgets.some(([name,value])=>name==="jev-manager:mascot" && value));
     assert.equal(childNotices.some(([msg])=>String(msg).includes("INACTIVE")),false);
   }
   assert.ok(childActive.includes("jev_progress"));
   childState={childEvents,childCtx,childCommands,childTools,entries,childActive,
     notices:childNotices,prompt:[]};
   await options.withSession({...childCtx,sendUserMessage:async text=>childState.prompt.push(text)});
   return {cancelled:false};
  };
  await parentCommands["jev-implement-session"].handler("auto",parentCtx);
  if(rejectModel){
    assert.equal(childState.prompt.length,0,
      "Implementation must never run when active model is not Jev");
    assert.equal(childState.childCtx.model.provider,"test");
    assert.equal(childState.entries.filter(e=>e.customType===PIPELINE_ENTRY).at(-1)?.data.status,
      "paused","Failed activation must pause auto pipeline");
    assert.ok(childState.notices.some(([text])=>
      String(text).includes("will NOT start") || String(text).includes("was not started")));
    return;
  }
  assert.equal(childState.prompt.length,1);
  assert.match(childState.prompt[0],/IMPLEMENTATION REQUIRED/);
  assert.equal(childState.entries.find(e=>e.customType==="jev-workflow-phase").data.task,"implement");
  assert.equal(childState.entries.find(e=>e.customType==="jev-auto-pipeline").data.status,"running");
  assert.equal(childState.childActive.includes("jev_quality_gate"),false);
  await childState.childEvents.session_start({reason:"reload"},childState.childCtx);
  assert.equal(childState.entries.filter(e=>e.customType===PIPELINE_ENTRY).at(-1)?.data.status,
    "paused","reload must never auto-launch QA/Review without user confirmation");
  assert.equal(childState.entries.find(e=>e.customType==="jev-implementation-progress")?.data.stage,
    "running","approved task checklist persists in child JSONL");
 }finally{
  if(prior===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=prior;
 }
});
