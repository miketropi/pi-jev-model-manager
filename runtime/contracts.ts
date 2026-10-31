import type { WorkflowBindings } from "./workflow-controller.ts";
import type { CommandBindings } from "../commands/register.ts";
import type { Decision } from "../routing/choose.ts";
import { latestSessionOrigin } from "../implementation-session.ts";
export type RuntimeBindings = WorkflowBindings & CommandBindings & {
  lastDecision: Decision | undefined;
  planRunActive: boolean;
  pendingPlanText: string | undefined;
  implementationOrigin: ReturnType<typeof latestSessionOrigin>;
  planOriginalRequest: string | undefined;
};
