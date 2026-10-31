import {registerStrategyCommand} from "./strategy-command.ts";
import {registerContextRuntime} from "./runtime-extension.ts";
/** Opt-in context archive and retrieval; no mutation of Pi conversation history. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { archiveContext, DEFAULT_CONTEXT_CONFIG, loadContext, normalizeContextConfig, readContext, searchContext, type ContextKind } from "./store.ts";
import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const configFile=join(process.env.PI_CODING_AGENT_DIR || join(homedir(),".pi","agent"),"jev-context.json");
function config() {
  try { return normalizeContextConfig(existsSync(configFile) ? JSON.parse(readFileSync(configFile,"utf8")) : {}); }
  catch { return DEFAULT_CONTEXT_CONFIG; }
}
function session(ctx: any): string {
  const manager=ctx.sessionManager;
  return String(manager?.getSessionFile?.() || manager?.getSessionId?.() || "unsaved-session");
}
const asText=(text:string)=>({content:[{type:"text" as const,text}]});
export default function(pi: ExtensionAPI) {
  registerContextRuntime(pi);
  registerStrategyCommand(pi);
  pi.registerCommand("jev-context",{
    description:"Show context archive status, policy, and safe retrieval instructions",
    handler: async (_args,ctx)=>{
      const c=config(), rows=loadContext(session(ctx));
      ctx.ui.notify("JEV Context Intelligence · "+c.mode+"\nArchive: "+rows.length+" records ("+rows.filter(x=>x.protected).length+" protected)\nCommands: /jev-context · tools: jev_context_store, jev_context_search, jev_context_read\nNo auto-pruning of Pi session history.", "info");
    },
  });
  pi.registerTool({
    name:"jev_context_store",label:"Store context evidence",
    description:"Archive a decision, checkpoint, research note, code reference or tool output outside the model context, keeping a stable ID. Checkpoints and decisions are always protected.",
    parameters:Type.Object({
      kind:Type.Union([Type.Literal("decision"),Type.Literal("research"),Type.Literal("tool-output"),Type.Literal("checkpoint"),Type.Literal("code-reference")]),
      summary:Type.String({minLength:1,maxLength:1000}),
      text:Type.String({minLength:1}),
      tags:Type.Optional(Type.Array(Type.String(),{maxItems:16})),
    }),
    async execute(_id,args,_signal,_onUpdate,ctx){
      try {
        const row=archiveContext(session(ctx),{kind:args.kind as ContextKind,summary:args.summary,text:args.text,tags:args.tags},config());
        return asText("Archived "+row.id+" ("+row.kind+", protected="+row.protected+").");
      } catch(e){return asText("Archive failed: "+String(e));}
    },
  });
  pi.registerTool({
    name:"jev_context_search",label:"Search context archive",
    description:"Search locally archived context summaries and evidence by keywords. Read records by exact ID when needed.",
    parameters:Type.Object({query:Type.String({minLength:2}),limit:Type.Optional(Type.Integer({minimum:1,maximum:20}))}),
    async execute(_id,args,_signal,_onUpdate,ctx) {
      try {
        const matches=searchContext(session(ctx),args.query,args.limit||8);
        return asText(matches.length ? matches.map(x=>x.record.id+" ["+x.record.kind+"] "+x.record.summary+" (score "+x.score+")").join("\n") : "No matching archived context.");
      }catch(e){return asText("Search failed: "+String(e));}
    },
  });
  pi.registerTool({
    name:"jev_context_read",label:"Read archived context",
    description:"Retrieve one archived context record by exact ID within configured output limits.",
    parameters:Type.Object({id:Type.String({pattern:"^[a-f0-9]{24}$"})}),
    async execute(_id,args,_signal,_onUpdate,ctx){
      try {
        const row=readContext(session(ctx),args.id,config().maxReadChars);
        return asText(row ? "["+row.kind+"] "+row.summary+"\n"+row.text : "Context record not found.");
      }catch(e){return asText("Read failed: "+String(e));}
    },
  });
}
