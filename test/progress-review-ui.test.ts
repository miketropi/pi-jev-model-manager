import test from "node:test";
import assert from "node:assert/strict";
import {createChecklistReviewComponent,chooseChecklistAction}
  from "../progress-review-ui.ts";
import type {Progress} from "../progress.ts";

const progress:Progress={version:9,visible:true,stage:"running",
 steps:Array.from({length:16},(_,i)=>({
  id:i+1,title:"Implement verified acceptance requirement "+(i+1),
  status:i<9?"done":i===10?"active":i===13?"blocked":"pending",
  ...(i===10?{note:"Implementation is currently testing the production case"}:{})
 }))};
const matcher=(data:string,key:string)=>data===key;
const width=(s:string)=>s.replace(/\x1b\[[0-9;]*m/g,"").length;
const clip=(s:string,n:number)=>s.slice(0,n);
const theme={fg:(_name:string,s:string)=>s};
function create(rows:number){
 const state={terminal:{rows},requests:0,requestRender(){this.requests++;}};
 const actions:string[]=[];
 const component=createChecklistReviewComponent(progress,state,theme,
  matcher,clip,width,a=>actions.push(a));
 return {state,actions,component};
}
test("scroll viewer begins at real active #11, not at item one, and fits terminal",()=>{
 for(const rows of [7,8,9,12,16,24,40]){
  const {component}=create(rows);
  const rendered=component.render(74);
  const layout=component.getLayout();
  assert.equal(rendered.length,layout.rows);
  assert.ok(rendered.length<=rows-1);
  assert.ok(rendered.every(line=>width(line)<=74));
  assert.equal(layout.selected,10);
  assert.ok(rendered.some(line=>line.includes("11.")),
   "currently active step should be visible");
  assert.ok(rendered.some(line=>line.includes("IMPLEMENTATION TASKS")));
 }
});
test("scroll viewer can inspect all steps, detail and safe visibility toggle",()=>{
 const {component,actions,state}=create(19);
 let visible=component.render(90);
 assert.ok(visible.some(line=>line.includes("11.")));
 assert.ok(visible.some(line=>line.includes("testing the production case")),
  "selected task shows its verification note");
 component.handleInput("home");
 visible=component.render(90);
 assert.ok(visible.some(line=>line.includes("1.")));
 assert.equal(component.getLayout().selected,0);
 component.handleInput("end");
 visible=component.render(90);
 assert.ok(visible.some(line=>line.includes("16.")));
 assert.equal(component.getLayout().selected,15);
 component.handleInput("pageup");
 assert.ok(component.getLayout().selected<15);
 component.handleInput("pagedown");
 assert.equal(component.getLayout().selected,15);
 component.handleInput("up");
 assert.equal(component.getLayout().selected,14);
 component.handleInput("enter");
 assert.deepEqual(actions,["step:15"]);
 assert.ok(state.requests>=4);
 const another=create(20);
 another.component.handleInput("v");
 assert.deepEqual(another.actions,["toggle"]);
 const close=create(20);
 close.component.handleInput("escape");
 assert.deepEqual(close.actions,["back"]);
});
test("Pi custom viewer returns selected task and supports older Pi without custom",async()=>{
 let overlays=0;
 const ui={custom:async(factory:any,options:any)=>{
  overlays++;
  assert.equal(options.overlay,true);
  let chosen="";
  const component=factory({terminal:{rows:24},requestRender(){}},theme,undefined,
   (selection:string)=>{chosen=selection;});
  assert.ok(component.render(80).some((row:string)=>row.includes("11.")));
  component.handleInput("enter");
  return chosen;
 }};
 const libs={truncateToWidth:clip,visibleWidth:width,
  matchesKey:matcher,Key:{pageUp:"pageup",pageDown:"pagedown",
   ctrl:(s:string)=>"ctrl+"+s}};
 assert.equal(await chooseChecklistAction({mode:"tui",ui},progress,
  async()=>libs),"step:11");
 assert.equal(overlays,1);
 assert.equal(await chooseChecklistAction({mode:"rpc",ui},progress,
  async()=>libs),undefined);
 assert.equal(overlays,1);
 assert.equal(await chooseChecklistAction({mode:"tui",ui:{custom:ui.custom}},
  progress,async()=>{throw Error("not installed")}),undefined);
});
