#!/usr/bin/env node
/* Synthetic, deterministic projection benchmark. Not an OMP quality benchmark. */
import {projectHistory,DEFAULT_RUNTIME_POLICY} from "../context/runtime-policy.ts";
import {scopedPlanBrief,boundAgentReport} from "../context/subagent-brief.ts";
const scenarios=[];
for(const [name,counts,chars,ratio] of [["low-pressure",12,25000,.4],["high-pressure",12,25000,.85],["short-results",12,1000,.85]]) {
 const messages=Array.from({length:counts},(_,i)=>({
  role:"toolResult",toolName:i%2?"bash":"read",toolCallId:"call-"+i,
  content:[{type:"text",text:"Example code and diagnostics ".repeat(Math.ceil(chars/29)).slice(0,chars)}],
 }));
 const out=projectHistory(messages,DEFAULT_RUNTIME_POLICY,ratio);
 const baseline=messages.reduce((s,x)=>s+x.content[0].text.length,0);
 scenarios.push({name,baselineToolChars:baseline,projectedToolChars:baseline-out.savedChars,
  omittedChars:out.savedChars,omittedPercent:baseline?Math.round(out.savedChars*100/baseline):0,
  protectedRecent:DEFAULT_RUNTIME_POLICY.recentToolResults,optimized:out.optimized,
  originalHistoryUntouched:messages[0].content[0].text.length===chars});
}
const plan="global constraints: no unrelated edits\n"+Array(800).fill("background detail").join("\n")+
 "\nTask 5 update src/module.ts and test\n"+Array(800).fill("irrelevant note").join("\n")+
 "\nAcceptance criteria: all tests pass";
const brief=scopedPlanBrief(plan,5,"update module",["src/module.ts"]);
const rawReport="tool output\n".repeat(5000);
const agent=boundAgentReport(rawReport);
console.log(JSON.stringify({kind:"synthetic-context-policy",
 note:"Approximate characters only, not actual token, OMP or quality/cost claims",
 scenarios,builder:{planOriginalChars:plan.length,scopedPromptChars:brief.text.length,
 reportOriginalChars:rawReport.length,reportReturnedChars:agent.length}},null,2));
