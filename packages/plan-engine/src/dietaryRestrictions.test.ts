/**
 * Dietary restrictions used to reach the model as the bare stored enum —
 * `قيود غذائية: lactose_free.` — while the allergy line beside it carried an
 * explicit «تجنّبيها تماماً». On a real `lactose_free` account the generated
 * week then served لبنة on three days plus جبن قريش and موزاريلا, none of them
 * lactose-free, and the advisor chat (reading the same profile) told the same
 * user that ordinary لبنة was not safe for her.
 *
 * The rule these tests defend: a restriction must reach the prompt in Arabic,
 * naming what it forbids, as a binding instruction — for the owner, for a
 * member, and for the family-wide list.
 */
import { describe, it, expect } from "vitest";
import { buildSkeletonPrompt, buildDayPrompt } from "./systemPrompt";
import type { PlanSkeleton } from "./schema";
import type {
  PlanPromptContext,
  PlanPromptContextMom,
  PlanPromptContextMember,
} from "./buildContext";

function mom(over: Partial<PlanPromptContextMom> = {}): PlanPromptContextMom {
  return {
    id: "mom",
    display_name: "هند",
    sex: "female",
    member_type: "adult",
    age: 36,
    height_cm: 163,
    weight_kg: 78,
    activity_level: "light",
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
    consulted_doctor: true,
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
    ...over,
  };
}

function member(over: Partial<PlanPromptContextMember> = {}): PlanPromptContextMember {
  return {
    id: "m1",
    name: "فيصل",
    role: "dad",
    member_type: "adult",
    sex: "male",
    age: 41,
    height_cm: 178,
    weight_kg: 92,
    activity_level: "very_active",
    primary_goal: "muscle_gain",
    dietary_restrictions: [],
    medical_conditions: [],
    allergies: [],
    dislikes: [],
    trimester: null,
    months_postpartum: null,
    high_risk_pregnancy: false,
    school_meal_handling: null,
    picky_eater: false,
    consulted_doctor: false,
    is_child: false,
    preferred_language: "ar",
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
    feeding_mode: null,
    ...over,
  };
}

function ctx(over: Partial<PlanPromptContext> = {}): PlanPromptContext {
  return {
    mom: mom(),
    family_members: [],
    family_wide: {
      dietary_restrictions: [],
      dislikes: [],
      cooking_methods: [],
      meal_out_frequency: null,
    },
    composition_summary: "فرد واحد",
    ...over,
  };
}

const prompt = (c: PlanPromptContext) => buildSkeletonPrompt(c);

describe("owner restrictions reach the prompt as rules", () => {
  it("never leaks the raw enum", () => {
    const out = prompt(ctx({ mom: mom({ dietary_restrictions: ["lactose_free"] }) }));
    expect(out).not.toContain("lactose_free");
    expect(out).toContain("خالٍ من اللاكتوز");
  });

  it("names the dairy the engine actually reached for", () => {
    const out = prompt(ctx({ mom: mom({ dietary_restrictions: ["lactose_free"] }) }));
    // The exact foods that shipped in the broken week.
    for (const food of ["اللبنة", "قريش", "موزاريلا", "القشدة"]) {
      expect(out).toContain(food);
    }
  });

  it("states it as binding, like the allergy line does", () => {
    const out = prompt(ctx({ mom: mom({ dietary_restrictions: ["lactose_free"] }) }));
    expect(out).toContain("قيود غذائية ملزمة");
    expect(out).toContain("التزمي بها في كل وجبة");
  });

  it("covers the Gulf wheat staples for gluten", () => {
    const out = prompt(ctx({ mom: mom({ dietary_restrictions: ["gluten_free"] }) }));
    for (const food of ["البرغل", "الجريش", "الفريكة", "المرقوق", "الساوردو"]) {
      expect(out).toContain(food);
    }
  });

  it("forbids peanuts and nut butters under nut_free", () => {
    const out = prompt(ctx({ mom: mom({ dietary_restrictions: ["nut_free"] }) }));
    expect(out).toContain("الفول السوداني");
    expect(out).toContain("زبدتها");
  });

  it("separates vegetarian from vegan", () => {
    expect(prompt(ctx({ mom: mom({ dietary_restrictions: ["vegetarian"] }) }))).toContain(
      "البيض والألبان مسموحة",
    );
    expect(prompt(ctx({ mom: mom({ dietary_restrictions: ["vegan"] }) }))).toContain(
      "بلا أي منتج حيواني",
    );
  });

  it("renders multiple restrictions together", () => {
    const out = prompt(
      ctx({ mom: mom({ dietary_restrictions: ["lactose_free", "gluten_free"] }) }),
    );
    expect(out).toContain("خالٍ من اللاكتوز");
    expect(out).toContain("خالٍ من الجلوتين");
  });

  it("passes an unknown value through rather than dropping the constraint", () => {
    expect(prompt(ctx({ mom: mom({ dietary_restrictions: ["halal_only"] }) }))).toContain(
      "halal_only",
    );
  });
});

describe("member and family-wide restrictions", () => {
  it("applies the same rules to a family member", () => {
    const out = prompt(
      ctx({ family_members: [member({ dietary_restrictions: ["lactose_free"] })] }),
    );
    expect(out).not.toContain("lactose_free");
    expect(out).toContain("خالٍ من اللاكتوز");
    expect(out).toContain("ملزمة");
  });

  it("applies them to the family-wide list too", () => {
    const out = prompt(
      ctx({
        family_wide: {
          dietary_restrictions: ["gluten_free"],
          dislikes: [],
          cooking_methods: [],
          meal_out_frequency: null,
        },
      }),
    );
    expect(out).not.toContain("gluten_free");
    expect(out).toContain("خالٍ من الجلوتين");
  });

  it("leaves a household with no restrictions unencumbered", () => {
    expect(prompt(ctx())).not.toContain("قيود غذائية ملزمة");
  });
});

/**
 * Same class of defect one line up in the same prompt: a real owner's clinical
 * instruction read «تعاني من: ibs» — the stored slug, in English, inside an
 * Arabic sentence telling the model to apply that condition's rules.
 */
describe("medical conditions reach the prompt in Arabic", () => {
  it("names the owner's condition instead of quoting the slug", () => {
    const out = prompt(ctx({ mom: mom({ medical_conditions: ["ibs"] }) }));
    expect(out).not.toContain("ibs");
    expect(out).toContain("متلازمة القولون العصبي");
  });

  it("names a member's conditions too", () => {
    const out = prompt(
      ctx({ family_members: [member({ medical_conditions: ["pcos", "anemia"] })] }),
    );
    expect(out).toContain("تكيس المبايض");
    expect(out).toContain("فقر الدم");
    expect(out).not.toContain("pcos");
  });

  it("passes free-text «حالة أخرى» through untouched", () => {
    // The save actions append the free-text answer to medical_conditions; a
    // condition the model cannot name is still one it must respect.
    const out = prompt(ctx({ mom: mom({ medical_conditions: ["صداع نصفي مزمن"] }) }));
    expect(out).toContain("صداع نصفي مزمن");
  });
});

/**
 * The DAY call is the one that writes ingredients. The August fix above
 * reached only the skeleton roster: the day prompt still said «حالات: ibs»
 * and never mentioned an individual's dietary restriction at all, so لبنة
 * kept landing on a lactose-free member's plate with the roster fixed.
 */
describe("the day prompt carries the same rules as the roster", () => {
  const skeletonFor = (memberIds: string[]): PlanSkeleton => ({
    members: memberIds.map((id) => ({
      member_id: id,
      member_name_ar: id === "mom" ? "هند" : "سارة",
      primary_goal: "fat_loss",
      daily_calories_target: 1600,
      macros_target: { protein_g: 100, carbs_g: 140, fat_g: 55 },
      days: [
        {
          day_index: 0,
          day_name_ar: "اليوم 1",
          meals: [{ slot: "breakfast", slot_name_ar: "فطور", recipe_name_ar: "بيض" }],
        },
      ],
    })),
    methodology_notes_ar: "ملاحظات",
    safety_disclaimer_ar: "تنبيه",
  });

  it("names the owner's condition in Arabic, not the slug", () => {
    const out = buildDayPrompt(
      ctx({ mom: mom({ medical_conditions: ["ibs"] }) }),
      skeletonFor(["mom"]),
      0,
    );
    expect(out).toContain("متلازمة القولون العصبي");
    expect(out).not.toContain("ibs");
  });

  it("carries the owner's OWN dietary restriction as a binding rule", () => {
    const out = buildDayPrompt(
      ctx({ mom: mom({ dietary_restrictions: ["lactose_free"] }) }),
      skeletonFor(["mom"]),
      0,
    );
    expect(out).toContain("قيود غذائية ملزمة");
    expect(out).toContain("خالٍ من اللاكتوز");
    expect(out).not.toContain("lactose_free");
  });

  it("carries a family member's own restriction and condition", () => {
    const out = buildDayPrompt(
      ctx({
        family_members: [
          member({ dietary_restrictions: ["lactose_free"], medical_conditions: ["pcos"] }),
        ],
      }),
      skeletonFor(["mom", "m1"]),
      0,
    );
    expect(out).toContain("تكيس المبايض");
    expect(out).not.toContain("pcos");
    expect(out).toContain("خالٍ من اللاكتوز");
    expect(out).not.toContain("lactose_free");
  });

  it("says nothing about restrictions when there are none", () => {
    const out = buildDayPrompt(ctx(), skeletonFor(["mom"]), 0);
    expect(out).not.toContain("قيود غذائية ملزمة");
  });
});
