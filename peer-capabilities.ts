/**
 * Peer availability is an ephemeral runtime capability, not a configured preference.
 * A safe read-only list probe is required; never spawn/start an external service.
 */
import {buildPeerCommand,executePeerCommand,type PeerCliAdapter,type PeerRunner} from "./collaboration-adapters.ts";
import {probeSucceeded} from "./peer-probe.ts";
export type PeerStatus="ready"|"unavailable"|"unverified"|"not_attached";
export type PeerProbe={id:string;status:PeerStatus;checkedAt:number};
const PROBE_TIMEOUT_MS=1700;
const STALE_MS=30_000;

export {probeSucceeded,isPeerUnavailableError} from "./peer-probe.ts";
export class PeerCapabilities {
 private readonly statuses=new Map<string,PeerProbe>();
 private readonly runner:PeerRunner;
 private readonly environment:Readonly<Record<string,string|undefined>>;
 constructor(runner:PeerRunner=executePeerCommand,
   environment:Readonly<Record<string,string|undefined>>=process.env){
  this.runner=runner;
  this.environment=environment;
 }
 isAttached(id:string,adapters:readonly PeerCliAdapter[]=[]):boolean{
  if(id==="herdr"){
   // A Herdr server elsewhere on the machine is NOT evidence that this Pi
   // process belongs to a Herdr pane. Both markers are documented by Herdr.
   return this.environment.HERDR_ENV==="1" &&
    typeof this.environment.HERDR_PANE_ID==="string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(this.environment.HERDR_PANE_ID);
  }
  const activation=adapters.find(a=>a.id===id)?.activation;
  if(!activation)return true;
  const value=this.environment[activation.environment];
  return typeof value==="string" &&
    (activation.equals===undefined ? value.length>0 : value===activation.equals);
 }
 status(id:string):PeerStatus{return this.statuses.get(id)?.status??"unverified";}
 ready(id:string):boolean{return this.status(id)==="ready";}
 anyReady(adapters:readonly PeerCliAdapter[]=[]):boolean{
  return ["herdr",...adapters.map(a=>a.id)].some(id=>this.ready(id));
 }
 getAvailable(adapters:readonly PeerCliAdapter[]=[]):string[] {
  return ["herdr",...adapters.map(a=>a.id)].filter(id=>this.ready(id));
 }
 invalidate(id:string):void{
  this.statuses.set(id,{id,status:"unavailable",checkedAt:Date.now()});
 }
 reset():void{this.statuses.clear();}
 async probe(id:string,adapters:readonly PeerCliAdapter[]=[],force=false):Promise<PeerStatus>{
  if(!this.isAttached(id,adapters)){
   this.statuses.set(id,{id,status:"not_attached",checkedAt:Date.now()});
   return "not_attached";
  }
  const existing=this.statuses.get(id);
  if(!force&&existing&&Date.now()-existing.checkedAt<STALE_MS)return existing.status;
  let status:PeerStatus="unverified";
  try {
   const call=buildPeerCommand({adapter:id,action:"list"},adapters);
   const output=await this.runner(call.executable,call.argv,
     Math.min(PROBE_TIMEOUT_MS,call.timeoutMs));
   status=probeSucceeded(output)?"ready":"unavailable";
  }catch {status="unavailable";}
  this.statuses.set(id,{id,status,checkedAt:Date.now()});
  return status;
 }
 async refresh(adapters:readonly PeerCliAdapter[]=[],force=false):Promise<void>{
  await Promise.all(["herdr",...adapters.map(x=>x.id)].map(id=>this.probe(id,adapters,force)));
 }
 summary(adapters:readonly PeerCliAdapter[]=[]):string {
  return ["Optional peer integrations:",...["herdr",...adapters.map(x=>x.id)]
   .map(id=>"  "+id+": "+this.status(id)),
   "Unavailable peers are skipped automatically; Planning runs locally.",
   "Use /jev-peers-refresh when a peer server starts or its configuration changes."].join("\n");
 }
}
