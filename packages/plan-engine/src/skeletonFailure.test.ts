/**
 * A phase-1 (skeleton) failure never reaches snapshot(), where gen_attempts is
 * charged — so a wide refill whose skeleton call failed deterministically was
 * re-dispatched by the sweeper (bounded only by its daily cap) and by the
 * page-mounted drain (bounded by nothing) against the same wall, forever. The
 * thrown error now names the members that were being attempted so the
 * production worker can charge them on the source plan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./anthropic", async () => {
  const actual = await vi.importActual<typeof import("./anthropic")>("./anthropic");
  return { ...actual, streamAnthropic: vi.fn() };
});

import { streamAnthropic } from "./anthropic";
import { generateMealPlan } from "./generate";
import { AnthropicCallError } from "./errors";
import type { PlanPromptContext } from "./buildContext";

const mockedStream = vi.mocked(streamAnthropic);

function soloContext(): PlanPromptContext {
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

describe("a skeleton failure names who was being attempted", () => {
  beforeEach(() => {
    mockedStream.mockReset();
  });

  it("attaches attemptedMemberIds to a non-retryable phase-1 error", async () => {
    // A 4xx is not retryable, so the very first call kills the run.
    mockedStream.mockRejectedValue(
      new AnthropicCallError("Anthropic API 400: invalid_request_error"),
    );

    let err: unknown;
    try {
      await generateMealPlan({ anthropicApiKey: "test-key", context: soloContext() });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(AnthropicCallError);
    expect((err as { attemptedMemberIds?: string[] }).attemptedMemberIds).toEqual(["mom"]);
    // Exactly one model call: no retry loop burned anything on a deterministic failure.
    expect(mockedStream).toHaveBeenCalledTimes(1);
  });
});
