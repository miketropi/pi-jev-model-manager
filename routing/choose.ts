import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {Config,ManagedModel} from "../core/config.ts";
import {fallbackModel} from "./selectors.ts";
import {classifierModelGuidance} from "../model-profiles.ts";
import {applyTaskRule} from "../task-routing.ts";
export interface Decision {model:string;task:string;probability:number;reason:string;suggested?:string;}
export async function choose(
  prompt: string,
  config: Config,
  candidates: ManagedModel[],
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<Decision> {
  const base = fallbackModel(candidates, config);
  if (!config.enabled) return { model: base.key, task: "unknown", probability: 0, reason: "routing disabled" };
  if (candidates.length === 1) return { model: base.key, task: "unknown", probability: 1, reason: "only eligible model" };
  const classifier = ctx.modelRegistry.findOfType(
    "classifier", config.classifier.provider, config.classifier.model,
  );
  if (!classifier) return { model: base.key, task: "unknown", probability: 0, reason: "classifier unavailable" };

  // Jev makes a typed choice. Application code validates the answer and enforces policy.
  const criteria = Object.fromEntries(candidates.map((m, index) => [
    "m" + index, classifierModelGuidance(m),
  ]));
  try {
    const result = await ctx.modelRegistry.classify(classifier, {
      state: { prompt },
      questions: {
        task: {
          type: "choice",
          instructions: "Classify the main user task, including software development and content creation.",
          criteria: {
            plan: "Plan an architecture, project, workflow or content outline",
            implement: "Write or change application code",
            debug: "Diagnose and fix a defect",
            review: "Review existing code, tests, or security",
            qa: "Run and evaluate tests, acceptance checks and regressions",
            research: "Investigate unfamiliar APIs, concepts, or libraries",
            explain: "Explain a concept without editing code",
            write: "Create or draft a blog post, article, tutorial, documentation or marketing content",
          },
        },
        selected_model: {
          type: "choice",
          instructions:
            "Select the best eligible model for solving this task. Follow model strengths and exclusions. Only choose from the provided choices.",
          criteria,
        },
      },
    }, { signal });
    if (result.stopReason !== "stop") throw new Error(`classifier stopped: ${result.stopReason}`);
    const modelAnswer = result.answers.selected_model;
    const taskAnswer = result.answers.task;
    if (modelAnswer?.type !== "choice") throw new Error("non-choice response");
    const index = Number(modelAnswer.choice?.slice(1));
    const picked = candidates[index];
    const probability = Number(modelAnswer.probabilities?.[modelAnswer.choice] ?? 0);
    const task = taskAnswer?.type === "choice" ? taskAnswer.choice : "unknown";
    if (!picked || !Number.isFinite(probability)) throw new Error("invalid model selection");
    const taskProbability = Number(taskAnswer?.probabilities?.[task] ?? 1);
    // The task policy overrides Jev's model recommendation only when task
    // classification is sufficiently confident and the target is available.
    const jevModel = probability < config.minProbability ? base.key : picked.key;
    const rule = applyTaskRule(task, jevModel, base.key, candidates.map((m) => m.key),
      config.taskRules, taskProbability, config.minProbability);
    return { model: rule.model, task, probability,
      reason: rule.reason === "Jev auto" && probability < config.minProbability
        ? "low confidence fallback" : rule.reason };
  } catch (e) {
    if (signal?.aborted) throw e;
    return {
      model: base.key, task: "unknown", probability: 0,
      reason: `classifier error; deterministic fallback (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

