/**
 * A five-person household got ONE day of seven for $2.81.
 *
 * Two causes, both measured on production (plan e8476731, 11.3 min, 178,860
 * output tokens, six days lost to `Anthropic stream timeout after 202876ms`):
 *
 * 1. Phase 1 was allowed to run until 150s remained — a reserve of ONE day call.
 *    That guarantees a single day could start, not that a week can be built. It
 *    also shared `bigCallTimeoutMs` with the day loop, so the skeleton got a
 *    ceiling sized for a day of full recipes, and a ceiling is what a slow call
 *    expands to fill.
 * 2. Every timed-out call was discarded whole, including the ~25k tokens it had
 *    already written.
 */
import { describe, it, expect } from "vitest";
import {
  DAY_CALL_ESTIMATE_MS,
  dayCallEstimateMs,
  TRANSLATION_RESERVE_MS,
  FINALIZE_RESERVE_MS,
  dayLoopReserveMs,
  dayLoopDeadline,
  planRunBudgetMs,
  boundedCallTimeoutMs,
  MIN_VIABLE_CALL_MS,
} from "./budget";
import {
  bigCallTimeoutMs,
  skeletonTimeoutMs,
  dayConcurrency,
  TRANSLATE_CALL_TIMEOUT_MS,
  PLAN_WEEK_DAYS,
} from "./constants";
import { salvageTruncatedJson } from "./anthropic";
import { rescueDaySlice } from "./generate";
import type { PlanSkeleton } from "./schema";

describe("phase 1 must leave the day LOOP room, not one day call", () => {
  it("reserves a wave per batch of days, not a single call", () => {
    // 7 days at concurrency 5 is two waves; reserving one call was the bug.
    expect(dayLoopReserveMs(7, 5)).toBe(2 * DAY_CALL_ESTIMATE_MS);
    expect(dayLoopReserveMs(7, 5)).toBeGreaterThan(DAY_CALL_ESTIMATE_MS);
  });

  it("reserves more when the days cannot run in parallel", () => {
    // A small family runs sequentially — seven waves, not one.
    expect(dayLoopReserveMs(7, 1)).toBe(7 * DAY_CALL_ESTIMATE_MS);
  });

  it("never reserves nothing", () => {
    expect(dayLoopReserveMs(0, 5)).toBeGreaterThan(0);
    expect(dayLoopReserveMs(7, 0)).toBeGreaterThan(0);
  });
});

describe("the skeleton's ceiling tracks the skeleton's own work", () => {
  it("is far below the day-call ceiling at every household size", () => {
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(skeletonTimeoutMs(n), `n=${n}`).toBeLessThan(
        bigCallTimeoutMs(n),
      );
    }
  });

  it("at five members the day loop can now fit a full wave; before, it could not", () => {
    // The measured failure: a housekeeper household of five. This asserts the
    // actual before/after, so the numbers cannot drift back without failing.
    const members = 5;
    const perWave = bigCallTimeoutMs(members); // one wave of real day work at ceiling

    // BEFORE: 180s translation reserve, a ceiling shared with the day loop, and
    // a reserve of one day call.
    const oldDeadline = planRunBudgetMs() - FINALIZE_RESERVE_MS - 180_000;
    const oldSkeleton = Math.min(
      bigCallTimeoutMs(members),
      oldDeadline - DAY_CALL_ESTIMATE_MS,
    );
    expect(oldDeadline - oldSkeleton).toBeLessThan(perWave); // ← one day, $2.81

    // AFTER.
    const deadline = dayLoopDeadline(0, true);
    const skeleton = Math.min(
      skeletonTimeoutMs(members),
      deadline - dayLoopReserveMs(PLAN_WEEK_DAYS, dayConcurrency(members, true)),
    );
    expect(deadline - skeleton).toBeGreaterThan(perWave);
  });

  it("still gives a solo household a workable phase 1", () => {
    expect(skeletonTimeoutMs(1)).toBeGreaterThan(120_000);
  });
});

describe("small households can actually finish a week", () => {
  // The sequential 1→7 fill was a UX nicety that broke the product's own
  // arithmetic: at concurrency 1 the week needs 7 waves, and from 3 members up
  // (2 with a housekeeper) those waves exceed the day-loop deadline — the
  // budget table said m=3 typically shipped 4-6 of 7 days, forever, with the
  // drain re-invoking one member at a time. The fill is now 2/3/4-wide.
  it("gives 1-3 member households enough concurrency for the week to fit the gates", () => {
    for (const m of [1, 2, 3] as const) {
      const conc = dayConcurrency(m, true);
      expect(conc, `m=${m}`).toBe(m + 1);
      const waves = Math.ceil(PLAN_WEEK_DAYS / conc);
      const gate = dayCallEstimateMs(bigCallTimeoutMs(m));
      // Worst deadline (translation reserve on) minus the small-household
      // skeleton floor must hold every wave at the gate's own estimate — this
      // is the arithmetic the old concurrency-1 fill failed.
      const deadline = dayLoopDeadline(0, true) - MIN_VIABLE_CALL_MS;
      expect(waves * gate, `m=${m}`).toBeLessThanOrEqual(deadline);
    }
  });

  it("the old sequential fill provably could not fit — the cliff this replaces", () => {
    const gate = dayCallEstimateMs(bigCallTimeoutMs(3));
    expect(PLAN_WEEK_DAYS * gate).toBeGreaterThan(dayLoopDeadline(0, true));
  });
});

describe("the translation reserve stopped costing a quarter of the day loop", () => {
  it("is smaller than the day loop's own reserve", () => {
    // 180s of an 11-minute budget bought a pass that now self-heals through the
    // drain and the maid's page; a deferred day is what a six-person household
    // cannot afford.
    expect(TRANSLATION_RESERVE_MS).toBeLessThan(dayLoopReserveMs(7, 5));
  });

  it("leaves the day loop meaningfully more than before", () => {
    const before = planRunBudgetMs() - FINALIZE_RESERVE_MS - 180_000;
    const after = dayLoopDeadline(0, true);
    expect(after - before).toBe(120_000);
  });
});

describe("a day is not started unless it can plausibly finish", () => {
  it("scales the start gate with the household, not a flat 4-member figure", () => {
    // Measured: three 5-member days began with ~205s against ~450s of work and
    // died having streamed ~25k tokens each — about $1.13 of a $3.28 run.
    const gate5 = dayCallEstimateMs(bigCallTimeoutMs(5));
    expect(gate5).toBeGreaterThan(205_000);
    expect(DAY_CALL_ESTIMATE_MS).toBeLessThan(205_000); // …the old gate let them in
  });

  it("never demands the full worst-case ceiling, which would defer good days", () => {
    for (const n of [2, 4, 5, 6]) {
      expect(dayCallEstimateMs(bigCallTimeoutMs(n)), `n=${n}`).toBeLessThan(
        bigCallTimeoutMs(n),
      );
    }
  });

  it("leaves a small household exactly as it was", () => {
    // 1-2 members: 0.6 × 240s is below the flat floor, so nothing changes.
    expect(dayCallEstimateMs(bigCallTimeoutMs(1))).toBe(DAY_CALL_ESTIMATE_MS);
    expect(dayCallEstimateMs(bigCallTimeoutMs(2))).toBe(DAY_CALL_ESTIMATE_MS);
  });

  it("does not make the phase-1 reserve pessimistic too", () => {
    // The reserve answers a different question — how much phase 1 must LEAVE —
    // and inflating it would starve the skeleton, the same bug reversed.
    expect(dayLoopReserveMs(7, 5)).toBe(2 * DAY_CALL_ESTIMATE_MS);
  });
});

// ── Salvage ───────────────────────────────────────────────────────────────

describe("salvageTruncatedJson keeps what finished", () => {
  it("closes a payload cut off mid-element", () => {
    const cut = '{"day_index":0,"members":[{"member_id":"mom","meals":[1,2]},{"member_id":"dad","me';
    expect(JSON.parse(salvageTruncatedJson(cut)!)).toEqual({
      day_index: 0,
      members: [{ member_id: "mom", meals: [1, 2] }],
    });
  });

  it("is not fooled by braces inside a string", () => {
    const cut = '{"a":[{"name":"كبسة {مع} أرز"},{"name":"جري';
    expect(JSON.parse(salvageTruncatedJson(cut)!)).toEqual({
      a: [{ name: "كبسة {مع} أرز" }],
    });
  });

  it("handles an escaped quote before the cut", () => {
    const cut = '{"a":[{"n":"say \\"hi\\""},{"n":"unfinis';
    expect(JSON.parse(salvageTruncatedJson(cut)!)).toEqual({ a: [{ n: 'say "hi"' }] });
  });

  it("returns null when nothing whole made it out", () => {
    expect(salvageTruncatedJson('{"day_index":0,"members":[{"member_id":"mo')).toBeNull();
    expect(salvageTruncatedJson("no json at all")).toBeNull();
    expect(salvageTruncatedJson("")).toBeNull();
  });
});

// ── Rescue: only members the skeleton says are COMPLETE ────────────────────

function skeletonWith(counts: Record<string, number>): PlanSkeleton {
  return {
    members: Object.entries(counts).map(([id, n]) => ({
      member_id: id,
      member_name_ar: id,
      primary_goal: "fat_loss" as const,
      daily_calories_target: 1800,
      macros_target: { protein_g: 120, carbs_g: 150, fat_g: 60 },
      days: [
        {
          day_index: 0,
          day_name_ar: "السبت",
          meals: Array.from({ length: n }, (_, i) => ({
            slot: "lunch" as const,
            slot_name_ar: "غداء",
            recipe_name_ar: `دجاج ${i}`,
          })),
        },
      ],
    })),
    methodology_notes_ar: "ملاحظات",
    safety_disclaimer_ar: "تنبيه",
  };
}

const meal = (name: string) => ({
  slot: "lunch",
  slot_name_ar: "غداء",
  recipe_name_ar: name,
  ingredients: [{ name_ar: "دجاج", amount: 200, unit: "g" }],
  prep_steps_ar: ["اطبخي"],
  calories: 600,
  macros: { protein_g: 40, carbs_g: 50, fat_g: 20 },
});

/** A stream that wrote mom's two meals in full and died inside dad's. */
function truncatedStream() {
  const full = JSON.stringify({
    day_index: 0,
    members: [
      { member_id: "mom", meals: [meal("أ"), meal("ب")] },
      { member_id: "dad", meals: [meal("ج"), meal("د")] },
    ],
  });
  return full.slice(0, full.indexOf('"د"') + 2);
}

/**
 * The shape that actually killed the rescue in production: the stream died deep
 * inside a half-written meal, not neatly between members. The first version cut
 * after the last bracket that closed while merely nested — an INGREDIENT object
 * — producing a meal with no steps, calories or macros, which failed the schema
 * and took the whole rescue down with it.
 */
function truncatedMidMeal() {
  const full = JSON.stringify({
    day_index: 0,
    members: [
      { member_id: "mom", meals: [meal("أ"), meal("ب")] },
      { member_id: "dad", meals: [meal("ج"), meal("د")] },
    ],
  });
  // Cut just after dad's FIRST ingredient object closes — mid-meal, mid-member.
  const dadAt = full.indexOf('"dad"');
  const ingClose = full.indexOf("}", full.indexOf('"name_ar":"دجاج"', dadAt));
  return full.slice(0, ingClose + 1);
}

describe("rescueDaySlice", () => {
  it("recovers the finished member when the cut lands INSIDE a later meal", () => {
    const out = rescueDaySlice(truncatedMidMeal(), skeletonWith({ mom: 2, dad: 2 }), 0);
    expect(out).not.toBeNull();
    expect(out!.members.map((m) => m.member_id)).toEqual(["mom"]);
    expect(out!.members[0]!.meals).toHaveLength(2);
  });

  it("keeps a member the skeleton says is complete", () => {
    const out = rescueDaySlice(truncatedStream(), skeletonWith({ mom: 2, dad: 2 }), 0);
    expect(out!.members.map((m) => m.member_id)).toEqual(["mom"]);
    expect(out!.members[0]!.meals).toHaveLength(2);
  });

  it("DROPS a member cut off mid-day rather than feed a short day to the rescale", () => {
    // The safety argument: two of four meals scaled up to a full day's target
    // is an absurd portion. Dropping means the drain refills that day — which
    // is what would have happened to every member anyway.
    const out = rescueDaySlice(truncatedStream(), skeletonWith({ mom: 4, dad: 4 }), 0);
    expect(out).toBeNull();
  });

  it("drops a member the skeleton never planned that day", () => {
    const out = rescueDaySlice(truncatedStream(), skeletonWith({ dad: 2 }), 0);
    expect(out).toBeNull();
  });

  it("returns null on a stream that wrote nothing usable", () => {
    expect(rescueDaySlice('{"day_index":0,"members":[{"mem', skeletonWith({ mom: 2 }), 0))
      .toBeNull();
    expect(rescueDaySlice("", skeletonWith({ mom: 2 }), 0)).toBeNull();
  });
});

/**
 * The regression the smaller translation reserve created.
 *
 * Cutting TRANSLATION_RESERVE_MS from 180s to 60s was right for the day loop,
 * but the end-of-run translation was only ever gated on having MIN_VIABLE_CALL_MS
 * (45s) to START — after which it ran a sequential member × day loop of
 * 240s-default calls with no bound at all. With 180s of slack that was survivable;
 * with 60s it is not. Measured: a run at 1001s against a 900s budget, still
 * 'started', one day written, the plan's last write three minutes earlier — the
 * function hard-killed before its terminal write, which leaves plan_generations
 * stuck 'started' and, under 00014's per-kind unique index, blocks EVERY future
 * meal generation for that user until the staleness sweep clears it.
 */
describe("the translation pass cannot outlive the invocation", () => {
  it("has a per-call ceiling far below a day call's", () => {
    expect(TRANSLATE_CALL_TIMEOUT_MS).toBeLessThan(bigCallTimeoutMs(5));
  });

  it("never lets a call run past the deadline, however little is left", () => {
    const now = 1_000_000;
    // Plenty of budget → the ceiling applies.
    expect(boundedCallTimeoutMs(TRANSLATE_CALL_TIMEOUT_MS, now + 600_000, now)).toBe(
      TRANSLATE_CALL_TIMEOUT_MS,
    );
    // Little budget → the budget applies, and nothing floors it back up. A floor
    // is exactly how the overrun happened: given 10s, a 45s floor spends 35s the
    // finalize reserve was holding.
    expect(boundedCallTimeoutMs(TRANSLATE_CALL_TIMEOUT_MS, now + 10_000, now)).toBe(10_000);
    expect(boundedCallTimeoutMs(TRANSLATE_CALL_TIMEOUT_MS, now - 5_000, now)).toBe(0);
  });

  it("is unbounded only for a caller that owns its whole invocation", () => {
    expect(boundedCallTimeoutMs(TRANSLATE_CALL_TIMEOUT_MS, undefined)).toBe(
      TRANSLATE_CALL_TIMEOUT_MS,
    );
  });

  it("leaves room to write the terminal row after the last call", () => {
    // Whatever translation spends, FINALIZE_RESERVE_MS is still outside the
    // deadline it is handed (hardDeadlineMs = budget - FINALIZE_RESERVE_MS).
    expect(planRunBudgetMs() - FINALIZE_RESERVE_MS).toBeLessThan(planRunBudgetMs());
    expect(FINALIZE_RESERVE_MS).toBeGreaterThan(0);
  });
});

/**
 * Fixing only the FIRST gate left the retries on a 45s floor.
 *
 * The start gate refuses a 5-member day below 270s — but a re-roll after a
 * transient failure was gated on `wait + MIN_VIABLE_CALL_MS`, so it could begin
 * with about fifty seconds against 450s of work. Measured: four days died at
 * `Anthropic stream timeout after 75446ms`, roughly $2 of a $3.32 run, all of it
 * spent by retries the start gate had already refused once.
 */
describe("a RETRY is held to the same bar as a first attempt", () => {
  it("costs the same scaled figure, not the bare viable floor", () => {
    const cost = dayCallEstimateMs(bigCallTimeoutMs(5));
    // The gates now add `cost`; they used to add MIN_VIABLE_CALL_MS (45s) or a
    // flat 150s, either of which admits the 75-second call that was observed.
    expect(cost).toBeGreaterThan(75_446);
    expect(MIN_VIABLE_CALL_MS).toBeLessThan(75_446);
    expect(DAY_CALL_ESTIMATE_MS).toBeGreaterThan(75_446);
  });

  it("still lets a small household retry freely", () => {
    // Two members: the scaled cost is the flat floor, so nothing tightened.
    expect(dayCallEstimateMs(bigCallTimeoutMs(2))).toBe(DAY_CALL_ESTIMATE_MS);
  });
});
