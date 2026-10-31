import test from "node:test";
import assert from "node:assert/strict";
import {allowedCandidates,canDispatch,modelCapacity,safeThinking} from "../routing/compatibility.ts";
import {ModelHealth,describeDispatchIssue,DEFAULT_HEALTH} from "../health.ts";
import {newNineRouterManagedModel} from "../integrations/nine-router-models.ts";
const make=(key:string,window?:number)=>({
 key,label:key,enabled:true,specialty:"coding",avoid:"",cost:"balanced" as const,
 thinking:"high" as const,...(window?{contextWindow:window,maxTokens:8192,metadataSource:"reported" as const}:{})
});
test("observed usage prevents switching to smaller known context models",()=>{
 const tiny=make("test/tiny",40000),large=make("test/large",128000);
 const candidates=allowedCandidates([tiny,large],m=>({contextWindow:m.contextWindow,maxTokens:8192}),36000);
 assert.deepEqual(candidates.models.map(m=>m.key),["test/large"]);
 assert.deepEqual(candidates.excluded,["test/tiny"]);
});
test("missing usage or unverified limits do not falsely reject models",()=>{
 const proxy=make("jev-9router/foo");
 const cap=modelCapacity({...proxy,contextWindow:128000,maxTokens:8192}, {contextWindow:128000,maxTokens:8192});
 assert.equal(cap.provenance,"assumed");
 assert.equal(canDispatch(200000,cap),true,"must not treat assumed metadata as verified");
 assert.equal(canDispatch(undefined,modelCapacity(make("test/small",40000))),true);
});
test("manual limits remain clearly labeled and can guard switches",()=>{
 const c=modelCapacity({...make("jev-9router/a",32000),metadataSource:"manual"},
   {contextWindow:32000,maxTokens:8192});
 assert.equal(c.provenance,"manual");
 assert.equal(canDispatch(30000,c),false);
 assert.match(c.warnings.join(" "),/Manually configured/);
});
test("thinking settings honor physical reasoning capabilities",()=>{
 assert.equal(safeThinking(make("test/model"),{reasoning:false}),"off");
 assert.equal(safeThinking({...make("test/model"),thinking:"max"}),"xhigh");
 assert.equal(safeThinking({...make("test/model"),thinking:"minimal"}),"low");
});
test("9Router imports explicitly label unverified default capability limits",()=>{
 const unknown=newNineRouterManagedModel({id:"abc",name:"abc"});
 const reported=newNineRouterManagedModel({id:"def",name:"def",contextWindow:32000,maxTokens:4096});
 assert.equal(unknown.metadataSource,"assumed");
 assert.equal(reported.metadataSource,"reported");
});
test("parameter errors are diagnostics, never provider outage/quarantine",()=>{
 assert.equal(describeDispatchIssue("HTTP 400: unsupported reasoning parameter").kind,"parameter");
 assert.equal(describeDispatchIssue("Maximum context length exceeded").kind,"context");
 assert.equal(describeDispatchIssue("429 quota exceeded").kind,"rate_limit");
 const health=new ModelHealth();
 assert.equal(health.reportFailure("p/model","error","HTTP 400 unsupported max_tokens",DEFAULT_HEALTH),undefined);
 assert.equal(health.isEligible("p/model",DEFAULT_HEALTH),true);
 assert.equal(health.lastDispatchIssue()?.kind,"parameter");
 assert.doesNotMatch(JSON.stringify(health.lastDispatchIssue()),/max_tokens|API_KEY/);
});
