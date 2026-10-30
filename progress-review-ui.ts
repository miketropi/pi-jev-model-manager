/**
 * Compact, scrollable TUI inspector for the complete Jev implementation
 * checklist. This does not execute tasks or modify verification statuses.
 */
import type {Progress} from "./progress.ts";
import {reviewHeight} from "./plan-review-ui.ts";

type Theme={fg:(color:string,text:string)=>string};
type KeyMatcher=(data:string,key:string)=>boolean;
export interface ChecklistReviewLayout{
 start:number;end:number;selected:number;viewport:number;rows:number;
}
export interface ChecklistReviewComponent {
 render:(width:number)=>string[];
 handleInput:(data:string)=>void;
 invalidate:()=>void;
 getLayout:()=>ChecklistReviewLayout;
}
const mark=(status:string)=>status==="done"?"☑":status==="active"?"◉":
 status==="blocked"?"!":"☐";
export function createChecklistReviewComponent(
 progress:Progress,
 tui:{terminal:{rows:number};requestRender:()=>void},
 theme:Theme,
 matches:KeyMatcher,
 truncate:(text:string,width:number,ellipsis?:string)=>string,
 visibleWidth:(text:string)=>number,
 done:(action:string)=>void
):ChecklistReviewComponent{
 const count=progress.steps.length;
 const active=progress.steps.findIndex(s=>s.status==="active");
 const blocked=progress.steps.findIndex(s=>s.status==="blocked");
 const pending=progress.steps.findIndex(s=>s.status==="pending");
 let selected=Math.max(0,active>=0?active:blocked>=0?blocked:
  pending>=0?pending:count-1);
 let start=0,viewport=1;
 const clamp=()=>{
  viewport=Math.max(1,reviewHeight(tui.terminal.rows)-
   (reviewHeight(tui.terminal.rows)<=6?5:6));
  start=Math.max(0,Math.min(start,Math.max(0,count-viewport)));
  if(selected<start)start=selected;
  else if(selected>=start+viewport)start=Math.max(0,selected-viewport+1);
  start=Math.max(0,Math.min(start,Math.max(0,count-viewport)));
 };
 clamp();
 const getLayout=():ChecklistReviewLayout=>{
  clamp();return {start,end:Math.min(count,start+viewport),selected,viewport,
   rows:reviewHeight(tui.terminal.rows)};
 };
 const component:ChecklistReviewComponent={
  getLayout,
  render(width:number){
   const w=Math.max(20,Math.floor(width));
   const inner=w-4;
   const lines:string[]=[];
   const clip=(text:string,n=inner)=>{
    const safe=truncate(text,n,"");
    return safe+" ".repeat(Math.max(0,n-visibleWidth(safe)));
   };
   const border=(l:string,r:string)=>theme.fg("border",l+"─".repeat(w-2)+r);
   const row=(text:string)=>theme.fg("border","│ ")+clip(text)+theme.fg("border"," │");
   const layout=getLayout();
   const doneCount=progress.steps.filter(s=>s.status==="done").length;
   const blockedCount=progress.steps.filter(s=>s.status==="blocked").length;
   lines.push(border("╭","╮"));
   lines.push(row(theme.fg("accent","JEV / IMPLEMENTATION TASKS")+" · "+
    doneCount+"/"+count+" · "+progress.stage.toUpperCase()+
    (blockedCount?" · ! "+blockedCount+" blocked":"")));
   lines.push(row(theme.fg("muted","Showing "+
    (count?layout.start+1:0)+"-"+layout.end+" / "+count+
    " · selected #"+(progress.steps[selected]?.id??"-"))));
   for(let i=0;i<viewport;i++){
    const step=progress.steps[start+i];
    lines.push(row(step
     ? (start+i===selected?theme.fg("accent","▶ "):"  ")+
        mark(step.status)+" "+step.id+". "+step.title
     :""));
   }
   const step=progress.steps[selected];
   const note=step?.note?" · "+step.note:" · no verification note";
   if(layout.rows>6)lines.push(row(theme.fg("muted","Selected: ")+
      (step?step.status.toUpperCase()+note:"none")));
   lines.push(row(theme.fg("muted","↑↓ navigate  PgUp/PgDn  Enter details  V toggle widget  Esc close")));
   lines.push(border("╰","╯"));
   return lines.map(line=>truncate(line,w,""));
  },
  handleInput(data:string){
   if(matches(data,"escape")||matches(data,"ctrl+c")){done("back");return;}
   if(matches(data,"enter")){done("step:"+progress.steps[selected]?.id);return;}
   if(data==="v"||data==="V"){done("toggle");return;}
   const jump=matches(data,"pageup")?-viewport:matches(data,"pagedown")?viewport:
    matches(data,"up")?-1:matches(data,"down")?1:0;
   if(jump)selected=Math.max(0,Math.min(count-1,selected+jump));
   else if(matches(data,"home"))selected=0;
   else if(matches(data,"end"))selected=Math.max(0,count-1);
   else return;
   clamp();tui.requestRender();
  },
  invalidate(){}
 };
 return component;
}
type Libraries={truncateToWidth:(s:string,w:number,ellipsis?:string)=>string;
 visibleWidth:(s:string)=>number;
 matchesKey:(data:string,key:string)=>boolean;
 Key:{pageUp:string;pageDown:string;ctrl:(char:string)=>string};
};
async function loadPiTui():Promise<Libraries>{
 const tui=await import("@earendil-works/pi-tui");
 return {truncateToWidth:tui.truncateToWidth,visibleWidth:tui.visibleWidth,
  matchesKey:tui.matchesKey,Key:tui.Key};
}
export async function chooseChecklistAction(
 ctx:{mode?:string;ui:{custom?:((factory:any,options:any)=>Promise<string|undefined>)}},
 p:Progress,load:()=>Promise<Libraries>=loadPiTui
):Promise<string|undefined>{
 if(ctx.mode!=="tui"||typeof ctx.ui.custom!=="function")return;
 try {
  const lib=await load();
  return await ctx.ui.custom((tui:any,theme:Theme,_keybindings:unknown,
    done:(action:string)=>void)=>{
   const matches=(data:string,name:string)=>{
    const physical=name==="pageup"?lib.Key.pageUp:name==="pagedown"?lib.Key.pageDown:
     name==="ctrl+c"?lib.Key.ctrl("c"):name;
    return lib.matchesKey(data,physical);
   };
   return createChecklistReviewComponent(p,tui,theme,matches,
    lib.truncateToWidth,lib.visibleWidth,done);
  },{overlay:true,overlayOptions:{anchor:"center",width:"96%",maxHeight:"90%",margin:1}});
 }catch{return;}
}
