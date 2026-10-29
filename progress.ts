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
export function progressLines(p:Progress,limit=6):string[]{
 const done=p.steps.filter(s=>s.status==="done").length;
 const rows=["JEV IMPLEMENT · "+done+"/"+p.steps.length+" · "+p.stage.toUpperCase()];
 for(const step of p.steps.slice(0,limit)){
  const icon=step.status==="done"?"☑":step.status==="active"?"◉":step.status==="blocked"?"!":"☐";
  rows.push(icon+" "+step.id+". "+tidy(step.title).slice(0,68));
 }
 if(p.steps.length>limit)rows.push("… "+(p.steps.length-limit)+" more · /jev-progress");
 rows.push("/jev-progress · details | /jev-progress-clear · dismiss");
 return rows;
}
