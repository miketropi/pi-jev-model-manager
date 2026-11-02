/**
 * Trusted, code-registered spawn adapters. Never execute a command template
 * from a model/user/remote result: Herdr is a fixed argv-only executable.
 */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const runFile=promisify(execFile);
export type SpawnPlatform="omp"|"pi";
export type SpawnLookup={state:"absent"|"present"|"unknown";name?:string;paneId?:string;status?:string};
export interface SpawnLaunch {
 name:string;paneId:string;platform:SpawnPlatform;args:readonly string[];
 timeoutMs:number;
}
export interface SpawnAdapter {
 readonly id:string;
 lookup(name:string,signal?:AbortSignal):Promise<SpawnLookup>;
 start(request:SpawnLaunch,signal?:AbortSignal):Promise<SpawnLookup>;
}
export type SpawnRunner=(argv:readonly string[],timeoutMs:number,signal?:AbortSignal)=>
 Promise<string>;
export const execHerdr:SpawnRunner=async(argv,timeoutMs,signal)=>{
 const {stdout,stderr}=await runFile("herdr",[...argv],{
  timeout:timeoutMs,maxBuffer:128*1024,windowsHide:true,signal,
 });
 return (stdout||stderr||"").trim().slice(0,24000);
};
export const safeAgentName=/^[a-z][a-z0-9_-]{0,31}$/;
export const safePaneId=/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/;
const absentCodes=new Set(["agent_not_found","agent_not_running","target_not_found","not_found"]);
function parseJson(payload:string):any {
 try{return JSON.parse(payload.trim());}catch{return null;}
}
function extractError(raw:string):string|undefined {
 const parsed=parseJson(raw);
 const e=parsed?.error;
 return e&&typeof e.code==="string"?e.code:undefined;
}
function info(raw:string):SpawnLookup {
 const json=parseJson(raw);
 if(!json||json.error||json.success===false)return {state:"unknown"};
 const agent=json.result?.agent;
 if(!agent||typeof agent!=="object")return {state:"unknown"};
 const name=typeof agent.name==="string"?agent.name:
   typeof agent.agent_name==="string"?agent.agent_name:undefined;
 const paneId=typeof agent.pane_id==="string"?agent.pane_id:
   typeof agent.paneId==="string"?agent.paneId:undefined;
 const status=typeof agent.state==="string"?agent.state:
   typeof agent.status==="string"?agent.status:undefined;
 return {state:"present",name,paneId,status};
}
function errorPayload(e:unknown):string {
 const x=e as {stdout?:string;stderr?:string;message?:string};
 return String(x?.stderr||x?.stdout||x?.message||"").slice(0,2000);
}
/** Only a known not-found code permits a new spawn; other failures fail closed. */
export class HerdrSpawnAdapter implements SpawnAdapter {
 readonly id="herdr";
 private readonly runner:SpawnRunner;
 constructor(runner:SpawnRunner=execHerdr){this.runner=runner;}
 async lookup(name:string,signal?:AbortSignal):Promise<SpawnLookup>{
  if(!safeAgentName.test(name))throw Error("Invalid agent name");
  try{
   const output=await this.runner(["agent","get",name],3500,signal);
   const code=extractError(output);
   if(code&&absentCodes.has(code))return {state:"absent"};
   return info(output);
  }catch(e){
   const code=extractError(errorPayload(e));
   return code&&absentCodes.has(code)?{state:"absent"}:{state:"unknown"};
  }
 }
 async start(req:SpawnLaunch,signal?:AbortSignal):Promise<SpawnLookup>{
  if(!safeAgentName.test(req.name)||!safePaneId.test(req.paneId))
   throw Error("Invalid agent name or pane ID");
  if(!["pi","omp"].includes(req.platform))throw Error("Unsupported agent kind");
  if(req.args.some(arg=>typeof arg!=="string"||!arg||
    arg.length>400||/[\x00-\x1f\x7f]/.test(arg)))throw Error("Invalid launch arg");
  const argv=["agent","start",req.name,"--kind",req.platform,"--pane",req.paneId,
    "--timeout",String(Math.min(60000,Math.max(4000,req.timeoutMs))),
    "--",...req.args];
  const result=info(await this.runner(argv,req.timeoutMs+2500,signal));
  // Herdr confirms agent startup/identity, NOT the model inside that agent.
  return result;
 }
}
export function confirmedIdentity(
 entry:SpawnLookup,name:string,paneId:string,
):boolean {
 return entry.state==="present"&&entry.name===name&&entry.paneId===paneId;
}
