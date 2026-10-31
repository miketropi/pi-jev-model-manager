/**
 * Conservative quality floor for Planning. Curated model tiers are heuristics,
 * not live benchmarks. User-configured Force/Prefer rules always win.
 */
import type {ManagedModel} from "../core/config.ts";
import {knownModelProfile} from "../model-profiles.ts";

export type PlanningTier = "deep" | "balanced" | "unknown" | "fast";
export function planningTier(model: Pick<ManagedModel,"key"|"label">): PlanningTier {
  const curated = knownModelProfile(model.key);
  if (curated) return curated.tier;
  // Labels can represent an explicit fast role, even for unrecognized proxy IDs.
  // Do not elevate unknown models to the reasoning tier from marketing names.
  if (/(?:^|[\s/_.(-])(?:fast|luna|flash|mini|nano|haiku)(?:$|[\s/_.)-])/i
    .test(model.key + " " + model.label)) return "fast";
  return "unknown";
}
export interface PlanningPool<T extends Pick<ManagedModel,"key"|"label">> {
  candidates: T[];
  preferred: T;
  restricted: boolean;
  degraded: boolean;
  reason: string;
}
export function planningPool<T extends Pick<ManagedModel,"key"|"label">>(
  candidates: readonly T[],
): PlanningPool<T> {
  if (!candidates.length) throw new Error("Planning requires an eligible model");
  const deep = candidates.filter(x=>planningTier(x)==="deep");
  const balanced = candidates.filter(x=>planningTier(x)==="balanced");
  const qualified = [...deep,...balanced];
  if (qualified.length) {
    return {candidates:qualified,preferred:qualified[0],restricted:qualified.length!==candidates.length,
      degraded:false,reason:"quality floor: deep/balanced candidates"};
  }
  const unknown = candidates.filter(x=>planningTier(x)==="unknown");
  if (unknown.length) {
    return {candidates:unknown,preferred:unknown[0],restricted:unknown.length!==candidates.length,
      degraded:true,reason:"unverified planning capabilities; no known deep/balanced model"};
  }
  return {candidates:[...candidates],preferred:candidates[0],restricted:false,degraded:true,
    reason:"fast-tier only; no planning-quality model available"};
}
export function enforcePlanningQuality<T extends Pick<ManagedModel,"key"|"label">>(
  chosen: string, available: readonly T[],
): {model:string; changed:boolean; reason:string; degraded:boolean} {
  const pool=planningPool(available);
  const accepted=pool.candidates.some(x=>x.key===chosen);
  return {model:accepted?chosen:pool.preferred.key,
    changed:!accepted,reason:pool.reason,degraded:pool.degraded};
}
