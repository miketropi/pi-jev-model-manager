/** Provider-agnostic semantic assessment contract. No provider calls or mutations here. */
import { decideContextAction, type ContextKind, type ContextAction } from "./store.ts";
export interface RelevanceInput {id:string;kind:ContextKind;summary:string;task:string;protected?:boolean;active?:boolean;duplicate?:boolean;}
export interface RelevanceResult {id:string;score:number;reason:string;action:ContextAction;source:"semantic"|"fallback";}
export type SemanticEvaluator=(input:RelevanceInput,signal:AbortSignal)=>Promise<{score:number;reason:string}>;
export async function assessRelevance(input:RelevanceInput,evaluator?:SemanticEvaluator,timeoutMs=2000):Promise<RelevanceResult> {
 const fallback=():RelevanceResult=>({id:input.id,score:NaN,reason:"No trusted semantic assessment",action:decideContextAction({kind:input.kind,protected:input.protected,isActive:input.active,duplicate:input.duplicate}),source:"fallback"});
 if(input.protected || input.kind==="decision" || input.kind==="checkpoint" || input.active || !evaluator) return fallback();
 const controller=new AbortController();
 const timeout=AbortSignal.timeout(Math.max(1,Math.min(30000,timeoutMs)));
 const abort=()=>controller.abort();timeout.addEventListener("abort",abort,{once:true});
 try {
  const response=await Promise.race([evaluator(input,controller.signal),new Promise<never>((_r,reject)=>timeout.addEventListener("abort",()=>reject(new Error("timeout")),{once:true}))]);
  if(!response || !Number.isFinite(response.score) || response.score<0 || response.score>1 || typeof response.reason!=="string" || response.reason.length>500) return fallback();
  return {id:input.id,score:response.score,reason:response.reason,action:decideContextAction({kind:input.kind,protected:input.protected,isActive:input.active,duplicate:input.duplicate,relevance:response.score}),source:"semantic"};
 }catch{return fallback();}finally{controller.abort();timeout.removeEventListener("abort",abort);}
}
