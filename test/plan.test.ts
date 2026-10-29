import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nextPlan, extractPlanText, latestPlanFromBranch, implementationHandoff } from "../plan-artifact.ts";
import { matchingSkills, skillGuidance } from "../skill-routing.ts";

test("plan documents are versioned, Markdown, and require explicit approval", () => {
 const one=nextPlan("Investigate the design. ".repeat(6),undefined,new Date("2026-10-01"));
 assert.equal(one.version,1);assert.equal(one.status,"draft");
 assert.match(one.markdown,/^# Implementation Plan/);
 assert.throws(()=>implementationHandoff(one),/approved/);
 const two=nextPlan(one.markdown+"\nAdd regression tests.",one);
 assert.equal(two.version,2);
 assert.equal(latestPlanFromBranch([{type:"custom",customType:"jev-plan-document",data:one},
    {type:"custom",customType:"jev-plan-document",data:two}]).version,2);
 assert.match(implementationHandoff({...two,status:"approved"}),/Add regression tests/);
 assert.ok(extractPlanText([{role:"assistant",stopReason:"stop",
   content:[{type:"text",text:"Complete architecture plan. ".repeat(5)}]}]));
});

test("reuse Pi-discovered global skills without copying/installing",()=>{
 const installed=[{name:"writing-plans",filePath:"/home/pi/.pi/agent/skills/writing-plans/SKILL.md"},
  {name:"brainstorming",path:"/home/pi/.agents/skills/brainstorming/SKILL.md"},
  {name:"test-driven-development",path:"/p/skills/tdd/SKILL.md"},
  {name:"verification-before-completion",path:"/p/skills/verify/SKILL.md"}];
 assert.deepEqual(matchingSkills("plan",installed).map(s=>s.name),
   ["brainstorming","writing-plans"]);
 assert.ok(skillGuidance("implement",installed).includes("test-driven-development"));
 assert.ok(skillGuidance("qa",installed).includes("verification-before-completion"));
 assert.ok(!skillGuidance("review",[]).includes("/p/"));
});
