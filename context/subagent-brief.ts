/** Bounded task-context selection; never manufacture missing implementation details. */
export interface ScopedBrief {text:string;shortened:boolean;originalChars:number}
export function scopedPlanBrief(plan:string,step:number,title:string,files:readonly string[],
 maxChars=6500):ScopedBrief {
 if(plan.length<=maxChars)return {text:plan,shortened:false,originalChars:plan.length};
 const lines=plan.split("\n");
 const selectors=[String(step),title,...files].filter(Boolean).map(x=>x.toLowerCase());
 const matches=lines.map((line,index)=>({line,index}))
  .filter(x=>selectors.some(key=>key.length>=3&&x.line.toLowerCase().includes(key)));
 const relevant=new Set<number>();
 for(const item of matches.slice(0,24))
  for(let i=Math.max(0,item.index-2);i<=Math.min(lines.length-1,item.index+5);i++)relevant.add(i);
 const head=plan.slice(0,2500);
 const selected=[...relevant].sort((a,b)=>a-b).map(i=>lines[i]).join("\n").slice(0,3000);
 const tail=plan.slice(-600);
 const intro="[SCOPED PLAN EXCERPT; not the full approved plan. If a missing constraint affects your task, stop and ask Lead. Never infer omitted requirements.]\n";
 const text=(intro+head+"\n[Relevant steps and file references]\n"+selected+"\n[Plan ending / acceptance]\n"+tail).slice(0,maxChars);
 return {text,shortened:true,originalChars:plan.length};
}
export function boundAgentReport(text:string,max=7500):string {
 if(text.length<=max)return text;
 const marker="\n[Additional agent output omitted from Lead view. Inspect changed files and rerun tests; this is NOT evidence of completion.]\n";
 const head=Math.floor((max-marker.length)*.55);
 return text.slice(0,head)+marker+text.slice(-(max-marker.length-head));
}
