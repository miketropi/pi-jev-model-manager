import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseList } from "../ui/list-picker.ts";

test("custom TUI adapter reaches last catalog item with real key handling",async()=>{
 const items=Array.from({length:180},(_,i)=>({id:"m"+i,label:"Model "+i}));
 const libs={
  truncateToWidth:(s:string,w:number)=>s.slice(0,w),
  visibleWidth:(s:string)=>s.length,
  matchesKey:(data:string,key:string)=>data===key,
  Key:{pageUp:"pageup",pageDown:"pagedown",ctrl:(key:string)=>"ctrl+"+key},
 };
 let drawn=0;
 const ui={
  select:async()=>{throw Error("must use custom UI");},
  custom:async(factory:any)=>{
   let result:any;
   const component=factory({terminal:{rows:17},requestRender:()=>{drawn++;}},
    {fg:(_c:string,x:string)=>x},null,(selected:any)=>{result=selected;});
   component.render(72);
   component.handleInput("end");
   component.render(72);
   component.handleInput("enter");
   return result;
  },
 };
 const chosen=await chooseList({mode:"tui",ui},{title:"Models",items},async()=>libs);
 assert.equal(chosen?.id,"m179");
 assert.ok(drawn>=1);
});

test("9Router scan can import model #100 from a 135-model catalog without filtering", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"jev-long-catalog-"));
 const prevDir=process.env.PI_CODING_AGENT_DIR;
 const prevApi=process.env.NINEROUTER_API_KEY;
 const oldFetch=globalThis.fetch;
 process.env.PI_CODING_AGENT_DIR=dir;
 process.env.NINEROUTER_API_KEY="test-key";
 let calls=0;
 const catalog=Array.from({length:135},(_,i)=>({id:"provider/model-"+i,name:"Catalog Model "+i}));
 globalThis.fetch=(async()=>new Response(JSON.stringify({data:catalog}),{status:200})) as typeof fetch;
 try {
  const { scanAndImportNineRouter } = await import("../ui/model-admin.ts");
  const { readConfig } = await import("../core/config.ts");
  const config=readConfig();
  const providers:Record<string,any>={};
  const pi:any={registerProvider:(name:string,def:any)=>{providers[name]=def;},unregisterProvider:()=>{}};
  let completed=false;
  const ui:any={
    notify(){},input:async()=>undefined,confirm:async()=>false,
    editor:async()=>undefined,
    select:async(title:string,opts:string[])=>{
      if(title.startsWith("Manage "))return "Back";
      if(!title.startsWith("9Router · model catalog"))throw Error("Unexpected menu "+title);
      if(completed)return "Back";
      calls++;
      const found=opts.find(x=>x.includes("+ provider/model-99"));
      if(found){completed=true;return found;}
      if(opts.includes("Next page ▶"))return "Next page ▶";
      throw Error("model 99 inaccessible");
    },
  };
  await scanAndImportNineRouter(pi,{hasUI:true,mode:"tui",ui} as any,config);
  assert.ok(calls>=10);
  assert.equal(config.models.length,1);
  assert.equal(config.models[0].key,"jev-9router/provider/model-99");
  assert.equal(providers["jev-9router"].models.length,1);
 }finally{
  globalThis.fetch=oldFetch;
  if(prevDir===undefined)delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR=prevDir;
  if(prevApi===undefined)delete process.env.NINEROUTER_API_KEY;
  else process.env.NINEROUTER_API_KEY=prevApi;
  rmSync(dir,{recursive:true,force:true});
 }
});
