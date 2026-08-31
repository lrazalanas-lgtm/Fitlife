/**
 * Dish-once emission (Stage 3 of the delivery plan) — the ~×0.69 output cut
 * that crosses the $0.25/person line, OFF by default behind `PLAN_DISH_ONCE=1`.
 *
 * Measured on stored production plans: in the terse per-member shape, a shared
 * dish's name, ingredient names, units and steps are emitted once PER SHARER —
 * 30-45% of a multi-member day's bytes are verbatim repetition. Here the model
 * writes each dish ONCE (`ds`), with one portion line per sharer (`ps`:
 * amounts aligned to the ingredient list, plus that sharer's calories and
 * macros). The batch math stays exactly where it always was — in code
 * (buildSharedGroup), never the model.
 *
 * THE CONTRACT THAT CONTAINS THE BLAST RADIUS: `expandDishOnceDaySlice` fans
 * the reply back into the SAME canonical per-member DaySlice the terse
 * expander produces — identical recipe names, identical ingredient name/unit
 * lists per sharer, scalar amounts per sharer — BEFORE zod validation. So the
 * band check, the rescale, the partial-scope projection, resyncSharedMeals'
 * shared-dish inference, absence scaling, the PDF and translation all run on
 * bytes they have always seen. Golden tests (dishOnce.test.ts) pin the
 * equivalence; the shape routing is by REPLY (`ds` key), so a model that
 * ignores the prompt and emits the old shape still parses, and old plans are
 * untouched.
 *
 * Solo days never use this shape — there is nobody to share with, and the
 * per-member emission is already minimal (the flag gates multi-member day
 * calls only; see generateDay).
 */

import { PlanValidationError } from "./errors";
import { SLOT_NAME_AR } from "./slotNames";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export function isDishOnceShape(raw: unknown): boolean {
  return (
    raw != null &&
    typeof raw === "object" &&
    Array.isArray((raw as AnyRecord).ds)
  );
}



/**
 * Fan a dish-once reply out to the canonical per-member day slice. Tolerant of
 * junk exactly the way expandTerseDaySlice is — anything structurally off is
 * passed through for zod to reject (→ the cheap content re-roll), EXCEPT the
 * one error zod cannot see: a portion line whose amounts array does not align
 * with the dish's ingredient list. That mismatch throws here (message contains
 * "failed validation" so isTransientContentError re-rolls it) because silently
 * zipping misaligned arrays would fabricate quantities.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function expandDishOnceDaySlice(raw: unknown): any {
  if (raw == null || typeof raw !== "object") return raw;
  const r = raw as AnyRecord;
  const dishes = r.ds;
  if (!Array.isArray(dishes)) return raw;

  // First-appearance member order, stable across dishes.
  const byMember = new Map<string, AnyRecord[]>();

  for (const dish of dishes) {
    if (dish == null || typeof dish !== "object") continue;
    const d = dish as AnyRecord;
    const ig: AnyRecord[] = Array.isArray(d.ig) ? d.ig : [];
    const portions: AnyRecord[] = Array.isArray(d.ps) ? d.ps : [];
    for (const p of portions) {
      if (p == null || typeof p !== "object") continue;
      const amounts: unknown[] = Array.isArray(p.a) ? p.a : [];
      if (amounts.length !== ig.length) {
        // PlanValidationError + "failed validation" wording ON PURPOSE — that
        // pair is what isTransientContentError keys on, so a misaligned reply
        // costs one cheap content re-roll instead of killing the day.
        throw new PlanValidationError(
          `Dish-once slice failed validation: dish "${String(d.r).slice(0, 40)}" has ${ig.length} ingredients but a ${amounts.length}-amount portion line`,
        );
      }
      const slot = d.s;
      const meal: AnyRecord = {
        slot,
        slot_name_ar:
          (typeof slot === "string" ? SLOT_NAME_AR[slot] : undefined) ?? slot,
        recipe_name_ar: d.r,
        ingredients: ig.map((g, i) => {
          const out: AnyRecord = {
            name_ar: g?.n,
            amount: amounts[i],
            unit: g?.u,
          };
          return out;
        }),
        prep_steps_ar: Array.isArray(d.st) ? d.st : [],
        calories: p.c,
        macros: {
          protein_g: p.mc?.p,
          carbs_g: p.mc?.cb,
          fat_g: p.mc?.f,
        },
      };
      if (d.sub != null) meal.substitutions_ar = d.sub;
      if (d.nt != null) meal.notes_ar = d.nt;
      const id = String(p.id);
      const meals = byMember.get(id) ?? [];
      meals.push(meal);
      byMember.set(id, meals);
    }
  }

  return {
    day_index: r.d ?? r.day_index,
    members: [...byMember.entries()].map(([member_id, meals]) => ({
      member_id,
      meals,
    })),
  };
}

// ── Structured-outputs schema for the dish-once shape ──────────────────────
// Same API constraints as terseDaySliceSchema.ts: additionalProperties:false
// on every object, no numeric/length keywords (zod enforces those app-side).

const DISH_INGREDIENT = {
  type: "object",
  properties: {
    n: { type: "string" },
    u: {
      type: "string",
      enum: [
        "g",
        "kg",
        "ml",
        "l",
        "tbsp",
        "tsp",
        "cup",
        "piece",
        "serving",
        "unlimited",
      ],
    },
  },
  required: ["n", "u"],
  additionalProperties: false,
} as const;

const PORTION = {
  type: "object",
  properties: {
    id: { type: "string" },
    a: { type: "array", items: { type: "number" } },
    c: { type: "number" },
    mc: {
      type: "object",
      properties: {
        p: { type: "number" },
        cb: { type: "number" },
        f: { type: "number" },
      },
      required: ["p", "cb", "f"],
      additionalProperties: false,
    },
  },
  required: ["id", "a", "c", "mc"],
  additionalProperties: false,
} as const;

export const DISH_ONCE_DAY_SLICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    d: { type: "integer" },
    ds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          s: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          r: { type: "string" },
          ig: { type: "array", items: DISH_INGREDIENT },
          st: { type: "array", items: { type: "string" } },
          sub: { type: "array", items: { type: "string" } },
          nt: { type: "string" },
          ps: { type: "array", items: PORTION },
        },
        required: ["s", "r", "ig", "st", "ps"],
        additionalProperties: false,
      },
    },
  },
  required: ["d", "ds"],
  additionalProperties: false,
} as const;

/** The `output_config.format` value for dish-once day calls. */
export function dishOnceDaySliceOutputFormat(): Record<string, unknown> {
  return { type: "json_schema", schema: DISH_ONCE_DAY_SLICE_JSON_SCHEMA };
}
