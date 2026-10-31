/** Typed Jev judgment is advisory; code enforces permission and delegation safety. */
export type ExecutionStrategy="direct"|"scout"|"builders";
export interface JevStrategyResult{
 strategy:ExecutionStrategy; confidence:number; source:"jev"|"fallback"; reason:string;
}
export async function suggestJevStrategy(
 task:string, phase:"plan"|"implement",
 registry:{findOfType:(type:string,provider:string,model:string)=>any;
   classify:(model:any,body:any,opts?:any)=>Promise<any>},
 classifier:{provider:string;model:string},
 signal?:AbortSignal
):Promise<JevStrategyResult>{
 const fallback: JevStrategyResult={strategy:"direct",confidence:0,source:"fallback",
  reason:"Jev unavailable or untrusted; retain single Lead execution"};
 if(!task.trim()||task.length>1200)return fallback;
 try {
  if(typeof registry?.findOfType!=="function" || typeof registry?.classify!=="function")
   return fallback;
  const model=registry.findOfType("classifier",classifier.provider,classifier.model);
  if(!model)return fallback;
  const result=await registry.classify(model,{
   state:{task:task.trim(),phase},
   questions:{
    isolation:{type:"choice",instructions:"Judge if work can be split into independently verifiable scoped subtasks without breaking dependencies. Never assume agent permissions.",
     criteria:{
      independent:"Independent bounded work streams, isolated evidence or nonoverlapping file scopes",
      sequential:"Tightly coupled or dependent work; maintain a single decision maker",
     }},
    complexity:{type:"choice",instructions:"Judge substantive task complexity",
     criteria:{simple:"Small and focused",complex:"Many files, unknown APIs, or multiple independent concerns"}},
   }
  },{signal});
  if(result?.stopReason!=="stop")return fallback;
  const a=result.answers?.isolation,b=result.answers?.complexity;
  const confidence=Number(a?.probabilities?.[a?.choice]??0);
  if(a?.type!=="choice"||b?.type!=="choice"||!["independent","sequential"].includes(a.choice)||
    !["simple","complex"].includes(b.choice)||!Number.isFinite(confidence)||
    confidence<.75 || a.choice!=="independent" || b.choice!=="complex")return fallback;
  // In Plan: only explicitly configured existing read-only collaborators may be
  // consulted; this does NOT spawn a native Pi child with unknown permissions.
  return {strategy:phase==="plan"?"scout":"builders",confidence,source:"jev",
   reason:phase==="plan"
    ?"Recommend bounded read-only research through trusted existing peers"
    :"Recommend scoped Builder waves with nonoverlapping file ownership"};
 }catch{return fallback;}
}
