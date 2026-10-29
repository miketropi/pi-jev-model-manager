/**
 * Authoritative per-session handoff metadata; no project files or copied chat history.
 * Pi session headers link implementation children to their planning parent.
 */
import type { PlanDocument } from "./plan-artifact.ts";
export const SESSION_ORIGIN_ENTRY = "jev-implementation-session-origin";
export const SESSION_LAUNCH_ENTRY = "jev-implementation-session-launch";
export type HandoffMode = "manual" | "auto";
export interface SessionOrigin {
  parentSession: string;
  planVersion: number;
  mode: HandoffMode;
  createdAt: string;
}
export function createOrigin(parentSession:string, plan:PlanDocument,
  mode:HandoffMode, date=new Date()):SessionOrigin {
 if(!parentSession || !plan || plan.status!=="approved" || plan.version<1)
  throw Error("A persistent planning session and approved plan are required");
 return {parentSession,planVersion:plan.version,mode,createdAt:date.toISOString()};
}
export function latestSessionOrigin(entries:readonly any[]):SessionOrigin|undefined {
 for(const e of [...entries].reverse()){
  if(e?.type==="custom" && e.customType===SESSION_ORIGIN_ENTRY &&
    typeof e.data?.parentSession==="string" && e.data.parentSession &&
    Number.isInteger(e.data.planVersion) && ["manual","auto"].includes(e.data.mode))
   return e.data;
 }
}
export function latestSessionLaunch(entries:readonly any[], planVersion:number):
  {planVersion:number;mode:HandoffMode;status:string}|undefined {
 for(const e of [...entries].reverse()){
  if(e?.type==="custom" && e.customType===SESSION_LAUNCH_ENTRY &&
    e.data?.planVersion===planVersion && ["manual","auto"].includes(e.data?.mode))
   return e.data;
 }
}
export function handoffTitle(plan:PlanDocument):string {
 const line=plan.markdown.split(/\r?\n/).find(x=>x.trim().startsWith("#"));
 const title=line?.replace(/^#+\s*/,"") || plan.request || "Approved plan";
 return "Jev Implement · "+title.replace(/[\r\n\x00-\x1f]/g," ").trim().slice(0,64);
}
