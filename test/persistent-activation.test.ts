import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Jev ON persists into new Pi/Herdr processes, OFF and overrides are honored",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-persist-"));
 const previous=process.env.PI_CODING_AGENT_DIR;
 const oldOverride=process.env.JEV_AUTO_ACTIVATE;
 process.env.PI_CODING_AGENT_DIR=dir;
 delete process.env.JEV_AUTO_ACTIVATE;
 const file=join(dir,"jev-model-manager.json");
 const physical=[{provider:"test",id:"fast",api:"openai-completions"}];
 const virtual={provider:"jev-manager",id:"auto",api:"pi-virtual"};
 const config={version:1,enabled:false,mode:"auto",fallback:"test/fast",
   minProbability:0.43,models:[{key:"test/fast",label:"Fast",enabled:true,
   specialty:"general",avoid:"",cost:"balanced",thinking:"low"}]};
 const load=()=>JSON.parse(readFileSync(file,"utf8"));
 const save=(value)=>writeFileSync(file,JSON.stringify(value));
 let extension;
 try {
  save(config);
  ({default:extension}=await import("../index.ts"));
  const start=(options={})=>{
   const commands={},events={},notices=[];
   let selected=physical[0],switches=0,reject=false;
   const ctx={mode:options.mode??"tui",hasUI:options.mode!=="rpc",scopedModels:[],
     get model(){return selected;},modelRegistry:{
       getAvailable:()=>physical,
       find:(provider,id)=>provider==="jev-manager"&&id==="auto"?virtual:
         physical.find(m=>m.provider===provider&&m.id===id)
     },sessionManager:{getBranch:()=>[]},
     ui:{setStatus(){},setWidget(){},notify:(message)=>notices.push(message)}};
   const pi={registerProvider(){},unregisterProvider(){},registerVirtualModel(){},
     registerTool(){},registerCommand:(name,cmd)=>commands[name]=cmd,
     on:(event,handler)=>events[event]=handler,
     setModel:async(model)=>{switches++;if(reject)return false;selected=model;return true}};
   extension(pi);
   return {commands,events,notices,ctx,get selected(){return selected;},
      get switches(){return switches;},reject:(value)=>{reject=value;},
      manualModel:()=>{selected=physical[0];}};
  };
  const initial=start();
  await initial.events.session_start({reason:"startup"},initial.ctx);
  assert.equal(initial.switches,0,"first install should not activate without opt-in");
  await initial.commands["jev-on"].handler("",initial.ctx);
  assert.equal(initial.selected.id,"auto");
  assert.equal(load().enabled,true,"/jev-on saves ON globally");
  const next=start({mode:"rpc"}); // Herdr-style spawned Pi with no TUI
  await next.events.session_start({reason:"new"},next.ctx);
  assert.equal(next.switches,1,"fresh headless Pi auto-selects Jev");
  assert.equal(next.selected.id,"auto");
  assert.equal(load().enabled,true);
  await next.events.session_start({reason:"reload"},next.ctx);
  assert.equal(next.switches,1,"reload does not reselect an already active virtual model");
  next.manualModel(); // user changes model in current session
  assert.equal(next.selected.id,"fast","a manual selection is not immediately overridden");
  await next.events.session_start({reason:"new"},next.ctx);
  assert.equal(next.selected.id,"auto","new Pi session restores persisted ON");
  await next.commands["jev-off"].handler("",next.ctx);
  assert.equal(load().enabled,false,"/jev-off persists OFF");
  assert.equal(next.selected.id,"fast","/jev-off exits the virtual model");
  const disabled=start();
  await disabled.events.session_start({reason:"startup"},disabled.ctx);
  assert.equal(disabled.switches,0,"OFF persists across further launches");
  // The environment override applies only at startup, not to explicit /jev-on.
  save({...config,enabled:true});
  process.env.JEV_AUTO_ACTIVATE="0";
  const overridden=start({mode:"rpc"});
  await overridden.events.session_start({reason:"startup"},overridden.ctx);
  assert.equal(overridden.switches,0,"per-process opt-out is honored");
  await overridden.commands["jev-on"].handler("",overridden.ctx);
  assert.equal(overridden.selected.id,"auto","explicit /jev-on wins over env opt-out");
  delete process.env.JEV_AUTO_ACTIVATE;
  save({...config,enabled:true,mode:"observe"});
  const observe=start();
  await observe.events.session_start({reason:"startup"},observe.ctx);
  assert.equal(observe.switches,0,"observe mode is not silently changed to auto");
  save({...config,enabled:true,models:[]});
  const unavailable=start();
  await unavailable.events.session_start({reason:"startup"},unavailable.ctx);
  assert.equal(unavailable.switches,0,"unavailable physical providers never select virtual");
  assert.equal(load().enabled,true,"failed restoration does not erase ON preference");
  save({...config,enabled:true});
  const rejected=start();
  rejected.reject(true);
  await rejected.events.session_start({reason:"startup"},rejected.ctx);
  assert.equal(rejected.selected.id,"fast");
  assert.equal(load().enabled,true,"a failed startup model selection retains opt-in");
  rejected.reject(false);
  await rejected.events.session_start({reason:"startup"},rejected.ctx);
  assert.equal(rejected.selected.id,"auto","subsequent healthy startup can recover");
 }finally{
  if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=previous;
  if(oldOverride===undefined)delete process.env.JEV_AUTO_ACTIVATE;
  else process.env.JEV_AUTO_ACTIVATE=oldOverride;
  rmSync(dir,{recursive:true,force:true});
 }
});
