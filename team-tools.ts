/** Role-aware launch advice; no external daemon or agent is spawned here. */
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {readConfig} from "./core/config.ts";
import {physicalCandidates} from "./routing/selectors.ts";
import {resolveTeamRole,herdrLaunchExample,type TeamRole,type Difficulty} from "./team-routing.ts";
const ROLES:TeamRole[]=["orchestrator","pm","dev","qa","reviewer","researcher"];
const asText=(text:string,isError=false)=>({
  ...(isError?{isError:true}:{}),
  content:[{type:"text" as const,text}]
});
export function registerTeamTools(pi:ExtensionAPI):void{
 pi.registerTool({
  name:"jev_team_route",label:"JEV · Team model routing",
  description:"Read-only role-to-model launch policy. Call before spawning each PM, Dev, QA or Reviewer CLI agent; never inherit the parent's plan model. No agent is spawned.",
  defaultActive:true,
  promptSnippet:"When creating a multi-agent IT team, call jev_team_route for EACH child role before its first CLI launch; pass its returned --model args to your orchestrator. Do not assume the parent's Plan model or Plan Mode applies to children.",
  promptGuidelines:[
    "Role is not the parent's workflow phase: PM plans, Dev implements, QA tests, Reviewer reviews; each new CLI process must receive its own explicit physical model at startup.",
    "If there is no available model for the requested role, stop and ask for configuration; do not silently start an expensive planning model.",
    "This tool never spawns agents. Plan Mode remains read-only: switch orchestrator to Auto/Implement before running a write-capable team.",
    "Cost is an operator-configured relative tier, not a live token price. Verify child model and mode after launch."
  ],
  parameters:{type:"object",additionalProperties:false,required:["role"],
    properties:{
      role:{type:"string",enum:ROLES},
      difficulty:{type:"string",enum:["small","normal","hard"]},
      platform:{type:"string",enum:["pi","omp"]},
    }} as any,
  async execute(_id,args,_signal,_update,ctx){
    const config=readConfig();
    const candidate=physicalCandidates(config,ctx);
    const difficulty=args.difficulty??"normal";
    const result=resolveTeamRole(args.role,difficulty,candidate,config.taskRules);
    if(!result.ok)return asText("Team model routing unavailable: "+result.error,true);
    const r=result.route;
    return {content:[{type:"text" as const,text:JSON.stringify({
      role:r.role,task:r.task,model:r.model,modelLabel:r.modelLabel,
      relativeCost:r.cost,thinking:r.thinking,source:r.source,reason:r.reason,
      degraded:r.degraded,cliArgs:r.cliArgs,
      example:herdrLaunchExample(r.role,"PANE_ID",
        args.platform==="pi"?"pi":"omp",r),
      requirement:"Use --model at child launch, verify child mode/model after start; do not inherit Plan Mode. JEV cannot alter an external process retroactively.",
    },null,2)}]};
  }
 } as any);
 pi.registerCommand("jev-team",{
  description:"Preview cost-aware model assignments for a PM/Dev/QA/Reviewer team (no agents spawned)",
  handler:async(_args,ctx)=>{
    const cfg=readConfig();
    const available=physicalCandidates(cfg,ctx);
    const rows=ROLES.map(role=>{
      const resolved=resolveTeamRole(role,"normal",available,cfg.taskRules);
      if(!resolved.ok)return role+": unavailable ("+resolved.error+")";
      const r=resolved.route;
      return role+": "+r.model+" · "+r.thinking+" · "+r.cost+
        (r.degraded?" [suboptimal fallback]":"");
    });
    if(ctx.hasUI)ctx.ui.notify(
      "JEV Team model assignments (normal difficulty)\n"+rows.join("\n")+
      "\nRun jev_team_route with difficulty=small/hard for each assigned task before spawning. No agents were launched.","info");
  }
 });
}
