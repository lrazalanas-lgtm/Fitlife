import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake only streamAnthropic; keep the real pure helpers (stripMarkdownFence etc.).
vi.mock("./anthropic", async () => {
  const actual = await vi.importActual<typeof import("./anthropic")>("./anthropic");
  return { ...actual, streamAnthropic: vi.fn() };
});

import { streamAnthropic } from "./anthropic";
import {
  generateMealPlan,
  summarizeDayErrors,
  BUDGET_DEFERRED_CAUSE,
  retryWaitMs,
  isTransientContentError,
} from "./generate";
import { AnthropicCallError, PlanValidationError } from "./errors";
import { DAY_MODEL } from "./constants";
import type { PlanPromptContext } from "./buildContext";

const mockedStream = vi.mocked(streamAnthropic);

const DAY_INDICES = [0, 1, 2];

/** Minimal solo-mom context → a from-scratch full generation (skeleton + days). */
function makeSoloContext(): PlanPromptContext {
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
    composition_summary: "عائلة",
  };
}

function skeletonResponse() {
  const skeleton = {
    members: [
      {
        member_id: "mom",
        member_name_ar: "mom",
        primary_goal: "fat_loss",
        daily_calories_target: 1600,
        macros_target: { protein_g: 100, carbs_g: 140, fat_g: 55 },
        days: DAY_INDICES.map((di) => ({
          day_index: di,
          day_name_ar: `اليوم ${di + 1}`,
          meals: [
            {
              slot: "breakfast",
              slot_name_ar: "الفطور",
              recipe_name_ar: `mom-fresh-${di}`,
            },
          ],
        })),
      },
    ],
    methodology_notes_ar: "ملاحظات",
    safety_disclaimer_ar: "تنبيه",
  };
  return { text: JSON.stringify(skeleton), tokensIn: 10, tokensOut: 20, stopReason: null };
}

function validMeal(recipeName: string) {
  return {
    slot: "breakfast",
    slot_name_ar: "الفطور",
    recipe_name_ar: recipeName,
    ingredients: [{ name_ar: "بيض", amount: 2, unit: "piece" }],
    prep_steps_ar: ["اخفقي البيض", "اطبخيه"],
    // In-band vs skeletonResponse's 1600-kcal target so the per-day calorie
    // enforcement doesn't re-roll the carefully scripted call sequences.
    calories: 1600,
    macros: { protein_g: 100, carbs_g: 140, fat_g: 55 },
  };
}

/** A valid canonical DaySlice for whichever members the prompt asks to expand. */
function validDayResponse(systemPrompt: string, stopReason: string | null = null) {
  const ids = [...systemPrompt.matchAll(/member_id="([^"]+)"/g)].map((m) => m[1]!);
  const memberIds = ids.length > 0 ? ids : ["mom"];
  const dayIndex = Number(systemPrompt.match(/day_index=(\d+)/)?.[1] ?? 0);
  const slice = {
    day_index: dayIndex,
    members: memberIds.map((id) => ({
      member_id: id,
      meals: [validMeal(`${id}-d${dayIndex}`)],
    })),
  };
  return { text: JSON.stringify(slice), tokensIn: 10, tokensOut: 20, stopReason };
}

beforeEach(() => mockedStream.mockReset());

describe("summarizeDayErrors", () => {
  it("returns empty string for no errors", () => {
    expect(summarizeDayErrors([])).toBe("");
  });
  it("counts the single error as a class", () => {
    expect(summarizeDayErrors(["boom"])).toBe("1x boom");
  });
  it("histograms by frequency (ties → earliest seen)", () => {
    expect(summarizeDayErrors(["a", "b", "a"])).toBe("2x a; 1x b");
    expect(summarizeDayErrors(["x", "y"])).toBe("1x x; 1x y"); // tie → first-seen order
  });
  it("clips unknown classes and bounds the whole line", () => {
    const long = "z".repeat(500);
    const out = summarizeDayErrors([long]);
    expect(out.startsWith("1x zzz")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(300);
  });
  it("groups unique per-day strings onto one class — deferrals can never outvote paid deaths", () => {
    // THE 08/30 failure: five truncations each carried a unique day number, two
    // deferrals shared one constant string, and the plurality vote over exact
    // strings recorded a $4.16 run as "no model call made".
    const errors = [
      "Day 0 hit max_tokens (32000)",
      "Day 2 hit max_tokens (32000) (salvage: no complete member)",
      "Day 3 hit max_tokens (32000)",
      "Day 4 hit max_tokens (32000) (salvage: nothing whole streamed)",
      "Day 5 hit max_tokens (32000)",
      BUDGET_DEFERRED_CAUSE,
      BUDGET_DEFERRED_CAUSE,
    ];
    expect(summarizeDayErrors(errors)).toBe(
      "5x max_tokens(32000); 2x deferred (no model call)",
    );
  });
  it("strips day indices and timing figures from stream errors", () => {
    expect(
      summarizeDayErrors([
        "Anthropic stream timeout after 75446ms",
        "Anthropic stream timeout after 204968ms",
      ]),
    ).toBe("2x stream timeout");
  });
});

describe("retryWaitMs", () => {
  it("honors Retry-After (capped at 60s) when present", () => {
    const w = retryWaitMs(1, 5000);
    expect(w).toBeGreaterThanOrEqual(5000);
    expect(w).toBeLessThan(5400);
    const capped = retryWaitMs(1, 90_000);
    expect(capped).toBeGreaterThanOrEqual(60_000);
    expect(capped).toBeLessThan(60_400);
  });
  it("falls back to exponential backoff (capped at 30s) without Retry-After", () => {
    const first = retryWaitMs(1);
    expect(first).toBeGreaterThanOrEqual(800);
    expect(first).toBeLessThan(1200);
    const high = retryWaitMs(10); // 800*2^9 → clamped to 30s
    expect(high).toBeGreaterThanOrEqual(30_000);
    expect(high).toBeLessThan(30_400);
  });
});

describe("generateMealPlan — surfaces the real cause when all days fail", () => {
  it("includes the underlying day error in the thrown message (not just a count)", async () => {
    // Skeleton (opus) succeeds; every day call (haiku) fails with a non-retryable
    // API error carrying a distinctive cause. Nothing is carried (from-scratch),
    // so the run throws — and the throw must surface the real cause.
    mockedStream.mockImplementation(async (params) => {
      // Read defensively: a prompt carrying day_index=N is a day call → fail it;
      // anything else (the skeleton) succeeds.
      const systemPrompt =
        (params as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      if (/day_index=\d+/.test(systemPrompt)) {
        throw new AnthropicCallError(
          "Anthropic API 400: invalid_request_error SURFACED_CAUSE_MARKER",
        );
      }
      return skeletonResponse();
    });

    let err: unknown;
    try {
      await generateMealPlan({
        anthropicApiKey: "test-key",
        context: makeSoloContext(),
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(PlanValidationError);
    const message = (err as Error).message;
    expect(message).toMatch(/All 3 day generations failed/);
    // Class-normalized: the status code survives (the diagnosis), the response
    // body does not — and the census says how many calls actually happened.
    expect(message).toMatch(/API 400/);
    expect(message).toMatch(/\[\d+ model calls?\]/);
  });
});

describe("isTransientContentError", () => {
  it("treats malformed JSON (SyntaxError) and validation misses as transient", () => {
    expect(isTransientContentError(new SyntaxError("Unexpected token"))).toBe(true);
    expect(
      isTransientContentError(new PlanValidationError("Day 2 failed validation: ...")),
    ).toBe(true);
  });
  it("does NOT treat max_tokens, generic errors, or API errors as transient content", () => {
    expect(
      isTransientContentError(new PlanValidationError("Day 2 hit max_tokens (12000)")),
    ).toBe(false);
    expect(isTransientContentError(new Error("boom"))).toBe(false);
    expect(
      isTransientContentError(new AnthropicCallError("Anthropic API 429: rate_limit_error")),
    ).toBe(false);
  });
});

describe("generateMealPlan — Part D: auto-retry transient per-day failures", () => {
  it("re-rolls a day that returns malformed output once, then succeeds", async () => {
    // Solo mom (concurrency 1 → sequential days). Day 1's FIRST call returns
    // malformed JSON (transient content failure → SyntaxError); the re-roll succeeds.
    let day1Calls = 0;
    mockedStream.mockImplementation(async (params) => {
      const systemPrompt =
        (params as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      if (!/day_index=\d+/.test(systemPrompt)) return skeletonResponse();
      if (/day_index=1\b/.test(systemPrompt)) {
        day1Calls++;
        if (day1Calls === 1)
          return { text: "{{ not valid json", tokensIn: 5, tokensOut: 5, stopReason: null };
      }
      return validDayResponse(systemPrompt);
    });

    const { plan, missingDays } = await generateMealPlan({
      anthropicApiKey: "test-key",
      context: makeSoloContext(),
    });

    expect(day1Calls).toBeGreaterThanOrEqual(2); // failed once, re-rolled
    expect(missingDays).not.toContain(1); // recovered
    const mom = plan.members.find((m) => m.member_id === "mom")!;
    expect(mom.days.find((d) => d.day_index === 1)!.meals.length).toBeGreaterThan(0);
  });

  it("retries a truncated (max_tokens) day once at a DOUBLED cap", async () => {
    const calls: { day: number; maxTokens: number }[] = [];
    let day1Calls = 0;
    mockedStream.mockImplementation(async (params) => {
      // Guard the occasional stray no-arg call in the from-scratch path (harness quirk).
      const p = (params ?? {}) as { systemPrompt?: string; maxTokens?: number };
      const systemPrompt = p.systemPrompt ?? "";
      const dayMatch = systemPrompt.match(/day_index=(\d+)/);
      if (!dayMatch) return skeletonResponse();
      const dayIndex = Number(dayMatch[1]);
      calls.push({ day: dayIndex, maxTokens: p.maxTokens ?? 0 });
      if (dayIndex === 1) {
        day1Calls++;
        if (day1Calls === 1)
          return { text: "", tokensIn: 5, tokensOut: 5, stopReason: "max_tokens" };
      }
      return validDayResponse(systemPrompt);
    });

    const { missingDays } = await generateMealPlan({
      anthropicApiKey: "test-key",
      context: makeSoloContext(),
    });

    expect(missingDays).not.toContain(1);
    const day1Calls2 = calls.filter((c) => c.day === 1);
    expect(day1Calls2.length).toBe(2);
    expect(day1Calls2[1]!.maxTokens).toBe(day1Calls2[0]!.maxTokens * 2);
  });
});

describe("generateMealPlan — Part E: partial failures surface the cause", () => {
  it("a day failing every re-roll lands in missingDays AND missingDaysCause", async () => {
    // Day 1 returns malformed JSON on EVERY call → exhausts content re-rolls →
    // dropped. Days 0 + 2 succeed, so it's a PARTIAL (no all-days throw).
    mockedStream.mockImplementation(async (params) => {
      const systemPrompt =
        (params as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      if (!/day_index=\d+/.test(systemPrompt)) return skeletonResponse();
      if (/day_index=1\b/.test(systemPrompt))
        return { text: "{{ not valid json", tokensIn: 5, tokensOut: 5, stopReason: null };
      return validDayResponse(systemPrompt);
    });

    const { missingDays, missingDaysCause } = await generateMealPlan({
      anthropicApiKey: "test-key",
      context: makeSoloContext(),
    });

    expect(missingDays).toContain(1);
    expect(missingDaysCause).toBeTruthy();
    expect((missingDaysCause ?? "").length).toBeGreaterThan(0);
    // A deterministically-failing day now runs its first-pass budget AND the
    // in-run second-chance pass (both with real content-retry backoff) before
    // being dropped, so give it headroom beyond the 5s default.
  }, 15000);
});

describe("generateMealPlan — Part F: in-run second-chance pass", () => {
  it("recovers a day that fails its first-pass re-rolls but passes on the second pass", async () => {
    // Day 1's first 3 calls (initial + 2 content re-rolls = the whole first-pass
    // budget) return malformed JSON → dropped into failedDays. The second-chance
    // pass re-runs it with a fresh budget; the 4th call parses. Days 0+2 succeed
    // first try. Day 1 must end up in the plan and NOT in missingDays.
    let day1Calls = 0;
    mockedStream.mockImplementation(async (params) => {
      const systemPrompt =
        (params as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      if (!/day_index=\d+/.test(systemPrompt)) return skeletonResponse();
      if (/day_index=1\b/.test(systemPrompt)) {
        day1Calls++;
        if (day1Calls <= 3)
          return { text: "{{ not valid json", tokensIn: 5, tokensOut: 5, stopReason: null };
      }
      return validDayResponse(systemPrompt);
    });

    const { plan, missingDays } = await generateMealPlan({
      anthropicApiKey: "test-key",
      context: makeSoloContext(),
    });

    expect(day1Calls).toBeGreaterThanOrEqual(4); // 3 first-pass fails + ≥1 second-pass
    expect(missingDays).not.toContain(1);
    const mom = plan.members.find((m) => m.member_id === "mom")!;
    expect(mom.days.find((d) => d.day_index === 1)!.meals.length).toBeGreaterThan(0);
  }, 20000);
});

describe("generateMealPlan — Part G: a truncated day is salvaged, not discarded", () => {
  it("rescues the complete members from a reply that hit max_tokens twice", async () => {
    // THE 08/30 money pit: a day that truncated at its cap was thrown away
    // WHOLE — 20-32k billed tokens per day — because truncation raises
    // PlanValidationError and the salvage gate only accepted
    // AnthropicCallError. The truncated text is a COMPLETE stream (the JSON is
    // merely cut short), so the whole-member rescue applies to it exactly as
    // it does to a dead stream.
    const wholeSlice = JSON.stringify({
      day_index: 1,
      members: [{ member_id: "mom", meals: [validMeal("mom-d1-salvaged")] }],
    });
    const truncated = wholeSlice.slice(0, wholeSlice.length - 2); // cut mid-structure
    let day1Calls = 0;
    mockedStream.mockImplementation(async (params) => {
      const systemPrompt =
        (params as { systemPrompt?: string } | undefined)?.systemPrompt ?? "";
      if (!/day_index=\d+/.test(systemPrompt)) return skeletonResponse();
      if (/day_index=1\b/.test(systemPrompt)) {
        day1Calls++;
        // Truncates on the initial call AND the doubled-cap retry.
        return { text: truncated, tokensIn: 5, tokensOut: 5, stopReason: "max_tokens" };
      }
      return validDayResponse(systemPrompt);
    });

    const { plan, missingDays, missingDaysCause } = await generateMealPlan({
      anthropicApiKey: "test-key",
      context: makeSoloContext(),
    });

    // Two paid calls (initial + doubled retry) — the salvage itself is free.
    expect(day1Calls).toBe(2);
    expect(missingDays).not.toContain(1);
    expect(missingDaysCause ?? "").toBe("");
    const mom = plan.members.find((m) => m.member_id === "mom")!;
    const day1 = mom.days.find((d) => d.day_index === 1)!;
    expect(day1.meals.length).toBeGreaterThan(0);
    expect(day1.meals[0]!.recipe_name_ar).toBe("mom-d1-salvaged");
  });
});

describe("DAY_MODEL default", () => {
  it("defaults the day phase to Sonnet", () => {
    // No PLAN_DAY_MODEL override in the test env → Sonnet is the default day model.
    if (!process.env.PLAN_DAY_MODEL) expect(DAY_MODEL).toBe("claude-sonnet-4-6");
  });
});
