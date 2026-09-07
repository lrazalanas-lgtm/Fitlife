/**
 * The condition catalogue — slug → Arabic label.
 *
 * Lives HERE, in the engine, because the prompt is built here and was rendering
 * the bare slug: a real owner's line read «تعاني من: ibs» — an English token in
 * an otherwise Arabic clinical instruction, asking the model to apply rules for
 * a condition it was never told the name of.
 *
 * The app's `lib/plans/medicalConditions.ts` re-exports these lists so the
 * wizard chips and the prompt cannot drift apart. That drift is a known failure
 * mode in this codebase (the UI chip roster and the engine's gate list had
 * already diverged by one slug), so there is deliberately one array per group.
 *
 * GATE_CONDITION slugs must stay in step with HIGH_RISK_MEDICAL_FLAGS in
 * buildContext.ts — selecting one triggers the doctor gate.
 */

export interface ConditionOption {
  slug: string;
  label_ar: string;
}

/** High-risk — require doctor sign-off before a plan is generated. */
export const GATE_CONDITIONS: ConditionOption[] = [
  { slug: "unstable_diabetes", label_ar: "مرض السكري غير مستقر" },
  { slug: "uncontrolled_hypertension", label_ar: "ارتفاع ضغط غير مسيطر عليه" },
  { slug: "heart_disease", label_ar: "أمراض القلب" },
  { slug: "kidney_disease", label_ar: "أمراض الكلى" },
  { slug: "liver_disease", label_ar: "أمراض الكبد" },
  { slug: "unstable_thyroid", label_ar: "اضطراب الغدة الدرقية غير مستقر" },
  { slug: "severe_food_allergy", label_ar: "حساسية غذائية شديدة" },
  { slug: "acute_digestive", label_ar: "اضطراب هضمي حاد" },
  { slug: "eating_disorder", label_ar: "اضطراب في الأكل" },
  { slug: "post_surgical", label_ar: "ما بعد عملية جراحية" },
  { slug: "bariatric_surgery", label_ar: "جراحة سمنة سابقة" },
  // In HIGH_RISK_MEDICAL_FLAGS (Sara's «أي أعراض غير مفسّرة تحتاج تشخيصاً»)
  // but had no chip, so the gate list carried a condition nobody could select.
  { slug: "unexplained_symptoms", label_ar: "أعراض غير مفسّرة تحتاج تشخيصاً" },
];

/** Stable / managed — inform the plan, never gate it. */
export const STABLE_CONDITIONS: ConditionOption[] = [
  { slug: "stable_diabetes", label_ar: "مرض السكري مستقر" },
  { slug: "controlled_hypertension", label_ar: "ارتفاع ضغط مسيطر عليه" },
  { slug: "pcos", label_ar: "تكيس المبايض" },
  { slug: "stable_hypothyroid", label_ar: "قصور الغدة الدرقية مستقر" },
  { slug: "high_cholesterol", label_ar: "ارتفاع الكوليسترول" },
  { slug: "ibs", label_ar: "متلازمة القولون العصبي" },
  { slug: "anemia", label_ar: "فقر الدم" },
];

const BY_SLUG: Record<string, string> = Object.fromEntries(
  [...GATE_CONDITIONS, ...STABLE_CONDITIONS].map((c) => [c.slug, c.label_ar]),
);

/**
 * Arabic name for a stored condition slug. Unknown values (the free-text
 * «حالة أخرى» the save actions append) pass through untouched — a condition the
 * model cannot name is still a condition it must respect.
 */
export function conditionLabelAr(slug: string): string {
  return BY_SLUG[slug] ?? slug;
}

/** Render a stored condition list for a prompt. */
export function conditionLabels(slugs: readonly string[]): string {
  return slugs.map(conditionLabelAr).join("، ");
}
