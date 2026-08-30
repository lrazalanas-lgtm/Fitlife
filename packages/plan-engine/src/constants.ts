/**
 * Anthropic / plan-generation constants.
 *
 * Verify pricing at https://docs.claude.com/en/docs/about-claude/pricing
 * before launch. Locked here as $15/M input, $75/M output for claude-opus-4-7
 * as of 2026-05.
 */

// Defaults to Opus 4.7. Override with the PLAN_MODEL env var (e.g.
// claude-sonnet-4-6 or claude-haiku-4-5-20251001) to test with a faster/cheaper
// model — no code change needed; remove the env var to go back to Opus.
export const PLAN_MODEL = process.env.PLAN_MODEL?.trim() || "claude-opus-4-7";

// ── Tiered (per-phase) models ────────────────────────────────────────────
// Generation has three phases with very different stakes:
//   • Skeleton  — decides each member's calorie/macro TARGETS and plans the week.
//                 For pregnancy/lactation/children/medical conditions this is real
//                 reasoning + a safety surface, and it's tiny in output tokens, so
//                 it stays on the strongest model (PLAN_MODEL).
//   • Day       — expands named dishes into recipes that hit the targets. ~95% of
//                 output tokens but mechanical given names+targets → cheaper/faster
//                 model is the big cost/latency win.
//   • Translate — purely mechanical (Arabic → housekeeper language) → cheapest model.
// Each is independently overridable by env so prod can roll out / revert per phase
// without a code change. Set e.g. PLAN_DAY_MODEL=claude-haiku-4-5-20251001 to drop
// the day phase back to Haiku (cheaper, but it reproducibly fails some member-days).
// Defaults below: skeleton inherits PLAN_MODEL (Opus); the day phase runs on Sonnet
// (strong enough that per-day failures effectively disappear); translate on Haiku.
const HAIKU = "claude-haiku-4-5-20251001";
export const SKELETON_MODEL = process.env.PLAN_SKELETON_MODEL?.trim() || PLAN_MODEL;
export const DAY_MODEL = process.env.PLAN_DAY_MODEL?.trim() || "claude-sonnet-4-6";
export const TRANSLATE_MODEL = process.env.PLAN_TRANSLATE_MODEL?.trim() || HAIKU;

/**
 * Human-readable label for the model(s) a generation used, recorded in the audit
 * rows (plan_generations.model, meal_plans.ai_model). When the skeleton and day
 * phases use the same model it's just that id; otherwise a composite like
 * "claude-sonnet-4-6+claude-haiku-4-5-20251001" so the audit reflects the tiered
 * split. NOTE: this is a display/audit label only — cost_usd is computed per-call
 * from each phase's actual model, never from this string.
 */
export function planModelLabel(): string {
  return SKELETON_MODEL === DAY_MODEL
    ? DAY_MODEL
    : `${SKELETON_MODEL}+${DAY_MODEL}`;
}

// USD per million tokens, keyed by model id. cost_usd in plan_generations is an
// internal audit figure (NOT the SAR price charged to users — that lives in
// packages/config). Verify rates at https://docs.claude.com/en/docs/about-claude/pricing
// before launch. Unknown models fall back to Opus rates (conservative: never
// under-report spend).
export const PRICING_USD_PER_MTOK_BY_MODEL: Record<
  string,
  { input: number; output: number }
> = {
  // Verified against docs.claude.com pricing 08/2026. Opus 4.7 was CUT to
  // $5/$25 after the 2026-05 figure this table originally locked ($15/$75) —
  // a stale row here silently over-reports audit cost 3x for any run pointed
  // at it, which is how the fallback below misled too.
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

// Deliberately above every real rate so an unknown id can never UNDER-report
// spend — but a run priced by this row is mis-audited by up to ~7.5x, so an
// unknown id is a loud misconfiguration, not a quiet fallback. Callers that
// configure models from env should check isKnownPricingModel and warn.
const FALLBACK_PRICING = { input: 15, output: 75 } as const;

export function pricingForModel(model: string): {
  input: number;
  output: number;
} {
  return PRICING_USD_PER_MTOK_BY_MODEL[model] ?? FALLBACK_PRICING;
}

/**
 * Whether cost accounting has a real rate for this model id. False means every
 * cost_usd written for the run is the conservative fallback (over-reported up
 * to ~7.5x) — the background function warns at invocation so an env-pointed
 * model id outside this table cannot silently corrupt the spend gauges the
 * pricing decisions are read from.
 */
export function isKnownPricingModel(model: string): boolean {
  return model in PRICING_USD_PER_MTOK_BY_MODEL;
}

/**
 * Output-token ceiling for the WHOLE family's weekly plan (single call).
 * A full 7-day plan with rich 8-field recipes can exceed 16k even for a solo
 * member, and multi-member plans definitely do — truncation (stop_reason=
 * max_tokens) was failing generations, so this is 32000. Bump further only if a
 * very large household still truncates.
 */
export const PLAN_MAX_TOKENS = 32000;

// Parallel-by-day generation caps. Phase 1 (skeleton) is names + targets only,
// but it scales with members-in-scope (a fresh full-family run skeletons every
// member, and verbose cases like a child's food-pyramid notes inflate output),
// so 16000 is the FLOOR for small families — generate.ts also retries once at 2x
// if it still truncates. Phase 2 expands one day at a time, in parallel, so
// wall-clock ≈ one day regardless of week/family size.
// DAY_CONCURRENCY caps simultaneous calls to stay under Anthropic rate limits
// (with retry/backoff on 429).
//
// IMPORTANT: SKELETON_MAX_TOKENS / DAY_MAX_TOKENS are FLOORS, not the values
// actually sent. The caps a call uses scale with the members in scope (see the
// helpers below) — a fixed cap truncated large families (a full family-tier run
// is up to 6 people, and independent meal_mode gives each their own recipes), and
// a truncated skeleton fails the WHOLE generation. Raising max_tokens is free
// unless the model actually emits more — it's a ceiling, billed per real token.
export const SKELETON_MAX_TOKENS = 16000;
export const DAY_MAX_TOKENS = 12000;
// Sequential (one day at a time, in order): the plan opens showing all 7 days
// as "loading" and they fill in 1→7. Higher values parallelize (faster total).
// This is the FLOOR concurrency (small families); dayConcurrency() raises it for
// large families so 7 sequential big calls don't blow the 15-min function budget.
export const DAY_CONCURRENCY = 1;

// Hard per-request output ceiling for the plan model. 32000 is already proven safe
// (it was PLAN_MAX_TOKENS, the whole-plan single-call cap). All scaled caps below
// clamp to this so we never request more than the model allows.
export const MAX_OUTPUT_TOKENS = 32000;

/**
 * Skeleton output cap scaled to the members in scope. The skeleton emits, per
 * member, their targets + a full week of dish NAMES (7 days × ~4 slots), so it
 * grows roughly linearly. 6 members → 6000 + 3000·6 = 24000 (vs the old fixed
 * 16000 that truncated and hard-failed the run). Solo stays at the 16000 floor.
 */
export function skeletonMaxTokens(memberCount: number): number {
  return Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(SKELETON_MAX_TOKENS, 6000 + 3000 * Math.max(1, memberCount)),
  );
}

/**
 * One day's expansion cap scaled to the members missing that day. Each member's
 * day is up to 4 terse-keyed recipes (their OWN portion only — code builds the
 * shared batch). Translation does NOT inflate this call: it left the day prompt
 * on 07-24 and runs as the separate Haiku pass.
 *
 * 5800/member puts the cap ABOVE every emission mode ever measured — compact
 * ~10k, pretty ~17.5k, canonical-key disobedience 19-21k, and the 08/30
 * calibration run's ≥26k. The previous 3400/member (20k at 5 members) sat
 * INSIDE that band under a comment claiming it sat above it: every day call
 * truncated at the cap, billed in full, then burned a doomed doubled-cap retry
 * — $4.16 for zero days. A cap bills only real tokens, so generosity is free;
 * what it must never be is a value an honest emission can reach. Tighten only
 * after structured outputs prove compact emission across several runs.
 */
export function dayMaxTokens(memberCount: number): number {
  const perMember = 5800;
  return Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(DAY_MAX_TOKENS, 3000 + perMember * Math.max(1, memberCount)),
  );
}

/**
 * Wall-clock cap for ONE day/skeleton call, derived from the CAP rather than
 * hand-tuned per member: the time a full-cap emission needs at the worst
 * measured stream rate (65 tok/s) plus time-to-first-token. Deriving it keeps
 * cap and ceiling consistent by construction — the 08/30 failure was the pair
 * drifting apart (a 360s ceiling under a cap whose honest emission needs ~400s,
 * so the doubled-cap retry was doomed before it started). At 5 members:
 * 32,000/65 + 20s ≈ 512s. A ceiling is an ABORT bound, not a target — typical
 * calls finish far under it, and boundedCallTimeoutMs still clamps every call
 * to the run's remaining budget.
 */
export function bigCallTimeoutMs(memberCount: number): number {
  return Math.min(
    600_000,
    Math.round((dayMaxTokens(memberCount) / 65) * 1000) + 20_000,
  );
}

/**
 * Wall-clock cap for the SKELETON call specifically.
 *
 * Phase 1 and phase 2 do very different amounts of writing, and sharing
 * `bigCallTimeoutMs` gave the skeleton a ceiling sized for a day of full
 * recipes. A ceiling is what a slow call expands to fill: measured on a
 * 5-beneficiary household, the run spent most of an 11-minute day-loop budget
 * before the first day call started, and six of seven days then died at a
 * ~200s clamp against work that needs ~450s. One usable day for $2.81.
 *
 * The skeleton emits per member a target block and a week of dish NAMES —
 * roughly 4k tokens at five members, against the 25k a day of recipes runs to.
 * `skeletonMaxTokens` is deliberately generous (a truncated skeleton fails the
 * whole run), but the TIMEOUT should track the work, not the cap.
 */
/** Days in a generated plan week — the skeleton prompt asks for exactly this. */
export const PLAN_WEEK_DAYS = 7;

/**
 * Ceiling for ONE translation call (a member's name, or a day's meals). The
 * pass is many small sequential calls, so this is nothing like a day-expansion
 * budget — it exists so a stalled stream cannot hold the loop open.
 */
export const TRANSLATE_CALL_TIMEOUT_MS = 120_000;

export function skeletonTimeoutMs(memberCount: number): number {
  return Math.min(360_000, 120_000 + 30_000 * Math.max(1, memberCount));
}

/**
 * Day-loop concurrency scaled to the workload. Small families keep the calm
 * ordered 1→7 fill (DAY_CONCURRENCY). Large families make each day's call big and
 * slow; running 7 strictly in sequence would exceed the 15-min function budget,
 * so we parallelize enough to keep total wall-clock ≈ one or two waves. Bounded so
 * we don't fan out an unreasonable number of concurrent heavy calls at once.
 */
// Optional prod override for the large-family parallel day-call cap (no deploy
// needed). Falls back to the tuned defaults below. The ≤3-member sequential
// behavior is unaffected.
const DAY_CONCURRENCY_OVERRIDE = (() => {
  const n = Number(process.env.PLAN_DAY_CONCURRENCY?.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
})();

export function dayConcurrency(memberCount: number, hasTranslation: boolean): number {
  if (memberCount <= 3) {
    // The calm sequential 1→7 fill was a UX nicety small households could not
    // actually afford: 7 sequential day calls exceed the run budget from 3
    // members up (and from 2 with a housekeeper) — the budget table in
    // dayBudget.test.ts is the arithmetic. 2/3/4 keeps the fill mostly ordered
    // while making the week fit with re-roll headroom.
    return DAY_CONCURRENCY_OVERRIDE ?? Math.max(DAY_CONCURRENCY, memberCount + 1);
  }
  // Cap the parallel burst so it stays under the day-model rate limit — 7
  // simultaneous large calls reliably tripped 429s (measured on Haiku; untested
  // on Sonnet). Override via PLAN_DAY_CONCURRENCY.
  return DAY_CONCURRENCY_OVERRIDE ?? (hasTranslation ? 5 : 4);
}

// Translation (maid/housekeeper) is a separate pass over already-generated meals.
// Strictly sequential (one day at a time, today-first): day 1's recipes fully
// translate and appear, THEN day 2, etc. — never several days landing at once.
// (Parallelizing was faster overall but made the recipes pop in unpredictable
// batches, which read as broken; sequential is the intended UX.)
export const TRANSLATE_CONCURRENCY = 1;

// One-at-a-time member adds: the drain re-runs an incomplete member (a day that
// failed after in-run retries) until it's whole BEFORE starting the next member.
// This caps those completion-retries per member so a deterministically-failing
// day can't block the household forever — after the cap the day shows
// "failed — regenerate" and the drain advances. Counts total runs targeting the
// member (initial attempt + retries).
export const MEMBER_GEN_MAX_ATTEMPTS = 3;
