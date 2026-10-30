import test from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_PLAN_PREFIX, HERDR_PLAN_TOOL, buildHerdrArgs, herdrPeerAction,
  registerHerdrPlanningTool
} from "../herdr-collaboration.ts";
import {isReadOnlyHerdrShell,canUseTool,toolsForPhase} from "../workflow.ts";

test("Plan exposes only safe Herdr introspection and blocks shell injection and spawning",()=>{
 const safe=[
  "herdr agent list","herdr agent get architect",
  "herdr agent read w1:p1",
  "herdr agent read dev1 --lines 80",
  "herdr agent wait researcher --timeout 5000",
  "herdr status server"
 ];
 for(const cmd of safe){
  assert.equal(isReadOnlyHerdrShell(cmd),true,cmd);
  assert.equal(canUseTool("plan","bash",{command:cmd}),true,cmd);
 }
 for(const cmd of [
  "herdr agent prompt researcher 'write code'",
  "herdr agent send-keys dev1 enter",
  "herdr pane run w1:p1 touch file",
  "herdr agent start worker --kind pi --pane w1:p1",
  "herdr workspace create",
  "herdr agent rename worker impostor",
  "herdr agent list; touch file",
  "herdr agent list | bash",
  "herdr agent get $(id)",
  "herdr agent read worker --lines 0",
  "herdr agent read worker --lines 300",
  "herdr agent wait worker --timeout 999999",
  "herdr agent get --help",
  "HERDR_ENV=1 herdr agent list"
 ]){
  assert.equal(canUseTool("plan","bash",{command:cmd}),false,cmd);
 }
 assert.equal(canUseTool("plan",HERDR_PLAN_TOOL,{}),true);
 assert.equal(canUseTool("qa",HERDR_PLAN_TOOL,{}),false);
 assert.equal(canUseTool("review",HERDR_PLAN_TOOL,{}),false);
 assert.deepEqual(toolsForPhase(["read",HERDR_PLAN_TOOL,"bash","write"],"review"),["read","bash"]);
 assert.deepEqual(toolsForPhase(["read",HERDR_PLAN_TOOL,"bash","write"],"plan"),
   ["read",HERDR_PLAN_TOOL,"bash"]);
 assert.equal(canUseTool("plan","write"),false);
 assert.equal(canUseTool("plan","subagent",{task:"change source"}),false);
});
test("Herdr prompt uses argv only, appends mandatory read-only peer guidance, and clips output",async()=>{
 const calls:unknown[]=[];
 const runner=async(args:readonly string[],timeout:number)=>{
   calls.push({args,timeout});return "Peer analysis: use immutable cache before retry.";
 };
 assert.deepEqual(buildHerdrArgs({action:"list"}),{argv:["agent","list"],timeoutMs:10000});
 assert.deepEqual(buildHerdrArgs({action:"get",target:"architect"}).argv,
   ["agent","get","architect"]);
 assert.deepEqual(buildHerdrArgs({action:"read",target:"w1:p1",lines:200}).argv,
   ["agent","read","w1:p1","--source","recent-unwrapped","--lines","160","--format","text"]);
 assert.deepEqual(buildHerdrArgs({action:"wait",target:"architect",timeoutMs:8000}).argv,
   ["agent","wait","architect","--timeout","8000"]);
 const query='Review whether API v5 supports cache behavior; do not implement.';
 const out=await herdrPeerAction({action:"prompt",target:"architect",prompt:query,timeoutMs:7000},runner);
 assert.match(out,/Peer analysis/);
 const args=(calls[0] as any).args;
 assert.deepEqual(args.slice(0,3),["agent","prompt","architect"]);
 assert.equal(args[3],HERDR_PLAN_PREFIX+query);
 assert.equal(args.length,4,"prompt submits once; wait/read are separate commands");
 assert.equal((calls[0] as any).timeout,10000);
 // Shell metacharacters in the question are sent as ONE argument, never executed locally.
 const suspicious="Review this literal command: ; rm -rf /tmp/test (do not run it)";
 const built=buildHerdrArgs({action:"prompt",target:"architect",prompt:suspicious});
 assert.equal(built.argv[3],HERDR_PLAN_PREFIX+suspicious);
 assert.throws(()=>buildHerdrArgs({action:"prompt",target:"--help",prompt:query}),/target/);
 for(const action of ["start","rename","run","send-keys","pane","workspace"])
  assert.throws(()=>buildHerdrArgs({action:action as any,target:"architect"}),/supports/);
 assert.throws(()=>buildHerdrArgs({action:"prompt",target:"architect",prompt:"short"}),/12/);
 assert.throws(()=>buildHerdrArgs({action:"read",target:"foo;touch"}),/target/);
});
test("Pi tool registration exposes Herdr safely and returns clear errors on backend failure",async()=>{
 let extensionTool:any;
 registerHerdrPlanningTool({registerTool:(tool:any)=>extensionTool=tool} as any,
   async(args)=>{if(args[1]==="get")throw Error("socket unavailable");return "agent researcher idle";});
 assert.equal(extensionTool.name,HERDR_PLAN_TOOL);
 assert.equal(extensionTool.defaultActive,false);
 const list=await extensionTool.execute("call1",{action:"list"},undefined,undefined,{});
 assert.equal(list.isError,undefined);
 assert.match(list.content[0].text,/agent researcher idle/);
 const error=await extensionTool.execute("call2",{action:"get",target:"researcher"},undefined,undefined,{});
 assert.equal(error.isError,true);
 assert.match(error.content[0].text,/socket unavailable/);
});
