import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {resolveTeamRole} from "../team-routing.ts";
import {defaultTaskRules} from "../task-routing.ts";
test("team routing tool returns model-per-child launch args; never spawns a process",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-team-"));
 const orig=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=dir;
 try {
  const models=[
   {key:"provider/claude-opus-4-6",cost:"premium",thinking:"high"},
   {key:"provider/claude-sonnet-4-6",cost:"balanced",thinking:"medium"},
   {key:"provider/gpt-5.6-luna",cost:"budget",thinking:"low"},
  ].map(x=>({...x,enabled:true,label:x.key,specialty:"",avoid:""}));
  const config:any={version:1,enabled:true,models,taskRules:defaultTaskRules()};
  writeFileSync(join(dir,"jev-model-manager.json"),JSON.stringify(config));
  const tools:any[]=[];const commands:Record<string,any>={};let notice="";
  const pi:any={registerTool:(tool:any)=>tools.push(tool),
   registerCommand:(name:string,cmd:any)=>commands[name]=cmd};
  const {registerTeamTools}=await import("../team-tools.ts");
  registerTeamTools(pi);
  const tool=tools.find(x=>x.name==="jev_team_route");
  assert.ok(tool);
  const ctx:any={hasUI:true,ui:{notify:(x:string)=>notice=x},
   scopedModels:[],modelRegistry:{getAvailable:()=>models.map(m=>({
    provider:m.key.split("/")[0],id:m.key.split("/")[1],api:"openai-completions",
   }))}};
  const qa=await tool.execute("call",{role:"qa",platform:"omp"},undefined,undefined,ctx);
  const result=JSON.parse(qa.content[0].text);
  assert.equal(result.role,"qa");
  assert.equal(result.model,models[2].key);
  assert.match(result.example,/--kind omp --pane PANE_ID -- --model provider\/gpt-5.6-luna/);
  assert.equal(result.cliArgs.at(-2),"--config");
  assert.equal(result.cliArgs.at(-1),result.workerModeOverlay);
  assert.ok(existsSync(result.workerModeOverlay));
  assert.match(readFileSync(result.workerModeOverlay,"utf8"),/defaultOnStartup: false/);
  const qaPi=await tool.execute("call",{role:"qa",platform:"pi"},undefined,undefined,ctx);
  assert.equal(JSON.parse(qaPi.content[0].text).workerModeOverlay,undefined);
  const pm=await tool.execute("call",{role:"pm",platform:"omp"},undefined,undefined,ctx);
  assert.equal(JSON.parse(pm.content[0].text).model,models[1].key);
  assert.equal(JSON.parse(pm.content[0].text).workerModeOverlay,undefined,
    "PM may deliberately enter OMP Plan Mode");
  await commands["jev-team"].handler("",ctx);
  assert.match(notice,/qa: provider\/gpt-5.6-luna/);
  assert.doesNotMatch(notice,/spawned agents/);
 }finally{
  if(orig===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=orig;
  rmSync(dir,{recursive:true,force:true});
 }
});
