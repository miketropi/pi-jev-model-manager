/**
 * Trusted, explicit tool contracts for strict Jev phases.
 * Capabilities describe what a tool invocation MAY do. This is a policy
 * declaration, not a sandbox or trustworthy inference from a tool name.
 */
import type {TaskType} from "./task-routing.ts";

export type Capability="read"|"communicate"|"delegate_research"|"verify"|"write"|"execute"|"spawn"|"admin";
export type StrictPhase="plan"|"qa"|"review";
export interface ToolGrant {
  tool:string;
  capability:Capability;
  phases:StrictPhase[];
  actionField?:string;
  allowedActions?:string[];
}
/** Builtins have been inspected; unknown 3rd-party tools must be opted in. */
const CORE:ToolGrant[]=[
 ...["read","grep","find","ls","jev_web_fetch","web_search","web_fetch",
   "search_web","fetch_url"].map(tool=>({tool,capability:"read" as const,
      phases:["plan","qa","review"] as StrictPhase[]})),
 {tool:"jev_team_route",capability:"read",phases:["plan","qa","review"]},
 {tool:"jev_ask_user",capability:"communicate",phases:["plan","review"]},
 {tool:"jev_quality_gate",capability:"verify",phases:["qa","review"]},
 {tool:"jev_herdr",capability:"delegate_research",phases:["plan"],
  actionField:"action",allowedActions:["list","get","read","wait","prompt"]},
 {tool:"jev_collaborate",capability:"delegate_research",phases:["plan"],
  actionField:"action",allowedActions:["list","get","read","wait","prompt"]},
];
export const RESTRICTED_TOOL_NAMES=new Set(["bash","write","edit","subagent",
  "Agent","agent_spawn","spawn_agent","subagent_spawn","jev_progress","jev_delegate",
  "jev_qa_triage","jev_qa_fix","jev_quality_gate","jev_web_fetch","jev_ask_user",
  "jev_herdr","jev_collaborate","jev_team_route","read","grep","find","ls"]);
export const CAPABILITIES:Record<StrictPhase,ReadonlySet<Capability>>={
 plan:new Set(["read","communicate","delegate_research"]),
 qa:new Set(["read","verify"]),
 review:new Set(["read","communicate"])
};
const SAFE_TOOL=/^[a-zA-Z][a-zA-Z0-9_.:/-]{0,95}$/;
const SAFE_ACTION=/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
export function normalizeToolGrants(value:unknown):ToolGrant[]{
 if(!Array.isArray(value))return [];
 const grants:ToolGrant[]=[];
 const keys=new Set<string>();
 for(const row of value.slice(0,60)){
  if(!row||typeof row!=="object")continue;
  const g=row as Record<string,unknown>;
  if(typeof g.tool!=="string"||!SAFE_TOOL.test(g.tool)||
     RESTRICTED_TOOL_NAMES.has(g.tool)||CORE.some(x=>x.tool===g.tool))continue;
  if(!["read","communicate","delegate_research","verify"].includes(String(g.capability)))continue;
  const capability=g.capability as Capability;
  const phases=Array.isArray(g.phases)?g.phases.filter(
    (x):x is StrictPhase=>(x==="plan"||x==="qa"||x==="review")&&
      CAPABILITIES[x as StrictPhase].has(capability)):[];
  const uniquePhases=[...new Set(phases)];
  if(!uniquePhases.length||keys.has(g.tool))continue;
  // Custom communication/delegation must be explicitly bounded by action.
  // A plain "prompt" tool without a separate safe action is not trusted.
  const actionField=typeof g.actionField==="string" &&
    SAFE_ACTION.test(g.actionField)?g.actionField:undefined;
  const actions=Array.isArray(g.allowedActions)?g.allowedActions.filter(
    (v):v is string=>typeof v==="string"&&SAFE_ACTION.test(v)).slice(0,20):[];
  const allowedActions=[...new Set(actions)];
  // Reject plainly mutating action names even in an administrator-written
  // grant. Ambiguous/custom names still require the user's trust review.
  if(allowedActions.some(action=>/(?:^|[_-])(?:spawn|start|run|execute|exec|shell|bash|write|edit|delete|remove|create|install|deploy|publish|sendkeys|send_keys|command|mutate|apply)(?:$|[_-])/i.test(action)))
    continue;
  if(capability!=="read" && (!actionField||!allowedActions.length))continue;
  if((actionField&&!allowedActions.length)||(!actionField&&allowedActions.length))continue;
  keys.add(g.tool);
  grants.push({tool:g.tool,capability,phases:uniquePhases,
    ...(actionField?{actionField,allowedActions}: {})});
 }
 return grants;
}
export function toolGrants(configured:readonly ToolGrant[]=[]):ToolGrant[]{
 return [...CORE,...configured];
}
export function grantForPhase(tool:string,phase:StrictPhase,
  configured:readonly ToolGrant[]=[]):ToolGrant|undefined {
 const grant=toolGrants(configured).find(x=>x.tool===tool);
 if(!grant || !grant.phases.includes(phase) || !CAPABILITIES[phase].has(grant.capability))
  return undefined;
 return grant;
}
export function grantsToolCall(tool:string,phase:StrictPhase,input:unknown,
  configured:readonly ToolGrant[]=[]):boolean {
 const grant=grantForPhase(tool,phase,configured);
 if(!grant)return false;
 if(!grant.actionField)return true;
 const obj=input&&typeof input==="object"&&!Array.isArray(input)
  ?input as Record<string,unknown>:undefined;
 const value=obj?.[grant.actionField];
 return typeof value==="string"&&!!grant.allowedActions?.includes(value);
}
