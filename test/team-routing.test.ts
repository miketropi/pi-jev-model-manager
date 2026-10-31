import test from "node:test";
import assert from "node:assert/strict";
import {resolveTeamRole,herdrLaunchExample,normalizeTeamRole} from "../team-routing.ts";
import {defaultTaskRules} from "../task-routing.ts";
import {canUseTool} from "../workflow.ts";
const m=(key:string,cost:"budget"|"balanced"|"premium",thinking="medium")=>({
  key:"proxy/"+key,label:key,enabled:true,specialty:"coding",avoid:"",cost,
  thinking:thinking as any
});
const models=[
  m("gpt-5.6-luna","budget","low"),
  m("claude-sonnet-4-6","balanced"),
  m("claude-opus-4-6","premium","high"),
];
const get=(role:string,difficulty:"small"|"normal"|"hard"="normal",config=defaultTaskRules())=>{
 const r=resolveTeamRole(role,difficulty,models,config);
 assert.equal(r.ok,true);
 if(!r.ok)throw new Error(r.error);
 return r.route;
};
test("PM/Dev/QA/Reviewer do not inherit the parent's deep planning model",()=>{
 assert.equal(get("pm").model,models[1].key);
 assert.equal(get("dev").model,models[1].key);
 assert.equal(get("qa").model,models[0].key);
 assert.equal(get("reviewer").model,models[1].key);
 assert.equal(get("orchestrator").model,models[1].key);
 assert.equal(get("researcher").model,models[0].key);
 assert.equal(get("architect","hard").model,models[2].key);
 assert.equal(get("reviewer","hard").model,models[2].key);
 assert.equal(get("developer","small").model,models[0].key);
 assert.equal(normalizeTeamRole("QA"),"qa");
 assert.equal(normalizeTeamRole("dev"),"dev");
 assert.equal(normalizeTeamRole("project-manager"),undefined);
});
test("user force/prefer overrides the heuristic; missing force does not silently choose a premium model",()=>{
 const rules=defaultTaskRules();
 rules.implement={mode:"force",model:models[2].key};
 assert.equal(get("dev","normal",rules).model,models[2].key);
 assert.equal(get("orchestrator","normal",{
   ...rules,plan:{mode:"force",model:models[2].key}
 }).model,models[1].key,"Orchestrator must not inherit forced premium Planning policy");
 rules.qa={mode:"prefer",model:models[1].key};
 assert.equal(get("qa","normal",rules).model,models[1].key);
 rules.review={mode:"force",model:"proxy/missing"};
 const unavailable=resolveTeamRole("reviewer","normal",models,rules);
 assert.equal(unavailable.ok,false);
 assert.match((unavailable as any).error,/Forced review model is unavailable/);
});
test("real availability matters; quality fallback visible instead of fabricated cheaper model",()=>{
 const onlyPremium=[models[2]];
 const r=resolveTeamRole("dev","normal",onlyPremium,defaultTaskRules());
 assert.equal(r.ok,true);
 if(!r.ok)return;
 assert.equal(r.route.model,models[2].key);
 assert.equal(r.route.degraded,true);
 assert.equal(resolveTeamRole("qa","normal",[],defaultTaskRules()).ok,false);
 assert.equal(resolveTeamRole("unknown","normal",models,defaultTaskRules()).ok,false);
});
test("Herdr launch contract passes independent per-role physical model selection",()=>{
 const r=get("qa");
 const cmd=herdrLaunchExample("qa","w1:p2","omp",r);
 assert.equal(cmd,
  "herdr agent start qa --kind omp --pane w1:p2 -- --model proxy/gpt-5.6-luna --thinking low");
 assert.throws(()=>herdrLaunchExample("QA;shutdown","w1:p2","omp",r));
 assert.throws(()=>herdrLaunchExample("qa","w1:p2;bad","omp",r));
 assert.deepEqual(r.cliArgs,["--model",models[0].key,"--thinking","low"]);
});


test("role routing advice is read-only; actual spawning stays blocked in Plan",()=>{
 assert.equal(canUseTool("plan","jev_team_route",{role:"dev"}),true);
 assert.equal(canUseTool("plan","agent_spawn",{role:"dev"}),false);
 assert.equal(canUseTool("plan","bash",{command:"herdr agent start dev --kind omp --pane w1:p2"}),false);
});
