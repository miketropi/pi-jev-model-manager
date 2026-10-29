import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_TYPES, applyTaskRule, defaultTaskRules, normalizeTaskRules, filterModels, subagentTaskType,
} from "../task-routing.ts";
import { chooseSearchableModel, configureTaskRules } from "../task-ui.ts";

test("task rules migrate legacy JSON config and reject invalid model policies", () => {
  assert.equal(TASK_TYPES.length, 8);
  assert.ok(TASK_TYPES.includes("write"));
  assert.equal(normalizeTaskRules({write: {mode:"force",model:"provider/writer"}}).write.model, "provider/writer");
  const original = defaultTaskRules();
  assert.equal(original.plan.mode, "auto");
  assert.deepEqual(normalizeTaskRules(undefined), original);
  assert.equal(normalizeTaskRules({review: {mode:"force",model:"provider/real"}}).review.model,"provider/real");
  assert.equal(normalizeTaskRules({review: {mode:"force",model:""}}).review.mode,"auto");
  assert.equal(normalizeTaskRules({review: {mode:"malformed",model:"provider/real"}}).review.mode,"auto");
});

test("force and prefer policies never produce an unavailable model", () => {
  const rules = defaultTaskRules();
  rules.review = {mode:"force",model:"pi/reviewer"};
  rules.implement = {mode:"prefer",model:"pi/fast"};
  assert.deepEqual(applyTaskRule("review","pi/fast","pi/safe",["pi/safe","pi/fast","pi/reviewer"],rules),
    {model:"pi/reviewer",reason:"review force policy"});
  assert.match(applyTaskRule("review","pi/fast","pi/safe",["pi/safe","pi/fast"],rules).reason, /unavailable/);
  assert.equal(applyTaskRule("review","pi/fast","pi/safe",["pi/safe","pi/fast"],rules).model,"pi/safe");
  assert.equal(applyTaskRule("implement","pi/safe","pi/safe",["pi/safe","pi/fast"],rules).model,"pi/fast");
  assert.equal(applyTaskRule("implement","pi/safe","pi/safe",["pi/safe"],rules).model,"pi/safe");
  assert.equal(applyTaskRule("review","pi/fast","pi/safe",["pi/safe","pi/fast","pi/reviewer"],rules,0.1).model,"pi/fast");
});

test("search supports long catalogs and case-insensitive name/provider/ID search", () => {
  const models = Array.from({length:500},(_,i)=>({key:`jev-9router/model-${i}`,label:`Model ${i}`}));
  models.push({key:"anthropic/claude-opus-4-6",label:"Opus Reviewer"});
  assert.equal(filterModels(models,"",50).length,50);
  assert.deepEqual(filterModels(models,"CLAUDE").map(m=>m.key),["anthropic/claude-opus-4-6"]);
  assert.deepEqual(filterModels(models,"reviewer").map(m=>m.key),["anthropic/claude-opus-4-6"]);
});

test("searchable selector filters first, then selects the exact intended model", async () => {
  const models = Array.from({length:300},(_,i)=>({key:`proxy/id-${i}`,label:`Model ${i}`}));
  const selections:string[][]=[];
  let count=0;
  const picked=await chooseSearchableModel({ui:{
    select:async(_title:string,opts:string[])=>{
      selections.push(opts);
      return count++ === 0 ? opts[0] : opts.find(x=>x.endsWith("[proxy/id-289]"));
    },
    input:async()=>"id-289",
  }} as any,models);
  assert.equal(picked,"proxy/id-289");
  assert.ok(selections[0].length<=52); // limit is 50 + search + cancel
  assert.equal(selections[1].length,3);
});

test("task TUI keeps old rule if choosing model is canceled", async () => {
  const rules=defaultTaskRules();
  let n=0,saves=0;
  await configureTaskRules({ui:{
    select:async(_title:string,choices:string[])=>{
      switch(n++) {
        case 0:return choices.find(x=>x.startsWith("Code Review:"));
        case 1:return "Force a model";
        case 2:return "Cancel";
        default:return "Back";
      }
    },
    input:async()=>undefined,
    notify:()=>{},
  }} as any,rules,[{key:"proxy/review",label:"Review"}],()=>saves++);
  assert.equal(rules.review.mode,"auto");
  assert.equal(saves,0);
});

test("subagent role aliases map known agent names only", () => {
  assert.equal(subagentTaskType({agent:"planner"}),"plan");
  assert.equal(subagentTaskType({agent:"builder"}),"implement");
  assert.equal(subagentTaskType({agent:"reviewer"}),"review");
  assert.equal(subagentTaskType({role:"debug"}),"debug");
  assert.equal(subagentTaskType({agent:"unrecognized"}),undefined);
});
