import { describe, it, expect } from "vitest";
import {
  PLAN_CHAIN_MAX_HOPS,
  shouldChainContinuation,
  incompleteInPlanMemberIds,
} from "./chain";
import { MEMBER_GEN_MAX_ATTEMPTS } from "./constants";
import type { MealPlan } from "./schema";

/**
 * The chain predicate is what turns "failed attempt" from a terminal state into
 * a hand-off — and every conjunct here guards a specific hazard found by the
 * adversarial review:
 *
 *  - progress required: a hop that completed zero days must not chain, because
 *    an identical successor meets whatever stopped it; without this the hop cap
 *    bounds invocations but not WASTE.
 *  - absent beneficiary → never chain: the wide continuation carries no
 *    `regenerateSharedGroup` routing, so it would generate a shared newcomer
 *    without rebuilding the shared group. The add/drain flow owns that.
 *  - attempt cap respected: wide runs now charge gen_attempts, and a member the
 *    cap gave up on must not be re-bought by the chain either.
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
    week_start_date: "2026-08-01",
    days_total: 7,
    generating: false,
    members,
    ...(gen_attempts ? { gen_attempts } : {}),
  }) as unknown as MealPlan;

// A 3-person household that stopped at 4 of 7 days — the measured production
// shape the chain exists for.
const shortWeek = () => plan([member("mom", 4), member("dad", 4), member("kid", 4)]);
const BENEFICIARIES = ["mom", "dad", "kid"];

const base = {
  plan: shortWeek(),
  beneficiaryIds: BENEFICIARIES,
  missingDays: [4, 5, 6],
  daysCompleted: 4,
  chainDepth: 0,
};

describe("shouldChainContinuation", () => {
  it("chains the measured production case: partial week, progress made, hop 0", () => {
    expect(shouldChainContinuation(base)).toBe(true);
  });

  it("never chains a whole week", () => {
    expect(
      shouldChainContinuation({ ...base, missingDays: [], daysCompleted: 7 }),
    ).toBe(false);
  });

  it("never chains without progress — an identical successor meets the same wall", () => {
    expect(shouldChainContinuation({ ...base, daysCompleted: 0 })).toBe(false);
  });

  it("stops at the hop cap", () => {
    expect(
      shouldChainContinuation({ ...base, chainDepth: PLAN_CHAIN_MAX_HOPS }),
    ).toBe(false);
    expect(
      shouldChainContinuation({ ...base, chainDepth: PLAN_CHAIN_MAX_HOPS - 1 }),
    ).toBe(true);
  });

  it("never chains while a beneficiary is ABSENT from the plan (needs skeleton + shared-group routing)", () => {
    expect(
      shouldChainContinuation({
        ...base,
        beneficiaryIds: [...BENEFICIARIES, "newcomer"],
      }),
    ).toBe(false);
  });

  it("never chains when every short member exhausted the attempt cap", () => {
    const capped = plan(
      [member("mom", 7), member("dad", 4)],
      { dad: MEMBER_GEN_MAX_ATTEMPTS },
    );
    expect(
      shouldChainContinuation({
        ...base,
        plan: capped,
        beneficiaryIds: ["mom", "dad"],
      }),
    ).toBe(false);
  });

  it("chains while at least one short member is still under the cap", () => {
    const mixed = plan(
      [member("mom", 4), member("dad", 4)],
      { mom: MEMBER_GEN_MAX_ATTEMPTS, dad: 1 },
    );
    expect(
      shouldChainContinuation({
        ...base,
        plan: mixed,
        beneficiaryIds: ["mom", "dad"],
      }),
    ).toBe(true);
  });
});

describe("incompleteInPlanMemberIds (one definition — the drain re-exports this)", () => {
  it("lists short members under the cap, in plan order", () => {
    const p = plan([member("mom", 7), member("dad", 3), member("kid", 0)]);
    expect(
      incompleteInPlanMemberIds({ plan: p, maxAttempts: MEMBER_GEN_MAX_ATTEMPTS }),
    ).toEqual(["dad", "kid"]);
  });

  it("drops members at the attempt cap", () => {
    const p = plan([member("dad", 3)], { dad: MEMBER_GEN_MAX_ATTEMPTS });
    expect(
      incompleteInPlanMemberIds({ plan: p, maxAttempts: MEMBER_GEN_MAX_ATTEMPTS }),
    ).toEqual([]);
  });
});
