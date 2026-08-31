/**
 * Atwater consistency guard — regression for the two production screenshots
 * of one member's day pill: both pinned to «2300 سعرة · 173 بروتين · 51 دهون»
 * by the band machinery, one carrying 288g carbs (4·173 + 4·288 + 9·51 = 2303,
 * consistent) and one 241g (= 2115 — 185 kcal no macro accounts for). The
 * model states calories and macros independently; the band enforces calories
 * and protein only; the rescale scales uniformly and so PRESERVES an
 * inconsistency. This suite pins the reconciliation that closes the gap.
 */
import { describe, it, expect } from "vitest";
import {
  atwaterKcal,
  reconcileAtwater,
  reconcileTargetMacros,
  reconcileSliceAtwater,
  ATWATER_TOLERANCE_MIN_KCAL,
} from "./atwater";
import { rescaleDayCalories } from "./generate";
import type { DaySlice, Meal } from "./schema";

const meal = (over: Partial<Meal> & { calories: number; macros: Meal["macros"] }): Meal => ({
  slot: "lunch",
  slot_name_ar: "الغداء",
  recipe_name_ar: "كبسة دجاج",
  ingredients: [{ name_ar: "أرز", amount: 100, unit: "g" }],
  prep_steps_ar: ["اطبخي الأرز"],
  ...over,
});

describe("reconcileAtwater", () => {
  it("accepts a consistent pair untouched", () => {
    // 4·40 + 4·65 + 9·20 = 600 exactly.
    expect(reconcileAtwater(600, { protein_g: 40, carbs_g: 65, fat_g: 20 })).toEqual({
      kind: "consistent",
    });
  });

  it("tolerates honest bookkeeping noise, in both directions", () => {
    // Tolerance at 600 kcal is max(20, 30) = 30. A gap of exactly 30 passes…
    expect(
      reconcileAtwater(600, { protein_g: 40, carbs_g: 57.5, fat_g: 20 }).kind, // sum 570
    ).toBe("consistent");
    // …including the fiber direction (stated kcal BELOW the 4/4/9 sum).
    expect(
      reconcileAtwater(600, { protein_g: 40, carbs_g: 72.5, fat_g: 20 }).kind, // sum 630
    ).toBe("consistent");
    // The floor binds on small meals: at 200 kcal, 5% is 10 but the floor is 20,
    // so a 20-kcal gap passes while a 44-kcal one is repaired.
    expect(ATWATER_TOLERANCE_MIN_KCAL).toBe(20);
    expect(
      reconcileAtwater(200, { protein_g: 10, carbs_g: 26, fat_g: 4 }).kind, // sum 180
    ).toBe("consistent");
    expect(
      reconcileAtwater(200, { protein_g: 10, carbs_g: 20, fat_g: 4 }).kind, // sum 156
    ).toBe("repaired");
  });

  it("repairs carbs to the residual of the stated calories", () => {
    // One kcal past tolerance flips it: sum 569 at 600 kcal (gap 31 > 30).
    const v = reconcileAtwater(600, { protein_g: 40, carbs_g: 57.25, fat_g: 20 });
    expect(v.kind).toBe("repaired");
    if (v.kind !== "repaired") return;
    expect(v.carbs_g).toBe(65); // (600 − 160 − 180) / 4
    // After repair the pair reconciles to within rounding.
    expect(
      Math.abs(600 - atwaterKcal({ protein_g: 40, carbs_g: v.carbs_g, fat_g: 20 })),
    ).toBeLessThanOrEqual(2);
  });

  it("refuses to invent when protein + fat alone exceed the calories", () => {
    // 4·50 + 9·30 = 470 > 300: the residual carbs would be negative.
    const v = reconcileAtwater(300, { protein_g: 50, carbs_g: 40, fat_g: 30 });
    expect(v.kind).toBe("unrepairable");
  });

  it("repairs to zero carbs at the exact boundary rather than refusing", () => {
    // 4·50 + 9·30 = 470; stated 468 → residual −0.5 rounds to −0, not < 0.
    const v = reconcileAtwater(468, { protein_g: 50, carbs_g: 40, fat_g: 30 });
    expect(v.kind).toBe("repaired");
    if (v.kind === "repaired") expect(v.carbs_g).toBe(0);
  });

  it("skips pairs with no authoritative calorie figure", () => {
    expect(reconcileAtwater(0, { protein_g: 40, carbs_g: 65, fat_g: 20 }).kind).toBe(
      "consistent",
    );
    expect(reconcileAtwater(NaN, { protein_g: 40, carbs_g: 65, fat_g: 20 }).kind).toBe(
      "consistent",
    );
  });
});

describe("reconcileTargetMacros — the production screenshot, as a header", () => {
  it("repairs the inconsistent screenshot (2300 kcal, 173p/241c/51f)", () => {
    const t = reconcileTargetMacros({
      daily_calories_target: 2300,
      macros_target: { protein_g: 173, carbs_g: 241, fat_g: 51 },
    });
    expect(t.macros_target.carbs_g).toBe(287); // (2300 − 692 − 459) / 4 = 287.25
    expect(atwaterKcal(t.macros_target)).toBe(2299);
    expect(t.macros_target.protein_g).toBe(173);
    expect(t.macros_target.fat_g).toBe(51);
  });

  it("leaves the consistent screenshot (…288c…) untouched, by identity", () => {
    const targets = {
      daily_calories_target: 2300,
      macros_target: { protein_g: 173, carbs_g: 288, fat_g: 51 },
    };
    expect(reconcileTargetMacros(targets)).toBe(targets);
  });

  it("passes an unrepairable header through unchanged", () => {
    const targets = {
      daily_calories_target: 300,
      macros_target: { protein_g: 50, carbs_g: 40, fat_g: 30 },
    };
    expect(reconcileTargetMacros(targets)).toBe(targets);
  });
});

describe("reconcileSliceAtwater", () => {
  const consistent = meal({ calories: 600, macros: { protein_g: 40, carbs_g: 65, fat_g: 20 } });
  const drifted = meal({
    slot: "dinner",
    calories: 700,
    macros: { protein_g: 50, carbs_g: 60, fat_g: 20 }, // sum 620, gap 80
  });
  const impossible = meal({
    slot: "snack",
    calories: 300,
    macros: { protein_g: 50, carbs_g: 40, fat_g: 30 }, // p+f alone = 470
  });

  it("repairs only the drifted meals and counts each kind", () => {
    const slice: DaySlice = {
      day_index: 0,
      members: [
        { member_id: "mom", meals: [consistent, drifted] },
        { member_id: "kid-1", meals: [consistent] },
      ],
    };
    const rec = reconcileSliceAtwater(slice);
    expect(rec.repaired).toBe(1);
    expect(rec.unrepairable).toBe(0);
    expect(rec.notes).toEqual(["mom/dinner: carbs_g 60→80 (gap 80 kcal)"]);
    const momDinner = rec.slice.members[0]!.meals[1]!;
    expect(momDinner.macros.carbs_g).toBe(80); // (700 − 200 − 180) / 4
    // Untouched things keep their identity — the carried-verbatim guarantee.
    expect(rec.slice.members[0]!.meals[0]).toBe(consistent);
    expect(rec.slice.members[1]).toBe(slice.members[1]);
  });

  it("leaves an unrepairable meal in place, counted and noted", () => {
    const slice: DaySlice = {
      day_index: 0,
      members: [{ member_id: "mom", meals: [impossible] }],
    };
    const rec = reconcileSliceAtwater(slice);
    expect(rec.repaired).toBe(0);
    expect(rec.unrepairable).toBe(1);
    expect(rec.slice.members[0]!.meals[0]).toBe(impossible);
    expect(rec.notes[0]).toContain("unrepairable");
  });

  it("returns the slice itself when everything is consistent", () => {
    const slice: DaySlice = {
      day_index: 0,
      members: [{ member_id: "mom", meals: [consistent] }],
    };
    expect(reconcileSliceAtwater(slice).slice).toBe(slice);
  });
});

describe("the deterministic rescale preserves a repaired meal's consistency", () => {
  it("so repairing before the rescale is sufficient — no second pass needed", () => {
    const repaired = reconcileSliceAtwater({
      day_index: 0,
      members: [
        {
          member_id: "mom",
          meals: [
            meal({ calories: 700, macros: { protein_g: 50, carbs_g: 60, fat_g: 20 } }),
          ],
        },
      ],
    }).slice;
    const scaled = rescaleDayCalories(repaired, [
      { member_id: "mom", got: 700, target: 630, allowed: 0 },
    ]);
    const m = scaled.members[0]!.meals[0]!;
    // factor 0.9: calories 630; macros scale with it, so the 4/4/9 sum still
    // lands on the stated calories to within per-macro rounding (±7 kcal).
    expect(m.calories).toBe(630);
    expect(Math.abs(m.calories - atwaterKcal(m.macros))).toBeLessThanOrEqual(7);
  });
});
