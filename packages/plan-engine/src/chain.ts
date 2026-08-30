import type { MealPlan } from "./schema";
import { MEMBER_GEN_MAX_ATTEMPTS } from "./constants";

/**
 * Continuation chaining — the decision half.
 *
 * A meal run that ends with missing days used to END: the partial week sat
 * until a logged-in browser happened to mount /plan or /dashboard, because
 * `DeferredMemberDrain` (the only self-heal) fires exclusively on page visits.
 * The background worker now closes its own rows and dispatches its own
 * continuation instead — this module is the pure predicate deciding WHETHER,
 * shared by the worker (and testable without it) so the rule cannot fork the
 * way the drain/engine pair once did.
 *
 * A chain must be bounded twice over, because a wide run holds the generation
 * lock for minutes and free-access mode removes the weekly spend guard:
 *   - PLAN_CHAIN_MAX_HOPS caps the invocation count outright;
 *   - progress is required (a hop that completed zero days does not chain —
 *     whatever stopped it will stop an identical successor);
 *   - the per-member attempt cap (gen_attempts, now charged by wide runs too)
 *     stops a deterministically-failing member from re-chaining via
 *     incompleteInPlanMemberIds.
 */
export const PLAN_CHAIN_MAX_HOPS = 3;

/**
 * Members already IN the plan who are still missing days, and are still under
 * the per-member retry cap.
 *
 * The drain fills gaps one member at a time: `pickNextMemberId` returns a single
 * id and the run targets only them. That is right for a NEWLY ADDED member —
 * they need a skeleton, and a shared newcomer needs the whole shared group
 * rebuilt so the merged dishes line up. It is wrong for the common case after a
 * budget-trimmed run, where four or five people are each missing the same two or
 * three days: the household then needs one drain round PER MEMBER, each waiting
 * on a page visit to dispatch and each holding the generation lock, so the week
 * trickles in over five separate invocations.
 *
 * The engine has always supported the better shape — `membersToGenerate` is
 * `beneficiaries.filter((b) => !isComplete(b))` whenever no `onlyMemberId` is
 * given, so a carry-over run with no member scope fills EVERY incomplete member.
 * (Such a run skips the skeleton only when the family dish grid still covers the
 * missing days; a day the whole family lost carries no dishes, so refilling it
 * re-runs a skeleton for the short members — day-calls-only was this comment's
 * original claim and it is false for family-wide losses.)
 *
 * The list is deliberately restricted to members already in the plan. An ABSENT
 * member is a different job (skeleton + possibly a shared-group rebuild), and
 * mixing the two into one run is what `regenerateSharedGroup` exists to handle.
 */
export function incompleteInPlanMemberIds(params: {
  plan: MealPlan;
  maxAttempts: number;
}): string[] {
  const { plan, maxAttempts } = params;
  const daysTotal = plan.days_total ?? 7;
  const attempts = plan.gen_attempts ?? {};
  return plan.members
    .filter(
      (m) =>
        m.days.filter((d) => d.meals.length > 0).length < daysTotal &&
        (attempts[m.member_id] ?? 0) < maxAttempts,
    )
    .map((m) => m.member_id);
}

/**
 * Should a just-finished (success-path) meal run dispatch its own continuation?
 *
 * Every conjunct guards a specific hazard, all found the hard way:
 *   - `missingDays` empty → the week is whole, nothing to chain.
 *   - `daysCompleted === 0` → zero progress; an identical successor would meet
 *     whatever stopped this one, and "no progress → no chain" is what makes the
 *     hop cap an upper bound on WASTE, not just on invocations.
 *   - `chainDepth` at the cap → stop; the drain (page-visit) remains the
 *     last-resort absorber, now against a bounded residue.
 *   - a beneficiary ABSENT from the plan → never chain. The wide continuation
 *     carries no `regenerateSharedGroup` routing, so it would generate a shared
 *     newcomer without rebuilding the shared group — the add/drain flow owns
 *     that, and it must win the race for the lock.
 *   - nobody short is under the attempt cap → chaining would re-buy a member
 *     the cap already gave up on; the residue ships visible instead.
 */
export function shouldChainContinuation(params: {
  plan: MealPlan;
  /** Every current non-housekeeper beneficiary id (mom + members). */
  beneficiaryIds: string[];
  missingDays: number[];
  /** Days this run actually completed (not carried — generated). */
  daysCompleted: number;
  /** 0 for a user-dispatched run; hops increment it. */
  chainDepth: number;
}): boolean {
  const { plan, beneficiaryIds, missingDays, daysCompleted, chainDepth } = params;
  if (missingDays.length === 0) return false;
  if (daysCompleted <= 0) return false;
  if (chainDepth >= PLAN_CHAIN_MAX_HOPS) return false;
  const inPlan = new Set(plan.members.map((m) => m.member_id));
  if (!beneficiaryIds.every((id) => inPlan.has(id))) return false;
  return (
    incompleteInPlanMemberIds({ plan, maxAttempts: MEMBER_GEN_MAX_ATTEMPTS })
      .length > 0
  );
}
