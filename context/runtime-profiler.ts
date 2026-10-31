/** Counts only: no prompts, secrets or raw tool content are persisted. */
export type ContextCategory="read"|"bash"|"search"|"delegation"|"other";
export function categoryOf(tool:string):ContextCategory {
 if(tool==="read")return "read";
 if(tool==="bash")return "bash";
 if(["grep","find","ls","rg"].includes(tool))return "search";
 if(["subagent","jev_delegate","jev_collaborate"].includes(tool))return "delegation";
 return "other";
}
export interface ProfilerSnapshot {
 byCategory:Record<ContextCategory,{calls:number;chars:number}>;
 toolCalls:number; compactions:number; preCompactions:number;
 modelSwitches:number; latestSystemPromptChars:number;
 shortenedChars:number; optimizedResults:number;
 observedTokens:number|null; contextWindow:number|null;
 workflow:string;
}
export class ContextProfiler {
 private values:ProfilerSnapshot;
 constructor(){this.values=this.blank();}
 private blank():ProfilerSnapshot{return {
  byCategory:{read:{calls:0,chars:0},bash:{calls:0,chars:0},
    search:{calls:0,chars:0},delegation:{calls:0,chars:0},other:{calls:0,chars:0}},
  toolCalls:0,compactions:0,preCompactions:0,modelSwitches:0,latestSystemPromptChars:0,
  shortenedChars:0,optimizedResults:0,
  observedTokens:null,contextWindow:null,workflow:"unknown"
 };}
 reset(){this.values=this.blank();}
 recordTool(name:string,content:unknown){
  const key=categoryOf(name);
  const blocks=Array.isArray(content)?content:[];
  const chars=blocks.reduce((n:any,b:any)=>n+(b?.type==="text"&&typeof b.text==="string"?b.text.length:0),0);
  this.values.byCategory[key].calls++;this.values.byCategory[key].chars+=chars;
  this.values.toolCalls++;
 }
 observe(usage:any,workflow?:string){
  if(typeof workflow==="string")this.values.workflow=workflow;
  if(Number.isSafeInteger(usage?.tokens)&&usage.tokens>=0)this.values.observedTokens=usage.tokens;
  if(Number.isSafeInteger(usage?.contextWindow)&&usage.contextWindow>0)
   this.values.contextWindow=usage.contextWindow;
 }
 beforeCompact(){this.values.preCompactions++;}
 compact(){this.values.compactions++;}
 modelSwitch(){this.values.modelSwitches++;}
 systemPrompt(chars:number){if(Number.isFinite(chars)&&chars>=0)this.values.latestSystemPromptChars=chars;}
 reclaim(chars:number,results:number){this.values.shortenedChars+=chars;this.values.optimizedResults+=results;}
 snapshot():ProfilerSnapshot{return JSON.parse(JSON.stringify(this.values));}
 report():string {
  const s=this.values;
  const observed=s.observedTokens===null||s.contextWindow===null?"unknown":
   s.observedTokens+" / "+s.contextWindow+" ("+(100*s.observedTokens/s.contextWindow).toFixed(1)+"%)";
  const rows=(Object.keys(s.byCategory) as ContextCategory[]).map(k=>
    k+": "+s.byCategory[k].calls+" calls, "+s.byCategory[k].chars+" characters");
  return ["JEV Context Profiler · "+s.workflow,"Observed context tokens: "+observed,
    "Breakdown below is tool-output CHARACTERS (not token counts or complete context share):",
    ...rows,
    "Tool calls: "+s.toolCalls,
    "Latest system prompt: "+s.latestSystemPromptChars+" characters (not tokens)",
    "Model switches observed: "+s.modelSwitches,
    "Historical tool results shortened in model view: "+s.optimizedResults,
    "Estimated characters omitted across context projections: "+s.shortenedChars,
    "Compactions completed / started: "+s.compactions+" / "+s.preCompactions,
    "Pi still owns actual context accounting and compaction.",
    "No raw content or credentials stored by profiler."].join("\n");
 }
}
