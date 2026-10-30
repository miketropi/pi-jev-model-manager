/**
 * Declarative CLI adapter for peer research. One explicit, trusted command
 * template per action; execFile argv, never a shell string.
 * This does not sandbox independently running peers.
 */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import type {ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {HERDR_PLAN_PREFIX} from "./herdr-collaboration.ts";

export const COLLABORATION_TOOL="jev_collaborate";
export type PeerAction="list"|"get"|"read"|"wait"|"prompt";
export interface PeerCliAdapter {
 id:string; executable:string;
 commands:Partial<Record<PeerAction,string[]>>;
}
export interface PeerRequest {
 adapter:string; action:PeerAction; target?:string;
 prompt?:string; lines?:number;timeoutMs?:number;
}
const safeId=/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const safeBinary=/^(?:[a-zA-Z][a-zA-Z0-9_.-]{0,63}|\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+)$/;
const safeTarget=/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/;
const variables=new Set(["{target}","{prompt}","{lines}","{timeout}"]);
const knownActions:PeerAction[]=["list","get","read","wait","prompt"];
export const HERDR_ADAPTER:PeerCliAdapter={
 id:"herdr",executable:"herdr",commands:{
  list:["agent","list"],get:["agent","get","{target}"],
  read:["agent","read","{target}","--source","recent-unwrapped",
    "--lines","{lines}","--format","text"],
  wait:["agent","wait","{target}","--timeout","{timeout}"],
  prompt:["agent","prompt","{target}","{prompt}"]
 }};
export function normalizePeerAdapters(value:unknown):PeerCliAdapter[]{
 if(!Array.isArray(value))return [];
 const result:PeerCliAdapter[]=[];
 const ids=new Set(["herdr"]);
 for(const raw of value.slice(0,12)){
  if(!raw||typeof raw!=="object")continue;
  const r=raw as Record<string,unknown>;
  if(typeof r.id!=="string"||!safeId.test(r.id)||ids.has(r.id)||
    typeof r.executable!=="string"||!safeBinary.test(r.executable)||
    /(?:^|\/)(?:bash|sh|zsh|fish|dash|ksh|cmd|powershell|pwsh|python|node|perl|ruby)$/i.test(r.executable))continue;
  if(!r.commands||typeof r.commands!=="object"||Array.isArray(r.commands))continue;
  const commands:PeerCliAdapter["commands"]={};
  for(const action of knownActions){
   const argv=(r.commands as Record<string,unknown>)[action];
   if(!Array.isArray(argv)||argv.length<1||argv.length>24||
     argv.some(x=>typeof x!=="string"||!x||x.length>100||
       (/\{[^}]*\}/.test(x)&&!variables.has(x))||
       /[\x00-\x1f\x7f]/.test(x)))continue;
   // The template must place all dynamic data in whole argv elements.
   if(action==="prompt"&&!argv.includes("{prompt}"))continue;
   if(!["list"].includes(action)&&!argv.includes("{target}"))continue;
   if(action==="list"&&argv.includes("{target}"))continue;
   if(action!=="prompt"&&argv.includes("{prompt}"))continue;
   commands[action]=[...argv] as string[];
  }
  if(!Object.keys(commands).length)continue;
  ids.add(r.id);
  result.push({id:r.id,executable:r.executable,commands});
 }
 return result;
}
export function buildPeerCommand(request:PeerRequest,adapters:readonly PeerCliAdapter[]=[]):
 {executable:string;argv:string[];timeoutMs:number}{
 if(!request||!knownActions.includes(request.action))throw Error("Unknown collaboration action.");
 const adapter=[HERDR_ADAPTER,...adapters].find(x=>x.id===request.adapter);
 if(!adapter)throw Error("Peer adapter is not registered. Configure peerAdapters explicitly.");
 const template=adapter.commands[request.action];
 if(!template)throw Error("This adapter does not support "+request.action+".");
 const target=typeof request.target==="string"?request.target.trim():"";
 if(request.action!=="list"&&!safeTarget.test(target))
   throw Error("A valid existing peer target is required.");
 const prompt=typeof request.prompt==="string"?request.prompt.trim():"";
 if(request.action==="prompt"&&(prompt.length<12||prompt.length>3000||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)))
   throw Error("Prompt must be 12–3000 printable characters.");
 const lines=Number.isInteger(request.lines)?Math.min(160,Math.max(1,request.lines!)):80;
 const timeout=Number.isInteger(request.timeoutMs)
    ?Math.min(30000,Math.max(1000,request.timeoutMs!)):15000;
 const substitutions:Record<string,string>={
  "{target}":target,"{prompt}":HERDR_PLAN_PREFIX+prompt,
  "{lines}":String(lines),"{timeout}":String(timeout)
 };
 const argv=template.map(arg=>substitutions[arg]??arg);
 const processTimeout=request.action==="wait"?timeout+2500:10000;
 return {executable:adapter.executable,argv,timeoutMs:processTimeout};
}
const runFile=promisify(execFile);
export type PeerRunner=(executable:string,args:readonly string[],timeoutMs:number)=>Promise<string>;
export const executePeerCommand:PeerRunner=async(executable,args,timeoutMs)=>{
 const {stdout,stderr}=await runFile(executable,[...args],{
  timeout:timeoutMs,maxBuffer:128*1024,windowsHide:true,env:process.env
 });
 return (stdout||stderr||"").trim().slice(0,20000)||
  "Peer adapter returned no text. Use wait/read to inspect the existing agent.";
};
export function registerCollaborationTool(pi:ExtensionAPI,
 providers:()=>readonly PeerCliAdapter[],runner:PeerRunner=executePeerCommand):void{
 pi.registerTool({
  name:COLLABORATION_TOOL,label:"Jev · Peer Collaboration",
  description:"Protocol-adapter based read-only planning discussion with existing agents via installed CLIs. Use configured peerAdapters. No arbitrary shell, writes or spawning.",
  defaultActive:false,
  promptSnippet:"Use jev_collaborate to list, discuss with, wait for and read existing trusted peers via a configured adapter.",
  promptGuidelines:[
   "Use adapter=herdr for existing Herdr colleagues or another explicitly configured peerAdapters id.",
   "Send only read-only planning, research, design-review questions. Prompt returns after submission; wait/read separately.",
   "Do not ask peers to implement, run commands, write files or start processes. Their tools may have independent permissions."
  ],
  parameters:{type:"object",required:["adapter","action"],additionalProperties:false,
   properties:{
    adapter:{type:"string",minLength:1,maxLength:40},
    action:{type:"string",enum:["list","get","read","wait","prompt"]},
    target:{type:"string",maxLength:80},
    prompt:{type:"string",maxLength:3000},
    lines:{type:"integer",minimum:1,maximum:160},
    timeoutMs:{type:"integer",minimum:1000,maximum:30000}
   }} as any,
  async execute(_id,params,_signal,_onUpdate,_ctx){
   try {
    const cmd=buildPeerCommand(params,providers());
    return {content:[{type:"text",text:
      (await runner(cmd.executable,cmd.argv,cmd.timeoutMs)).slice(0,20000)}]};
   }catch(e){
    return {isError:true,content:[{type:"text",text:"Peer collaboration error: "+
      String(e instanceof Error?e.message:e).slice(0,500)+
      ". Check the adapter command syntax and whether the peer is running."}]};
   }
  }
 } as any);
}
