import { describe, it, expect } from "vitest";
import { MEMBER_GEN_MAX_ATTEMPTS, type MealPlan } from "@fitlife/plan-engine";
import { decideSweep, SWEEP_DAILY_GEN_CAP, type SweepCandidate } from "./sweep";

/**
 * The sweeper is a cron that dispatches PAID model runs with nobody watching —
 * so every skip-rule here is a spend guard first and a correctness rule
 * second. The truth table mirrors the drain's preconditions plus the chain's
 * absent-member exclusion, from the same shared definitions.
 */

type Member = MealPlan["members"][number];

function member(id: string, filledDays: number): Member {
  return {
    member_id: id,
    member_name_ar: id,
    daily_calories_target: 1600,
    macros_target: { protein_g: 100, carbs_g: 140, fat_g: 55 },
    days: Array.from({ length: 7 }, (_, i) => ({
      day_index: i,
      day_name_ar: `يوم ${i}`,
      day_total: { calories: 600, protein_g: 40, carbs_g: 50, fat_g: 20 },
      meals:
        i < filledDays
          ? [
              {
                slot: "lunch",
                slot_name_ar: "الغداء",
                recipe_name_ar: "دجاج",
                ingredients: [{ name_ar: "دجاج", amount: 200, unit: "g" }],
                prep_steps_ar: ["اطبخي"],
                calories: 600,
                macros: { protein_g: 40, carbs_g: 50, fat_g: 20 },
              },
            ]
          : [],
    })),
  } as unknown as Member;
}

const plan = (
  members: Member[],
  gen_attempts?: Record<string, number>,
): MealPlan =>
  ({
    week_start_date: "2026-08-30",
    days_total: 7,
    generating: false,
    members,
    ...(gen_attempts ? { gen_attempts } : {}),
  }) as unknown as MealPlan;

const base: SweepCandidate = {
  userId: "u1",
  onboardingCompleted: true,
  planWindow: [
    { id: "p2", status: "failed" },
    { id: "p1", status: "ready" },
  ],
  newestReadyPlan: plan([member("mom", 4), member("dad", 4)]),
  beneficiaryIds: ["mom", "dad"],
  hasLiveMealRun: false,
  genRowsLast24h: 2,
};

describe("decideSweep", () => {
  it("dispatches the canonical case: partial ready week behind a failed newest row", () => {
    // The window matters: after the credit-exhaustion incident the QA
    // account's NEWEST rows were all failed — a newest-only read would have
    // declared 'nothing to heal' forever, the documented stacking bug.
    expect(decideSweep(base).action).toBe("dispatch");
  });

  it("stands down while onboarding is incomplete", () => {
    expect(
      decideSweep({ ...base, onboardingCompleted: false }),
    ).toMatchObject({ action: "skip" });
  });

  it("stands down while a live run holds the lock", () => {
    expect(decideSweep({ ...base, hasLiveMealRun: true }).action).toBe("skip");
  });

  it("the daily budget is a hard stop — a cron must be unable to loop spend", () => {
    expect(
      decideSweep({ ...base, genRowsLast24h: SWEEP_DAILY_GEN_CAP }).action,
    ).toBe("skip");
    expect(
      decideSweep({ ...base, genRowsLast24h: SWEEP_DAILY_GEN_CAP - 1 }).action,
    ).toBe("dispatch");
  });

  it("skips a complete week", () => {
    expect(
      decideSweep({
        ...base,
        newestReadyPlan: plan([member("mom", 7), member("dad", 7)]),
      }).action,
    ).toBe("skip");
  });

  it("skips when every short member exhausted the attempt cap — bounded, visible, done", () => {
    expect(
      decideSweep({
        ...base,
        newestReadyPlan: plan([member("mom", 7), member("dad", 4)], {
          dad: MEMBER_GEN_MAX_ATTEMPTS,
        }),
      }).action,
    ).toBe("skip");
  });

  it("never chases an absent member — that is the drain's routing, not a wide fill", () => {
    expect(
      decideSweep({
        ...base,
        beneficiaryIds: ["mom", "dad", "newcomer"],
      }).action,
    ).toBe("skip");
  });

  it("skips when no ready plan exists in the window", () => {
    expect(
      decideSweep({
        ...base,
        planWindow: [
          { id: "p2", status: "failed" },
          { id: "p1", status: "failed" },
        ],
        newestReadyPlan: null,
      }).action,
    ).toBe("skip");
  });
});
