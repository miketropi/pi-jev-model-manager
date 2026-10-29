/** Select existing Pi-discovered skills without copying or installing. */
import type { TaskType } from "./task-routing.ts";
export interface LoadedSkill { name: string; description?: string; filePath?: string; path?: string }
const PREFER: Record<TaskType, string[]> = {
 plan: ["brainstorming","writing-plans","planning-with-files","architecture","software-architecture","requirements-analysis","jev-plan-quality"],
 implement: ["executing-plans","test-driven-development","verification-before-completion","coding-guidelines","jev-implementation-quality"],
 qa: ["verification-before-completion","test-driven-development","webapp-testing","playwright","testing","qa","jev-qa-quality"],
 review: ["requesting-code-review","code-review","security-review","verification-before-completion","jev-review-quality"],
 debug: ["systematic-debugging","root-cause-analysis","verification-before-completion"],
 research: ["research","deep-research","documentation"],
 write: ["writing","technical-writing","documentation","copywriting"],
 explain: ["technical-writing","documentation","explanation"],
};
export function matchingSkills(task: TaskType, loaded: readonly LoadedSkill[], limit=4): LoadedSkill[] {
 const names=PREFER[task];
 const scored=loaded.map(s=>({s,n:s.name.toLowerCase(),rank:names.indexOf(s.name.toLowerCase())}))
  .filter(o=>o.rank>=0).sort((a,b)=>a.rank-b.rank);
 const uniq=new Set<string>();
 return scored.filter(o=>{if(uniq.has(o.n))return false;uniq.add(o.n);return true;}).slice(0,limit).map(o=>o.s);
}
export function skillGuidance(task: TaskType, loaded: readonly LoadedSkill[]): string {
 const matches=matchingSkills(task,loaded);
 if(!matches.length) return "No matching installed skill found. Use Jev phase quality gates; do not pretend a missing skill is installed.";
 const detail=matches.map(s => "- "+s.name+(s.filePath||s.path ? " (read SKILL.md: "+(s.filePath||s.path)+")" : "")).join("\n");
 return "Already installed/discovered Pi skills for this phase (load only as relevant; do not install or duplicate):\n"+detail;
}
