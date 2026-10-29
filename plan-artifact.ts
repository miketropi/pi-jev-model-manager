/**
 * Durable, per-session plan document helpers.
 * Session entries are the source of truth; no workspace writes in Plan Mode.
 */
export const PLAN_ENTRY = "jev-plan-document";
export const PLAN_MESSAGE = "jev-plan-preview";
export const PLAN_UI_ENTRY = "jev-plan-ui-state";
export interface PlanDocument {
  markdown: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "approved";
  request?: string;
}
export function extractPlanText(messages: readonly any[] | undefined): string | undefined {
  if (!messages) return;
  const candidates = [...messages].reverse().filter(m =>
    m?.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted");
  for(const message of candidates) {
    const text = Array.isArray(message.content)
      ? message.content.filter((b:any)=>b.type==="text").map((b:any)=>b.text).join("\n")
      : typeof message.content==="string" ? message.content : "";
    if (text.trim().length >= 80) return text.trim().slice(0,50000);
  }
}
export function normalizePlanMarkdown(input:string): string {
  const content=input.trim().slice(0,50000);
  if (!content) throw new Error("Plan must not be empty.");
  return /^#\s+.+/m.test(content) ? content : "# Implementation Plan\n\n"+content;
}
export function nextPlan(text:string, previous?:PlanDocument, date=new Date(), request?:string):PlanDocument {
  const now=date.toISOString();
  return {
    markdown: normalizePlanMarkdown(text),
    version:(previous?.version ?? 0)+1,
    createdAt:previous?.createdAt ?? now,
    updatedAt:now,
    status:"draft",
    request: request?.trim() || previous?.request,
  };
}
export function latestPlanFromBranch(entries:readonly any[]):PlanDocument|undefined {
  for(const e of [...entries].reverse()) {
    if (e?.type!=="custom" || e.customType!==PLAN_ENTRY) continue;
    const p=e.data;
    if(typeof p?.markdown==="string" && Number.isInteger(p.version) &&
        p.version>0 && p.markdown.trim().length>0)
      return p as PlanDocument;
  }
}
export function planPreview(p:PlanDocument):string[] {
 const heading=p.markdown.split("\n").map(x=>x.trim()).find(x=>/^#{1,3}\s+/.test(x))
   ?? p.markdown.split("\n").find(x=>x.trim()) ?? "Saved implementation plan";
 return ["JEV PLAN · v"+p.version+" · "+p.status,
   heading.slice(0,76),
   "/jev-plan-open · actions  |  /jev-plan-hide · dismiss"];
}
export function implementationHandoff(p:PlanDocument):string {
 if(p.status!=="approved")throw new Error("Plan must be approved before implementation.");
 return [
  "[JEV WORKFLOW HANDOFF — IMPLEMENTATION REQUIRED]",
  "The user has explicitly APPROVED the plan below and selected Implement now.",
  "THIS IS AN EXECUTION REQUEST, NOT A REQUEST TO DRAFT, REVIEW OR REWRITE A PLAN.",
  "Execute the actual end deliverables described by the plan now. If it is a writing/content task, produce the finished article/content; if it is a code task, implement code and validate it.",
  "Use the plan as requirements and context, NOT as the output artifact to update.",
  "Do not create, revise or merely summarize the plan itself unless the user explicitly requests that as the final deliverable.",
  "Perform the work with available tools, verify outcomes and report actual results. Ask only for a truly blocking input.",
  "Approved plan version: "+p.version,
  p.request ? "Original user request (subject/context only; do not return to planning): "+p.request : "",
  "",
  "--- BEGIN APPROVED PLAN ---",
  p.markdown,
  "--- END APPROVED PLAN ---",
 ].join("\n");
}
