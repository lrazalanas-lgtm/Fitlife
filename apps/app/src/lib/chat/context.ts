import "server-only";

import { conditionLabels, type MealPlan } from "@fitlife/plan-engine";
import {
  getCurrentUserProfile,
  getCurrentUserFamilyMembers,
} from "@/lib/supabase/queries";
import { getCookablePlan } from "@/lib/plans/getLatestPlan";
import { applyMemberDisplayNames } from "@/lib/plans/memberNames";
import {
  CUISINE_AR,
  GOAL_AR,
  RESTRICTION_AR,
  label,
  labelList,
  measurements,
  todayLine,
  ageOrderLine,
} from "./contextFormat";

/** Render a jsonb-ish value (usually a string[]) as a compact comma list. */
function list(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value
      .map((v) => (typeof v === "string" ? v : typeof v === "object" && v && "name_ar" in v ? String((v as { name_ar: unknown }).name_ar) : ""))
      .filter(Boolean);
    return items.length ? items.join("، ") : "لا شيء";
  }
  return "لا شيء";
}

/** Conditions are stored as slugs; the advisor was quoting «ibs» at the user. */
function conditionList(value: string[] | null | undefined): string {
  return value && value.length ? conditionLabels(value) : "لا شيء";
}

function lifeStage(m: {
  member_type?: string | null;
  trimester?: number | null;
  months_postpartum?: number | null;
  high_risk_pregnancy?: boolean | null;
}): string {
  if (m.member_type === "pregnant") {
    return `حامل${m.trimester ? ` (الثلث ${m.trimester})` : ""}${m.high_risk_pregnancy ? " — حمل عالي الخطورة" : ""}`;
  }
  if (m.member_type === "lactating") {
    return `مرضع${m.months_postpartum != null ? ` (${m.months_postpartum} شهر بعد الولادة)` : ""}`;
  }
  if (m.member_type === "child") return "طفل";
  return "";
}

function planSummary(plan: MealPlan): string {
  const lines: string[] = [`الخطة الحالية (أسبوع يبدأ ${plan.week_start_date}):`];
  if (plan.generating) {
    // Without this the model sees targets and no dishes and fills the gap
    // itself: asked «الكبار بس — وش عندهم اليوم؟» during a regeneration it
    // invented a full day's menu for two adults, while the same context in the
    // same minute correctly told other questions it had no meal details.
    lines.push(
      "  (الخطة قيد التوليد الآن — الأيام الفارغة أدناه لم تُنشأ بعد، وستظهر تلقائياً)",
    );
  }
  for (const member of plan.members) {
    const macros = member.macros_target;
    const targetKnown = member.daily_calories_target > 0;
    lines.push(
      targetKnown
        ? `- ${member.member_name_ar}: هدف يومي ~${member.daily_calories_target} سعرة (بروتين ${macros.protein_g}جم · كارب ${macros.carbs_g}جم · دهون ${macros.fat_g}جم)`
        : `- ${member.member_name_ar}: هدفه اليومي لم يُحتسب بعد (قيد التحضير) — لا تقولي إنه بلا احتياج.`,
    );
    const filled = member.days.filter((d) => d.meals.length > 0);
    for (const day of filled) {
      const meals = day.meals
        .map((meal) => `${meal.slot_name_ar}: ${meal.recipe_name_ar}`)
        .join(" / ");
      lines.push(`    ${day.day_name_ar}: ${meals}`);
    }
    // Name the gaps explicitly. A day that is simply absent from the list reads
    // as "not mentioned"; a day named as empty cannot be answered from memory.
    const empty = member.days.filter((d) => d.meals.length === 0);
    if (empty.length) {
      lines.push(
        `    أيام بلا وجبات بعد: ${empty.map((d) => d.day_name_ar).join("، ")}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Assemble a COMPACT Arabic summary of the caller's household for the advisor
 * chat — read with the RLS-scoped client (via the query helpers), so it can only
 * ever describe the caller's own family. Deliberately a summary (roster + the
 * current plan's meal NAMES + per-member targets), never the raw plan_data jsonb,
 * to stay inside the token budget.
 */
export async function buildHouseholdContext(userId: string): Promise<string> {
  // The COOKABLE plan, not the newest row: every dispatch mints a placeholder
  // row with empty plan_data that stays 'generating' through the whole
  // skeleton phase, and getLatestPlan reported that as "no plan" while a
  // complete week sat one row back — the advisor then told a household with a
  // ready plan that it had none. Same read the housekeeper page uses.
  const [profile, family, cookable] = await Promise.all([
    getCurrentUserProfile(),
    getCurrentUserFamilyMembers(),
    getCookablePlan(userId),
  ]);
  const latest = cookable?.plan ?? null;

  const sections: string[] = [];

  sections.push(todayLine());

  if (profile) {
    sections.push(
      [
        `${profile.sex === "male" ? "صاحب الحساب" : "صاحبة الحساب"}:`,
        `- الاسم: ${profile.display_name ?? "غير محدد"}`,
        ...measurements(profile),
        `- الهدف: ${label(GOAL_AR, profile.primary_goal)}`,
        profile.meals_per_day != null
          ? `- عدد الوجبات اليومية المعتاد: ${profile.meals_per_day}`
          : "",
        `- المطبخ المفضل: ${label(CUISINE_AR, profile.cuisine_preference)}`,
        `- الحساسيات: ${list(profile.allergies)}`,
        `- أطعمة لا تحبها: ${list(profile.dislikes)}`,
        `- قيود غذائية: ${labelList(RESTRICTION_AR, profile.dietary_restrictions)}`,
        `- حالات طبية: ${conditionList(profile.medical_conditions)}${profile.consulted_doctor ? " (راجعت الطبيب)" : ""}`,
        profile.target_weight_kg != null
          ? `- الوزن المستهدف: ${profile.target_weight_kg} كجم`
          : "",
        Array.isArray(profile.medications) && profile.medications.length > 0
          ? `- أدوية: ${list(profile.medications)}`
          : "",
        Array.isArray(profile.supplements) && profile.supplements.length > 0
          ? `- مكملات: ${list(profile.supplements)}`
          : "",
        profile.is_pregnant
          ? `- الحمل: نعم${profile.pregnancy_trimester ? ` (الثلث ${profile.pregnancy_trimester})` : ""}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const beneficiaries = family.filter((m) => m.role !== "housekeeper");
  if (beneficiaries.length) {
    const roster = beneficiaries.map((m) => {
      const stage = lifeStage(m);
      // Same omission as the owner's block: without age/height/weight/activity
      // the advisor cannot answer a calorie or portion question about a member
      // either, and every member's own numbers are already on file.
      const physical = measurements(m)
        .map((s) => s.replace(/^- /, ""))
        .join("، ");
      return [
        `- ${m.name} (${m.role}${stage ? `، ${stage}` : ""}):`,
        physical ? `${physical}.` : "",
        m.primary_goal ? `الهدف: ${label(GOAL_AR, m.primary_goal)}.` : "",
        `حساسيات: ${list(m.allergies)}`,
        `قيود: ${labelList(RESTRICTION_AR, m.dietary_restrictions)}`,
        `حالات طبية: ${conditionList(m.medical_conditions)}`,
      ]
        .filter(Boolean)
        .join(" ");
    });
    sections.push(["أفراد الأسرة:", ...roster].join("\n"));
  }

  // Superlatives and ordinals ("الأصغر", "الأكبر", "الثاني") were being answered
  // by picking, not comparing. Precompute the order so there is nothing to infer.
  const ageOrder = ageOrderLine([
    ...(profile
      ? [
          {
            name:
              profile.display_name ??
              (profile.sex === "male" ? "صاحب الحساب" : "صاحبة الحساب"),
            birth_year: profile.birth_year,
          },
        ]
      : []),
    ...beneficiaries.map((m) => ({ name: m.name, birth_year: m.birth_year })),
  ]);
  if (ageOrder) sections.push(ageOrder);

  if (latest?.status === "ready" && latest.plan_data) {
    // Overlay current roster names so the advisor never refers to a member by a
    // pre-rename name still frozen in the plan snapshot (the roster section above
    // already uses live names).
    sections.push(
      planSummary(
        applyMemberDisplayNames(latest.plan_data, {
          mom: { display_name: profile?.display_name ?? null },
          members: family,
        }),
      ),
    );
    if (cookable?.superseded) {
      sections.push(
        "ملاحظة: يجري الآن إعداد خطة أسبوع جديد؛ الخطة أعلاه هي الخطة الحالية المعتمدة حتى تكتمل الجديدة.",
      );
    }
  } else {
    sections.push("لا توجد خطة حالية جاهزة بعد.");
  }

  return sections.join("\n\n");
}
