import test from "node:test";
import assert from "node:assert/strict";
import {createPlanReviewComponent,choosePlanReviewAction,reviewHeight,
  PLAN_REVIEW_OPTIONS} from "../plan-review-ui.ts";
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
test("Plan reader dedicates screen height to document, not 8-option menu",()=>{
 for(const rows of [9,12,16,22,30,48]){
  const {component,width}=fakeReader(rows);
  const lines=component.render(width);
  const state=component.getLayout();
  assert.equal(lines.length,reviewHeight(rows));
  assert.ok(lines.length<=rows-1,"modal must fit terminal height");
  assert.ok(state.viewportRows>=1);
  assert.ok(state.viewportRows>=Math.floor(rows*.6)-5,
   "document should use most of modal, rather than a stacked eight-row menu");
  assert.ok(lines.every(x=>visibleWidth(x)<=width));
  assert.equal(lines.filter(x=>/Action 1\/8/.test(x)).length,1);
  assert.ok(lines.some(x=>/PLAN REVIEW/.test(x)));
  assert.ok(lines.some(x=>/Paragraph 1:/.test(x)));
 }
});
test("Plan reader scroll, page jump, home/end, resize and focus navigation",()=>{
 const {tui,chosen,source,component,width}=fakeReader(32);
 const initial=component.render(width);
 assert.ok(initial.some(x=>x.includes("Paragraph 1:")));
 component.handleInput("pagedown");
 let rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 22:")));
 assert.equal(component.getLayout().focus,"document");
 component.handleInput("end");
 rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 120:")));
 const position=component.getLayout().scroll;
 component.handleInput("down");
 component.render(width);
 assert.equal(component.getLayout().scroll,position,"scroll clamps to content end");
 tui.terminal.rows=17;
 rendered=component.render(width);
 assert.equal(rendered.length,reviewHeight(17));
 assert.equal(component.getLayout().end,120,"resize retains last visible section");
 component.handleInput("home");
 rendered=component.render(width);
 assert.ok(rendered.some(x=>x.includes("Paragraph 1:")));
 component.handleInput("enter");
 assert.deepEqual(chosen,[],"Enter while reading never auto-approves anything");
 assert.equal(component.getLayout().focus,"actions");
 component.handleInput("right");
 assert.equal(component.getLayout().selected,1);
 component.handleInput("tab");
 assert.equal(component.getLayout().focus,"document");
 component.handleInput("shift+tab");
 assert.equal(component.getLayout().focus,"actions");
 component.handleInput("enter");
 assert.deepEqual(chosen,["Implement now · New session (recommended)"]);
 assert.ok(tui.requestRenderCalls>4);
 component.invalidate();
 component.render(width);
 assert.equal(source.invalidated,1);
});
test("Plan review Escape closes without approval, action cycle wraps",()=>{
 const {component,chosen,width}=fakeReader(24);
 component.render(width);
 component.handleInput("left");
 assert.equal(component.getLayout().selected,PLAN_REVIEW_OPTIONS.length-1);
 component.handleInput("right");
 assert.equal(component.getLayout().selected,0);
 component.handleInput("escape");
 assert.deepEqual(chosen,["Keep plan for later"]);
});
test("Plan custom overlay returns selected action; RPC/old TUI retains native menu",async()=>{
 let passedOptions:any;
 let fallbackCalls=0;
 const ui={select:async(_title:string,options:string[])=>{
  fallbackCalls++;return options[0];
 },custom:async(factory:any,options:any)=>{
  passedOptions=options;
  const tui={terminal:{rows:30},requestRender(){}};
  const comp=factory(tui,theme,keys,(x:string)=>{passedOptions.result=x});
  const lines=comp.render(80);
  assert.ok(lines.some((l:string)=>l.includes("PLAN REVIEW")));
  comp.handleInput("tab");
  comp.handleInput("right");
  comp.handleInput("right");
  comp.handleInput("enter");
  return passedOptions.result;
 }};
 const libraries={Markdown:class {
  constructor(_content:string){}
  render(width:number){return Array.from({length:140},
   (_,i)=>("Section "+(i+1)+" content").slice(0,width))}
 },getMarkdownTheme:()=>({}),visibleWidth,truncateToWidth:truncate,
  matchesKey:(data:string,key:string)=>data===key,
  Key:{pageUp:"pageup",pageDown:"pagedown",ctrl:(c:string)=>"ctrl+"+c}};
 const choice=await choosePlanReviewAction({mode:"tui",ui},plan,async()=>libraries);
 assert.equal(choice,"Auto Implement → QA → Review · New session");
 assert.equal(fallbackCalls,0,"TUI custom viewer replaces old cramped selector");
 assert.equal(passedOptions.overlay,true);
 assert.equal(passedOptions.overlayOptions.maxHeight,"90%");
 assert.equal(await choosePlanReviewAction({mode:"rpc",ui},plan,async()=>libraries),
  "View / edit full plan");
 assert.equal(fallbackCalls,1,"RPC stays compatible with native selector");
 assert.equal(await choosePlanReviewAction({mode:"tui",ui},plan,
  async()=>{throw Error("old Pi build")}),"View / edit full plan");
 assert.equal(fallbackCalls,2,"unsupported TUI falls back instead of losing approval menu");
});
