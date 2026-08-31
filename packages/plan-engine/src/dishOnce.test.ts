import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isDishOnceShape,
  expandDishOnceDaySlice,
  DISH_ONCE_DAY_SLICE_JSON_SCHEMA,
} from "./dishOnceDaySlice";
import { expandTerseDaySlice, rescueDaySlice, isTransientContentError } from "./generate";
import { DaySliceSchema } from "./schema";
import type { PlanSkeleton } from "./schema";

/**
 * Dish-once is the highest-blast-radius change in the delivery plan: the band
 * check, rescale, partial-scope projection, shared-batch inference, absence
 * scaling, PDF and translation ALL read the canonical per-member shape, so the
 * expander must reproduce it byte-for-byte from the cheaper wire format. These
 * are the golden tests that contain that risk — plus the salvage integration
 * the adversarial review flagged as the silent breaker.
 */

// One shared lunch (mom + dad, different amounts) and one dad-only dinner.
const V2 = {
  d: 2,
  ds: [
    {
      s: "lunch",
      r: "كبسة دجاج",
      ig: [
        { n: "دجاج", u: "g" },
        { n: "أرز", u: "g" },
      ],
      st: ["اطبخي الأرز", "قدّمي"],
      sub: ["سمك بدل الدجاج"],
      nt: "ملاحظة",
      ps: [
        { id: "mom", a: [150, 70], c: 520, mc: { p: 38, cb: 60, f: 14 } },
        { id: "dad", a: [220, 110], c: 780, mc: { p: 55, cb: 90, f: 22 } },
      ],
    },
    {
      s: "dinner",
      r: "شوربة عدس",
      ig: [{ n: "عدس", u: "g" }],
      st: ["اسلقي"],
      ps: [{ id: "dad", a: [180], c: 320, mc: { p: 20, cb: 45, f: 5 } }],
    },
  ],
};

// The SAME content in the terse per-member shape.
const TERSE_EQUIVALENT = {
  d: 2,
  ms: [
    {
      id: "mom",
      m: [
        {
          s: "lunch",
          r: "كبسة دجاج",
          ig: [
            { n: "دجاج", a: 150, u: "g" },
            { n: "أرز", a: 70, u: "g" },
          ],
          st: ["اطبخي الأرز", "قدّمي"],
          sub: ["سمك بدل الدجاج"],
          nt: "ملاحظة",
          c: 520,
          mc: { p: 38, cb: 60, f: 14 },
        },
      ],
    },
    {
      id: "dad",
      m: [
        {
          s: "lunch",
          r: "كبسة دجاج",
          ig: [
            { n: "دجاج", a: 220, u: "g" },
            { n: "أرز", a: 110, u: "g" },
          ],
          st: ["اطبخي الأرز", "قدّمي"],
          sub: ["سمك بدل الدجاج"],
          nt: "ملاحظة",
          c: 780,
          mc: { p: 55, cb: 90, f: 22 },
        },
        {
          s: "dinner",
          r: "شوربة عدس",
          ig: [{ n: "عدس", a: 180, u: "g" }],
          st: ["اسلقي"],
          c: 320,
          mc: { p: 20, cb: 45, f: 5 },
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("golden equivalence: both wire shapes → one canonical slice", () => {
  it("expands to EXACTLY what the terse shape expands to", () => {
    const fromV2 = DaySliceSchema.parse(expandDishOnceDaySlice(V2));
    const fromTerse = DaySliceSchema.parse(expandTerseDaySlice(TERSE_EQUIVALENT));
    expect(fromV2).toEqual(fromTerse);
  });

  it("sharers get IDENTICAL names/ingredients/steps — the shared-batch inference contract", () => {
    const slice = DaySliceSchema.parse(expandDishOnceDaySlice(V2));
    const momLunch = slice.members.find((m) => m.member_id === "mom")!.meals[0]!;
    const dadLunch = slice.members.find((m) => m.member_id === "dad")!.meals[0]!;
    expect(momLunch.recipe_name_ar).toBe(dadLunch.recipe_name_ar);
    expect(momLunch.ingredients.map((i) => `${i.name_ar}|${i.unit}`)).toEqual(
      dadLunch.ingredients.map((i) => `${i.name_ar}|${i.unit}`),
    );
    expect(momLunch.prep_steps_ar).toEqual(dadLunch.prep_steps_ar);
    expect(momLunch.ingredients[0]!.amount).not.toBe(dadLunch.ingredients[0]!.amount);
  });

  it("shape routing is by reply, not by flag", () => {
    expect(isDishOnceShape(V2)).toBe(true);
    expect(isDishOnceShape(TERSE_EQUIVALENT)).toBe(false);
  });
});

describe("the one error zod cannot see", () => {
  it("misaligned amounts throw a re-rollable validation error — never fabricate quantities", () => {
    const bad = JSON.parse(JSON.stringify(V2));
    bad.ds[0].ps[0].a = [150]; // 2 ingredients, 1 amount
    let err: unknown;
    try {
      expandDishOnceDaySlice(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(isTransientContentError(err)).toBe(true);
  });
});

describe("schema honors the API constraints (same walk as the terse schema)", () => {
  const walk = (node: unknown, visit: (o: Record<string, unknown>) => void) => {
    if (node == null || typeof node !== "object") return;
    if (!Array.isArray(node)) visit(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, visit);
  };
  it("additionalProperties:false everywhere, no unsupported keywords", () => {
    const banned = new Set([
      "minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern",
    ]);
    let objects = 0;
    walk(DISH_ONCE_DAY_SLICE_JSON_SCHEMA, (o) => {
      if (o.type === "object") {
        objects++;
        expect(o.additionalProperties).toBe(false);
      }
      for (const k of Object.keys(o)) expect(banned.has(k), k).toBe(false);
    });
    expect(objects).toBeGreaterThan(3);
  });
});

describe("salvage integration — the breaker the review flagged", () => {
  const skeleton: PlanSkeleton = {
    safety_disclaimer_ar: "تنبيه",
    members: [
      {
        member_id: "mom",
        daily_calories_target: 1600,
        macros_target: { protein_g: 100, carbs_g: 140, fat_g: 55 },
        days: [
          {
            day_index: 2,
            day_name_ar: "الاثنين",
            meals: [{ slot: "lunch", slot_name_ar: "الغداء", recipe_name_ar: "كبسة دجاج" }],
          },
        ],
      },
      {
        member_id: "dad",
        daily_calories_target: 2400,
        macros_target: { protein_g: 150, carbs_g: 220, fat_g: 80 },
        days: [
          {
            day_index: 2,
            day_name_ar: "الاثنين",
            meals: [
              { slot: "lunch", slot_name_ar: "الغداء", recipe_name_ar: "كبسة دجاج" },
              { slot: "dinner", slot_name_ar: "العشاء", recipe_name_ar: "شوربة عدس" },
            ],
          },
        ],
      },
    ],
  } as unknown as PlanSkeleton;

  it("a whole dish-once reply rescues both members", () => {
    const rescued = rescueDaySlice(JSON.stringify(V2), skeleton, 2);
    expect(rescued).not.toBeNull();
    expect(rescued!.members.map((m) => m.member_id).sort()).toEqual(["dad", "mom"]);
  });

  it("truncation at every cut point yields null or only whole, skeleton-complete members", () => {
    const whole = JSON.stringify(V2);
    for (let cut = 10; cut < whole.length - 1; cut += 7) {
      const rescued = rescueDaySlice(whole.slice(0, cut), skeleton, 2);
      if (rescued == null) continue;
      for (const m of rescued.members) {
        const expected = skeleton.members
          .find((sm) => sm.member_id === m.member_id)!
          .days.find((d) => d.day_index === 2)!.meals.length;
        expect(m.meals.length, `cut=${cut} member=${m.member_id}`).toBe(expected);
        for (const meal of m.meals) {
          expect(meal.ingredients.length).toBeGreaterThan(0);
          expect(meal.calories).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("the prompt moves with the flag", () => {
  it("PLAN_DISH_ONCE=1 asks multi-member days for ds, and solo days never", async () => {
    vi.stubEnv("PLAN_DISH_ONCE", "1");
    vi.resetModules();
    const { buildSkeletonPrompt: _skip, buildDayPrompt } = await import("./systemPrompt");
    void _skip;
    const { makeCtx, makeSkeleton } = await makeFixtures();
    const multi = buildDayPrompt(makeCtx(), makeSkeleton(["mom", "dad"]), 2);
    expect(multi).toContain("ds: Array");
    expect(multi).toContain("كل طبق مرة واحدة");
    expect(multi).not.toContain("ms: Array");
    const solo = buildDayPrompt(makeCtx(), makeSkeleton(["mom"]), 2);
    expect(solo).toContain("ms: Array");
    expect(solo).not.toContain("ds: Array");
  });

  it("flag off keeps the terse shape everywhere", async () => {
    vi.stubEnv("PLAN_DISH_ONCE", "");
    vi.resetModules();
    const { buildDayPrompt } = await import("./systemPrompt");
    const { makeCtx, makeSkeleton } = await makeFixtures();
    const multi = buildDayPrompt(makeCtx(), makeSkeleton(["mom", "dad"]), 2);
    expect(multi).toContain("ms: Array");
    expect(multi).not.toContain("ds: Array");
  });
});

async function makeFixtures() {
  const makeCtx = () =>
    ({
      mom: {
        id: "u1",
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  const makeSkeleton = (ids: string[]) =>
    ({
      safety_disclaimer_ar: "تنبيه",
      members: ids.map((id) => ({
        member_id: id,
        daily_calories_target: 1600,
        macros_target: { protein_g: 100, carbs_g: 140, fat_g: 55 },
        days: [
          {
            day_index: 2,
            day_name_ar: "الاثنين",
            meals: [{ slot: "lunch", slot_name_ar: "الغداء", recipe_name_ar: "كبسة" }],
          },
        ],
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  return { makeCtx, makeSkeleton };
}
