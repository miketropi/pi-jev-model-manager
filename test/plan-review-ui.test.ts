import test from "node:test";
import assert from "node:assert/strict";
import {
 createPlanReviewComponent,choosePlanReviewAction,reviewHeight,
 reviewActionHints,PLAN_REVIEW_OPTIONS,PLAN_REVIEW_MORE_ACTIONS
} from "../plan-review-ui.ts";
import {nextPlan} from "../plan-artifact.ts";

const plan=nextPlan("# Release Plan\n\n"+Array.from({length:120},
 (_,i)=>"Paragraph "+(i+1)+": verify critical behavior, sources and acceptance criteria.")
 .join("\n"),undefined,new Date("2026-10-30T09:00:00Z"));
const keys={matches:(data:string,id:string)=>data===id};
const theme={fg:(_name:string,text:string)=>text};
const visibleWidth=(s:string)=>s.replace(/\x1b\[[0-9;]*m/g,"").length;
const truncate=(s:string,n:number)=>s.slice(0,n);
function fakeReader(rows:number,width=80){
 const tui={terminal:{rows},requestRenderCalls:0,requestRender(){
  this.requestRenderCalls++;
 }};
 const chosen:string[]=[];
 const source={render:(n:number)=>Array.from({length:120},(_,i)=>
  ("Paragraph "+(i+1)+": accepted plan review").slice(0,n)),invalidated:0,
  invalidate(){this.invalidated++;}};
 const component=createPlanReviewComponent({plan,tui,theme,keys,markdown:source,
  visibleWidth,truncate,done:x=>chosen.push(x)});
 return {tui,chosen,source,component,width};
}
test("reader dedicates most space to document and ALWAYS displays direct actions",()=>{
 for(const rows of [9,12,16,22,30,48]){
  const {component,width}=fakeReader(rows);
  const lines=component.render(width);
  const state=component.getLayout();
  assert.equal(lines.length,reviewHeight(rows));
  assert.ok(lines.length<=rows-1);
  assert.ok(state.viewportRows>=1);
  assert.ok(state.viewportRows>=Math.floor(rows*.6)-5);
  assert.ok(lines.every(x=>visibleWidth(x)<=width));
  assert.ok(lines.some(x=>/PLAN REVIEW/.test(x)));
  assert.ok(lines.some(x=>/Paragraph 1:/.test(x)));
  assert.ok(lines.some(x=>/E Edit/.test(x)), "edit visible without focus");
  assert.ok(lines.some(x=>/I Implement/.test(x)), "implement visible without focus");
  assert.ok(lines.some(x=>/M More/.test(x)), "all actions discoverable without focus");
  assert.ok(!lines.some(x=>/Action 1\/8/.test(x)),
   "hide confusing horizontal cycling control");
 }
 assert.match(reviewActionHints(110),/A.*Auto/);
 assert.match(reviewActionHints(110),/R.*Refine/);
 assert.match(reviewActionHints(65),/M More/);
 assert.match(reviewActionHints(30,true),/Esc Later/);
});
test("arrows ALWAYS scroll, Enter and M open native menu, shortcuts work from document",()=>{
 const {tui,chosen,source,component,width}=fakeReader(32);
 let rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 1:")));
 component.handleInput("pagedown");
 rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 22:")));
 component.handleInput("end");
 rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 120:")));
 const position=component.getLayout().scroll;
 component.handleInput("down");
 component.render(width);
 assert.equal(component.getLayout().scroll,position);
 tui.terminal.rows=17;
 rendered=component.render(width);
 assert.equal(rendered.length,reviewHeight(17));
 assert.equal(component.getLayout().end,120);
 component.handleInput("home");
 rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 1:")));
 component.handleInput("down");
 assert.equal(component.getLayout().scroll,1,"down never selects an action");
 component.handleInput("enter");
 assert.deepEqual(chosen,[PLAN_REVIEW_MORE_ACTIONS],
  "Enter opens options; it must never approve implementation by itself");
 assert.ok(tui.requestRenderCalls>=5);
 component.invalidate();
 component.render(width);
 assert.equal(source.invalidated,1);
});
test("direct E/I/A/R/M shortcuts require NO Tab or arrow navigation",()=>{
 const choices:Record<string,string>={
  e:"View / edit full plan",
  i:"Implement now · New session (recommended)",
  a:"Auto Implement → QA → Review · New session",
  r:"Refine with AI",m:PLAN_REVIEW_MORE_ACTIONS,
  E:"View / edit full plan",I:"Implement now · New session (recommended)"
 };
 for(const [key,expected] of Object.entries(choices)){
  const {component,chosen,width}=fakeReader(23);
  component.render(width);
  component.handleInput(key);
  assert.deepEqual(chosen,[expected],key+" should immediately choose "+expected);
 }
 const keep=fakeReader(20);
 keep.component.render(80);
 keep.component.handleInput("escape");
 assert.deepEqual(keep.chosen,["Keep plan for later"]);
 const other=fakeReader(20);
 other.component.render(80);
 other.component.handleInput("left");
 other.component.handleInput("tab");
 assert.deepEqual(other.chosen,[],"old hidden focus controls are inert");
});
test("Enter and M show FULL native Pi menu with all 8 options",async()=>{
 let menuCalls=0,customCalls=0;
 const ui={select:async(_title:string,options:string[])=>{
  menuCalls++;
  assert.deepEqual(options,[...PLAN_REVIEW_OPTIONS]);
  return options[3]; // explicit, deliberate same-session Implement choice
 },custom:async(factory:any,options:any)=>{
  customCalls++;
  assert.equal(options.overlay,true);
  assert.equal(options.overlayOptions.maxHeight,"90%");
  const tui={terminal:{rows:30},requestRender(){}};
  let result="";
  const comp=factory(tui,theme,{},(x:string)=>{result=x});
  const lines=comp.render(80);
  assert.ok(lines.some((l:string)=>l.includes("PLAN REVIEW")));
  assert.ok(lines.some((l:string)=>l.includes("M More")));
  comp.handleInput(customCalls===1?"enter":"m");
  return result;
 }};
 const libs={Markdown:class {
  constructor(_content:string){}
  render(width:number){return Array.from({length:140},
   (_,i)=>("Section "+(i+1)+" content").slice(0,width))}
 },getMarkdownTheme:()=>({}),visibleWidth,truncateToWidth:truncate,
  matchesKey:(data:string,key:string)=>data===key,
  Key:{pageUp:"pageup",pageDown:"pagedown",ctrl:(c:string)=>"ctrl+"+c}};
 const action1=await choosePlanReviewAction({mode:"tui",ui},plan,async()=>libs);
 assert.equal(action1,"Implement now (approve plan)");
 const action2=await choosePlanReviewAction({mode:"tui",ui},plan,async()=>libs);
 assert.equal(action2,action1);
 assert.equal(menuCalls,2);
 assert.equal(customCalls,2);
 assert.equal(await choosePlanReviewAction({mode:"rpc",ui},plan,async()=>libs),
  "Implement now (approve plan)");
 assert.equal(menuCalls,3,"RPC uses its native selector");
 assert.equal(await choosePlanReviewAction({mode:"tui",ui},plan,
  async()=>{throw Error("not installed")}),"Implement now (approve plan)");
 assert.equal(menuCalls,4,"old Pi version falls back safely");
});
test("Direct Implement shortcut bypasses extra menu but requires an intentional key",async()=>{
 let menuCalls=0;
 const ui={select:async()=>{menuCalls++;return "Cancel";},
  custom:async(factory:any)=>{
   let action="";
   const component=factory({terminal:{rows:30},requestRender(){}},theme,{},
    (choice:string)=>{action=choice});
   component.render(85);
   component.handleInput("i");
   return action;
  }};
 const libs={Markdown:class {
  constructor(_content:string){}
  render(width:number){return ["# Plan",...Array(60).fill("Do work")].map(x=>x.slice(0,width))}
 },getMarkdownTheme:()=>({}),visibleWidth,truncateToWidth:truncate,
  matchesKey:(data:string,key:string)=>data===key,
  Key:{pageUp:"pageup",pageDown:"pagedown",ctrl:(c:string)=>"ctrl+"+c}};
 assert.equal(await choosePlanReviewAction({mode:"tui",ui},plan,async()=>libs),
  "Implement now · New session (recommended)");
 assert.equal(menuCalls,0);
});
