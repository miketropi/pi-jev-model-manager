export const PROGRESS_ENTRY="jev-implementation-progress";
export const PROGRESS_WIDGET="jev-implementation-checklist";
export type StepStatus = "pending" | "active" | "done" | "blocked";
export interface Step { id: number; title: string; status: StepStatus; note?: string }
export interface Progress {version: number; steps: Step[]; stage: "running" | "paused" | "complete" | "cancelled"; visible: boolean}
const tidy=(s:string)=>s.trim().replaceAll("**","").slice(0,110);
export function planSteps(markdown:string):string[]{
 const all:{title:string;rank:number}[]=[];let execution=false;
 for(const line of markdown.split(String.fromCharCode(10))){
  const text=line.trim();
  if(text.startsWith("## ")||text.startsWith("### ")){
   const h=text.toLowerCase();
   execution=["steps","tasks","implementation","execution","checklist","triển khai","các bước","thực hiện","công việc"].some(k=>h.includes(k));
   continue;
  }
  const checkbox=text.startsWith("- [ ]")||text.startsWith("- [x]")||text.startsWith("- [X]");
  const bullet=text.startsWith("- ")||text.startsWith("* ");
  const first=text.split(".")[0];
  const numbered=first.length<=2&&first.length>0&&[...first].every(c=>"0123456789".includes(c))
    &&text.includes(". ");
  if(!checkbox&&!numbered&&!(execution&&bullet))continue;
  const title=tidy(checkbox?text.slice(5):numbered?text.slice(text.indexOf(".")+1):text.slice(2));
  if(title.length>=5)all.push({title,rank:checkbox?3:execution?2:1});
 }
 const preferred=all.some(c=>c.rank>1)?all.filter(c=>c.rank>1):all;
 const out:string[]=[];
 for(const item of preferred){
  if(!out.some(title=>title.toLowerCase()===item.title.toLowerCase()))out.push(item.title);
  if(out.length>=12)break;
 }
 return out.length?out:["Complete the approved deliverable and verify the result"];
}
export function newProgress(markdown:string,version:number):Progress {
 const steps=planSteps(markdown).map((title,i)=>({id:i+1,title,status:(i===0?"active":"pending") as StepStatus}));
 return {version,steps,stage:"running",visible:true};
}
export function changeProgress(p:Progress,id:number,status:"active"|"done"|"blocked",note?:string):Progress{
 if(p.stage==="complete"||p.stage==="cancelled")throw Error("Progress closed");
 const steps=p.steps.map(s=>({...s})),step=steps.find(s=>s.id===id);
 if(!step)throw Error("Unknown step ID");
 if(status==="done"&&(!note||note.trim().length<3))throw Error("Provide verification for completed step");
 if(step.status==="done"&&status!=="done")throw Error("Cannot silently reopen a verified step");
 if(status==="active")for(const s of steps)if(s.status==="active")s.status="pending";
 step.status=status;if(note)step.note=tidy(note).slice(0,200);
 const all=steps.every(s=>s.status==="done");
 if(status==="done"&&!all&&!steps.some(s=>s.status==="active"||s.status==="blocked")){
  const next=steps.find(s=>s.status==="pending");if(next)next.status="active";
 }
 return {...p,steps,stage:all?"complete":"running",visible:!all};
}
export function latestProgress(entries:readonly any[]):Progress|undefined{
 for(const entry of [...entries].reverse()){
  if(entry?.type==="custom"&&entry.customType===PROGRESS_ENTRY&&Number.isInteger(entry.data?.version)&&Array.isArray(entry.data?.steps))return entry.data as Progress;
 }
}
export interface ProgressWindow {
  start: number; end: number; focusId: number|undefined;
  before: number; after: number;
}
/** A stable, bounded viewport that follows actual agent-reported task state.
 * Explicit active wins; if none, show blockers, then the first pending task.
 * A fully verified checklist remains positioned at its last task.
 */
export function progressWindow(p:Progress,limit=5):ProgressWindow {
 const count=p.steps.length;
 const slots=Math.max(1,Math.min(32,Number.isFinite(limit)?Math.floor(limit):5));
 const focusIndex=Math.max(0,
  p.steps.findIndex(s=>s.status==="active")>=0
   ? p.steps.findIndex(s=>s.status==="active")
   : p.steps.findIndex(s=>s.status==="blocked")>=0
    ? p.steps.findIndex(s=>s.status==="blocked")
    : p.steps.findIndex(s=>s.status==="pending")>=0
     ? p.steps.findIndex(s=>s.status==="pending"):count-1);
 const maxStart=Math.max(0,count-slots);
 const start=Math.min(maxStart,Math.max(0,focusIndex-Math.floor((slots-1)/2)));
 const end=Math.min(count,start+slots);
 return {start,end,focusId:p.steps[focusIndex]?.id,
  before:start,after:count-end};
}
export function progressLines(p:Progress,limit=5):string[]{
 const done=p.steps.filter(s=>s.status==="done").length;
 const blocked=p.steps.filter(s=>s.status==="blocked");
 const window=progressWindow(p,limit);
 const current=window.focusId===undefined?"":(" · #"+window.focusId+"/"+p.steps.length);
 const warning=blocked.length?" · ! "+blocked.length+" blocked":"";
 const rows=["JEV IMPLEMENT · "+done+"/"+p.steps.length+" · "+p.stage.toUpperCase()+
  current+warning];
 for(const step of p.steps.slice(window.start,window.end)){
  const icon=step.status==="done"?"☑":step.status==="active"?"◉":step.status==="blocked"?"!":"☐";
  rows.push(icon+" "+step.id+". "+tidy(step.title).slice(0,68));
 }
 if(window.before||window.after)rows.push(
  (window.before?"↑ "+window.before+" earlier":"")+
  (window.before&&window.after?" · ":"")+
  (window.after?"↓ "+window.after+" next":"")+" · /jev-progress");
 rows.push("/jev-progress · all tasks | /jev-progress-clear · dismiss");
 return rows;
}
