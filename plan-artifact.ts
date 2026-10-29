/**
 * Durable, per-session plan document helpers.
 * Session entries are the source of truth; no workspace writes in Plan Mode.
 */
export const PLAN_ENTRY = "jev-plan-document";
export const PLAN_MESSAGE = "jev-plan-preview";
export interface PlanDocument {
  markdown: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "approved";
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
export function nextPlan(text:string, previous?:PlanDocument, date=new Date()):PlanDocument {
  const now=date.toISOString();
  return {
    markdown: normalizePlanMarkdown(text),
    version:(previous?.version ?? 0)+1,
    createdAt:previous?.createdAt ?? now,
    updatedAt:now,
    status:"draft",
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
export function planPreview(p:PlanDocument, max=5):string[] {
 const head=p.markdown.split("\n").filter(l=>l.trim()).slice(0,max).map(l=>l.slice(0,90));
 return ["JEV PLAN · v"+p.version+" · "+p.status, ...head, "/jev-plan-open · review / edit / implement"];
}
export function implementationHandoff(p:PlanDocument):string {
 if(p.status!=="approved")throw new Error("Plan must be approved before implementation.");
 return "Implement the approved Jev plan version "+p.version+". Respect scope and acceptance criteria.\n\n"+p.markdown;
}
