import test from "node:test";
import assert from "node:assert/strict";
import {createListPickerComponent,chooseList,chooseListOption,matchedItems} from "../ui/list-picker.ts";

const models=Array.from({length:250},(_,i)=>({
 id:"provider/model-"+i,label:"Model "+i,searchText:"model_"+i,
}));
const keys=(d:string,k:string)=>d===k;
const theme={fg:(_name:string,value:string)=>value};
const truncate=(s:string,width:number)=>Array.from(s).slice(0,width).join("");
const width=(s:string)=>Array.from(s).length;
const create=(options:Parameters<typeof createListPickerComponent>[0],rows=20)=>{
 let value:any=null;
 let paints=0;
 const control=createListPickerComponent(options,{terminal:{rows},requestRender:()=>{paints++;}},
  theme,keys,truncate,width,(v)=>value=v);
 return {control,selected:()=>value,repaints:()=>paints};
};
test("250-item catalog scrolls to the last item without filtering",()=>{
 const {control,selected,repaints}=create({title:"Models",items:models});
 assert.equal(control.getLayout().matching,250);
 control.handleInput("end"); control.render(100);
 assert.equal(control.getLayout().selected,249);
 assert.equal(control.getLayout().end,250);
 assert.ok(repaints()>0);
 control.handleInput("enter");
 assert.equal(selected()?.id,"provider/model-249");
});
test("keyboard paging keeps selection in viewport on narrow terminals",()=>{
 const {control}=create({title:"Catalog",items:models},11);
 for(let i=0;i<5;i++) control.handleInput("pagedown");
 let layout=control.getLayout();
 assert.ok(layout.selected>0 && layout.selected<250);
 assert.ok(layout.selected>=layout.scroll && layout.selected<layout.scroll+layout.viewport);
 assert.ok(control.render(32).length<=11);
 control.handleInput("home");
 assert.equal(control.getLayout().selected,0);
});
test("live search, unicode input and clear retain full result access",()=>{
 const {control,selected}=create({title:"Catalog",items:models,
   actions:[{id:"@batch",label:"Import matching"}]});
 "model_249".split("").forEach(k=>control.handleInput(k));
 assert.equal(control.getLayout().matching,1);
 control.handleInput("enter"); assert.equal(selected()?.id,"provider/model-249");
 control.handleInput("backspace");
 assert.ok(control.getLayout().matching>1);
 control.handleInput("ctrl+u");
 assert.equal(control.getLayout().matching,250);
 control.handleInput("end");
 control.handleInput("enter"); assert.equal(selected()?.id,"@batch");
});
test("action remains accessible when search matches zero models",()=>{
 const {control,selected}=create({title:"Catalog",items:models,
  actions:[{id:"@batch",label:"Import matching"}]});
 "no-match-here".split("").forEach(k=>control.handleInput(k));
 assert.equal(control.getLayout().matching,0);
 control.handleInput("enter");
 assert.deepEqual(selected(),{id:"@batch",query:"no-match-here"});
});
test("native fallback paginates all results and returns stable IDs",async()=>{
 let calls=0;
 const ui={select:async (_title:string,choices:string[])=>{
   calls++;
   return choices.includes("Next page ▶") ? "Next page ▶" :
    choices.find(x=>x.includes("Model 249"));
 }};
 const result=await chooseList({mode:"tui",ui},{title:"Catalog",items:models,pageSize:11});
 assert.equal(result?.id,"provider/model-249");
 assert.ok(calls>20);
});
test("native fallback supports filter and action without scrolling",async()=>{
 let calls=0;
 const ui={
  select:async (_title:string,choices:string[])=>{
    calls++;
    if(calls===1) return choices.find(x=>x.startsWith("Filter: "));
    return choices.find(x=>x.startsWith("◆ "));
  },
  input:async()=>"model_249",
 };
 const result=await chooseList({mode:"tui",ui},{title:"Catalog",items:models,
  actions:[{id:"@batch",label:"Import matching"}]});
 assert.deepEqual(result,{id:"@batch",query:"model_249"});
});
test("small non-TUI menus remain compatible with native Pi selector",async()=>{
 const ui={select:async (_title:string,options:string[])=>options[2]};
 assert.equal(await chooseListOption({ui},"Simple",["A","B","C"]),"C");
 assert.deepEqual(matchedItems(models,"MODEL_249").map(x=>x.id),["provider/model-249"]);
});
test("duplicate IDs fail closed and cancellation returns undefined",async()=>{
 const ui={select:async()=>undefined};
 await assert.rejects(chooseList({ui},{title:"bad",items:[{id:"x",label:"1"},{id:"x",label:"2"}]}),/unique/);
 assert.equal(await chooseList({ui},{title:"Empty",items:[]}),undefined);
});
