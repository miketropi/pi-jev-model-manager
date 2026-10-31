import test from "node:test";
import assert from "node:assert/strict";
import {planningTier,planningPool,enforcePlanningQuality} from "../routing/planning-quality.ts";
import {knownModelProfile} from "../model-profiles.ts";
import {choose} from "../routing/choose.ts";
import {defaultTaskRules} from "../task-routing.ts";
const model=(id:string,label=id)=>({
  key:"proxy/"+id,label,enabled:true,specialty:"General software engineering",
  avoid:"",cost:"balanced" as const,thinking:"medium" as const,
});
const fast=model("gpt-5.6-luna","Builder • Fast (GPT-5.6 Luna)");
const deep=model("claude-opus-4-6");
const balanced=model("claude-sonnet-4-6");
const unknown=model("custom-unverified");

test("GPT-5.6 Luna and explicit Builder Fast labels are not planning tier",()=>{
  assert.equal(knownModelProfile(fast.key)?.tier,"fast");
  assert.equal(planningTier(fast),"fast");
  assert.equal(planningTier(model("my-custom","Builder • Fast")),"fast");
  assert.equal(planningTier(deep),"deep");
  assert.equal(planningTier(balanced),"balanced");
  assert.equal(planningTier(unknown),"unknown");
});

test("planning pool excludes fast/unknown when verified curated deep/balanced models exist",()=>{
  const pool=planningPool([fast,unknown,balanced,deep]);
  assert.deepEqual(pool.candidates.map(x=>x.key),[deep.key,balanced.key]);
  assert.equal(pool.preferred.key,deep.key);
  assert.equal(pool.restricted,true);
  assert.equal(pool.degraded,false);
  const corrected=enforcePlanningQuality(fast.key,[fast,balanced,deep]);
  assert.equal(corrected.model,deep.key);
  assert.equal(corrected.changed,true);
  assert.equal(enforcePlanningQuality(balanced.key,[fast,balanced,deep]).changed,false);
});
test("unknown model is a documented degraded fallback ahead of known fast tiers",()=>{
  const pool=planningPool([fast,unknown]);
  assert.deepEqual(pool.candidates.map(x=>x.key),[unknown.key]);
  assert.equal(pool.degraded,true);
  assert.match(pool.reason,/unverified/);
});
test("fast-only plan remains runnable but exposes a quality degradation warning",()=>{
  const p=planningPool([fast]);
  assert.equal(p.preferred.key,fast.key);
  assert.equal(p.degraded,true);
  assert.match(p.reason,/fast-tier only/);
  assert.throws(()=>planningPool([]),/eligible/);
});

test("automatically inferred plan overrides fast classifier selection with a qualified model",async()=>{
  const candidates=[fast,deep,balanced];
  const cfg:any={enabled:true,mode:"auto",minProbability:0.43,fallback:fast.key,taskRules:defaultTaskRules(),
    classifier:{provider:"typesafe",model:"jev-latest"}};
  const ctx:any={modelRegistry:{
    findOfType:()=>({id:"jev-latest"}),
    classify:async()=>({stopReason:"stop",answers:{
      task:{type:"choice",choice:"plan",probabilities:{plan:.99}},
      selected_model:{type:"choice",choice:"m0",probabilities:{m0:.99}}
    }})
  }};
  const result=await choose("Architect a new application",cfg,candidates,ctx);
  assert.equal(result.model,deep.key);
  assert.match(result.reason,/planning quality guard/);
  cfg.taskRules.plan={mode:"force",model:fast.key};
  const manuallyForced=await choose("Architect a new application",cfg,candidates,ctx);
  assert.equal(manuallyForced.model,fast.key);
});
