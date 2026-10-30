/**
 * Read-first Plan review. The entire viewer has ONE keyboard context:
 * arrows always scroll; advertised single-key actions work immediately.
 * Secondary actions are available through the familiar native Pi selector.
 */
import type {PlanDocument} from "./plan-artifact.ts";

export const PLAN_REVIEW_OPTIONS=[
  "View / edit full plan",
  "Implement now · New session (recommended)",
  "Auto Implement → QA → Review · New session",
  "Implement now (approve plan)",
  "Auto Implement → QA → Review (approve plan)",
  "Refine with AI","Keep plan for later","Cancel"
] as const;
export const PLAN_REVIEW_MORE_ACTIONS="jev-plan-review:more-actions";

type ReviewTheme={fg:(name:string,text:string)=>string};
type ReviewKeys={matches:(data:string,key:string)=>boolean};
export interface ReviewDimensions {terminal:{rows:number};requestRender:()=>void}
export interface PlanReviewComponent {
 render:(width:number)=>string[];handleInput:(data:string)=>void;invalidate:()=>void;
}
export interface ReviewText {render:(width:number)=>string[];invalidate?:()=>void}
export interface ReviewLayout {
 viewportRows:number;documentRows:number;scroll:number;
 start:number;end:number;
}
export function reviewHeight(terminalRows:number):number {
 const rows=Number.isFinite(terminalRows)?Math.floor(terminalRows):24;
 return Math.max(6,Math.min(Math.max(6,rows-2),Math.floor(rows*.88)));
}
export function reviewActionHints(width:number,compact=false):string{
 if(compact||width<53)return "E Edit · I Implement · M More · Esc Later";
 if(width<82)return "E Edit  ·  I Implement  ·  A Auto  ·  R Refine  ·  M More";
 return "[E] Edit    [I] Implement · new session    [A] Auto QA/Review    [R] Refine    [M] More";
}
export function createPlanReviewComponent(args:{
 plan:PlanDocument;tui:ReviewDimensions;theme:ReviewTheme;keys:ReviewKeys;
 markdown:ReviewText;
 truncate:(text:string,width:number,ellipsis?:string)=>string;
 visibleWidth:(text:string)=>number;done:(choice:string)=>void;
}):PlanReviewComponent & {getLayout:()=>ReviewLayout} {
 const {plan,tui,theme,keys,markdown,truncate,visibleWidth,done}=args;
 let scroll=0,contentWidth=-1,content:string[]=[];
 let height=reviewHeight(tui.terminal.rows);
 let viewport=Math.max(1,height-(height<11?4:7));
 const padded=(value:string,n:number)=>{
  const clipped=truncate(value,Math.max(0,n),"");
  return clipped+" ".repeat(Math.max(0,n-visibleWidth(clipped)));
 };
 const docLines=(width:number)=>{
  if(width!==contentWidth){
   contentWidth=width;
   content=markdown.render(width);
  }
 };
 const layout=():ReviewLayout=>{
  const max=Math.max(0,content.length-viewport);
  scroll=Math.max(0,Math.min(scroll,max));
  return {viewportRows:viewport,documentRows:content.length,
   scroll,start:content.length?scroll+1:0,
   end:Math.min(content.length,scroll+viewport)};
 };
 const key=(data:string,id:string)=>keys.matches(data,id);
 const component:PlanReviewComponent & {getLayout:()=>ReviewLayout}={
  getLayout:layout,
  render(width:number):string[]{
   const w=Math.max(14,Math.floor(width));
   const wasAtEnd=content.length>0 && scroll>=Math.max(0,content.length-viewport);
   height=reviewHeight(tui.terminal.rows);
   const compact=height<11;
   viewport=Math.max(1,height-(compact?4:7));
   const inside=w-4;
   docLines(inside);
   if(wasAtEnd)scroll=Math.max(0,content.length-viewport);
   const info=layout();
   const border=(left:string,right:string)=>theme.fg("border",left+"─".repeat(w-2)+right);
   const row=(value:string)=>theme.fg("border","│ ")+padded(value,inside)+theme.fg("border"," │");
   const header=theme.fg("accent","JEV  /  PLAN REVIEW   v"+plan.version)+
     theme.fg("muted","  ·  "+plan.status.toUpperCase());
   const counter=info.documentRows?
     info.start+"–"+info.end+" / "+info.documentRows+" lines":"Empty plan";
   const headRow=theme.fg("muted","READ PLAN  ·  "+counter+"  ·  ↑↓ / PgUp PgDn to scroll");
   const hint=theme.fg("accent",reviewActionHints(inside,compact));
   const help=theme.fg("muted",
      "↑↓ Scroll · PgUp/PgDn · Home/End · Enter All actions · Esc Keep for later");
   const lines=compact
     ?[border("╭","╮"),row(header)]
     :[border("╭","╮"),row(header),row(headRow)];
   for(let i=0;i<viewport;i++)lines.push(row(content[scroll+i]??""));
   if(!compact)lines.push(row(theme.fg("border","─".repeat(Math.max(1,inside)))));
   lines.push(row(hint));
   if(!compact)lines.push(row(help));
   lines.push(border("╰","╯"));
   return lines.map(line=>truncate(line,w,""));
  },
  handleInput(data:string):void {
   if(key(data,"escape")||key(data,"ctrl+c")){done("Keep plan for later");return;}
   // All visible shortcuts work immediately. No hidden focus, mode switch
   // or "Enter while reading" ambiguity. Implementation requires an explicit
   // I / A key or a deliberate choice from the native action menu.
   const action=typeof data==="string"?data.toLowerCase():"";
   const shortcuts:Record<string,string>={
    "e":PLAN_REVIEW_OPTIONS[0],
    "i":PLAN_REVIEW_OPTIONS[1],
    "a":PLAN_REVIEW_OPTIONS[2],
    "r":PLAN_REVIEW_OPTIONS[5],
    "m":PLAN_REVIEW_MORE_ACTIONS,
   };
   if(Object.prototype.hasOwnProperty.call(shortcuts,action)){
    done(shortcuts[action]);return;
   }
   if(key(data,"enter")||data==="?"){done(PLAN_REVIEW_MORE_ACTIONS);return;}
   if(key(data,"up"))scroll-=1;
   else if(key(data,"down"))scroll+=1;
   else if(key(data,"pageup"))scroll-=viewport;
   else if(key(data,"pagedown"))scroll+=viewport;
   else if(key(data,"home"))scroll=0;
   else if(key(data,"end"))scroll=Math.max(0,content.length-viewport);
   else return;
   layout();tui.requestRender();
  },
  invalidate:()=>{contentWidth=-1;content=[];markdown.invalidate?.();}
 };
 return component;
}
type ReviewLibraries={
 Markdown:new(content:string,x:number,y:number,theme:unknown)=>ReviewText;
 getMarkdownTheme:()=>unknown;
 visibleWidth:(text:string)=>number;
 truncateToWidth:(text:string,width:number,ellipsis?:string)=>string;
 matchesKey:(data:string,key:string)=>boolean;
 Key:{pageUp:string;pageDown:string;ctrl:(char:string)=>string};
};
async function loadLibraries():Promise<ReviewLibraries>{
 const [tui,agent]=await Promise.all([
  import("@earendil-works/pi-tui"),import("@earendil-works/pi-coding-agent")
 ]);
 return {Markdown:tui.Markdown,getMarkdownTheme:agent.getMarkdownTheme,
  visibleWidth:tui.visibleWidth,truncateToWidth:tui.truncateToWidth,
  matchesKey:tui.matchesKey,Key:tui.Key};
}
export async function choosePlanReviewAction(
 ctx:{mode?:string;ui:{
  select:(title:string,options:string[])=>Promise<string|undefined>;
  custom?:((factory:any,opts?:any)=>Promise<string|undefined>);
 }},
 plan:PlanDocument,
 load:()=>Promise<ReviewLibraries>=loadLibraries
):Promise<string|undefined> {
 if(ctx.mode==="tui"&&typeof ctx.ui.custom==="function"){
  try{
   const libs=await load();
   const result=await ctx.ui.custom((tui:ReviewDimensions,theme:ReviewTheme,
    _keybindings:unknown,done:(choice:string)=>void)=>{
    const markdown=new libs.Markdown(plan.markdown,0,0,libs.getMarkdownTheme());
    const keys:ReviewKeys={matches:(data,name)=>{
      const physical=name==="pageup"?libs.Key.pageUp
        :name==="pagedown"?libs.Key.pageDown
        :name==="ctrl+c"?libs.Key.ctrl("c"):name;
      return libs.matchesKey(data,physical);
    }};
    return createPlanReviewComponent({plan,tui,theme,keys,markdown,
     visibleWidth:libs.visibleWidth,truncate:libs.truncateToWidth,done});
   },{overlay:true,overlayOptions:{
    anchor:"center",width:"96%",maxHeight:"90%",margin:1
   }});
   if(result===PLAN_REVIEW_MORE_ACTIONS){
    return ctx.ui.select("Jev Plan v"+plan.version+" · choose next action",
     [...PLAN_REVIEW_OPTIONS]);
   }
   if(result!==undefined)return result;
  }catch{ /* Unsupported older Pi UI: use the native selector. */ }
 }
 return ctx.ui.select("Jev Plan v"+plan.version+" · "+plan.status+" · next action",
  [...PLAN_REVIEW_OPTIONS]);
}
