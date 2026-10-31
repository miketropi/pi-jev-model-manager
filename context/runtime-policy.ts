/** Pure, non-destructive context projection. Pi session history stays original. */
export type ContextMode="observe"|"optimize"|"off";
export interface ContextRuntimePolicy {
 mode:ContextMode;
 triggerRatio:number;
 maxOldResultChars:number;
 recentToolResults:number;
 minSavingsChars:number;
}
export const DEFAULT_RUNTIME_POLICY:ContextRuntimePolicy={
 mode:"optimize",triggerRatio:0.70,maxOldResultChars:4800,
 recentToolResults:4,minSavingsChars:12000,
};
export function normalizeRuntimePolicy(raw:any):ContextRuntimePolicy {
 const d=DEFAULT_RUNTIME_POLICY;
 return {
  mode:["observe","optimize","off"].includes(raw?.mode)?raw.mode:d.mode,
  triggerRatio:Number.isFinite(raw?.triggerRatio)?
    Math.max(.5,Math.min(.95,raw.triggerRatio)):d.triggerRatio,
  maxOldResultChars:Number.isInteger(raw?.maxOldResultChars)?
    Math.max(1600,Math.min(10000,raw.maxOldResultChars)):d.maxOldResultChars,
  recentToolResults:Number.isInteger(raw?.recentToolResults)?
    Math.max(2,Math.min(20,raw.recentToolResults)):d.recentToolResults,
  minSavingsChars:Number.isInteger(raw?.minSavingsChars)?
    Math.max(3000,Math.min(100000,raw.minSavingsChars)):d.minSavingsChars,
 };
}
export interface ProjectionResult<T> {
 messages:T[];
 savedChars:number;
 optimized:number;
 eligible:number;
 pressure:boolean;
}
const allowedTools=new Set(["read","bash","grep","find","ls","rg"]);
function resultText(msg:any):string|undefined {
 if(msg?.role!=="toolResult" || msg.isError || !allowedTools.has(msg.toolName))return;
 if(!Array.isArray(msg.content)||!msg.content.length || msg.content.some((x:any)=>x.type!=="text"))return;
 return msg.content.map((x:any)=>x.text).join("\n");
}
function shorten(text:string,max:number):string {
 const marker="\n[Older tool output shortened in model view. Original remains in Pi session history; re-read/re-run for details.]\n";
 if(text.length<=max+marker.length+200)return text;
 const budget=max-marker.length;
 return text.slice(0,Math.floor(budget*.65))+marker+
   text.slice(-Math.ceil(budget*.35));
}
export function projectHistory<T>(messages:readonly T[],policy:ContextRuntimePolicy,
  observedRatio:number|null):ProjectionResult<T> {
 const original=[...messages];
 const pressure=observedRatio!==null && Number.isFinite(observedRatio)
  && observedRatio>=policy.triggerRatio;
 const eligible=original.map((m,i)=>({i,text:resultText(m)}))
  .filter((v):v is {i:number;text:string}=>typeof v.text==="string");
 const old=eligible.slice(0,-policy.recentToolResults);
 const prospective=old.filter(x=>x.text.length>policy.maxOldResultChars+200)
  .reduce((sum,x)=>sum+x.text.length-shorten(x.text,policy.maxOldResultChars).length,0);
 // No rewriting on low pressure or if there isn't material reclaimable context.
 if(policy.mode!=="optimize"||!pressure||prospective<policy.minSavingsChars)
  return {messages:original,savedChars:0,optimized:0,eligible:eligible.length,pressure};
 let saved=0,optimized=0;
 for(const item of old) {
  const short=shorten(item.text,policy.maxOldResultChars);
  if(short.length===item.text.length)continue;
  const source=original[item.i] as any;
  // Shallow-copy message and blocks; never mutate Pi's session/event inputs.
  const blocks=source.content as {type:"text";text:string}[];
  // Only text-only results qualify, so a single block retains original structure.
  const replaced=blocks.length===1
    ?[{...blocks[0],text:short}]
    :[{type:"text",text:short}];
  original[item.i]={...source,content:replaced};
  optimized++;saved+=item.text.length-short.length;
 }
 return {messages:original,savedChars:saved,optimized,eligible:eligible.length,pressure};
}
