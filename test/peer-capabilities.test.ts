import test from "node:test";
import assert from "node:assert/strict";
import {PeerCapabilities,probeSucceeded,isPeerUnavailableError} from "../peer-capabilities.ts";
import {normalizePeerAdapters,registerCollaborationTool} from "../collaboration-adapters.ts";
import {registerHerdrPlanningTool} from "../herdr-collaboration.ts";
import {createWorkflowController} from "../runtime/workflow-controller.ts";

const adapters=normalizePeerAdapters([{
 id:"research_bridge",executable:"research-cli",commands:{
 list:["peers","list"],prompt:["peers","ask","{target}","{prompt}"],
 read:["peers","read","{target}"]
 }
}]);
const OFFLINE_JSON='{"id":"cli:agent:list","error":{"code":"server_not_running","message":"no herdr server is running at /private/herdr.sock"}}';

test("generic bounded probes detect ready vs absent peer and never expose raw CLI diagnostics",async()=>{
 const calls:string[]=[];
 let bridgeOnline=true;
 const peers=new PeerCapabilities(async(bin,args,timeout)=>{
  calls.push(bin+":"+args.join(" "));
  assert.ok(timeout<=1700,"availability probe must be bounded");
  if(bin==="herdr")throw Object.assign(new Error("herdr socket offline"),{code:"ECONNREFUSED"});
  if(!bridgeOnline)throw Object.assign(new Error("server offline"),{code:"ENOENT"});
  return "researcher available";
 },{HERDR_ENV:"1",HERDR_PANE_ID:"w1:p1"});
 await peers.refresh(adapters);
 assert.equal(peers.status("herdr"),"unavailable");
 assert.equal(peers.status("research_bridge"),"ready");
 assert.deepEqual(peers.getAvailable(adapters),["research_bridge"]);
 assert.ok(peers.anyReady(adapters));
 const once=calls.length;
 await peers.refresh(adapters);
 assert.equal(calls.length,once,"cached checks do not repeatedly query missing services");
 bridgeOnline=false;
 await peers.refresh(adapters,true);
 assert.equal(peers.status("research_bridge"),"unavailable");
 assert.equal(peers.anyReady(adapters),false);
 assert.match(peers.summary(adapters),/Planning runs locally/);
 assert.doesNotMatch(peers.summary(adapters),/herdr.sock/);
});

test("CLIs returning JSON errors with exit code zero are not considered ready",()=>{
 assert.equal(probeSucceeded(OFFLINE_JSON),false);
 assert.equal(probeSucceeded('{"error":{"code":"not_configured"}}'),false);
 assert.equal(probeSucceeded('{"ok":false}'),false);
 assert.equal(probeSucceeded('{"success":false}'),false);
 assert.equal(probeSucceeded('[{"id":"researcher"}]'),true);
 assert.equal(probeSucceeded("no agents yet"),true);
 assert.equal(probeSucceeded(""),false);
 assert.equal(isPeerUnavailableError({code:"ENOENT",message:"not found"}),true);
 assert.equal(isPeerUnavailableError(new Error("backend unreachable")),true);
 assert.equal(isPeerUnavailableError(new Error("Bad argument target")),false);
});

test("unavailable optional backend fails quietly, while a verified peer can be called",async()=>{
 let service=false,called=0;
 const runner=async(bin:string,args:readonly string[])=>{
  called++;
  if(!service)throw Object.assign(new Error("connection refused"),{code:"ECONNREFUSED"});
  return args[0]==="peers"&&args[1]==="list"?"architect ready":"peer question received";
 };
 const peers=new PeerCapabilities(runner);
 let tool:any;
 registerCollaborationTool({registerTool:(x:any)=>tool=x} as any,()=>adapters,runner,peers);
 const payload={adapter:"research_bridge",action:"prompt",target:"architect",
  prompt:"Analyze this API contract for possible racing changes."};
 const invalid=await tool.execute("call-invalid",
  {...payload,adapter:"not_registered"},null,null,{});
 assert.equal(invalid.isError,true,"invalid adapter must be a configuration error");
 assert.match(invalid.content[0].text,/Invalid peer request/);
 const absent=await tool.execute("call-a",payload,null,null,{});
 assert.equal(absent.isError,undefined);
 assert.match(absent.content[0].text,/Continue Planning locally/);
 assert.equal(peers.ready("research_bridge"),false);
 const once=called;
 const quiet=await tool.execute("call-b",payload,null,null,{});
 assert.equal(quiet.isError,undefined);
 assert.equal(called,once,"unavailable peer result is cached rather than retried endlessly");
 service=true;
 await peers.refresh(adapters,true);
 const result=await tool.execute("call-c",payload,null,null,{});
 assert.equal(result.isError,undefined);
 assert.match(result.content[0].text,/received/);
 assert.equal(peers.ready("research_bridge"),true);
 service=false;
 const disconnected=await tool.execute("call-d",payload,null,null,{});
 assert.equal(disconnected.isError,undefined);
 assert.match(disconnected.content[0].text,/Continue Planning locally/);
 assert.equal(peers.ready("research_bridge"),false);
});

test("legacy Herdr tool uses same neutral offline contract without repeated retries",async()=>{
 const peers=new PeerCapabilities(async()=>OFFLINE_JSON);
 let tool:any;
 registerHerdrPlanningTool({registerTool:(x:any)=>tool=x} as any,async()=>OFFLINE_JSON,peers);
 const out=await tool.execute("x",{action:"list"},null,null,{});
 assert.equal(out.isError,undefined);
 assert.match(out.content[0].text,/Continue Planning locally/);
 assert.doesNotMatch(out.content[0].text,/server_not_running|herdr.sock/);
 assert.equal(peers.status("herdr"),"not_attached");
});

test("Plan tool visibility follows runtime readiness rather than installed binaries or configuration",async()=>{
 let active=["read","bash","grep"];
 const pi:any={
  getActiveTools:()=>[...active],setActiveTools:(names:string[])=>{active=[...names];},
  getAllTools:()=>[
    {name:"jev_herdr"},{name:"jev_collaborate"},
    {name:"jev_ask_user"},{name:"jev_web_fetch"}],
 };
 const peers=new PeerCapabilities(async(bin:string)=>bin==="herdr"?"agent researcher idle":"researcher idle",
  {HERDR_ENV:"1",HERDR_PANE_ID:"w1:p1"});
 const env:any={peers,workflowTask:undefined,
  toolsBeforeStrictPhase:undefined,progressToolInjected:false,
  delegationToolInjected:false,nativeSubagentInjected:false,
  pipelineGateInjected:false,qaRecoveryToolsInjected:[]};
 const controller=createWorkflowController(pi,env);
 controller.changeWorkflow("plan");
 assert.equal(active.includes("jev_herdr"),false);
 assert.equal(active.includes("jev_collaborate"),false);
 await peers.probe("herdr",[],true);
 controller.changeWorkflow("plan");
 assert.ok(active.includes("jev_herdr"),"verified Herdr activates its alias tool");
 assert.ok(active.includes("jev_collaborate"),"generic tool can use a verified default adapter");
 peers.invalidate("herdr");
 controller.changeWorkflow("plan");
 assert.equal(active.includes("jev_herdr"),false,"disconnected peer disappears on next phase update");
 assert.equal(active.includes("jev_collaborate"),false);
 assert.ok(active.includes("read"),"local read tools remain available");
});

test("unrelated Herdr server is never auto-attached to a standalone Pi session",async()=>{
 let called=0;
 const peers=new PeerCapabilities(async()=>{
  called++; return "remote Herdr server is live";
 },{HERDR_ENV:undefined,HERDR_PANE_ID:undefined});
 await peers.refresh([]);
 assert.equal(peers.status("herdr"),"not_attached");
 assert.equal(peers.anyReady(),false);
 assert.equal(called,0,"no CLI should run outside the Herdr-managed pane");
 // One marker is not enough; do not attach to a potentially unrelated server.
 const partial=new PeerCapabilities(async()=>{called++;return "online";},
  {HERDR_ENV:"1",HERDR_PANE_ID:undefined});
 assert.equal(await partial.probe("herdr"),"not_attached");
 assert.equal(called,0);
});

test("other peer adapters may require their own explicit runtime activation marker",async()=>{
 const configured=normalizePeerAdapters([{
  id:"orchestrator",executable:"other-cli",
  activation:{environment:"OTHER_PEER_SESSION",equals:"active"},
  commands:{list:["members","list"]}
 }]);
 assert.equal(configured.length,1);
 let calls=0;
 const standalone=new PeerCapabilities(async()=>{calls++;return "peer ready";},{});
 assert.equal(await standalone.probe("orchestrator",configured),"not_attached");
 assert.equal(calls,0);
 const attached=new PeerCapabilities(async()=>{calls++;return "peer ready";},
  {OTHER_PEER_SESSION:"active"});
 assert.equal(await attached.probe("orchestrator",configured),"ready");
 assert.equal(calls,1);
 assert.deepEqual(normalizePeerAdapters([{
  id:"bad",executable:"other-cli",activation:{environment:"BAD;DROP"},
  commands:{list:["list"]}
 }]),[]);
});
