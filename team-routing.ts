/**
 * Role-aware launch policy for external CLI agents.
 * Separates team role from the parent Pi/OMP session workflow mode.
 * It NEVER starts agents or changes another process.
 */
import type {ManagedModel, CostTier, Thinking} from "./core/config.ts";
import type {TaskRules,TaskType} from "./task-routing.ts";
import {knownModelProfile} from "./model-profiles.ts";

export type TeamRole="orchestrator"|"pm"|"dev"|"qa"|"reviewer"|"researcher";
export type Difficulty="small"|"normal"|"hard";
type Tier="fast"|"balanced"|"deep"|"unknown";
const roles:Record<string,TeamRole>={
  orchestrator:"orchestrator",lead:"orchestrator",supervisor:"orchestrator",
  manager:"orchestrator",pm:"pm",planner:"pm",architect:"pm",
  dev:"dev",developer:"dev",engineer:"dev",builder:"dev",coder:"dev",
  qa:"qa",test:"qa",tester:"qa",verifier:"qa",
  review:"reviewer",reviewer:"reviewer",auditor:"reviewer",
  research:"researcher",researcher:"researcher",scout:"researcher",
};
const mapped:Record<TeamRole,TaskType>={
  orchestrator:"research",pm:"plan",dev:"implement",qa:"qa",
  reviewer:"review",researcher:"research",
};
const costOrder:Record<CostTier,number>={budget:0,balanced:1,premium:2};
const tierRank:Record<Tier,number>={fast:0,balanced:1,deep:2,unknown:3};
const thinkingOrder:Thinking[]=["off","minimal","low","medium","high","xhigh","max"];
export function normalizeTeamRole(input:string):TeamRole|undefined {
  if(typeof input!=="string")return undefined;
  return roles[input.toLowerCase().trim().replace(/[^a-z]/g,"")];
}
export function tierOf(model:Pick<ManagedModel,"key">):Tier {
  return knownModelProfile(model.key)?.tier??"unknown";
}
function preferredTier(role:TeamRole,difficulty:Difficulty):Exclude<Tier,"unknown"> {
  if(difficulty==="hard")
    return ["pm","reviewer","orchestrator"].includes(role)?"deep":"balanced";
  if(role==="qa" || role==="researcher" ||
    (difficulty==="small" && role==="dev"))return "fast";
  return "balanced";
}
function levelFor(role:TeamRole,difficulty:Difficulty,model:ManagedModel):Thinking {
  const configured=thinkingOrder.indexOf(model.thinking);
  if(configured<0)return "off";
  const cap=difficulty==="hard"?"high":
    (role==="qa" || role==="researcher")?"low":"medium";
  return thinkingOrder[Math.min(configured,thinkingOrder.indexOf(cap))];
}
export interface TeamRoute {
  role:TeamRole;task:TaskType;model:string;modelLabel:string;
  thinking:Thinking;tier:Tier;cost:CostTier;
  reason:string;source:"manual"|"heuristic";degraded:boolean;
  cliArgs:readonly string[];
}
export type TeamResolution={ok:true;route:TeamRoute}|{ok:false;error:string};
export function resolveTeamRole(
  roleInput:string, difficulty:Difficulty,models:readonly ManagedModel[],
  rules:TaskRules,
):TeamResolution {
  const role=normalizeTeamRole(roleInput);
  if(!role)return {ok:false,error:"Unknown team role. Supported: orchestrator, pm, dev, qa, reviewer, researcher."};
  if(!["small","normal","hard"].includes(difficulty))
    return {ok:false,error:"Difficulty must be small, normal, or hard."};
  const eligible=models.filter(m=>m.enabled);
  if(!eligible.length)return {ok:false,error:"No enabled, available physical models for this team role."};
  // Orchestrator is a team role, not a Plan task. Never inherit a forced
  // premium Planning policy just because the parent coordinates work.
  const task=mapped[role],rule=role==="orchestrator"?undefined:rules[task];
  const specified=rule?.mode!=="auto"&&rule?.model
    ?eligible.find(m=>m.key===rule.model):undefined;
  if(rule?.mode==="force" && !specified)
    return {ok:false,error:"Forced "+task+" model is unavailable. No silent premium fallback."};
  const target=preferredTier(role,difficulty);
  const permitted:Tier[]=target==="deep"?["deep","balanced","fast","unknown"]:
    target==="balanced"?["balanced","fast","deep","unknown"]:
      ["fast","balanced","deep","unknown"];
  const chosen=specified??[...eligible].sort((a,b)=>{
    const x=tierOf(a),y=tierOf(b);
    const xi=permitted.indexOf(x),yi=permitted.indexOf(y);
    if(xi!==yi)return xi-yi;
    return costOrder[a.cost]-costOrder[b.cost] ||
      tierRank[x]-tierRank[y] || a.key.localeCompare(b.key);
  })[0];
  const tier=tierOf(chosen);
  const degraded=tier==="unknown"||permitted.indexOf(tier)>0||
    (["dev","qa","researcher"].includes(role)&&chosen.cost==="premium"&&!specified);
  const thinking=levelFor(role,difficulty,chosen);
  return {ok:true,route:{
    role,task,model:chosen.key,modelLabel:chosen.label,
    thinking,tier,cost:chosen.cost,
    source:specified?"manual":"heuristic",
    degraded,
    reason:specified
      ?task+" explicit "+rule.mode+" policy"
      :"team role "+role+" / "+difficulty+"; target "+target+" tier, lowest configured cost in matching tier",
    cliArgs:["--model",chosen.key,"--thinking",thinking],
  }};
}

/** Explicit platform launch contract. Never assume the new child inherited this role. */
export function herdrLaunchExample(agentName:string,paneId:string,kind:"pi"|"omp",route:TeamRoute):string {
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName))throw Error("Invalid Herdr agent name");
  if(!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(paneId))throw Error("Invalid Herdr pane ID");
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,191}$/.test(route.model))
    throw Error("Unsafe model ID for CLI example");
  return ["herdr","agent","start",agentName,"--kind",kind,"--pane",paneId,
    "--",...route.cliArgs].join(" ");
}
