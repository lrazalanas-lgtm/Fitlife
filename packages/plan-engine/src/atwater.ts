/**
 * Atwater consistency guard.
 *
 * The model states a meal's `calories` AND its `macros` as separate numbers,
 * and nothing downstream ever reconciled them: `sumDayTotal` sums each column
 * independently, the band machinery enforces calories (±10%) and protein (±7%)
 * against the skeleton target, and carbs/fat ride along unchecked — the
 * deterministic rescale multiplies everything by one factor, which PRESERVES
 * an inconsistency rather than repairing it. Seen on production: two runs of
 * the same member's day both pinned to «2300 سعرة · 173 بروتين · 51 دهون»,
 * one with 288g carbs (4·173 + 4·288 + 9·51 = 2303 ✓) and one with 241g
 * (= 2115 — 185 kcal no macro accounts for).
 *
 * The repair direction follows the system's existing hierarchy of trust:
 * calories are the enforced figure (band re-rolls chase them, the rescale
 * steers ingredient amounts onto them), protein is band-checked, so CARBS —
 * the residual by construction, exactly how nutrition targets are derived in
 * practice (protein first, fat set, carbs fill the remaining calories) —
 * absorbs the correction: carbs_g = (kcal − 4·protein − 9·fat) / 4. A meal
 * whose protein + fat alone exceed its stated calories has no honest carbs
 * fix (the residual is negative) and is left untouched, counted and logged —
 * never fabricate.
 *
 * Tolerance: integer rounding of three macros is worth ~±7 kcal, and fiber
 * bookkeeping (counted at ~2 kcal/g rather than carbs' 4) can legitimately put
 * stated calories ~2×fiber_g BELOW the 4/4/9 sum — ~20 kcal on a high-fiber
 * meal. So gaps inside max(20 kcal, 5%) are honest noise and left alone; the
 * production case was 8% of the day, which is what this exists to catch.
 *
 * Everything here is pure and unit-tested.
 */
import type { Macros, DaySlice, Meal } from "./schema";

export const ATWATER_PROTEIN_KCAL_PER_G = 4;
export const ATWATER_CARBS_KCAL_PER_G = 4;
export const ATWATER_FAT_KCAL_PER_G = 9;

export const ATWATER_TOLERANCE_PCT = 0.05;
export const ATWATER_TOLERANCE_MIN_KCAL = 20;

/** Calories the stated macros account for, at 4/4/9. */
export function atwaterKcal(macros: Macros): number {
  return (
    ATWATER_PROTEIN_KCAL_PER_G * (macros.protein_g || 0) +
    ATWATER_CARBS_KCAL_PER_G * (macros.carbs_g || 0) +
    ATWATER_FAT_KCAL_PER_G * (macros.fat_g || 0)
  );
}

export type AtwaterVerdict =
  | { kind: "consistent" }
  /** Out of tolerance; `carbs_g` is the reconciled residual. */
  | { kind: "repaired"; carbs_g: number; gap_kcal: number }
  /** Protein + fat alone exceed the stated calories — no honest carbs fix. */
  | { kind: "unrepairable"; gap_kcal: number };

/**
 * Judge one (calories, macros) pair. Calories ≤ 0 or non-finite means there is
 * nothing authoritative to reconcile against (empty shells, children's
 * portion-only estimates before they exist), so the pair passes untouched.
 */
export function reconcileAtwater(calories: number, macros: Macros): AtwaterVerdict {
  if (!Number.isFinite(calories) || calories <= 0) return { kind: "consistent" };
  const gap = calories - atwaterKcal(macros);
  const tolerance = Math.max(
    ATWATER_TOLERANCE_MIN_KCAL,
    calories * ATWATER_TOLERANCE_PCT,
  );
  if (Math.abs(gap) <= tolerance) return { kind: "consistent" };
  // `|| 0` normalizes Math.round(-0.5)'s -0 — a boundary residual repairs to
  // zero carbs rather than refusing (or serializing a negative zero).
  const residual =
    Math.round(
      (calories -
        ATWATER_PROTEIN_KCAL_PER_G * (macros.protein_g || 0) -
        ATWATER_FAT_KCAL_PER_G * (macros.fat_g || 0)) /
        ATWATER_CARBS_KCAL_PER_G,
    ) || 0;
  if (residual < 0) return { kind: "unrepairable", gap_kcal: Math.round(gap) };
  return { kind: "repaired", carbs_g: residual, gap_kcal: Math.round(gap) };
}

/**
 * Reconcile a member header's macros_target against its daily_calories_target.
 * Applied AFTER the calorie floor (whose raise path scales macros uniformly,
 * preserving whatever consistency the input had). This also cleans the target
 * the day prompt states to the model — asking for 2300 kcal alongside macros
 * that sum to 2115 is a contradiction the model can only resolve by drifting
 * one of the two. Unrepairable targets pass through unchanged: the header is
 * advisory, and inventing a lower protein/fat figure is not ours to do.
 */
export function reconcileTargetMacros<
  T extends { daily_calories_target: number; macros_target: Macros },
>(targets: T): T {
  const v = reconcileAtwater(targets.daily_calories_target, targets.macros_target);
  if (v.kind !== "repaired") return targets;
  return {
    ...targets,
    macros_target: { ...targets.macros_target, carbs_g: v.carbs_g },
  };
}

export interface SliceAtwaterResult {
  slice: DaySlice;
  /** Meals whose carbs_g was rewritten to the residual. */
  repaired: number;
  /** Meals left inconsistent because protein+fat alone exceed calories. */
  unrepairable: number;
  /** One human-readable line per touched meal, for the run log. */
  notes: string[];
}

/**
 * Reconcile every meal in a day slice. Untouched meals keep their object
 * identity; day_total is NOT recomputed here — callers derive it from the
 * meals via sumDayTotal, which is what makes a per-meal repair reach the pill.
 */
export function reconcileSliceAtwater(slice: DaySlice): SliceAtwaterResult {
  let repaired = 0;
  let unrepairable = 0;
  const notes: string[] = [];
  const members = slice.members.map((m) => {
    let touched = false;
    const meals = m.meals.map((meal): Meal => {
      const v = reconcileAtwater(meal.calories, meal.macros);
      if (v.kind === "consistent") return meal;
      if (v.kind === "unrepairable") {
        unrepairable++;
        notes.push(
          `${m.member_id}/${meal.slot}: unrepairable (protein+fat alone exceed ${meal.calories} kcal by ${-v.gap_kcal})`,
        );
        return meal;
      }
      repaired++;
      touched = true;
      notes.push(
        `${m.member_id}/${meal.slot}: carbs_g ${meal.macros.carbs_g}→${v.carbs_g} (gap ${v.gap_kcal} kcal)`,
      );
      return { ...meal, macros: { ...meal.macros, carbs_g: v.carbs_g } };
    });
    return touched ? { ...m, meals } : m;
  });
  if (repaired === 0)
    return { slice, repaired, unrepairable, notes };
  return { slice: { ...slice, members }, repaired, unrepairable, notes };
}
