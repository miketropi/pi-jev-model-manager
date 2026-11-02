import test from "node:test";
import assert from "node:assert/strict";
import {HerdrSpawnAdapter,confirmedIdentity,type SpawnAdapter,type SpawnLookup}
 from "../team-spawn-adapters.ts";
import {TeamSpawnController} from "../team-spawn-controller.ts";
import {DEFAULT_TEAM_SPAWN,normalizeTeamSpawn,isUnmanagedHerdrStart} from "../team-spawn-policy.ts";
import {inferTeamDifficulty} from "../team-spawn-difficulty.ts";
import {defaultTaskRules} from "../task-routing.ts";
const models=[
 {key:"proxy/gpt-5.6-luna",label:"Luna",enabled:true,cost:"budget",thinking:"low",specialty:"",avoid:""},
 {key:"proxy/claude-sonnet-4-6",label:"Sonnet",enabled:true,cost:"balanced",thinking:"medium",specialty:"",avoid:""},
 {key:"proxy/claude-opus-4-6",label:"Opus",enabled:true,cost:"premium",thinking:"high",specialty:"",avoid:""},
] as const;
const cfg={...DEFAULT_TEAM_SPAWN,enabled:true};
const request=(name:string,role:"dev"|"qa"|"pm"|"reviewer"="dev",id="task001")=>({
 adapter:"herdr",requestId:id,name,paneId:"w1:p2",role,difficulty:"normal" as const,platform:"omp" as const
});
const agent=(name:string,pane="w1:p2"):SpawnLookup=>
 ({state:"present",name,paneId:pane,status:"idle"});
test("Herdr adapter uses safe argv, detects absent agents only from known JSON error codes",async()=>{
 const calls:{args:readonly string[];timeout:number}[]=[];
 let launched=false;
 const adapter=new HerdrSpawnAdapter(async(args,timeout)=>{
  calls.push({args,timeout});
  if(args[1]==="get"){
   if(!launched)throw Object.assign(new Error("missing"),{
    stderr:'{"error":{"code":"agent_not_found","message":"not found"}}'});
   return JSON.stringify({result:{agent:{name:"dev",pane_id:"w1:p2",state:"idle"}}});
  }
  launched=true;
  return JSON.stringify({result:{agent:{name:"dev",pane_id:"w1:p2",state:"idle"}}});
 });
 assert.deepEqual(await adapter.lookup("dev"),{state:"absent"});
 const start=await adapter.start({name:"dev",paneId:"w1:p2",platform:"omp",
  args:["--model","proxy/claude-sonnet-4-6","--thinking","medium"],timeoutMs:30000});
 assert.ok(confirmedIdentity(start,"dev","w1:p2"));
 assert.deepEqual(calls[1].args,["agent","start","dev","--kind","omp",
  "--pane","w1:p2","--timeout","30000","--","--model",
  "proxy/claude-sonnet-4-6","--thinking","medium"]);
 assert.ok(confirmedIdentity(await adapter.lookup("dev"),"dev","w1:p2"));
 assert.equal(await new HerdrSpawnAdapter(async()=>"{not json").lookup("dev").then(x=>x.state),"unknown");
 assert.equal(await new HerdrSpawnAdapter(async()=>{
  throw new Error("socket refused");
 }).lookup("dev").then(x=>x.state),"unknown");
});
test("Controller pins model, caps OMP cost and prevents duplicate launches",async()=>{
 let launches=0;let current:SpawnLookup={state:"absent"};
 const calls:string[][]=[];
 const adapter:SpawnAdapter={id:"herdr",lookup:async()=>current,
  start:async req=>{
   launches++;calls.push([...req.args]);current=agent(req.name,req.paneId);return current;
  }};
 const records:any[]=[];
 const ctrl=new TeamSpawnController([adapter],r=>records.push(r));
 const input=request("dev");
 const run=await ctrl.spawn(input,{...cfg,maxCostUsdPerAgent:1.25},
  models as any,defaultTaskRules(),undefined,async()=>true);
 assert.equal(run.ok,true);
 if(!run.ok)return;
 assert.equal(run.receipt.state,"ready");
 assert.equal(run.receipt.model,models[1].key);
 assert.equal(run.receipt.modelVerified,false);
 assert.deepEqual(calls[0].slice(0,4),["--model",models[1].key,"--thinking","medium"]);
 assert.deepEqual(calls[0].slice(-2),["--max-cost","1.25"]);
 assert.ok(calls[0].includes("--config"));
 assert.equal(records.length,1);
 const repeat=await ctrl.spawn(input,cfg,models as any,defaultTaskRules());
 assert.equal(repeat.ok,true);
 assert.equal(launches,1,"same request ID never spawns twice");
 const conflict=await ctrl.spawn({...input,name:"dev2"},cfg,models as any,defaultTaskRules());
 assert.equal(conflict.ok,false);
 assert.equal((conflict as any).code,"conflict");
 const occupied=await ctrl.spawn(request("dev","dev","task002"),cfg,models as any,defaultTaskRules());
 assert.equal((occupied as any).code,"occupied");
});
test("Unknown outcome is reserved, never retried; explicit status can recover identity",async()=>{
 let started=false,starts=0;
 const adapter:SpawnAdapter={id:"herdr",lookup:async name=>
  started?agent(name):{state:"absent"},
  start:async()=>{starts++;started=true;throw new Error("timeout after child started");}};
 const ctrl=new TeamSpawnController([adapter]);
 const x=await ctrl.spawn(request("qa","qa","qa001"),cfg,models as any,
  defaultTaskRules(),undefined,async()=>true);
 assert.equal(x.ok,true);
 if(!x.ok)return;
 assert.equal(x.receipt.state,"uncertain");
 assert.equal((await ctrl.spawn(request("qa","qa","qa001"),cfg,models as any,
  defaultTaskRules())).ok,true);
 assert.equal(starts,1);
 assert.deepEqual(await ctrl.status("herdr","qa"),{
  state:"ready (model not verified)",name:"qa",modelVerified:false});
 assert.equal(ctrl.get("qa")?.state,"ready");
});
test("Preflight and name checks fail closed without trying to spawn",async()=>{
 let launch=0;
 const adapter:SpawnAdapter={id:"herdr",
  lookup:async()=>({state:"unknown"}),
  start:async()=>{launch++;return agent("x");}};
 const ctrl=new TeamSpawnController([adapter]);
 const x=await ctrl.spawn(request("dev","dev","bad001"),cfg,models as any,
  defaultTaskRules(),undefined,async()=>false);
 assert.equal((x as any).code,"unavailable");
 assert.equal(launch,0);
 const u=await ctrl.spawn(request("dev2","dev","bad002"),cfg,models as any,
  defaultTaskRules(),undefined,async()=>true);
 assert.equal((u as any).code,"unverified");
 assert.equal(launch,0);
 assert.equal((await ctrl.spawn(request("x","dev","bad003"),{
  ...cfg,enabled:false},models as any,defaultTaskRules()) as any).code,"disabled");
});
test("Caps team headcount, premium agents, concurrency and impossible Pi USD caps",async()=>{
 let pendingResolver:((v:SpawnLookup)=>void)|undefined;
 const adapter:SpawnAdapter={id:"herdr",lookup:async()=>({state:"absent"}),
  start:async req=>new Promise(resolve=>{pendingResolver=resolve;})};
 const ctrl=new TeamSpawnController([adapter]);
 const policy={...cfg,maxConcurrentStarts:1,maxAgents:1};
 const pending=ctrl.spawn(request("worker","dev","con001"),policy,
  models as any,defaultTaskRules(),undefined,async()=>true);
 await new Promise(resolve=>setImmediate(resolve));
 const blocked=await ctrl.spawn(request("worker2","dev","con002"),policy,
  models as any,defaultTaskRules());
 assert.ok(["team_budget","concurrency"].includes((blocked as any).code));
 pendingResolver?.(agent("worker"));
 await pending;
 const blocked2=await ctrl.spawn(request("worker3","dev","con003"),policy,
  models as any,defaultTaskRules());
 assert.equal((blocked2 as any).code,"team_budget");
 const piCap=await new TeamSpawnController([adapter]).spawn({
  ...request("worker4","dev","con004"),platform:"pi"},
  {...cfg,maxCostUsdPerAgent:2},models as any,defaultTaskRules());
 assert.equal((piCap as any).code,"unsupported_cost_cap");
 const rules=defaultTaskRules();rules.plan={mode:"force",model:models[2].key};
 const premium=new TeamSpawnController([adapter]);
 const deny=await premium.spawn(request("manager","pm","con005"),
  {...cfg,maxPremiumAgents:0},models as any,rules);
 assert.equal((deny as any).code,"premium_budget");
});
test("Policy normalization constrains unsafe values",()=>{
 assert.equal(normalizeTeamSpawn({enabled:true,maxAgents:100}).enabled,true);
 assert.equal(normalizeTeamSpawn({maxAgents:100}).maxAgents,DEFAULT_TEAM_SPAWN.maxAgents);
 assert.equal(normalizeTeamSpawn({maxPremiumAgents:0}).maxPremiumAgents,0);
 assert.equal(normalizeTeamSpawn({maxCostUsdPerAgent:-1}).maxCostUsdPerAgent,0);
});

test("TypeSafe Jev classifies only explicit scoped task summaries and fails safely",async()=>{
 const cfg={provider:"typesafe",model:"jev-latest"};
 let calls=0;
 const registry:any={
  findOfType:(_type:string,provider:string,id:string)=>
   provider==="typesafe"&&id==="jev-latest"?{id}:null,
  classify:async()=>{calls++;return {stopReason:"stop",answers:{
   effort:{type:"choice",choice:"hard",probabilities:{hard:.91}}
  }};},
 };
 const hard=await inferTeamDifficulty("Review a critical payment authorization race",registry,cfg);
 assert.deepEqual(hard,{difficulty:"hard",confidence:.91,source:"jev"});
 assert.equal(calls,1);
 const noLeak=await inferTeamDifficulty("short",registry,cfg);
 assert.equal(noLeak.source,"default");
 assert.equal(calls,1);
 const low=await inferTeamDifficulty("Fix an ambiguous issue that requires evaluation",
  {findOfType:()=>({}),classify:async()=>({
   stopReason:"stop",answers:{effort:{type:"choice",choice:"small",probabilities:{small:.3}}}
  })},cfg);
 assert.deepEqual(low,{difficulty:"normal",confidence:0,source:"default"});
});

test("unmanaged Herdr spawn shell commands are recognizable while ordinary reads are not",()=>{
 assert.equal(isUnmanagedHerdrStart("herdr agent start qa --kind omp"),true);
 assert.equal(isUnmanagedHerdrStart("/usr/local/bin/herdr   agent   start dev"),true);
 assert.equal(isUnmanagedHerdrStart("herdr agent list"),false);
 assert.equal(isUnmanagedHerdrStart("pwd"),false);
});
