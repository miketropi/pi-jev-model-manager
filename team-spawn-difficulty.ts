/** Optional TypeSafe Jev workload judgment. Default is conservative normal. */
import type {Difficulty} from "./team-routing.ts";
export interface DifficultyDecision {
 difficulty:Difficulty;confidence:number;source:"jev"|"default";
}
export async function inferTeamDifficulty(taskSummary:string,
 registry:any,classifier:{provider:string;model:string},
 signal?:AbortSignal):Promise<DifficultyDecision>{
 const fallback:DifficultyDecision={difficulty:"normal",confidence:0,source:"default"};
 const prompt=taskSummary.trim();
 if(prompt.length<12||prompt.length>1200 ||
   typeof registry?.findOfType!=="function"||
   typeof registry?.classify!=="function")return fallback;
 try{
  const model=registry.findOfType("classifier",classifier.provider,classifier.model);
  if(!model)return fallback;
  const result=await registry.classify(model,{
   state:{task:prompt},
   questions:{
    effort:{type:"choice",instructions:
      "Estimate engineering complexity for ONE scoped worker assignment, not the parent orchestrator. Judge required verification, code coupling, risk and reasoning; do not assume premium for routine tasks.",
     criteria:{
      small:"Trivial bounded change, extraction or repetitive low-risk checks",
      normal:"Moderate coding, routine feature implementation or standard QA/review",
      hard:"Complex architecture, high-risk/security, difficult debugging or highly coupled work",
     }},
   }
  },{signal});
  const choice=result?.answers?.effort;
  const value=choice?.choice;
  const confidence=Number(choice?.probabilities?.[value]??0);
  if(result?.stopReason!=="stop"||choice?.type!=="choice"||
    !["small","normal","hard"].includes(value)||
    !Number.isFinite(confidence)||confidence<.72)return fallback;
  return {difficulty:value,confidence,source:"jev"};
 }catch{return fallback;}
}
