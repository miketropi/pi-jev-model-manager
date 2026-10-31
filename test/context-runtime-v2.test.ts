import test from "node:test";
import assert from "node:assert/strict";
import {projectHistory,DEFAULT_RUNTIME_POLICY,normalizeRuntimePolicy} from "../context/runtime-policy.ts";
import {ContextProfiler} from "../context/runtime-profiler.ts";
import {scopedPlanBrief,boundAgentReport} from "../context/subagent-brief.ts";
import {suggestJevStrategy} from "../context/jev-strategy.ts";
const row=(name:string,text:string,extra:any={})=>({role:"toolResult",toolName:name,
 toolCallId:name,content:[{type:"text",text}],...extra});
test("projection only trims old successful text-only tool outputs at real observed pressure",()=>{
 const msg=[row("read","A".repeat(20000)),row("bash","B".repeat(20000)),
  row("grep","C".repeat(20000)),row("read","D".repeat(20000)),
  row("read","E".repeat(20000)),row("read","F".repeat(20000)),
  row("read","G".repeat(20000)),row("read","H".repeat(20000))];
 const snapshot=JSON.stringify(msg);
 const low=projectHistory(msg,DEFAULT_RUNTIME_POLICY,.2);
 assert.equal(low.optimized,0);
 const high=projectHistory(msg,DEFAULT_RUNTIME_POLICY,.89);
 assert.equal(high.optimized,4);
 assert.ok(high.savedChars>50000);
 assert.equal(JSON.stringify(msg),snapshot,"never mutate stored session history");
 assert.equal(high.messages.at(-1)?.content[0]?.text.length,20000,"protect newest");
 assert.match(high.messages[0].content[0].text,/Older tool output shortened/);
});
test("projection fails closed on errors, images, unsupported tools or insufficient savings",()=>{
 const msg=[row("read","A".repeat(30000),{isError:true}),
  {role:"toolResult",toolName:"read",content:[{type:"image",data:"base64"}]},
  row("jev_context_read","X".repeat(20000)),row("read","G".repeat(9000)),
  ...Array.from({length:4},()=>row("bash","x"))];
 const projected=projectHistory(msg,DEFAULT_RUNTIME_POLICY,.92);
 assert.equal(projected.optimized,0);
 assert.equal(projected.savedChars,0);
 assert.deepEqual(projectHistory(msg,{...DEFAULT_RUNTIME_POLICY,mode:"observe"},.9).messages,msg);
 assert.equal(normalizeRuntimePolicy({mode:"hacked",recentToolResults:-99}).mode,"optimize");
});
test("profile records char-based metrics and actual tokens separately",()=>{
 const p=new ContextProfiler();
 p.recordTool("read",[{type:"text",text:"secret-but-not-persisted"}]);
 p.recordTool("bash",[{type:"text",text:"test"}]);
 p.observe({tokens:12000,contextWindow:32000},"implement");
 p.beforeCompact();p.compact();p.reclaim(1500,1);
 const report=p.report();
 assert.match(report,/12000 \/ 32000/);
 assert.match(report,/characters/);
 assert.doesNotMatch(report,/secret-but-not-persisted/);
 assert.equal(p.snapshot().byCategory.read.calls,1);
 assert.equal(p.snapshot().compactions,1);
 p.reset();assert.equal(p.snapshot().toolCalls,0);
});
test("scope-limited Builder brief preserves relevant references and refuses hidden assumptions",()=>{
 const plan="Goals and nonnegotiable constraints\n"+Array(600).fill("Background background background").join("\n")+
  "\nStep 7: Implement donation forms in src/blocks/donation.ts\nDo not bypass validation\n"+
  Array(200).fill("notes").join("\n")+"\nAcceptance: run payment tests";
 const brief=scopedPlanBrief(plan,7,"Implement donation forms",["src/blocks/donation.ts"]);
 assert.equal(brief.shortened,true);
 assert.ok(brief.text.length<=6500);
 assert.match(brief.text,/Do not bypass validation/);
 assert.match(brief.text,/Acceptance: run payment tests/);
 assert.match(brief.text,/SCOPED PLAN EXCERPT/);
 assert.match(boundAgentReport("x".repeat(10000)),/NOT evidence of completion/);
 assert.equal(scopedPlanBrief("Short plan",1,"task",[]).shortened,false);
});
test("TypeSafe Jev typed strategy is advisory and confidence gated",async()=>{
 const cfg={provider:"typesafe",model:"jev-latest"};
 const fake=(isolation:string,complexity:string,confidence:number)=>({
  findOfType:()=>({provider:"typesafe",id:"jev-latest"}),
  classify:async()=>({stopReason:"stop",answers:{
   isolation:{type:"choice",choice:isolation,probabilities:{[isolation]:confidence}},
   complexity:{type:"choice",choice:complexity,probabilities:{[complexity]:.9}}
  }})
 });
 const task="Separate research across docs and independent code modules";
 assert.equal((await suggestJevStrategy(task,"plan",fake("independent","complex",.9),cfg)).strategy,"scout");
 assert.equal((await suggestJevStrategy(task,"implement",fake("independent","complex",.9),cfg)).strategy,"builders");
 assert.equal((await suggestJevStrategy(task,"plan",fake("independent","complex",.4),cfg)).strategy,"direct");
 assert.equal((await suggestJevStrategy(task,"plan",fake("sequential","complex",.9),cfg)).strategy,"direct");
 assert.equal((await suggestJevStrategy(task,"plan",{findOfType:()=>null,classify:async()=>{}},cfg)).source,"fallback");
});
