import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {readConfig} from "../core/config.ts";
import {suggestJevStrategy} from "./jev-strategy.ts";
export function registerStrategyCommand(pi:ExtensionAPI):void{
 pi.registerCommand("jev-context-strategy",{
  description:"Ask TypeSafe Jev for an advisory direct/scout/builder execution strategy for a short task description",
  handler:async(args,ctx)=>{
   const task=String(args??"").trim();
   if(task.length<12||task.length>1200){
    ctx.ui.notify("Usage: /jev-context-strategy <12–1200 character task summary>. The text is sent to the configured Jev classifier.","info");return;
   }
   const cfg=readConfig();
   const phase=/(?:^|\s)(?:plan|research|investigate|architect|design)(?:\s|$)/i.test(task)
    ?"plan":"implement";
   const result=await suggestJevStrategy(task,phase,ctx.modelRegistry as any,cfg.classifier);
   ctx.ui.notify("JEV strategy: "+result.strategy+" ("+result.source+
    ", confidence "+result.confidence.toFixed(2)+")\n"+result.reason+
    "\nThis is advisory; Plan cannot spawn write-capable agents, and Builder dispatch still requires a verified scope and an approved plan.","info");
  }
 });
}
