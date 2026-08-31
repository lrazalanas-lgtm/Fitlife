import {
  incompleteInPlanMemberIds,
  planHasContent,
  MEMBER_GEN_MAX_ATTEMPTS,
  type MealPlan,
} from "@fitlife/plan-engine";

/**
 * The scheduled sweeper's DECISION half — pure, unit-tested, no I/O.
 *
 * Until now the product had exactly one self-heal for an incomplete week:
 * `DeferredMemberDrain`, a client component that fires when a logged-in
 * browser mounts /plan or /dashboard. The worker's self-chaining (chain.ts)
 * removed the page-visit dependency for runs that END SHORT — but a run the
 * platform hard-kills before its terminal writes cannot chain, and a household
 * that closes the tab after dispatching still waits for someone to come back.
 * The sweeper is the last stretch of that road: a 5-minute cron that does, for
 * every account, exactly what a page visit would have done.
 *
 * Deliberate scope limits, each load-bearing:
 * - WIDE refills only, and only when every beneficiary is already IN the plan.
 *   An absent member needs a skeleton and possibly `regenerateSharedGroup`
 *   routing that lives in the drain/add flow — the same exclusion the chain
 *   makes, built on the same `incompleteInPlanMemberIds` definition.
 * - Meal kind only. Workout runs have their own meals-first choreography.
 * - A hard per-account daily budget of recent generation rows. A cron that
 *   dispatches paid model runs MUST be unable to loop: whatever else goes
 *   wrong, the cap turns a bug into a bounded cost instead of an unbounded one
 *   (free-access mode removes the weekly quota, so nothing else bounds it).
 * - Translation refills stay with the housekeeper page + end-of-run pass.
 */

/** Recent generation rows an account may accrue per rolling day before the
 * sweeper stands down. Covers the account's OWN activity too — deliberately:
 * an account that busy is not one a cron should add spend to. */
export const SWEEP_DAILY_GEN_CAP = 8;

/** How many recent plans the ready-plan search may scan — mirrors
 * `previousPlanFallback`'s window in getLatestPlan.ts (failures stack; the
 * account that motivated the window had the last good week THIRD). */
export const SWEEP_PLAN_WINDOW = 5;

export interface SweepPlanRow {
  id: string;
  status: string;
}

export interface SweepCandidate {
  userId: string;
  onboardingCompleted: boolean;
  /** Newest-first window of recent meal plans (statuses only). */
  planWindow: SweepPlanRow[];
  /** plan_data of the newest 'ready' row in the window, when one exists. */
  newestReadyPlan: MealPlan | null;
  /** Non-housekeeper member ids + "mom" — the roster a wide fill must cover. */
  beneficiaryIds: string[];
  /** A live (non-stale) 'started' meal generation exists — the lock is held. */
  hasLiveMealRun: boolean;
  /** plan_generations rows created for this user in the last 24h, any status. */
  genRowsLast24h: number;
}

export type SweepDecision =
  | { action: "dispatch"; reason: string }
  | { action: "skip"; reason: string };

export function decideSweep(c: SweepCandidate): SweepDecision {
  if (!c.onboardingCompleted)
    return { action: "skip", reason: "onboarding incomplete" };
  if (c.hasLiveMealRun)
    return { action: "skip", reason: "meal generation in flight" };
  if (c.genRowsLast24h >= SWEEP_DAILY_GEN_CAP)
    return {
      action: "skip",
      reason: `daily generation budget spent (${c.genRowsLast24h})`,
    };
  const newestReadyIdx = c.planWindow.findIndex((p) => p.status === "ready");
  if (newestReadyIdx === -1 || !c.newestReadyPlan)
    return { action: "skip", reason: "no ready plan in window" };
  if (!planHasContent(c.newestReadyPlan))
    return { action: "skip", reason: "ready plan has no content" };
  const incomplete = incompleteInPlanMemberIds({
    plan: c.newestReadyPlan,
    maxAttempts: MEMBER_GEN_MAX_ATTEMPTS,
  });
  if (incomplete.length === 0)
    return { action: "skip", reason: "week complete or attempts capped" };
  const inPlan = new Set(c.newestReadyPlan.members.map((m) => m.member_id));
  const absent = c.beneficiaryIds.filter((id) => !inPlan.has(id));
  if (absent.length > 0)
    return {
      action: "skip",
      reason: `absent member needs the drain's routing (${absent.length})`,
    };
  return {
    action: "dispatch",
    reason: `refill ${incomplete.length} short member(s)`,
  };
}
