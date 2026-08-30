import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Same shape as generate.test.ts: only the network layer is faked, so the code
// under test parses our mocked SSE exactly as it would a real response.
vi.mock("./anthropic", async () => {
  const actual = await vi.importActual<typeof import("./anthropic")>("./anthropic");
  return { ...actual, streamAnthropic: vi.fn() };
});

import { streamAnthropic } from "./anthropic";
import { generateMealPlan, BUDGET_DEFERRED_CAUSE } from "./generate";
import type { PlanPromptContext } from "./buildContext";
import type { DaySlice, Meal, PlanSkeleton } from "./schema";
import { DaySliceSchema, PlanSkeletonSchema } from "./schema";

const mockedStream = vi.mocked(streamAnthropic);

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const TARGET_KCAL = 1600;

/**
 * A virtual clock. The engine measures the budget with Date.now(), so advancing
 * it inside the mocked model call simulates a slow generation without any real
 * waiting — and lets a test assert the run stopped INSIDE its deadline.
 */
let virtualNow = 0;
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

function startClock() {
  virtualNow = Date.parse("2026-07-27T09:00:00.000Z");
  // Only Date.now is intercepted; `new Date()` (used for the week anchor) keeps
  // its real behavior, so day naming and week math are untouched.
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => virtualNow);
  return virtualNow;
}

function makeMeal(recipeName: string, calories = TARGET_KCAL): Meal {
  const scale = calories / TARGET_KCAL;
  return {
    slot: "breakfast",
    slot_name_ar: "الفطور",
    recipe_name_ar: recipeName,
    ingredients: [{ name_ar: "بيض", amount: 2, unit: "piece" }],
    prep_steps_ar: ["اخفقي البيض", "اطبخيه"],
    calories,
    macros: {
      protein_g: Math.round(100 * scale),
      carbs_g: Math.round(140 * scale),
      fat_g: Math.round(55 * scale),
    },
  };
}

function makeContext(): PlanPromptContext {
  return {
    mom: {
      id: "user-1",
      display_name: "أم محمد",
      sex: "female",
      member_type: "adult",
      age: 35,
      height_cm: 165,
      weight_kg: 70,
      activity_level: "moderate",
      primary_goal: "fat_loss",
      dietary_restrictions: [],
      cuisine_preference: "khaleeji",
      medical_conditions: [],
      allergies: [],
      dislikes: [],
      is_pregnant: false,
      pregnancy_trimester: null,
      months_postpartum: null,
      high_risk_pregnancy: false,
      consulted_doctor: false,
      meal_mode: "shared",
      target_weight_kg: null,
      day_nature: null,
      exercise_days: null,
      exercise_type: null,
      water_cups: null,
      water_liters: null,
      sleep_hours: null,
      medications: [],
      supplements: [],
      nausea_foods: [],
      notes: null,
    },
    family_members: [],
    family_wide: {
      dietary_restrictions: [],
      dislikes: [],
      cooking_methods: [],
      meal_out_frequency: null,
    },
    composition_summary: "امرأة بمفردها",
  };
}

/**
 * Scripted model. Advances the virtual clock by the configured per-phase cost so
 * the budget actually drains, and emits valid content for whichever phase the
 * prompt describes.
 */
function scriptModel(opts: {
  skeletonMs: number;
  dayMs: number;
  dayCalories?: number;
  days?: number[];
  /**
   * Days whose call throws a deterministic (non-retryable, non-transient) error,
   * standing in for a real defect. The clock still advances — a failing call
   * costs wall time exactly like a successful one.
   */
  throwOnDays?: number[];
}) {
  const days = opts.days ?? DAYS;
  const throwOn = new Set(opts.throwOnDays ?? []);
  mockedStream.mockImplementation(async (args: { systemPrompt: string }) => {
    const systemPrompt = args.systemPrompt;
    const ids = [...systemPrompt.matchAll(/member_id="([^"]+)"/g)].map((m) => m[1]!);
    const memberIds = ids.length > 0 ? ids : ["mom"];
    const dayMatch = systemPrompt.match(/day_index=(\d+)/);

    let text: string;
    if (!dayMatch) {
      virtualNow += opts.skeletonMs;
      const skeleton: PlanSkeleton = {
        members: memberIds.map((id) => ({
          member_id: id,
          member_name_ar: id,
          primary_goal: "fat_loss",
          daily_calories_target: TARGET_KCAL,
          macros_target: { protein_g: 100, carbs_g: 140, fat_g: 55 },
          days: days.map((di) => ({
            day_index: di,
            day_name_ar: `اليوم ${di + 1}`,
            meals: [
              { slot: "breakfast", slot_name_ar: "الفطور", recipe_name_ar: `${id}-${di}` },
            ],
          })),
        })),
        methodology_notes_ar: "ملاحظات",
        safety_disclaimer_ar: "تنبيه",
      };
      PlanSkeletonSchema.parse(skeleton);
      text = JSON.stringify(skeleton);
    } else {
      virtualNow += opts.dayMs;
      const dayIndex = Number(dayMatch[1]);
      // A TypeError is deterministic: the engine fails the day fast rather than
      // retrying or re-rolling, which is what makes it a clean stand-in here.
      if (throwOn.has(dayIndex)) throw new TypeError("boom");
      const slice: DaySlice = {
        day_index: dayIndex,
        members: memberIds.map((id) => ({
          member_id: id,
          meals: [makeMeal(`${id}-${dayIndex}`, opts.dayCalories ?? TARGET_KCAL)],
        })),
      };
      DaySliceSchema.parse(slice);
      text = JSON.stringify(slice);
    }
    return { text, tokensIn: 10, tokensOut: 20, stopReason: null };
  });
}

const dayCallCount = () =>
  mockedStream.mock.calls.filter((c) => /day_index=\d+/.test(c[0]!.systemPrompt)).length;

beforeEach(() => {
  mockedStream.mockReset();
});
afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
});

describe("run deadline — days are deferred, never started into a hard kill", () => {
  it("stops starting days once the budget cannot fit another, and finishes inside it", async () => {
    const t0 = startClock();
    scriptModel({ skeletonMs: 50_000, dayMs: 100_000 });

    // 50s skeleton + 100s/day. Phase 1 needs its 0.6x window ABOVE the solo
    // day-loop reserve (4 waves x 150s = 600s), so the budget must clear ~690s
    // for the run to start at all; at 700s the day gate (150s) then refuses
    // whichever day would begin past t=550 — one day deferred, never killed.
    const deadlineMs = t0 + 700_000;
    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      deadlineMs,
    });

    expect(dayCallCount()).toBe(6);
    expect(res.missingDays).toHaveLength(1);
    // The run ended INSIDE its box. This is the whole point: the old code sailed
    // past the function budget and was killed with no terminal write at all.
    expect(virtualNow).toBeLessThanOrEqual(deadlineMs);

    // What it hands back is a real, usable partial week.
    const mom = res.plan.members.find((m) => m.member_id === "mom")!;
    expect(mom.days.filter((d) => d.meals.length > 0)).toHaveLength(6);
    expect(res.plan.generating).toBe(false);
  });

  it("names the budget as the cause, distinctly from a model or API failure", async () => {
    const t0 = startClock();
    scriptModel({ skeletonMs: 50_000, dayMs: 100_000 });

    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      deadlineMs: t0 + 700_000,
    });

    // Histogram class + the run's call census: a deferral is visibly "no model
    // call", and the census says how many calls the run DID make.
    expect(res.missingDaysCause).toMatch(/1x deferred \(no model call\)/);
    expect(res.missingDaysCause).toMatch(/\[\d+ model calls\]/);
  });

  it("generates the whole week when no deadline is given — unchanged behavior", async () => {
    startClock();
    scriptModel({ skeletonMs: 50_000, dayMs: 100_000 });

    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
    });

    expect(dayCallCount()).toBe(7);
    expect(res.missingDays).toEqual([]);
  });

  it("never spends a model call re-attempting a day the budget already refused", async () => {
    const t0 = startClock();
    scriptModel({ skeletonMs: 50_000, dayMs: 100_000 });

    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      deadlineMs: t0 + 700_000,
    });

    // 6 real day calls and nothing more — including across the second-chance
    // wave, which must not turn a budget stop into another round of spending.
    expect(dayCallCount()).toBe(6);
    // And the deferred days are reported exactly once each: not lost, not doubled.
    expect(res.missingDays).toEqual([...new Set(res.missingDays)]);
    expect(res.missingDays).toHaveLength(1);
  });

  it("keeps the real failure as the reported cause instead of drowning it in budget notices", async () => {
    const t0 = startClock();
    // Three days fail for a REAL reason, three succeed, one is budget-deferred.
    scriptModel({ skeletonMs: 10_000, dayMs: 100_000, throwOnDays: [0, 1, 2] });

    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      deadlineMs: t0 + 750_000,
    });

    expect(res.missingDays).toEqual([0, 1, 2, 6]);
    // The histogram counts CLASSES, so the real defect leads and the single
    // deferral cannot outvote it — the 08/30 failure mode, where unique per-day
    // strings let two free deferrals outvote five paid deaths.
    expect(res.missingDaysCause).toMatch(/^3x boom/);
    expect(res.missingDaysCause).toContain("1x deferred (no model call)");
    expect(res.missingDaysCause).not.toContain("run budget spent");
  });

  it("refuses phase 1 outright when the budget cannot hold skeleton + day loop — before any model call", async () => {
    const t0 = startClock();
    scriptModel({ skeletonMs: 400_000, dayMs: 100_000 });

    // The old behavior here was "run the skeleton anyway, then defer all 7
    // days" — paid tokens for a plan that could never happen. Phase 1 now has
    // a hard deadline (run deadline minus the day loop's reserve) and refuses
    // to START an attempt with under 0.6x the skeleton ceiling of room: a
    // doomed call is worse than no call, and $0 beats the 08/30 run's $4.16.
    await expect(
      generateMealPlan({
        anthropicApiKey: "k",
        context: makeContext(),
        deadlineMs: t0 + 450_000,
      }),
    ).rejects.toThrow(/Phase 1 refused/);
    expect(mockedStream).not.toHaveBeenCalled();
  });
});

describe("run deadline — corrective re-rolls yield to the budget", () => {
  it("re-rolls an out-of-band day when there is room", async () => {
    startClock();
    // 800 kcal against a 1600 target is far out of band → the engine re-rolls.
    scriptModel({ skeletonMs: 1_000, dayMs: 1_000, dayCalories: 800, days: [0] });

    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      // Generous: the band re-rolls are affordable (and phase 1's reserve —
      // 600s for a solo household — is comfortably cleared).
      deadlineMs: Date.now() + 15 * 60_000,
    });

    // 1 initial + CONTENT_MAX_RETRIES (2) corrective re-rolls.
    expect(dayCallCount()).toBe(3);
    expect(res.missingDays).toEqual([]);
  }, 20_000);

  it("accepts the closest attempt instead of re-rolling when the budget is tight", async () => {
    const t0 = startClock();
    // A slow 600s day call: after it, only ~90s remain — a re-roll (150s gate)
    // no longer fits, while phase 1's floor (~690s) was cleared at dispatch.
    scriptModel({ skeletonMs: 10_000, dayMs: 600_000, dayCalories: 800, days: [0] });

    const deadlineMs = t0 + 700_000;
    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      deadlineMs,
    });

    // One call only: after it, a re-roll plus its backoff no longer fits, so the
    // best attempt is taken. Chasing calorie drift must never cost a whole day.
    expect(dayCallCount()).toBe(1);
    expect(res.missingDays).toEqual([]);
    expect(virtualNow).toBeLessThanOrEqual(deadlineMs);
    const mom = res.plan.members.find((m) => m.member_id === "mom")!;
    expect(mom.days.find((d) => d.day_index === 0)!.meals.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("onUsage — a failed or trimmed run is still costed", () => {
  it("reports running totals, so the caller can bill a run that never returns", async () => {
    startClock();
    // Every day fails deterministically → the run throws AFTER the skeleton
    // spent real tokens. (The old fixture starved the budget instead, but that
    // now refuses phase 1 before any call — $0 spent is the intended outcome
    // there, and this test is about billing a run that DID spend.)
    scriptModel({ skeletonMs: 1_000, dayMs: 1_000, throwOnDays: DAYS });

    let accrued = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    await expect(
      generateMealPlan({
        anthropicApiKey: "k",
        context: makeContext(),
        onUsage: (u) => {
          accrued = u;
        },
      }),
    ).rejects.toThrow();

    // The skeleton call happened and cost money even though the run threw. This
    // is what used to be lost — every failed generation wrote cost_usd NULL and
    // the admin cost view counted it as $0.
    expect(accrued.input_tokens).toBeGreaterThan(0);
    expect(accrued.output_tokens).toBeGreaterThan(0);
    expect(accrued.cost_usd).toBeGreaterThan(0);
  });

  it("keeps accruing across day calls", async () => {
    const t0 = startClock();
    scriptModel({ skeletonMs: 50_000, dayMs: 100_000 });

    const seen: number[] = [];
    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      deadlineMs: t0 + 700_000,
      onUsage: (u) => seen.push(u.output_tokens),
    });

    expect(seen).toHaveLength(7); // 1 skeleton + 6 days
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // monotonic
    expect(seen.at(-1)).toBe(res.usage.output_tokens);
  });

  it("never lets a throwing reporter break a generation", async () => {
    startClock();
    scriptModel({ skeletonMs: 1_000, dayMs: 1_000 });

    const res = await generateMealPlan({
      anthropicApiKey: "k",
      context: makeContext(),
      onUsage: () => {
        throw new Error("reporting blew up");
      },
    });

    expect(res.missingDays).toEqual([]);
  });
});
