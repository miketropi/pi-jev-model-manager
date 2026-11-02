import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {SpawnAdapter} from "../team-spawn-adapters.ts";

test("tool respects human opt-in, strict Plan guard, no-shell adapter, and persists receipts",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-team-spawn-"));
 const original=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 try {
  const models=[
   {key:"provider/claude-sonnet-4-6",cost:"balanced",thinking:"medium"},
   {key:"provider/gpt-5.6-luna",cost:"budget",thinking:"low"},
  ].map(x=>({...x,enabled:true,label:x.key,specialty:"",avoid:""}));
  const config:any={version:1,enabled:true,models};
  const path=join(dir,"jev-model-manager.json");
  writeFileSync(path,JSON.stringify(config));
  const handlers:Record<string,any>={},commands:Record<string,any>={},tools:any[]=[];
  const records:any[]=[];let attempts=0;let phase:"plan"|"implement"|"review"="plan";
  let confirm=true,notices:string[]=[];
  const pi:any={on:(name:string,fn:any)=>handlers[name]=fn,
   registerTool:(x:any)=>tools.push(x),
   registerCommand:(name:string,cmd:any)=>commands[name]=cmd,
   appendEntry:(name:string,data:any)=>records.push({type:"custom",customType:name,data})};
  const peer:any={probe:async()=> "ready"};
  const actual=new Set<string>();
  const adapter:SpawnAdapter={id:"herdr",lookup:async(name:string)=>
   actual.has(name)?{state:"present",name,paneId:"w1:p2"}:{state:"absent"},
   start:async r=>{attempts++;actual.add(r.name);
    return {state:"present",name:r.name,paneId:r.paneId,status:"idle"};}};
  const {registerTeamSpawnTools,TEAM_SPAWN_ENTRY}=await import("../team-spawn-tools.ts");
  registerTeamSpawnTools(pi,{getPhase:()=>phase,peers:peer},[adapter]);
  const ctx:any={hasUI:true,
   ui:{confirm:async()=>confirm,notify:(s:string)=>notices.push(s)},
   scopedModels:[],sessionManager:{getBranch:()=>records},
   modelRegistry:{getAvailable:()=>models.map(x=>({
    provider:x.key.split("/")[0],id:x.key.split("/")[1],api:"openai-completions"}))}};
  const tool=tools.find(x=>x.name==="jev_team_spawn");
  assert.ok(tool);
  const task={action:"spawn",adapter:"herdr",role:"qa",difficulty:"normal",platform:"omp",
   name:"qa",paneId:"w1:p2",requestId:"qa-task-001"};
  handlers.session_start({reason:"new"},ctx);
  const first=await tool.execute("c1",task,undefined,undefined,ctx);
  assert.match(first.content[0].text,/Team spawning is disabled during strict/);
  assert.equal(attempts,0);
  phase="implement";
  const disabled=await tool.execute("c2",task,undefined,undefined,ctx);
  assert.match(disabled.content[0].text,/disabled/);
  assert.equal(attempts,0);
  confirm=false;
  await commands["jev-team-spawn-on"].handler("",ctx);
  assert.equal(JSON.parse(readFileSync(path,"utf8")).teamSpawn,undefined);
  confirm=true;
  await commands["jev-team-spawn-on"].handler("",ctx);
  assert.equal(JSON.parse(readFileSync(path,"utf8")).teamSpawn.enabled,true);
  const success=await tool.execute("c3",task,undefined,undefined,ctx);
  const result=JSON.parse(success.content[0].text);
  assert.equal(result.ok,true);
  assert.equal(result.receipt.model,models[1].key);
  assert.equal(result.receipt.modelVerified,false);
  assert.equal(attempts,1);
  assert.equal(records.filter(x=>x.customType===TEAM_SPAWN_ENTRY).length,1);
  const repeat=await tool.execute("c4",task,undefined,undefined,ctx);
  assert.equal(JSON.parse(repeat.content[0].text).ok,true);
  assert.equal(attempts,1);
  const status=await tool.execute("c5",{action:"status",name:"qa"},undefined,undefined,ctx);
  assert.match(status.content[0].text,/ready \(model not verified\)/);
  await commands["jev-team-spawn-status"].handler("",ctx);
  assert.ok(notices.at(-1)?.includes("qa · qa"));
  await commands["jev-team-spawn-off"].handler("",ctx);
  assert.equal(JSON.parse(readFileSync(path,"utf8")).teamSpawn.enabled,false);
  const off=await tool.execute("c6",{...task,requestId:"qa-task-002",name:"qa2"},
   undefined,undefined,ctx);
  assert.match(off.content[0].text,/disabled/);
  assert.equal(attempts,1);
 }finally {
  if(original===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=original;
  rmSync(dir,{recursive:true,force:true});
 }
});
