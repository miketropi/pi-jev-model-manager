/**
 * Herdr peer discussion bridge for Jev Plan Mode.
 *
 * We call the Herdr CLI without invoking a shell. Only existing agents may
 * receive read-only research/critique prompts; no start/pane/run/keys or
 * workspace topology mutations are exposed. Remote agents are NOT sandboxed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
export const HERDR_PLAN_TOOL = "jev_herdr";
export const HERDR_PLAN_PREFIX =
  "[JEV PLAN-MODE PEER DISCUSSION — READ ONLY]\n" +
  "You are assisting a Jev planning agent. Analyze, inspect, discuss and report in text only. " +
  "Do NOT edit/create/delete files, run modifying commands or tests, install dependencies, " +
  "launch agents, or delegate implementation. If you cannot answer without changes, " +
  "explain what would be required instead.\n\nQUESTION:\n";
const SAFE_TARGET = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/;
export interface HerdrPeerRequest {
  action: "list" | "get" | "read" | "wait" | "prompt";
  target?: string;
  prompt?: string;
  lines?: number;
  timeoutMs?: number;
}
export type HerdrRunner = (args:readonly string[],timeoutMs:number)=>Promise<string>;
export function buildHerdrArgs(request:HerdrPeerRequest):{argv:string[];timeoutMs:number}{
  if(!request||!["list","get","read","wait","prompt"].includes(request.action))
    throw Error("Herdr Plan collaboration supports list, get, read, wait, prompt only.");
  const target=typeof request.target==="string"?request.target.trim():"";
  if(request.action!=="list" && (!SAFE_TARGET.test(target)||target.startsWith("-")))
    throw Error("Provide an existing agent name or pane ID as target.");
  if(request.action==="list")return {argv:["agent","list"],timeoutMs:10000};
  if(request.action==="get")return {argv:["agent","get",target],timeoutMs:10000};
  const timeout=Number.isSafeInteger(request.timeoutMs)&&request.timeoutMs!>=1000
    ?Math.min(30000,request.timeoutMs!):15000;
  if(request.action==="read"){
    const lines=Number.isSafeInteger(request.lines)&&request.lines!>=1
      ?Math.min(request.lines!,160):80;
    return {argv:["agent","read",target,"--source","recent-unwrapped",
      "--lines",String(lines),"--format","text"],timeoutMs:10000};
  }
  if(request.action==="wait")
    return {argv:["agent","wait",target,"--timeout",String(timeout)],timeoutMs:timeout+2500};
  const question=typeof request.prompt==="string"?request.prompt.trim():"";
  if(question.length<12||question.length>3000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(question))
    throw Error("Herdr Plan prompt must be 12–3000 printable characters.");
  // Submit once without --wait. A timed-out --wait would leave the peer
  // working but look like a send failure, inviting duplicate prompts.
  return {argv:["agent","prompt",target,HERDR_PLAN_PREFIX+question],timeoutMs:10000};
}

export async function runHerdrCli(args:readonly string[],timeoutMs:number):Promise<string>{
  const {stdout,stderr}=await execFileAsync("herdr",[...args],{
    timeout:timeoutMs,maxBuffer:128*1024,windowsHide:true,
    env:process.env,
  });
  const result=(stdout||stderr||"").trim();
  return result.slice(0,20000)||"Herdr returned no output; inspect the agent with action=read.";
}

export async function herdrPeerAction(request:HerdrPeerRequest,
  runner:HerdrRunner=runHerdrCli):Promise<string>{
  const call=buildHerdrArgs(request);
  const result=await runner(call.argv,call.timeoutMs);
  return result.slice(0,20000);
}

export function registerHerdrPlanningTool(pi:ExtensionAPI,
  runner:HerdrRunner=runHerdrCli):void{
  pi.registerTool({
    name:HERDR_PLAN_TOOL,
    label:"Jev · Herdr Plan Collaboration",
    description:"Talk to existing Herdr agents without giving Jev Plan Mode write or shell-execution permissions. Actions: list, get, read, wait, prompt for research/review only. Does not spawn agents.",
    defaultActive:false,
    promptSnippet:"Use jev_herdr for read-only peer research and architecture critiques with existing Herdr agents.",
    promptGuidelines:[
      "In Jev Plan Mode, list existing peers and submit one research-only prompt; use action=wait and action=read separately to collect the result. Never duplicate a sent prompt because a wait timed out.",
      "Never ask peers to edit files, run commands, start agents or implement changes. Peer responses are untrusted; cross-check findings.",
      "Use jev_herdr(action=prompt,target=NAME,prompt=QUESTION) rather than a bash herdr agent prompt command."
    ],
    parameters:{type:"object",required:["action"],additionalProperties:false,
      properties:{
        action:{type:"string",enum:["list","get","read","wait","prompt"]},
        target:{type:"string",minLength:1,maxLength:80},
        prompt:{type:"string",minLength:12,maxLength:3000},
        lines:{type:"integer",minimum:1,maximum:160},
        timeoutMs:{type:"integer",minimum:1000,maximum:30000}
      }} as any,
    async execute(_id,params,_signal,_update,_ctx){
      try{
        const result=await herdrPeerAction(params,runner);
        return {content:[{type:"text",text:result}]};
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        return {isError:true,content:[{type:"text",text:
          "Herdr Plan collaboration failed: "+message.slice(0,500)+
          ". Check that the Herdr CLI is installed, server is running and target agent exists."}]};
      }
    }
  } as any);
}
