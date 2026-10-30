import test from "node:test";
import assert from "node:assert/strict";
import {knownModelProfile,effectiveModelProfile,classifierModelGuidance}
  from "../model-profiles.ts";

test("family hints match provider-nested real model slugs, not unrelated labels",()=>{
 const samples=[
  ["anthropic/claude-opus-4-6","Claude","deep"],
  ["jev-9router/cc/claude-sonnet-4-5-20250929","Claude","balanced"],
  ["anthropic/claude-haiku-4-5","Claude","fast"],
  ["openai/gpt-6-astra","OpenAI","deep"],
  ["mock/gpt-6.1-sol","OpenAI","balanced"],
  ["mock/gpt-6-luna","OpenAI","fast"],
  ["openai/gpt-5.3-codex","OpenAI","balanced"],
  ["deepseek/deepseek-v4-pro","DeepSeek","deep"],
  ["jev-9router/deepseek/deepseek-v4-flash","DeepSeek","fast"],
  ["deepseek/deepseek-v4.1-flash","DeepSeek","fast"],
  ["minimax/MiniMax-M2.5","MiniMax","balanced"],
  ["minimax/MiniMax-M2.7","MiniMax","deep"],
  ["minimax/MiniMax-M3","MiniMax","deep"],
  ["moonshot/kimi-k2.5","Kimi","balanced"],
  ["moonshot/kimi-k2.7-code","Kimi","deep"],
  ["moonshot/kimi-k3","Kimi","deep"],
 ];
 for(const [key,family,tier] of samples){
  const actual=knownModelProfile(key);
  assert.equal(actual?.family,family,key);
  assert.equal(actual?.tier,tier,key);
  assert.ok(actual?.specialty.length!>45,key);
  assert.ok(actual?.avoid.length!>20,key);
 }
 for(const key of ["", "vendor/opus-helper","mock/sonnet-analyzer",
    "mock/claude-impersonator","mock/gpt-money-transfer","mock/minimaximal"]) {
  assert.equal(knownModelProfile(key),undefined,"unrelated vendor text: "+key);
 }
});

test("old placeholder gets curated strengths, user edits and cost remain authoritative",()=>{
 const model={key:"jev-9router/cc/claude-sonnet-4-6",
  label:"Claude Sonnet",cost:"premium",
  specialty:"General software engineering (edit capabilities after import)",avoid:""};
 const enhanced=effectiveModelProfile(model);
 assert.match(enhanced.specialty,/Production coding/);
 assert.match(enhanced.avoid,/trivial/);
 const preview=classifierModelGuidance(model);
 assert.match(preview,/Curated family context: Claude/);
 assert.match(preview,/User-configured relative cost: premium/);
 assert.ok(preview.length<900,"classifier descriptions should be concise");
 const customized=classifierModelGuidance({
  ...model,specialty:"ONLY internal WordPress security audits",
  avoid:"Avoid writing deployment instructions"
 });
 assert.match(customized,/ONLY internal WordPress security audits/);
 assert.match(customized,/Avoid writing deployment instructions/);
 assert.doesNotMatch(customized,/Best suited for: Production coding/);
 assert.doesNotMatch(customized,/Avoid for: Spending premium reasoning/);
 assert.equal(effectiveModelProfile({key:"mock/unlisted",specialty:"User custom",avoid:"Not for email"}).specialty,"User custom");
});
