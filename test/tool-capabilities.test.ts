import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolGrants,grantForPhase,grantsToolCall
} from "../tool-capabilities.ts";
import {toolsForPhase,canUseTool} from "../workflow.ts";
test("opt-in declarative capabilities enable unfamiliar agent tools in Plan without granting execution",()=>{
 const grants=normalizeToolGrants([
  {tool:"paseo_bridge",capability:"delegate_research",
    phases:["plan","review"],actionField:"operation",
    allowedActions:["agents","ask_peer","read_peer","spawn_agent"]},
  {tool:"paseo_bridge",capability:"delegate_research",phases:["plan"],
    actionField:"operation",allowedActions:["agents"]},
  {tool:"peer_hub",capability:"communicate",phases:["plan"],
    actionField:"intent",allowedActions:["ask","discuss","status"]},
  {tool:"mcp_observe",capability:"read",phases:["plan","qa","review"]},
  {tool:"workhorse",capability:"write",phases:["plan"]},
  {tool:"bash",capability:"read",phases:["plan"]},
  {tool:"subagent",capability:"delegate_research",phases:["plan"],actionField:"action",
    allowedActions:["prompt"]},
 ]);
 assert.deepEqual(grants.map(g=>g.tool),["paseo_bridge","peer_hub","mcp_observe"],
   "mutating grants rejected while a later safe grant for that tool is retained");
 const only=normalizeToolGrants([{
   tool:"paseo_bridge",capability:"delegate_research",phases:["plan","qa"],
   actionField:"operation",allowedActions:["ask_peer","read_peer"]
 }]);
 assert.deepEqual(only[0].phases,["plan"],"QA never inherits peer delegation capability");
 assert.equal(grantsToolCall("paseo_bridge","plan",{operation:"ask_peer"},only),true);
 assert.equal(grantsToolCall("paseo_bridge","plan",{operation:"spawn_agent"},only),false);
 assert.equal(grantsToolCall("paseo_bridge","plan",{},only),false);
 assert.equal(grantsToolCall("paseo_bridge","qa",{operation:"ask_peer"},only),false);
 assert.equal(grantsToolCall("mcp_observe","review",{},grants),true);
 assert.equal(grantForPhase("unregistered","plan",grants),undefined);
 assert.equal(canUseTool("plan","bash",{command:"npm install"},only),false);
 assert.deepEqual(toolsForPhase(["read","paseo_bridge","write","bash"],"plan",only),
   ["read","paseo_bridge","bash"]);
 assert.equal(canUseTool("plan","peer_hub",{intent:"discuss"},grants),true);
 assert.equal(canUseTool("plan","peer_hub",{intent:"send_keys"},grants),false);
 assert.equal(canUseTool("plan","tool_that_sounds_readonly",{},grants),false,
   "tool names and descriptions are not trusted");
});
test("capability normalizer rejects unclear or malformed permission grants",()=>{
 const rejected=normalizeToolGrants([
  {tool:"unknown",capability:"communicate",phases:["plan"]},
  {tool:"nomutator",capability:"read",phases:["implement"]},
  {tool:"jev_delegate",capability:"read",phases:["plan"]},
  {tool:"random",capability:"admin",phases:["plan"]},
  {tool:"write",capability:"read",phases:["plan"]},
  {tool:"untrusted",capability:"delegate_research",phases:["plan"],
   actionField:"action",allowedActions:["execute"]},
  {tool:"will_spawn",capability:"delegate_research",phases:["plan"],
   actionField:"action",allowedActions:["ask","spawn_agent"]},
 ]);
 assert.equal(rejected.length,0);
 assert.equal(canUseTool("plan","Agent",{prompt:"read only"},rejected),false);
 assert.equal(canUseTool("qa","edit",{path:"article.md"},rejected),false);
});
