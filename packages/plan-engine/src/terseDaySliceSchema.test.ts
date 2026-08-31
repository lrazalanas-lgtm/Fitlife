import { describe, it, expect } from "vitest";
import {
  TERSE_DAY_SLICE_JSON_SCHEMA,
  terseDaySliceOutputFormat,
} from "./terseDaySliceSchema";
import { expandTerseDaySlice } from "./generate";
import { DaySliceSchema, IngredientSchema, MealSchema } from "./schema";

/**
 * The structured-outputs schema and the terse expander are two descriptions of
 * ONE shape. If they drift — a key the schema requires that the expander
 * ignores, an enum value zod accepts that the schema forbids — the API will
 * faithfully enforce replies the pipeline then rejects, and every day call
 * fails at 100% with nothing but "failed validation" to show for it. These
 * tests are the drift alarm, plus the API's own documented constraints
 * (additionalProperties:false everywhere; no numeric/length keywords).
 */

// A canonical terse day exactly as the schema permits it.
const terseMeal = {
  s: "lunch",
  r: "كبسة دجاج",
  ig: [
    { n: "دجاج", a: 200, u: "g" },
    { n: "أرز", a: 90, mn: 80, mx: 100, u: "g" },
    { n: "سلطة", a: 1, u: "unlimited" },
  ],
  st: ["اطبخي الأرز", "قدّمي"],
  sub: ["استبدلي الدجاج بسمك"],
  nt: "ملاحظة",
  c: 620,
  mc: { p: 45, cb: 70, f: 18 },
};

const terseSlice = {
  d: 3,
  ms: [
    { id: "mom", m: [terseMeal] },
    { id: "member-2", m: [{ ...terseMeal, r: "شوفان", s: "breakfast" }] },
  ],
};

describe("round trip: schema-valid terse reply → expander → zod", () => {
  it("expands to a canonical DaySlice that passes DaySliceSchema", () => {
    const expanded = expandTerseDaySlice(terseSlice);
    const parsed = DaySliceSchema.safeParse(expanded);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.day_index).toBe(3);
    const meal = parsed.data.members[0]!.meals[0]!;
    expect(meal.recipe_name_ar).toBe("كبسة دجاج");
    expect(meal.ingredients[1]).toEqual({
      name_ar: "أرز",
      amount: 90,
      amount_min: 80,
      amount_max: 100,
      unit: "g",
    });
    expect(meal.macros).toEqual({ protein_g: 45, carbs_g: 70, fat_g: 18 });
    expect(meal.substitutions_ar).toEqual(["استبدلي الدجاج بسمك"]);
    expect(meal.notes_ar).toBe("ملاحظة");
  });

  it("optional keys may be absent, exactly as the schema's required lists say", () => {
    const minimal = {
      d: 0,
      ms: [
        {
          id: "mom",
          m: [{ s: "dinner", r: "شوربة", ig: [{ n: "عدس", a: 150, u: "g" }], st: ["اسلقي"], c: 300, mc: { p: 18, cb: 40, f: 6 } }],
        },
      ],
    };
    const parsed = DaySliceSchema.safeParse(expandTerseDaySlice(minimal));
    expect(parsed.success).toBe(true);
  });
});

describe("the schema honors the API's documented constraints", () => {
  const walk = (node: unknown, visit: (obj: Record<string, unknown>) => void) => {
    if (node == null || typeof node !== "object") return;
    if (!Array.isArray(node)) visit(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, visit);
  };

  it("every object declares additionalProperties: false", () => {
    const objects: Record<string, unknown>[] = [];
    walk(TERSE_DAY_SLICE_JSON_SCHEMA, (o) => {
      if (o.type === "object") objects.push(o);
    });
    expect(objects.length).toBeGreaterThan(3);
    for (const o of objects) expect(o.additionalProperties).toBe(false);
  });

  it("uses no unsupported keywords (min/max/length constraints stay zod-side)", () => {
    const banned = new Set([
      "minimum",
      "maximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "pattern",
    ]);
    walk(TERSE_DAY_SLICE_JSON_SCHEMA, (o) => {
      for (const k of Object.keys(o)) expect(banned.has(k), k).toBe(false);
    });
  });

  it("enum values mirror the zod enums — the drift that would fail every call", () => {
    const schemaUnits = (
      TERSE_DAY_SLICE_JSON_SCHEMA.properties.ms.items.properties.m.items
        .properties.ig.items.properties.u.enum as readonly string[]
    ).slice();
    expect(schemaUnits.sort()).toEqual(
      [...IngredientSchema.shape.unit.options].sort(),
    );
    const schemaSlots = (
      TERSE_DAY_SLICE_JSON_SCHEMA.properties.ms.items.properties.m.items
        .properties.s.enum as readonly string[]
    ).slice();
    expect(schemaSlots.sort()).toEqual([...MealSchema.shape.slot.options].sort());
  });

  it("wire shape is the documented output_config.format value", () => {
    expect(terseDaySliceOutputFormat()).toEqual({
      type: "json_schema",
      schema: TERSE_DAY_SLICE_JSON_SCHEMA,
    });
  });
});
