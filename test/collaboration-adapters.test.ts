import test from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_ADAPTER,buildPeerCommand,normalizePeerAdapters,
  registerCollaborationTool,COLLABORATION_TOOL
} from "../collaboration-adapters.ts";
test("declarative peer adapter supports another CLI without new code",()=>{
 const normalized=normalizePeerAdapters([{
  id:"custom_peer",executable:"mock-orchestrator",
  commands:{
   list:["peers","list"],
   prompt:["peers","ask","--target","{target}","--message","{prompt}"],
   read:["peers","messages","{target}","--max-lines","{lines}"],
   wait:["peers","await","{target}","--max-ms","{timeout}"],
   start:["spawn","{target}"]
  }
 }]);
 assert.deepEqual(normalized.map(x=>x.id),["custom_peer"]);
 const prompt=buildPeerCommand({
  adapter:"custom_peer",action:"prompt",target:"researcher",
  prompt:"Review this API proposal and identify tradeoffs; do not write code."
 },normalized);
 assert.equal(prompt.executable,"mock-orchestrator");
 assert.deepEqual(prompt.argv.slice(0,5),
   ["peers","ask","--target","researcher","--message"]);
 assert.match(prompt.argv[5],/JEV PLAN-MODE PEER DISCUSSION/);
 const read=buildPeerCommand({adapter:"custom_peer",action:"read",target:"researcher",lines:150},normalized);
 assert.deepEqual(read.argv,["peers","messages","researcher","--max-lines","150"]);
 const wait=buildPeerCommand({adapter:"custom_peer",action:"wait",target:"researcher",timeoutMs:7000},normalized);
 assert.deepEqual(wait.argv,["peers","await","researcher","--max-ms","7000"]);
 assert.equal(wait.timeoutMs,9500);
 assert.equal(buildPeerCommand({adapter:"herdr",action:"list"}).executable,"herdr");
 assert.deepEqual(HERDR_ADAPTER.commands.list,["agent","list"]);
 assert.throws(()=>buildPeerCommand({adapter:"unconfigured",action:"list"},normalized),/not registered/);
 assert.throws(()=>buildPeerCommand({adapter:"custom_peer",action:"prompt",target:"--verbose",
    prompt:"Analyze the open questions and present alternatives."},normalized),/target/);
 assert.throws(()=>buildPeerCommand({adapter:"custom_peer",action:"spawn" as any,target:"researcher"},normalized),/Unknown collaboration action/);
});
test("untrusted templates and unsound placeholders do not become callable",()=>{
 const profiles=normalizePeerAdapters([
  {id:"evil",executable:"bash",commands:{prompt:["-c","{prompt}"]}},
  {id:"partial",executable:"bridge",commands:{prompt:["ask","before-{prompt}"]}},
  {id:"valid",executable:"bridge",commands:{prompt:["ask","{target}","{prompt}"],
    wait:["wait","{target}","{timeout}"]}},
  {id:"shell",executable:"/tmp/app;touch",commands:{list:["list"]}},
  {id:"herdr",executable:"other",commands:{list:["list"]}},
 ]);
 assert.deepEqual(profiles.map(p=>p.id),["valid"],
   "shell interpreters, unsafe placeholders/paths and reserved names rejected");
 // The adapter comes from the user-owned config: don't allow a shell interpreter,
 // even if its argv has no injection.
 assert.equal(profiles[0].executable,"bridge");
});
test("generic collaboration tool uses independent argv arrays, and reports backend failures",async()=>{
 let externalTool:any;
 const calls:unknown[]=[];
 const profile=normalizePeerAdapters([{
  id:"custom_peer",executable:"peer-cli",commands:{
   prompt:["ask","{target}","{prompt}"],read:["read","{target}"]
  }}]);
 registerCollaborationTool({registerTool:(x:any)=>externalTool=x} as any,
   ()=>profile,async(bin,args,timeout)=>{
    calls.push({bin,args,timeout});
    if(args[0]==="read")throw Error("backend unreachable");
    return "peer question accepted";
   });
 assert.equal(externalTool.name,COLLABORATION_TOOL);
 assert.equal(externalTool.defaultActive,false);
 const outcome=await externalTool.execute("1",{adapter:"custom_peer",action:"prompt",
   target:"architect",prompt:"Analyze the proposed design and identify weak points."},
   undefined,undefined,{});
 assert.equal(outcome.isError,undefined);
 assert.match(outcome.content[0].text,/accepted/);
 assert.equal((calls[0] as any).bin,"peer-cli");
 assert.equal((calls[0] as any).args.length,3);
 const failure=await externalTool.execute("2",{adapter:"custom_peer",action:"read",target:"architect"},
   undefined,undefined,{});
 assert.equal(failure.isError,true);
 assert.match(failure.content[0].text,/backend unreachable/);
});
