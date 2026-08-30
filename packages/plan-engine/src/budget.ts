/**
 * A run-wide deadline for one generation invocation.
 *
 * Every per-call budget in the engine is sized to the WORK (see constants.ts:
 * `bigCallTimeoutMs` allows 400s for one 6-member day call, `CONTENT_MAX_RETRIES`
 * adds two more full calls per day, `MAX_RETRIES` adds five API retries with
 * sleeps, and generate.ts runs a second-chance wave over failed days). None of
 * them knew about the 15-minute ceiling the Netlify background function actually
 * runs under, so a large household could legitimately spend 20 minutes of work
 * inside a 15-minute box and be hard-killed mid-flight — no catch, no terminal
 * row, no plan.
 *
 * Measured in production on a paid `family` account: a 6-member run reached 6/7
 * days and a 4-member run 4/7 days, both killed, both recording $0.
 *
 * The fix is NOT to fit more work into one invocation. It is to stop cleanly
 * while budget remains and hand back a partial week — `DeferredMemberDrain`
 * (apps/app/src/app/plan/page.tsx) already re-dispatches for members with
 * missing days, so a trimmed run self-completes across invocations and any
 * household size works by construction.
 */

/** Netlify's background-function ceiling. */
export const DEFAULT_PLAN_RUN_BUDGET_MS = 15 * 60_000;

/**
 * Room to write the final `meal_plans` + `plan_generations` rows after the day
 * loop returns. Small, but it must never be zero: a run that spends its last
 * millisecond generating still dies without a terminal row, which is the exact
 * failure this module exists to prevent.
 */
export const FINALIZE_RESERVE_MS = 45_000;

/**
 * Room after the day loop for the housekeeper translation pass.
 *
 * Was 180s, "generous on purpose" because over-reserving supposedly cost "at
 * most a deferred day" while under-reserving cost the whole pass. Both halves of
 * that stopped being true. Translation is no longer last-chance: it runs on a
 * PARTIAL plan now, her page re-triggers it, the drain finishes it, and
 * `runMealPlanTranslation` takes the generation lock so a later pass cannot race
 * a run — so a skipped end-of-run pass costs a few minutes, not the feature.
 * Meanwhile a deferred day is exactly what a six-person household cannot afford:
 * 180s is a quarter of the day loop's entire budget, and that budget was
 * delivering one day of seven.
 *
 * 60s still lets a run that finishes early translate a day or two on its way
 * out, which is the case worth keeping.
 */
export const TRANSLATION_RESERVE_MS = 60_000;

/**
 * Optional prod override (no deploy needed), matching the `PLAN_DAY_CONCURRENCY`
 * shape in constants.ts. Read at call time, not module load, so tests can set it.
 */
export function planRunBudgetMs(): number {
  const n = Number(process.env.PLAN_RUN_BUDGET_MS?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PLAN_RUN_BUDGET_MS;
}

/**
 * Absolute epoch ms by which the DAY LOOP must be done. `startMs` is the
 * invocation's own start, so a run that already spent time on the skeleton gets
 * a correspondingly smaller day budget rather than a fresh one.
 */
export function dayLoopDeadline(startMs: number, hasTranslation: boolean): number {
  return (
    startMs +
    planRunBudgetMs() -
    FINALIZE_RESERVE_MS -
    (hasTranslation ? TRANSLATION_RESERVE_MS : 0)
  );
}

/** Milliseconds left before `deadlineMs`, floored at 0. Infinity when unset. */
export function remainingMs(deadlineMs: number | undefined, now = Date.now()): number {
  if (deadlineMs == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, deadlineMs - now);
}

/**
 * Whether `estimateMs` more work fits before the deadline.
 *
 * With no deadline this is always true, which is what keeps every existing
 * caller (and every existing test) behaving exactly as it did before.
 */
export function canFit(
  deadlineMs: number | undefined,
  estimateMs: number,
  now = Date.now(),
): boolean {
  if (deadlineMs == null) return true;
  return remainingMs(deadlineMs, now) >= estimateMs;
}

/**
 * What we assume one more day call costs when deciding whether to start it.
 *
 * Deliberately NOT `bigCallTimeoutMs` — that is the worst-case abort bound (up
 * to 10 min), and requiring it would defer days that would comfortably have
 * finished. This is a typical large-day figure taken from the measured runs
 * (days landed at 147s/167s/455s/516s for 4 members), so we start a day when a
 * normal one fits and let the timeout clamp handle the tail.
 */
export const DAY_CALL_ESTIMATE_MS = 150_000;

/**
 * What starting one more day call ACTUALLY costs at this household size — the
 * gate that decides whether to spend tokens on it.
 *
 * `DAY_CALL_ESTIMATE_MS` is a flat 150s taken from 4-member runs, and it is the
 * optimistic end of that measurement (days landed anywhere from 147s to 516s).
 * Used as a start gate it let a 5-member day begin with 205s of budget against
 * work that needs ~450s: measured on production, three days did exactly that,
 * streamed ~25k tokens apiece, and died — about $1.13 of a $3.28 run spent on
 * calls that could never have finished. A day not started costs nothing and
 * lands in `missingDays`, which the drain refills with a fresh budget.
 *
 * Anchored to the call's own ceiling rather than a second hand-tuned curve, and
 * floored at the flat estimate so small households behave exactly as before.
 * Deliberately NOT used for `dayLoopReserveMs`: the reserve answers "how much
 * must phase 1 leave", and making that pessimistic too would starve the skeleton
 * — the same failure pointing the other way.
 */
export function dayCallEstimateMs(perCallCeilingMs: number): number {
  return Math.max(DAY_CALL_ESTIMATE_MS, Math.round(perCallCeilingMs * 0.6));
}

/**
 * What the WHOLE day loop needs, in waves — the reserve phase 1 has to leave.
 *
 * `DAY_CALL_ESTIMATE_MS` is what ONE day costs, and reserving one day was the
 * mistake: it guarantees a single day call could theoretically start, not that
 * a week can be built. Days run `concurrency` at a time, so the loop's real
 * wall-clock is `ceil(days / concurrency)` waves, and phase 1 must leave that
 * much or the household gets a fraction of its week no matter how healthy the
 * run looks.
 *
 * `perDayEstimateMs` must be the SAME figure the day loop's start gate demands
 * (`dayCallEstimateMs` of this household's ceiling) — the two drifting apart is
 * the all-defer inversion: phase 1 dutifully leaves waves × 150s while the gate
 * demands waves × 300s, so every day is refused with the budget technically
 * unspent. The default keeps legacy callers (and the flat small-household case)
 * behaving as before; generate.ts passes the real gate figure.
 */
export function dayLoopReserveMs(
  dayCount: number,
  concurrency: number,
  perDayEstimateMs: number = DAY_CALL_ESTIMATE_MS,
): number {
  const waves = Math.ceil(Math.max(1, dayCount) / Math.max(1, concurrency));
  return waves * Math.max(DAY_CALL_ESTIMATE_MS, perDayEstimateMs);
}

/**
 * A call's timeout, clamped so it cannot outlive the run.
 *
 * The caller must already have checked `canFit(deadlineMs, MIN_VIABLE_CALL_MS)`
 * — this deliberately does NOT floor the result, because flooring is exactly how
 * a call overshoots: given 10s of budget, a 45s floor spends 35s that the
 * finalize reserve was holding. Refusing to start is the caller's job; this only
 * decides how long a call that IS starting may take.
 */
export function boundedCallTimeoutMs(
  ceilingMs: number,
  deadlineMs: number | undefined,
  now = Date.now(),
): number {
  if (deadlineMs == null) return ceilingMs;
  return Math.min(ceilingMs, remainingMs(deadlineMs, now));
}

/**
 * The floor under which starting anything is pointless. A call given less than
 * this cannot produce a parseable day, so spending tokens on it is pure waste.
 */
export const MIN_VIABLE_CALL_MS = 45_000;
