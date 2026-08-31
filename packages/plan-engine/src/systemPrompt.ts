import {
  getBeneficiaries,
  type PlanPromptContext,
  type PlanPromptContextMember,
} from "./buildContext";
import type { PlanSkeleton, LocaleCode } from "./schema";
import { DAY_NAMES_AR } from "./dates";
import { engagementText } from "./engagementDigest";
import { isChildByAge, minorStage } from "./childRule";
import { DISH_ONCE_EMISSION } from "./constants";
import { conditionLabels } from "./medicalConditionLabels";

/**
 * Standalone translation prompt — translates an existing plan's meals into the
 * housekeeper's language (no generation). Names/amounts/units come from the
 * source; only the human-readable strings are translated.
 */
/**
 * How to refer to the person these instructions are FOR.
 *
 * Her wizard had no sex step, so `family_members.sex` was null for every
 * housekeeper and both prompts said «طبّاخة» outright — a male cook was handed
 * recipes written for someone else. The question is asked now and optional, so
 * an unanswered value keeps the previous wording rather than guessing: feminine
 * is the fallback, exactly as it is everywhere else in the product.
 */
function cookNoun(sex?: string | null): string {
  return sex === "male" ? "طبّاخ" : "طبّاخة";
}

export function buildTranslatePrompt(
  items: {
    i: number;
    recipe_name_ar: string;
    ingredient_names: string[];
    prep_steps_ar: string[];
  }[],
  locale: LocaleCode,
  cookSex?: string | null,
): string {
  const name = HK_LANG_NAMES[locale] ?? locale;
  const cook = cookNoun(cookSex);
  return `# دورك
أنتِ مترجمة محترفة لوصفات الطبخ. تترجمين من العربية إلى ${name} ترجمة طبيعية عملية — كأنك تكتبين لـ${cook} يقرأ ${name} كلغة أم. خاطبي القارئ بالصيغة المناسبة لـ${cook}. تجنّبي الترجمة الحرفية، وحافظي على نفس المعنى والمقادير.

# العناصر المطلوب ترجمتها
\`\`\`json
${JSON.stringify(items)}
\`\`\`

# الإخراج
أرجعي JSON صالحاً فقط (لا نص قبله/بعده، لا أكواد محاطة بغير اللازم): مصفوفة بنفس عدد العناصر وبنفس قيم i:
\`\`\`ts
type Out = Array<{
  i: number;                    // كما في المدخل
  recipe_name: string;          // اسم الطبق بـ ${name}
  ingredient_names: string[];   // أسماء المكونات بـ ${name} — نفس العدد والترتيب
  steps: string[];              // خطوات الطبخ بـ ${name} — نفس العدد والترتيب
}>;
\`\`\``;
}

/**
 * Standalone name-transliteration prompt — renders family members' personal
 * names in the housekeeper's language/script (how she'd read the name aloud),
 * NOT a meaning translation.
 */
export function buildNameTranslatePrompt(
  names: { i: number; name_ar: string }[],
  locale: LocaleCode,
  cookSex?: string | null,
): string {
  const name = HK_LANG_NAMES[locale] ?? locale;
  const cook = cookNoun(cookSex);
  return `# دورك
أنتِ مساعدة تكتب أسماء الأشخاص بحروف لغة أخرى. حوّلي كل اسم شخص من العربية إلى كتابته بـ ${name} كما يُنطق (نقل صوتي/transliteration) — وليس ترجمة معناه. اكتبي الاسم بحروف ${name} كما يقرؤه ${cook} يعرف ${name} فقط.

# الأسماء
\`\`\`json
${JSON.stringify(names)}
\`\`\`

# الإخراج
أرجعي JSON صالحاً فقط (لا نص قبله/بعده): مصفوفة بنفس عدد العناصر وبنفس قيم i:
\`\`\`ts
type Out = Array<{
  i: number;       // كما في المدخل
  name: string;    // الاسم بحروف ${name}
}>;
\`\`\``;
}

// Human-readable names for the housekeeper's language, interpolated into the
// day-expansion translation directive. (ar is never a translation target.)
const HK_LANG_NAMES: Record<LocaleCode, string> = {
  ar: "العربية",
  en: "English",
  tl: "Tagalog (Filipino)",
  id: "Bahasa Indonesia",
  bn: "Bengali (বাংলা)",
  am: "Amharic (አማርኛ)",
  ur: "Urdu (اردو)",
};

const ROLE_LABELS_AR: Record<string, string> = {
  dad: "الزوج",
  son: "ابن",
  daughter: "ابنة",
  housekeeper: "الخادمة",
  other_adult: "فرد بالغ",
  other_child: "طفل آخر",
};

// MOH-aligned bucket names — identical wording to the methodology's multiplier
// table (خامل ×1.2 … عالي جداً ×1.9) so the model never has to infer the match.
const ACTIVITY_LABELS_AR: Record<string, string> = {
  sedentary: "خامل (كثير الجلوس)",
  light: "نشاط خفيف (1-3 أيام أسبوعياً)",
  moderate: "نشاط متوسط (3-5 أيام أسبوعياً)",
  active: "نشاط عالي (6-7 أيام أسبوعياً)",
  very_active: "نشاط عالي جداً (تدريب مكثف/عمل بدني)",
};

const DAY_NATURE_LABELS_AR: Record<string, string> = {
  desk: "مكتبية (جلوس معظم اليوم)",
  moderate_movement: "حركة متوسطة",
  physical_work: "عمل بدني",
};

const EXERCISE_DAYS_LABELS_AR: Record<string, string> = {
  none: "لا رياضة",
  d1_2: "رياضة 1-2 يوم أسبوعياً",
  d3_5: "رياضة 3-5 أيام أسبوعياً",
  d6_plus: "رياضة 6 أيام أو أكثر أسبوعياً",
};

const EXERCISE_TYPE_LABELS_AR: Record<string, string> = {
  resistance: "مقاومة",
  cardio: "كارديو",
  mixed: "مقاومة وكارديو",
};

const WATER_LITERS_LABELS_AR: Record<string, string> = {
  lt1: "أقل من لتر",
  l1_2: "1-2 لتر",
  l2_3: "2-3 لترات",
  gt3: "أكثر من 3 لترات",
};

const FEEDING_MODE_LABELS_AR: Record<string, string> = {
  exclusive: "طبيعية كاملة",
  mixed: "مختلطة",
  formula: "صناعية",
};

const GOAL_LABELS_AR: Record<string, string> = {
  // Sara's 8
  fat_loss: "نزول الوزن",
  muscle_gain: "زيادة العضل",
  body_recomposition: "إعادة تركيب الجسم",
  athletic_performance: "الأداء الرياضي",
  metabolic_health: "الصحة الأيضية",
  digestive_health: "صحة الجهاز الهضمي",
  pregnancy_lactation: "الحمل والرضاعة",
  posture_recovery: "القوام والتعافي",
  // legacy
  lose_weight: "نزول الوزن",
  maintain: "ثبات الوزن",
  gain_weight: "زيادة الوزن",
  general_health: "الصحة العامة",
  pregnancy: "الحمل",
  post_pregnancy: "ما بعد الولادة",
  child_growth: "النمو الصحي",
};

const MEAL_OUT_LABELS_AR: Record<string, string> = {
  never: "أبداً",
  rarely: "نادراً (1-2 في الأسبوع)",
  sometimes: "أحياناً (3-4 في الأسبوع)",
  often: "غالباً (5+ في الأسبوع)",
};

const CUISINE_LABELS_AR: Record<string, string> = {
  khaleeji: "خليجي تقليدي",
  arabic: "عربي",
  asian: "آسيوي",
  western: "غربي",
  varied: "متنوع",
  // Legacy values (pre-00016 remap) — still resolvable until prod migrates.
  mixed: "خليط من الخليجي والعالمي",
  mediterranean: "متوسطي",
  international: "عالمي",
};

const SLEEP_BAND_LABELS_AR: Record<string, string> = {
  lt5: "أقل من 5 ساعات",
  h5_6: "5-6 ساعات",
  h7_8: "7-8 ساعات",
  gt8: "أكثر من 8 ساعات",
};

/**
 * Dietary restrictions as ENFORCEABLE rules, not labels.
 *
 * These used to reach the model as the raw stored enum — `قيود غذائية:
 * lactose_free.` — an English snake_case token dropped into an Arabic prompt
 * with no directive attached, while the allergy line right beneath it carried
 * an explicit «تجنّبيها تماماً». Measured consequence on a real `lactose_free`
 * account: the generated week served لبنة on three days, جبن قريش once and
 * موزاريلا once, none of them marked lactose-free — and the advisor chat, which
 * reads the same profile, correctly told the same user that لبنة التقليدية is
 * not safe for her. The model was never told what the token forbids.
 *
 * Each entry therefore names the restriction in Arabic AND lists what it rules
 * out, in the concrete ingredient vocabulary the plan is written in. Gulf
 * staples are called out by name (لبنة، جريش، برغل، فريكة، مرقوق) because that
 * is what the cookbook reaches for by default.
 */
const RESTRICTION_RULES_AR: Record<string, string> = {
  lactose_free:
    "خالٍ من اللاكتوز — امنعي الحليب واللبن والزبادي واللبنة والقشدة والأجبان الطرية (قريش، موزاريلا، فيتا) وأي صلصة بالكريمة. لا تستخدمي هذه الأصناف إلا إذا كتبتِ في المكوّن صراحةً أنه «خالٍ من اللاكتوز» أو نباتي",
  gluten_free:
    "خالٍ من الجلوتين — امنعي القمح والشعير والشوفان غير الموسوم والبرغل والجريش والفريكة والمرقوق والخبز والمعكرونة والساوردو. البدائل: الأرز، الكينوا، الذرة، البطاطس",
  nut_free:
    "خالٍ من المكسرات — امنعي جميع المكسرات والفول السوداني وزبدتها وزيوتها والطحينة المخلوطة بها",
  vegetarian: "نباتي — بلا لحوم ولا دواجن ولا أسماك ولا مأكولات بحرية. البيض والألبان مسموحة",
  vegan: "نباتي صرف — بلا أي منتج حيواني إطلاقاً: لا لحوم ولا دواجن ولا أسماك ولا بيض ولا ألبان ولا عسل",
};

/**
 * Render a restriction list as rules. Unknown values (free text, future enums)
 * pass through verbatim so nothing is ever silently dropped from a constraint.
 */
function restrictionRules(values: readonly string[]): string {
  return values.map((v) => RESTRICTION_RULES_AR[v] ?? v).join("؛ ");
}

function labeled(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "غير محدد";
  return map[key] ?? key;
}

/**
 * The ACCOUNT OWNER's answered الجنس, as a picker — the same contract as the
 * app's lib/copy/gender.ts. The owner is the plan's reader: every section that
 * names them, and every instruction addressed TO them, follows this. Feminine
 * is the fallback only for a profile that never answered (legacy rows) — it is
 * NOT a blanket default applied to male owners.
 * Imperatives addressed to Sara herself (طبّقي، اكتبي…) stay feminine: she is
 * the coach persona, not the reader.
 */
function ownerG(context: PlanPromptContext) {
  const male = context.mom.sex === "male";
  return (feminine: string, masculine: string): string => (male ? masculine : feminine);
}

/** Arabic year count — 3-10 take the plural, everything else the singular. */
function yearsAr(age: number): string {
  if (age === 1) return "سنة واحدة";
  if (age === 2) return "سنتان";
  if (age >= 3 && age <= 10) return `${age} سنوات`;
  return `${age} سنة`;
}

/**
 * How a minor is described to the model — the ONE wording, shared by the owner
 * roster line, the member roster line and the day prompt.
 *
 * Found by driving the deployed app: سعود (16, 58 kg) and لمى (10, 33 kg) were
 * handed the IDENTICAL 985 kcal estimate, across four separate regenerations.
 * Nothing was wrong with the portions rule — the problem was that "طفل — بالحصص،
 * بدون هدف سعرات" was the entire description of both of them. The roster carries
 * each one's age and weight two clauses earlier, but the only sentence that said
 * anything about how to FEED them erased the difference, so the model had one
 * bucket for every under-18 in the house and used it.
 *
 * So the stage and the age are stated, and the portion is pointed at them. This
 * sets no calorie number and keeps the no-BMR/TDEE rule exactly as it was: a
 * minor of any age is still planned by portions.
 */
function minorClauseAr(age: number | null | undefined, male: boolean): string {
  const g = (f: string, m: string) => (male ? m : f);
  const adolescent = minorStage(age) === "adolescent";
  const noun = adolescent ? g("مراهقة", "مراهق") : g("طفلة", "طفل");
  const head = age != null ? `${noun}، ${yearsAr(age)}` : noun;
  const scale = g(
    "قدّري حصتها حسب عمرها ووزنها ونشاطها ومرحلة نموّها",
    "قدّري حصته حسب عمره ووزنه ونشاطه ومرحلة نموّه",
  );
  const stageNote = adolescent
    ? ` حاجة ${g("المراهقة", "المراهق")} في طور النمو أعلى بوضوح من حاجة الطفل الصغير — لا تساوي بينهما.`
    : "";
  return ` (${head} — استخدمي حصص الهرم الغذائي الصحي، و${scale}، بدون معادلات BMR/TDEE ولا حد سعرات.${stageNote})`;
}

function describeMom(c: PlanPromptContext): string {
  const m = c.mom;
  // The account owner is female by default; a male owner (الجنس asked at
  // onboarding) flips the clause's grammar and the BMR formula pick. The
  // imperatives addressed to Sara herself (طبّقي، نسّقي…) stay feminine.
  const male = m.sex === "male";
  const g = (f: string, mm: string) => (male ? mm : f);
  // Signup accepts an owner as young as 13 (step1Schema), and the plan
  // assembly already stamps is_child for her — the prompts used to not, so she
  // was handed an adult BMR/TDEE target in direct violation of the
  // methodology's "لا تستخدمي معادلات BMR/TDEE للأطفال إطلاقاً". Same rule as
  // every family member now.
  const isChild = isChildByAge(m.member_type, m.age);
  const parts: string[] = [];
  parts.push(
    `${g("العميلة (الأم)", "العميل (رب الأسرة)")}: ${m.display_name ?? "غير معروف"}`,
  );
  parts.push(g("أنثى", "ذكر — استخدمي معادلة BMR للذكر"));
  if (m.age != null) parts.push(yearsAr(m.age));
  if (m.height_cm != null) parts.push(`${g("طولها", "طوله")} ${m.height_cm} سم`);
  if (m.weight_kg != null) parts.push(`${g("وزنها", "وزنه")} ${m.weight_kg} كيلو`);
  parts.push(`${g("نشاطها", "نشاطه")} ${labeled(ACTIVITY_LABELS_AR, m.activity_level)}`);
  parts.push(`${g("هدفها", "هدفه")} ${labeled(GOAL_LABELS_AR, m.primary_goal)}`);

  let line = parts.join("، ") + ".";

  if (m.medical_conditions.length > 0) {
    line += ` ${g("تعاني", "يعاني")} من: ${conditionLabels(m.medical_conditions)} — طبّقي قواعد الحالة الصحية المناسبة.`;
  } else {
    line += g(" لا تعاني من حالات صحية.", " لا يعاني من حالات صحية.");
  }
  if (m.is_pregnant) {
    const stage =
      m.pregnancy_month != null
        ? `الشهر ${m.pregnancy_month}، الثلث ${m.pregnancy_trimester ?? "غير محدد"}`
        : `الثلث ${m.pregnancy_trimester ?? "غير محدد"}`;
    line += ` حامل (${stage})${m.high_risk_pregnancy ? " — حمل عالي الخطورة" : ""} — طبّقي قواعد الحمل.`;
  }
  // months_postpartum is «months since giving birth» for ANY owner, not a
  // lactation flag: a woman who formula-feeds still needs the recovery rules.
  // member_type === "lactating" is what adds the lactation calories.
  if (m.months_postpartum != null) {
    if (m.member_type === "lactating") {
      const feeding = m.feeding_mode
        ? `${labeled(FEEDING_MODE_LABELS_AR, m.feeding_mode)}، `
        : "";
      line += ` مرضعة (${feeding}عمر الطفل ${m.months_postpartum} شهر) — طبّقي قواعد الرضاعة.`;
    } else if (!male) {
      line += ` ولدت قبل ${m.months_postpartum} شهر ولا ترضع — لا تضيفي سعرات الرضاعة، وطبّقي قواعد التعافي بعد الولادة: بروتين كافٍ، حديد، ألياف وسوائل، وتغيير وزن تدريجي لا حاد.`;
    }
  }
  if (m.dietary_restrictions.length > 0) {
    line += ` قيود غذائية ملزمة: ${restrictionRules(m.dietary_restrictions)} — التزمي بها في كل وجبة.`;
  }
  if (m.allergies.length > 0) {
    line += ` حساسية: ${m.allergies.join("، ")} — تجنّبيها تماماً.`;
  }
  if (m.never_eat_foods && m.never_eat_foods.length > 0) {
    line += ` أطعمة ${g("لا تتناولها", "لا يتناولها")} نهائياً: ${m.never_eat_foods.join("، ")} — استبعديها تماماً مثل الحساسية.`;
  }
  if (m.dislikes.length > 0) {
    line += ` ${g("لا تحب", "لا يحب")}: ${m.dislikes.join("، ")}.`;
  }
  if (m.deep_dive && m.deep_dive.liked_foods.length > 0) {
    line += ` ${g("تحب", "يحب")}: ${m.deep_dive.liked_foods.join("، ")} — وظّفيها في الخطة.`;
  }
  // Coach questionnaire (00013). Raw exercise answers ride with the derived
  // level so the TDEE multiplier match is explicit, not inferred.
  // A weight target is never framed for a minor — growth, not weight change.
  if (m.target_weight_kg != null && !isChild) {
    line += ` ${g("هدفها", "هدفه")} الوصول إلى ${m.target_weight_kg} كيلو — اجعلي وتيرة التغيير واقعية ومستدامة.`;
  }
  if (m.day_nature || m.exercise_days) {
    const bits: string[] = [];
    if (m.day_nature) bits.push(`طبيعة ${g("يومها", "يومه")} ${labeled(DAY_NATURE_LABELS_AR, m.day_nature)}`);
    if (m.exercise_days) {
      const t = m.exercise_type ? ` (${labeled(EXERCISE_TYPE_LABELS_AR, m.exercise_type)})` : "";
      bits.push(`${labeled(EXERCISE_DAYS_LABELS_AR, m.exercise_days)}${t}`);
    }
    line += ` ${bits.join("، ")} — مستوى النشاط أعلاه محتسب من ذلك.`;
  }
  if (m.medications.length > 0) {
    line += ` ${g("تتناول", "يتناول")} أدوية: ${m.medications.join("، ")} — نسّقي توقيت الوجبات مع الدواء وفق قواعد الحالة الصحية، ولا تقدّمي أي نصيحة دوائية.`;
  }
  if (m.supplements.length > 0) {
    line += ` ${g("تتناول", "يتناول")} مكملات: ${m.supplements.join("، ")} — راعيها في توزيع الوجبات (مثل فصل الحديد عن الكالسيوم).`;
  }
  if (m.nausea_foods.length > 0) {
    line += ` أطعمة تسبب ${g("لها", "له")} الغثيان حالياً: ${m.nausea_foods.join("، ")} — تجنّبيها مؤقتاً في هذه الخطة.`;
  }
  if (m.water_liters) {
    const low = m.water_liters === "lt1" || m.water_liters === "l1_2";
    line += ` ${g("تشرب", "يشرب")} ${labeled(WATER_LITERS_LABELS_AR, m.water_liters)} من الماء يومياً${low ? ` — ${g("شجّعيها", "شجّعيه")} بلطف على الزيادة ضمن الخطة` : ""}.`;
  } else if (m.water_cups != null) {
    line += ` ${g("تشرب", "يشرب")} نحو ${m.water_cups} أكواب ماء يومياً${m.water_cups < 8 ? ` — ${g("شجّعيها", "شجّعيه")} بلطف على الزيادة ضمن الخطة` : ""}.`;
  }
  if (m.sleep_band) {
    const lowSleep = m.sleep_band === "lt5" || m.sleep_band === "h5_6";
    line += ` ${g("تنام", "ينام")} ${labeled(SLEEP_BAND_LABELS_AR, m.sleep_band)} يومياً${lowSleep ? " — راعي وجبات مسائية خفيفة تدعم نوماً أفضل" : ""}.`;
  } else if (m.sleep_hours != null) {
    line += ` ${g("تنام", "ينام")} نحو ${m.sleep_hours} ساعات${m.sleep_hours < 7 ? " — راعي وجبات مسائية خفيفة تدعم نوماً أفضل" : ""}.`;
  }
  line += ` ${g("تفضل", "يفضل")} مطبخ ${labeled(CUISINE_LABELS_AR, m.cuisine_preference)}.`;
  // Same clause the member roster uses — keeps the two paths identical.
  if (isChild) {
    line += minorClauseAr(m.age, male);
  }
  // meal_mode is discretionary: 'shared' is the default (cook once, split), so it
  // needs no instruction. Only flag 'independent' — and it must be surfaced HERE,
  // in the roster the SKELETON sees, because the skeleton is the phase that decides
  // which dishes are shared (same recipe_name_ar = shared). Without it the skeleton
  // gives mom the family's shared dish names and she stays grouped as shared even
  // after switching to independent. Mirrors describeMember (feminine phrasing).
  if (m.meal_mode === "independent") {
    line += g(
      " (وجبات مستقلة: أعطيها أطباقاً خاصة بها بأسماء مختلفة عن باقي العائلة، إلا إذا تعارض مع حالة طبية/حساسية/حمل فالصحة أولاً.)",
      " (وجبات مستقلة: أعطيه أطباقاً خاصة به بأسماء مختلفة عن باقي العائلة، إلا إذا تعارض مع حالة طبية/حساسية فالصحة أولاً.)",
    );
  }

  return line;
}

function describeMember(member: PlanPromptContextMember): string {
  const roleLabel = labeled(ROLE_LABELS_AR, member.role);
  const parts: string[] = [];
  parts.push(`${roleLabel}: ${member.name}`);
  // Arabic counts 3-10 in the plural. The roster said «10 سنة» while the minor
  // clause three fields later said «10 سنوات» — one line disagreeing with itself
  // is exactly the sloppiness the model imitates in the plan it writes back.
  if (member.age != null) parts.push(yearsAr(member.age));
  if (member.height_cm != null) parts.push(`طوله ${member.height_cm} سم`);
  if (member.weight_kg != null) parts.push(`وزنه ${member.weight_kg} كيلو`);
  if (member.activity_level)
    parts.push(`نشاطه ${labeled(ACTIVITY_LABELS_AR, member.activity_level)}`);
  if (member.primary_goal)
    parts.push(`هدفه ${labeled(GOAL_LABELS_AR, member.primary_goal)}`);

  let line = parts.join("، ") + ".";
  if (member.dietary_restrictions.length > 0) {
    line += ` قيود غذائية ملزمة: ${restrictionRules(member.dietary_restrictions)} — التزمي بها في كل وجبة له.`;
  }
  if (member.allergies.length > 0) {
    line += ` حساسية: ${member.allergies.join("، ")} — تجنّبيها تماماً.`;
  }
  if (member.dislikes.length > 0) {
    line += ` لا يحب: ${member.dislikes.join("، ")}.`;
  }
  if (member.medical_conditions.length > 0) {
    line += ` حالات صحية: ${conditionLabels(member.medical_conditions)}.`;
  }
  if (member.member_type === "pregnant") {
    line += ` حامل (الثلث ${member.trimester ?? "غير محدد"})${member.high_risk_pregnancy ? " — عالي الخطورة" : ""} — طبّقي قواعد الحمل.`;
  }
  if (member.member_type === "lactating") {
    line += ` مرضعة (مرّ ${member.months_postpartum ?? "غير محدد"} شهر على الولادة) — طبّقي قواعد الرضاعة.`;
    if (member.feeding_mode) {
      line += ` طريقة الرضاعة: ${labeled(FEEDING_MODE_LABELS_AR, member.feeding_mode)}${
        member.feeding_mode === "exclusive"
          ? " — احتياج سعرات الرضاعة كامل."
          : " — عدّلي إضافة سعرات الرضاعة بما يناسب."
      }`;
    }
  }
  // Coach questionnaire (00013) — masculine default phrasing like the rest of
  // the member block; nausea only ever arrives on pregnant members.
  if (member.target_weight_kg != null) {
    line += ` هدفه الوصول إلى ${member.target_weight_kg} كيلو — اجعلي وتيرة التغيير واقعية ومستدامة.`;
  }
  if (member.day_nature || member.exercise_days) {
    const bits: string[] = [];
    if (member.day_nature)
      bits.push(`طبيعة يومه ${labeled(DAY_NATURE_LABELS_AR, member.day_nature)}`);
    if (member.exercise_days) {
      const t = member.exercise_type
        ? ` (${labeled(EXERCISE_TYPE_LABELS_AR, member.exercise_type)})`
        : "";
      bits.push(`${labeled(EXERCISE_DAYS_LABELS_AR, member.exercise_days)}${t}`);
    }
    line += ` ${bits.join("، ")} — مستوى النشاط أعلاه محتسب من ذلك.`;
  }
  if (member.medications.length > 0) {
    line += ` يتناول أدوية: ${member.medications.join("، ")} — نسّقي توقيت الوجبات مع الدواء وفق قواعد الحالة الصحية، ولا تقدّمي أي نصيحة دوائية.`;
  }
  if (member.supplements.length > 0) {
    line += ` يتناول مكملات: ${member.supplements.join("، ")} — راعيها في توزيع الوجبات.`;
  }
  if (member.nausea_foods.length > 0) {
    line += ` أطعمة تسبب لها الغثيان حالياً: ${member.nausea_foods.join("، ")} — تجنّبيها مؤقتاً في هذه الخطة.`;
  }
  if (member.water_liters) {
    line += ` يشرب ${labeled(WATER_LITERS_LABELS_AR, member.water_liters)} من الماء يومياً.`;
  } else if (member.water_cups != null) {
    line += ` يشرب نحو ${member.water_cups} أكواب ماء يومياً.`;
  }
  if (member.sleep_hours != null) {
    line += ` ينام نحو ${member.sleep_hours} ساعات.`;
  }
  // Minors: portion-based planning only — never BMR/TDEE. The clause names the
  // stage and the age, so a 16-year-old and a 10-year-old stop being one bucket.
  if (member.is_child) {
    if (member.school_meal_handling) {
      line += ` وجبات المدرسة: ${SCHOOL_MEAL_LABELS_AR[member.school_meal_handling] ?? member.school_meal_handling}.`;
    }
    if (member.picky_eater) line += " صعب في الأكل — اختاري أطباق مألوفة ومحبّبة.";
    line += minorClauseAr(member.age, member.sex === "male");
  }
  // meal_mode is discretionary: 'shared' is the default family behavior (cook once,
  // split), so it needs no extra instruction. Only flag 'independent' as the exception.
  if (member.meal_mode === "independent") {
    line +=
      " (وجبات مستقلة: أعطه أطباقاً خاصة به بأسماء مختلفة عن باقي العائلة، إلا إذا تعارض مع حالة طبية/حساسية/حمل فالصحة أولاً.)";
  }
  return line;
}

const SCHOOL_MEAL_LABELS_AR: Record<string, string> = {
  home_packed: "وجبة من البيت",
  school_provided: "من المدرسة",
  mixed: "مزيج",
};

// Sara's methodology — encoded verbatim (numbers are her professional standard).
// TONE is intentionally left as a placeholder; Email 2 fills {{TONE_PLACEHOLDER}}.
const SARA_METHODOLOGY = `## معادلة السعرات (Mifflin-St Jeor للبالغين)
- BMR للأنثى = (10 × الوزن كجم) + (6.25 × الطول سم) − (5 × العمر) − 161
- BMR للذكر = (10 × الوزن كجم) + (6.25 × الطول سم) − (5 × العمر) + 5
- TDEE = BMR × معامل النشاط
- معاملات النشاط: قليلة الحركة 1.2، نشاط خفيف (1-3 أيام) 1.375، متوسط (3-5 أيام) 1.55، عالي (6-7 أيام) 1.725، عالي جداً (تدريب مكثف/عمل بدني) 1.9

## تعديل السعرات حسب الهدف (قاعدة لكل جنس — توجيه الكوتش 07/2026)
للنساء:
- نزول الوزن: TDEE − 300 إلى 500 سعرة
- زيادة العضل: TDEE + 200 إلى 300 سعرة (أو +10-12% للزيادة النظيفة)
- مثال: امرأة 65 كجم / 165 سم / 35 سنة بنشاط متوسط: BMR ≈ 1345 → TDEE ≈ 2085 → للنزول 1585-1785 سعرة
للرجال:
- نزول الوزن (تنشيف): TDEE − 15% إلى 20%
- زيادة العضل (ضخامة): TDEE + 10% إلى 15%
- مثال: رجل 80 كجم / 180 سم / 30 سنة بنشاط متوسط: BMR = 1780 → TDEE ≈ 2759 → للتنشيف 2207-2345 سعرة
للجنسين:
- الثبات: TDEE بدون تغيير
- إعادة التركيب: TDEE تقريباً (بروتين عالي، سعرات قرب الثبات)

## توزيع الماكروز حسب الهدف (معتمد الكوتش الأصلي للنساء — يُطبَّق للرجال أيضاً حتى اعتماد جدول خاص بهم)
- نزول الوزن: 45% بروتين / 40% كارب / 15% دهون
- الثبات: 30% بروتين / 40% كارب / 30% دهون
- زيادة العضل: 30% بروتين / 50% كارب / 20% دهون
- إعادة التركيب: بروتين عالي، عامليها كنزول وزن
- التحويل: بروتين_جم = السعرات × نسبة البروتين ÷ 4، كارب_جم = السعرات × نسبة الكارب ÷ 4، دهون_جم = السعرات × نسبة الدهون ÷ 9

## الحمل والرضاعة
- الحمل الثلث الأول (شهر 1-3): سعرات الثبات مع التركيز على جودة العناصر
- الحمل الثلث الثاني والثالث (شهر 4-9): الثبات + 300 سعرة
- الرضاعة (أول 6 أشهر): الثبات + 200-300 سعرة عند الجوع، مع أطعمة تدعم الحليب والمزاج والنوم وتقليل القلق

## الأطفال تحت 18
لا تستخدمي معادلات BMR/TDEE للأطفال إطلاقاً. استخدمي حصص الهرم الغذائي لوزارة الصحة السعودية، وخطّطي حول الحصص المعيارية المتوازنة وليس على هدف سعرات.
والحصة تتبع العمر ومرحلة النمو، لا مجرد كون الفرد قاصراً: حصة المراهق (13-17) أكبر بوضوح من حصة الطفل الصغير — كما في مثال تقسيم القِدر أدناه (المراهق 30٪ مقابل الطفل 10٪). لا تعطي قاصرَين مختلفَي العمر نفس الحصة ولا نفس التقدير.

## الأهداف المعتمدة (8)
نزول الوزن، زيادة العضل، إعادة تركيب الجسم، الأداء الرياضي (تحمل/قوة/سرعة/لياقة)، الصحة الأيضية (سكري/مقاومة إنسولين/ضغط/غدة/تكيس مبايض/كبد دهني/دهون الدم)، صحة الجهاز الهضمي (قولون/انتفاخ/إمساك/حساسية طعام/ارتجاع)، الحمل والرضاعة، القوام/تكوين الجسم مع التدريب.

## التعديلات حسب الحالات الصحية
- السكري/مقاومة الإنسولين: ضبط كمية وجودة الكارب (منخفض لمتوسط حسب الحالة)، ألياف وبروتين عالي لثبات السكر، توزيع الكارب على اليوم وعدم تجميعه في وجبة واحدة، تنسيق التوقيت مع الدواء/الإنسولين، متابعة القراءات والأعراض.
- الضغط: ضبط الصوديوم، زيادة البوتاسيوم والمغنيسيوم (إن سمحت الحالة)، تقليل المعلبات والمصنّعات، إدارة الوزن إن لزم، الانتباه لتداخل الأدوية.
- تكيس المبايض: تحسين حساسية الإنسولين، بروتين كافٍ وألياف عالية، تنظيم الكارب حسب استجابة الجسم، دعم النوم وإدارة التوتر والنشاط البدني، نزول وزن تدريجي إن لزم.
- قصور الغدة الدرقية: التأكد من استقرار العلاج والتحاليل قبل التعديل، تجنّب خفض السعرات الحاد، بروتين كافٍ للحفاظ على العضل، مراعاة الطاقة والإمساك واحتباس السوائل والإرهاق، الانتباه لتوقيت الطعام/المكملات مع الدواء.
- قاعدة عامة: أي حالة صحية تتطلب خطة شخصية وليست مجرد حساب سعرات وماكروز، وتتطلب استشارة الطبيب قبل البدء.

## عدد الوجبات وتوزيعها (غير ثابت — حسب الهدف)
- متوازن افتراضي (3 وجبات + سناك): فطور 25% / غداء 35-40% / عشاء 25-30% / سناك 10-15%
- نزول الوزن: فطور 30% / غداء 35% / عشاء 25% / سناك 10%
- زيادة العضل/الأداء الرياضي: 4-5 وجبات بتوزيع البروتين على اليوم، وحمل سعرات أعلى حول التمرين
- السكري/مقاومة الإنسولين: توزيع الكارب أهم من عدد السعرات، وتجنّب جرعة كارب كبيرة في وجبة واحدة
- مشاكل الهضم: وجبات أصغر وأكثر تكراراً (4-6 وجبات صغيرة)

## الأطباق الخليجية المفضلة
كبسة دجاج أو لحم، الجريش، المفلق أو البرغل، المرقوق أو القرصان، المكرونة/الباستا، الكشري (بمقادير محسوبة)، المشاوي بأنواعها، السمك مع الأرز، الفول أو الحمص. وأطباق الفطور: فاصوليا، حمص، البيض، اللبنة، زعتر، الجبن، الخبز المناسب.
المبدأ الأساسي: لا حرمان. الأطعمة المألوفة يُعاد توظيفها بمقادير وطرق تحضير معدّلة لتخدم الهدف الصحي.

## الأطعمة المُقللة أو المُتجنبة (حسب الحالة)
الأطعمة المصنّعة عالية المعالجة منخفضة القيمة، المشروبات السكرية والسكر المضاف المتكرر، الدهون المتحولة والمقالي المعادة، الوجبات السريعة عالية السعرات قليلة الإشباع، عالية الصوديوم (خاصة للضغط/احتباس السوائل)، سريعة رفع السكر (للسكري/مقاومة الإنسولين)، والأطعمة المسببة لأعراض هضمية (حسب الفرد).
قاعدة: لا تمنعي مجموعة غذائية كاملة بدون سبب طبي أو متعلق بالهدف.

## منهجية تخطيط العائلة (أساسية)
الوجبات تُطبخ مرة واحدة وتُقسَّم على العائلة. لا تكتبي وصفة منفصلة لكل فرد افتراضياً.

1) جمّعي قبل الطبخ: لكل وجبة، حدّدي مَن من الأفراد يناسبهم نفس الطبق حسب هدفه (سعرات، ماكروز، حساسيات، قيود، تفضيلات). يشترك الأفراد في وصفة واحدة حتى لو احتاجوا **كميات** مختلفة منها. ادمجي فرداً في وصفة مشتركة فقط حين يناسبه الطبق فعلاً؛ ومَن يحتاج وجبة مختلفة جذرياً (حساسية، أو ماكروز لا يحققها الطبق) اتركيه خارج الوصفة المشتركة وأعطيه وصفته الخاصة. لا تُجبري الجميع على طبق واحد.

2) وصفة واحدة مقيّسة للمجموعة: لكل وجبة مشتركة اكتبي وصفة واحدة تُطبخ مرة واحدة للجميع. قيّسي كل المكونات لكمية المجموعة الكاملة، واذكري الوزن النهائي الإجمالي للطبق في batch_finished_weight_g.

3) قسّمي الكمية لكل فرد: في per_member_portions، لكل فرد يشارك الطبق اذكري حصته بالجرام (portion_grams) **و** كنسبة مئوية من إجمالي الكمية (portion_percentage). مجموع النسب للمشاركين ≈ 100٪. هكذا يحقق كل فرد هدفه المختلف من نفس القِدر — حصص أكبر أو أصغر من الطبق نفسه، لا طبخ منفصل. استخدمي notes_ar فقط لإضافة حقيقية (مثل مصدر دهون صحية إضافي)، لا لإعادة كتابة الوصفة.

مثال (عشاء دجاج وأرز، إجمالي الكمية 1800 جم):
- الأب: 630 جم (35٪)
- الأم: 450 جم (25٪)
- المراهق: 540 جم (30٪)
- الطفل: 180 جم (10٪)

للأطفال: حصة مناسبة للعمر والحاجة، بدون معادلات سعرات.
خصّصي لها خطة منفصلة تماماً (ليست أساساً مشتركاً) فقط في هذه الحالات: سكري يتطلب ضبطاً دقيقاً، حساسية أو عدم تحمّل طعام، مشاكل هضم شديدة، الحمل أو الرضاعة، أو اختلاف جذري في الأهداف. مَن لا يناسبه الطبق المشترك يأخذ وصفته الخاصة لتلك الوجبة بنفس الطريقة.

## الحد الأدنى لكل وصفة
لكل وصفة: اسم واضح، قائمة مكونات كاملة، مقادير دقيقة (جرامات/ملاعق/أكواب وليس تقديرات غامضة)، خطوات تحضير واضحة، وقت التحضير + وقت الطبخ، عدد الحصص، القيم الغذائية للحصة (سعرات/بروتين/كارب/دهون)، وبدائل/تعديلات (خالي جلوتين، قليل صوديوم، مناسب للسكري...). واختيارياً: ملاحظات تخزين/تحضير مسبق/تحذير حساسية.

## الحدود الآمنة
- المرأة البالغة: الحد الأدنى 1600 سعرة/يوم في الظروف الطبيعية.
- أقل من 1400 سعرة/يوم: يتطلب تبريراً صريحاً وإشرافاً مختصاً — لا تنزلي تحته.
- 1500 سعرة: مقبول فقط إذا دعمه حساب TDEE وكانت الماكروز والمغذيات كافية وبدون أعراض.
- الرجل البالغ: الأرقام أعلاه حدود نسائية ولا تُطبَّق عليه. التزمي بقاعدة العجز النسبي (TDEE − 15% إلى 20%)، ولا تنزلي بسعراته اليومية تحت معدل الأيض الأساسي (BMR) المحسوب له.
هذه الحدود للبالغين فقط — الأطفال يُخطَّط لهم بالحصص لا بالسعرات.

## الحالات التي تتطلب طبيباً قبل الخطة
حمل/رضاعة عالي الخطورة يحتاج تدخلاً غذائياً خاصاً، سكري غير مستقر، ضغط غير منضبط، أمراض قلب/كلى/كبد، اضطراب غدة درقية غير مستقر، حساسية طعام شديدة، اضطراب هضمي حاد/غير مشخّص، اضطرابات الأكل، تعافٍ بعد جراحة/حالة طبية خاصة، أو أي أعراض غير مفسّرة تحتاج تشخيصاً. المبدأ: إذا تجاوزت الحالة نطاق التخطيط الغذائي الآمن، الطبيب أولاً ثم تُبنى الخطة حول الحالة.`;

// Sara's cookbook ("كنز الوصفات الصحية") — STYLE inspiration only (no recipes
// are extracted). Layered AFTER the methodology and explicitly SUBORDINATE to
// it: the methodology decides targets, portions, medical/pregnancy rules and
// which dishes are on the table; the cookbook decides technique, ingredient
// palette and how a recipe is written.
//
// It used to read as a list of absolute bans («لا تستخدمي أرز أبيض»، «لا
// تستخدمي مكرونة عادية») that directly contradicted the methodology's own Gulf
// staples list (كبسة، الجريش، المرقوق، السمك مع الأرز) and its «لا حرمان»
// principle — and, being the later block, it won. It also stated a per-recipe
// calorie band (120-430) that cannot add up to an adult day target, which the
// per-day band enforcement then had to fight with re-rolls. Both are now framed
// as defaults that yield to the day target and to the Gulf palette.
//
// Written in فصحى to match every other instruction in the prompt (it was
// عامية), with Western digits like the methodology.
const SARA_COOKBOOK = `# كتابك المرجعي للوصفات

أنتِ مؤلفة كتاب «كنز الوصفات الصحية» (101 وصفة). هذا الكتاب يمثل **أسلوبك في الطبخ**: كيف تُحضَّر الوصفة وكيف تُكتب. اجعلي وصفات الخطة تسير على روحه.

## الأولوية عند التعارض (إلزامية)
منهجيتك أعلاه تحكم: أهداف السعرات والماكروز، الحصص، قواعد الحالات الصحية والحمل والرضاعة، وقائمة الأطباق الخليجية المفضلة ومبدأ «لا حرمان». الكتاب يحكم: طريقة التحضير، اختيار المكونات، وصياغة الوصفة. إذا تعارض تفضيل من الكتاب مع هدف يومي أو مع طبق خليجي مطلوب، فالمنهجية أولاً والكتاب يتكيّف — لا تحذفي طبقاً خليجياً أصيلاً لأن الكتاب يفضّل بديلاً عنه.

## الفلسفة الأساسية للكتاب

**«غني بالبروتين، منخفض السكر المضاف، يعتمد الحبوب الكاملة»** — هذا ما يوجّه اختياراتك:

1. لكل وصفة مصدر بروتين واضح.
2. لا سكر مضاف: استخدمي التمر أو العسل بمقدار محسوب أو الفاكهة الطازجة.
3. الدقيق الأبيض المكرر ليس خيارك الأول: الشوفان، الكينوا، البرغل، الساوردو، والحبوب الكاملة أولاً.
4. مكونات متوفرة في كل بيت خليجي، دون مكونات نادرة أو مكلفة بلا داعٍ.

## حجم الوصفة والماكروز

الحصة تُحسب من **هدف الفرد اليومي** المذكور في المطلوب، لا من نطاق ثابت: وزّعي سعرات اليوم على وجباته وفق نسب توزيع الوجبات في منهجيتك، ثم اكتبي مقادير الحصة لتصل إلى ذلك الرقم.
- الوجبات الخفيفة والسناك تقع عادة في نطاق 120-320 سعرة للحصة.
- الوجبات الرئيسية للبالغين تتجاوز ذلك بحسب الهدف، وقد تصل إلى 600-800 سعرة للحصة عند هدف يومي مرتفع. هذا مطلوب ولا يُعدّ خروجاً عن أسلوب الكتاب.
- اذكري الألياف مع السعرات والماكروز حين تكون قيمتها ملحوظة.

## المكونات التي تستخدمينها بشكل متكرر

**حبوب وكاربوهيدرات:**
- البرغل (خشن أو ناعم، مطبوخ أو منقوع)
- الشوفان (مطحون أو حب كامل)
- الكينوا (مطبوخة)
- خبز الساوردو (شرائح أو خبز مدور)
- الحبوب الكاملة
- الأرز — بمقدار موزون؛ والأرز البني أو المحوَّج بالحبوب الكاملة خيار جيد حين يقبله الطبق

**بروتينات:**
- صدر دجاج (مشوي، مكعبات، شرائح)
- البيض (مسلوق، أو مقلي بزيت قليل، أو أومليت)
- التونة (معلبة مصفاة من الماء)
- الحمص المسلوق
- اللبنة والجبن قليل الدسم (شيدر، موزاريلا، فيتا)
- اللحم والسمك في الأطباق الرئيسية

**خضار رئيسية:**
- الطماطم (طازجة، كرزية، مجففة)
- الخيار
- البصل (أبيض أو أخضر)
- البقدونس والنعناع (طازج أو مجفف)
- السبانخ (طازجة)
- الأفوكادو
- الجرجير
- البربير (بقلة حساوية)
- الذرة
- الفلفل الأحمر والأخضر

**نكهات ومحسنات:**
- زيت الزيتون
- عصير الليمون الطازج
- دبس الرمان
- الرمان (حبوب)
- الثوم المهروس
- السماق
- الكمون
- الزعتر والأوريغانو
- الفلفل الأسود
- الملح بكميات معتدلة
- البهارات الخليجية للأطباق الرئيسية (بهارات الكبسة، الهيل، الزعفران، القرفة، ورق الغار)

**اختياريات (بكميات صغيرة):**
- التمر (محشو أو مفروم كبديل للسكر)
- العسل (نصف ملعقة كحد أقصى)
- المكسرات والبذور (للزينة، 7-10 جرام)
- جبن الفيتا (30 جرام كحد أقصى)

## أسلوب كتابة الوصفة

**العنوان:** قصير ومباشر، يذكر المكون الرئيسي والمكونات المميزة.
أمثلة من كتابك:
- «سلطة البرغل بالحمص والطماطم المجففة»
- «سلطة دجاج بالأفوكادو والكينوا»
- «بان كيك مالح بالشوفان والبيض والسبانخ»
- «بيتزا فطور الساوردو والبيض»
- «توست ساوردو بالبيض المسلوق والسبانخ»

**المكونات:**
- مقادير دقيقة بالأكواب أو الملاعق أو الجرامات
- اذكري حالة المكون (مطبوخ، منقوع، مفروم، مكعبات، شرائح)
- اذكري البدائل بين قوسين (نباتي أو عادي، شيدر أو موزاريلا)
- ضعي كلمة «اختياري» على مكونات الزينة والمحسنات

**خطوات التحضير:**
- 3 خطوات قصيرة كما هو محدد في المطلوب
- كل خطوة جملة واحدة قصيرة وعملية
- تبدأ بفعل أمر مؤنث (اخلطي، أضيفي، سخّني، قطّعي، قلّبي)
- الخطوة الأخيرة للتقديم: «قدّميها باردة» أو «قدّميها دافئة» أو «قدّميها فوراً»

**القيمة الغذائية:** أضيفي فائدة صحية مختصرة في الملاحظات حين يكون للوصفة مكون مميز. مثال: «البربير غني بأوميغا 3 والمغنيسيوم ويدعم صحة القلب».

## أنواع الوصفات في كتابك (استلهمي منها دون التقيّد بها)

**سلطات:**
- سلطة البرغل بأنواعها (بالحمص والطماطم المجففة، أو بالخضار والليمون)
- سلطة الحمص (بالتونة أو بالخضار)
- سلطة الدجاج (بالأفوكادو والكينوا، أو بالخضار)
- سلطة البربير
- سلطات الورقيات مع البروتين

**وصفات الفطور:**
- بان كيك مالح بالشوفان والبيض
- توست الساوردو بأنواعه
- بيتزا الفطور بقاعدة الساوردو
- البيض المسلوق مع الخضار
- الفول والحمص واللبنة مع خبز مناسب

**وصفات أساسية (غداء وعشاء):**
- الأطباق الخليجية من منهجيتك بمقادير موزونة: كبسة الدجاج أو اللحم، الجريش، المفلق أو البرغل، المرقوق أو القرصان، السمك مع الأرز، المشاوي
- دجاج مشوي مع كينوا أو برغل وسلطة
- سمك مشوي مع خضار
- حساء العدس مع خبز ساوردو
- مكرونة الحبوب الكاملة بصلصة بسيطة

**وجبات خفيفة:**
- لبنة مع زعتر وخبز ساوردو
- حمص بطحينة مع خضار طازجة
- بيض مسلوق مع خيار وطماطم
- مكسرات وبذور بكميات محسوبة

## تفضيلات الأسلوب (افتراضات، لا محرّمات)

هذه تفضيلات تُطبَّق حين لا تتعارض مع هدف الفرد ولا مع طبق خليجي مطلوب:

1. **الحبوب الكاملة أولاً** — الكينوا أو البرغل أو الأرز البني حين يقبله الطبق. أما الأطباق الخليجية التي جوهرها الأرز الأبيض (الكبسة مثلاً) فتُقدَّم بمقدار موزون وبجانبها بروتين وخضار، ولا تُستبدل ولا تُحذف.
2. **مكرونة الحبوب الكاملة** هي الخيار الافتراضي للمكرونة.
3. **الساوردو والحبوب الكاملة وشراك القمح الكامل** هي الخيار الافتراضي للخبز.
4. **لا سكر مضاف** — العسل بمقدار محسوب، أو التمر، أو الفاكهة الطازجة.
5. **لا قلي بزيت غزير** — شوي، خبز في الفرن، طبخ بالبخار، أو قلي بقطرات زيت.
6. **زيت الزيتون هو الدهن الأساسي** بكميات معتدلة، ويُزاد عند الحاجة لبلوغ هدف الدهون اليومي.
7. **الخضار الورقية والمكونات الطازجة** حاضرة في معظم الوصفات، حتى الفطور.`;

/**
 * Static system prefix — identical across the skeleton call AND every per-day
 * call, so it's sent as a cached block (streamAnthropic's systemStatic).
 * {{TONE_PLACEHOLDER}} is filled later (Email 2).
 */
export const STATIC_SYSTEM = `# دورك

أنتِ سارة، أخصائية تغذية خليجية، متخصصة في تصميم خطط غذائية للعائلات السعودية والخليجية. تكتبين بالعربية فقط، وتراعين الذوق الخليجي التقليدي في اختيار الوصفات. {{TONE_PLACEHOLDER}}

# منهجيتك

${SARA_METHODOLOGY}

${SARA_COOKBOOK}

# ترتيب المراجع عند التعارض

1. **قواعد السلامة والحالات الصحية والحمل والرضاعة** في منهجيتك — تتقدم على كل ما سواها.
2. **أهداف السعرات والماكروز والحصص** لكل فرد كما وردت في المطلوب — الرقم اليومي هو القيد، لا التفضيلات.
3. **الحساسية والأطعمة المستبعدة نهائياً** — استبعاد تام دون استثناء.
4. **قائمة الأطباق الخليجية المفضلة ومبدأ «لا حرمان»** — الأطباق المألوفة تبقى، وتُعدَّل مقاديرها وطرق تحضيرها لتخدم الهدف.
5. **تفضيلات كتاب الوصفات** — طريقة التحضير وقائمة المكونات وصياغة الوصفة، وتتكيّف مع ما سبق.`;

function buildRoster(
  context: PlanPromptContext,
  targetMemberIds?: string[],
): string {
  let beneficiaries = getBeneficiaries(context);
  if (targetMemberIds) {
    const set = new Set(targetMemberIds);
    beneficiaries = beneficiaries.filter((b) => set.has(b.member_id));
  }
  return beneficiaries
    .map((b) => {
      const desc =
        b.member_id === "mom"
          ? describeMom(context)
          : describeMember(
              context.family_members.find((m) => m.id === b.member_id) ?? {
                id: b.member_id,
                name: b.member_name_ar,
                role: b.role,
                member_type: "adult",
                sex: null,
                age: null,
                height_cm: null,
                weight_kg: null,
                activity_level: null,
                primary_goal: null,
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
              },
            );
      return `- member_id="${b.member_id}" — ${desc}`;
    })
    .join("\n");
}

// Cooking-method slugs → Arabic (the stored values are English tokens; the
// prompt should read as فصحى, not slugs).
const COOKING_LABELS_AR: Record<string, string> = {
  grilling: "شوي",
  boiling: "سلق",
  steaming: "طبخ بالبخار",
  baking: "فرن",
  air_fryer: "مقلاة هوائية",
  frying_minimal: "قلي بزيت قليل",
  deep_frying: "قلي عميق",
};

function familyWideText(context: PlanPromptContext): string {
  const fw = context.family_wide;
  const bits: string[] = [];
  if (fw.dietary_restrictions.length > 0)
    bits.push(
      `قيود غذائية ملزمة على كل العائلة: ${restrictionRules(fw.dietary_restrictions)}`,
    );
  if (fw.dislikes.length > 0)
    bits.push(`أطعمة لا تأكلها العائلة أبداً: ${fw.dislikes.join("، ")}`);
  if (fw.cooking_methods.length > 0)
    bits.push(
      `طرق الطبخ المفضلة: ${fw.cooking_methods.map((c) => COOKING_LABELS_AR[c] ?? c).join("، ")}`,
    );
  if (fw.meal_out_frequency)
    bits.push(
      `الأكل خارج البيت: ${MEAL_OUT_LABELS_AR[fw.meal_out_frequency] ?? fw.meal_out_frequency}`,
    );
  return bits.length > 0
    ? `\n\nتفضيلات العائلة المشتركة (طبّقيها على الجميع): ${bits.join("؛ ")}.`
    : "";
}

/**
 * The user's regeneration feedback ("what's wrong / what to improve"), layered
 * in as guidance. Methodology + cookbook stay first, so they take precedence;
 * this adapts the new plan to the user without breaking the core rules.
 */
function feedbackText(context: PlanPromptContext): string {
  const fb = context.user_feedback?.trim();
  if (!fb) return "";
  return `\n\n# ${ownerG(context)("ملاحظات العميلة", "ملاحظات العميل")} (راعيها في هذه الخطة الجديدة)
${fb}
طبّقي هذه الملاحظات قدر الإمكان مع الحفاظ على منهجيتك وأسلوب كتابك وبنية الوصفات والقواعد الصحية.`;
}

/**
 * The engagement digest block («خطة تشبهك») — what the household actually
 * cooked/loved/vetoed last week, plus the week_changes emission instruction.
 * Skeleton-only (like the deep-dive block) to keep day-call token cost flat.
 * Empty string when there is no digest — the minimum-signal guard lives in
 * computeEngagementDigest, not here.
 */
function skeletonEngagementText(context: PlanPromptContext): string {
  return engagementText(context.engagement_digest);
}

const DEEP_DIVE_LABELS: Array<{
  key: keyof import("./buildContext").DeepDiveFields;
  label: string;
  map?: Record<string, string>;
}> = [
  { key: "waist_cm", label: "محيط الخصر (سم)" },
  { key: "hip_cm", label: "محيط الورك (سم)" },
  { key: "steps_daily", label: "متوسط الخطوات اليومية" },
  {
    key: "exercise_duration",
    label: "مدة التمرين",
    map: { lt30: "أقل من 30 دقيقة", m30_60: "30-60 دقيقة", gt60: "أكثر من 60 دقيقة" },
  },
  { key: "meals_per_day", label: "عدد الوجبات المفضل يومياً" },
  { key: "snacks_habit", label: "وجبات خفيفة", map: { yes: "نعم", no: "لا" } },
  {
    key: "breakfast_habit",
    label: "الإفطار",
    map: { regular: "بانتظام", sometimes: "أحياناً", never: "لا تتناوله" },
  },
  {
    key: "intermittent_fasting",
    label: "صيام متقطع",
    map: { yes: "نعم", no: "لا" },
  },
  { key: "food_recall_24h", label: "أكل آخر 24 ساعة" },
  {
    key: "sleep_quality",
    label: "جودة النوم",
    map: { excellent: "ممتازة", good: "جيدة", fair: "متوسطة", poor: "ضعيفة" },
  },
  {
    key: "stress_level",
    label: "مستوى التوتر",
    map: { low: "منخفض", medium: "متوسط", high: "مرتفع" },
  },
  {
    key: "who_cooks",
    label: "من يطبخ غالباً",
    map: { me: "هي بنفسها", family_member: "أحد أفراد الأسرة", cook: "طاهٍ/خدامة", delivery: "طلب خارجي غالباً" },
  },
  {
    key: "cooking_time",
    label: "وقت الطبخ المتاح يومياً",
    map: { lt20: "أقل من 20 دقيقة", m20_40: "20-40 دقيقة", gt40: "أكثر من 40 دقيقة" },
  },
  { key: "previous_diets", label: "حميات سابقة (وما نجح/لم ينجح)" },
  { key: "food_budget", label: "ميزانية الطعام" },
];

/**
 * The mom's optional deep-dive lifestyle answers. SKELETON-only: they shape
 * targets/meal-count/structure once; day prompts never repeat them.
 * liked_foods renders inside describeMom instead (positive steer clause).
 */
function deepDiveText(context: PlanPromptContext): string {
  const dd = context.mom.deep_dive;
  if (!dd) return "";
  const lines: string[] = [];
  for (const { key, label, map } of DEEP_DIVE_LABELS) {
    const v = dd[key];
    if (v == null || v === "" || Array.isArray(v)) continue;
    const rendered = typeof v === "string" && map ? (map[v] ?? v) : String(v);
    lines.push(`- ${label}: ${rendered}`);
  }
  if (lines.length === 0) return "";
  return `\n\n# ${ownerG(context)("نمط حياة العميلة", "نمط حياة العميل")} (تفاصيل إضافية من الاستبيان)
${lines.join("\n")}
راعيها في توزيع الوجبات وأسلوب الطبخ والتنويع، مع بقاء المنهجية والقواعد الصحية أولاً.`;
}

/**
 * The mom's free "anything else" questionnaire note. SKELETON-only (like
 * feedback): targets/structure are decided there, and day prompts repeat 7×.
 * Methodology still takes precedence.
 */
function momNotesText(context: PlanPromptContext): string {
  const n = context.mom.notes?.trim();
  if (!n) return "";
  return `\n\n# ${ownerG(context)("ملاحظات إضافية من العميلة", "ملاحظات إضافية من العميل")} (من الاستبيان)
${n}
راعيها قدر الإمكان مع الحفاظ على منهجيتك والقواعد الصحية.`;
}

/**
 * Phase 1 — the dynamic part of the SKELETON call: compute per-member targets +
 * a week of dish NAMES only (no recipes). Small + fast; decides variety and
 * which meals are shared across the family (same recipe_name_ar = shared).
 */
export function buildSkeletonPrompt(
  context: PlanPromptContext,
  targetMemberIds?: string[],
): string {
  const count = targetMemberIds
    ? targetMemberIds.length
    : getBeneficiaries(context).length;
  const isSolo = count === 1;
  const sharedNote = isSolo
    ? "هذه خطة لفرد واحد، لا تشارك."
    : "عندما تكون الوجبة نفسها مشتركة بين أكثر من فرد، استخدمي **نفس** recipe_name_ar لهم حتى نوسّعها لاحقاً كوصفة عائلة واحدة بحصص مختلفة. مَن وُسم بـ(وجبات مستقلة) في القائمة أعطيه أطباقاً بأسماء مختلفة عن البقية.";

  return `# سياق العائلة

ملخص العائلة: ${context.composition_summary}${familyWideText(context)}

الخدامة (إن وجدت) تطبخ وتنفّذ الوصفات، وليست فرداً في الخطة.

# أفراد الخطة المطلوبة الآن (استخدمي member_id بالضبط)
${buildRoster(context, targetMemberIds)}${deepDiveText(context)}${momNotesText(context)}${feedbackText(context)}${skeletonEngagementText(context)}

# المطلوب (المرحلة 1: الهيكل فقط)
احسبي لكل بالغ هدفه اليومي (سعرات + ماكروز) حسب منهجيتك (Mifflin-St Jeor + النشاط + الهدف + توزيع الماكروز). مَن هو دون 18: ضعي daily_calories_target تقديرياً فقط (الخطة له بالحصص لا بالسعرات)، ويكون التقدير مبنياً على عمره ووزنه وجنسه ونشاطه ومرحلة نموّه. لا تعطي قاصرَين مختلفَي العمر نفس الرقم — تقدير المراهق (13-17) أعلى بوضوح من تقدير الطفل الصغير.
ثم خطّطي **أسبوعاً كاملاً (7 أيام متتالية)** من **أسماء الأطباق الخليجية فقط** لكل فرد — متنوّعة عبر الأيام، بدون مكونات أو خطوات. ${sharedNote}
التنويع يكون في **الأطباق والنكهات فقط، لا في كمية البروتين**. حافظي على **ثبات البروتين اليومي (والسعرات) عبر الأيام السبعة** لكل فرد — نفس هدفه اليومي في كل يوم، بلا أيام «خفيفة» بروتيناً وأخرى «ثقيلة». وزّعي الأطباق الغنية بالبروتين على جميع الأيام بالتساوي حتى يقع بروتين كل يوم قرب الهدف نفسه.

# الإخراج
أرجعي JSON صالحاً فقط (لا نص قبله/بعده، لا أكواد محاطة)، **مضغوطاً في سطر واحد**: بلا مسافات بادئة وبلا أسطر جديدة بين العناصر — التنسيق الجميل يضاعف الحجم بلا فائدة. الشكل:
\`\`\`ts
type Skeleton = {
  safety_disclaimer_ar: string;            // تذكير مختصر بأن الخطة لا تغني عن الطبيب
  methodology_notes_ar?: string;
  week_changes?: Array<{ change_ar: string; because_ar: string }>; // فقط عند وجود قسم «ما حدث فعلياً في أسبوع العائلة» أعلاه، وإلا احذفيه
  members: Array<{
    member_id: string;                     // كما هو أعلاه
    primary_goal?: "fat_loss"|"muscle_gain"|"body_recomposition"|"athletic_performance"|"metabolic_health"|"digestive_health"|"pregnancy_lactation"|"posture_recovery"|"maintain"|"general_health";
    daily_calories_target: number;
    macros_target: { protein_g: number; carbs_g: number; fat_g: number };
    days: Array<{                          // 7 عناصر
      day_index: number;                   // 0..6 (0 = أول يوم في الخطة)
      day_name_ar: string;
      meals: Array<{ slot: "breakfast"|"lunch"|"dinner"|"snack"; slot_name_ar: string; recipe_name_ar: string }>;
    }>;
  }>;
};
\`\`\``;
}

/**
 * Phase 2 — the dynamic part of one DAY's expansion call: turn that day's named
 * meals into full recipes hitting each member's targets. Runs in parallel.
 */
export function buildDayPrompt(
  context: PlanPromptContext,
  skeleton: PlanSkeleton,
  dayIndex: number,
  dayNameOverride?: string,
): string {
  const dayName = dayNameOverride ?? DAY_NAMES_AR[dayIndex] ?? `اليوم ${dayIndex + 1}`;
  const isSolo = skeleton.members.length === 1;

  // Housekeeper translation is NOT produced in this call. Generating each recipe
  // twice (Arabic + fully translated, amounts and all) here roughly DOUBLED output
  // tokens for maid households. Translation now runs only as a separate LEAN pass
  // (buildTranslatePrompt → names + steps, no re-emitted amounts/macros): the
  // background function calls translateMealPlan at end-of-run for maid households,
  // and the maid view re-triggers it on demand. So the day prompt stays Arabic-only.

  const memberBlocks = skeleton.members
    .map((sm) => {
      const ctxMember =
        sm.member_id === "mom"
          ? null
          : context.family_members.find((m) => m.id === sm.member_id);
      const isChild =
        sm.member_id === "mom"
          ? isChildByAge(context.mom.member_type, context.mom.age)
          : (ctxMember?.is_child ?? false);
      const minorAge = sm.member_id === "mom" ? context.mom.age : (ctxMember?.age ?? null);
      const minorIsMale =
        (sm.member_id === "mom" ? context.mom.sex : ctxMember?.sex) === "male";

      const constraints: string[] = [];
      const allergies =
        sm.member_id === "mom"
          ? // never-eat foods are hard exclusions like allergies — they must
            // repeat in every day prompt, not just the skeleton roster.
            [...context.mom.allergies, ...(context.mom.never_eat_foods ?? [])]
          : (ctxMember?.allergies ?? []);
      const dislikes =
        sm.member_id === "mom" ? context.mom.dislikes : (ctxMember?.dislikes ?? []);
      const conditions =
        sm.member_id === "mom"
          ? context.mom.medical_conditions
          : (ctxMember?.medical_conditions ?? []);
      if (allergies.length) constraints.push(`حساسية (تجنّب تام): ${allergies.join("، ")}`);
      if (dislikes.length) constraints.push(`لا يحب: ${dislikes.join("، ")}`);
      if (conditions.length) constraints.push(`حالات: ${conditions.join("، ")}`);
      // Meds + nausea are per-meal-relevant (timing / temporary aversions), so
      // they repeat in every day prompt; everything else questionnaire-related
      // stays skeleton-only for token economy.
      const medications =
        sm.member_id === "mom" ? context.mom.medications : (ctxMember?.medications ?? []);
      const nauseaFoods =
        sm.member_id === "mom" ? context.mom.nausea_foods : (ctxMember?.nausea_foods ?? []);
      if (medications.length)
        constraints.push(`أدوية: ${medications.join("، ")} (نسّقي توقيت الوجبات؛ لا نصيحة دوائية)`);
      if (nauseaFoods.length)
        constraints.push(`غثيان من: ${nauseaFoods.join("، ")} (تجنّب مؤقت)`);
      const mealMode =
        sm.member_id === "mom" ? context.mom.meal_mode : ctxMember?.meal_mode;
      if (mealMode === "independent")
        constraints.push("وجبات مستقلة (طبق خاص باسم مختلف)");

      const day = sm.days.find((d) => d.day_index === dayIndex);
      const meals = (day?.meals ?? [])
        .map((m) => `${m.slot_name_ar} (${m.slot}): ${m.recipe_name_ar}`)
        .join(" | ");

      // Aim band shown to the model (calories ±5%); code enforces wider hard
      // bands and re-rolls the day when an adult lands outside either (see
      // dayCalorieDeviations / dayProteinDeviations). Protein gets its own
      // explicit band — days must match on protein too, and it can only be
      // steered here (composition), never fixed by the code-side rescale.
      const aimBand = Math.round(sm.daily_calories_target * 0.05);
      // Kept in sync with DAY_PROTEIN_BAND_PCT / DAY_PROTEIN_BAND_MIN_G in
      // generate.ts — the band shown to the model must match what the code
      // enforces, so the model aims for the same window the re-roll checks.
      const proteinBand = Math.max(
        15,
        Math.round(sm.macros_target.protein_g * 0.07),
      );
      // A minor's line carries the stage and the age too: this prompt is the one
      // that sizes the actual food, and «طفل — بالحصص» alone was how a
      // sixteen-year-old ended up eating a ten-year-old's portions.
      const target = isChild
        ? `${minorStage(minorAge) === "adolescent" ? (minorIsMale ? "مراهق" : "مراهقة") : minorIsMale ? "طفل" : "طفلة"}${
            minorAge != null ? ` (${yearsAr(minorAge)})` : ""
          } — بالحصص حسب العمر والوزن ومرحلة النمو، بدون هدف سعرات`
        : `الهدف: ${sm.daily_calories_target} سعرة (مجموع اليوم المقبول: من ${sm.daily_calories_target - aimBand} إلى ${sm.daily_calories_target + aimBand})، بروتين ${sm.macros_target.protein_g} جم (مجموع بروتين اليوم المقبول: من ${sm.macros_target.protein_g - proteinBand} إلى ${sm.macros_target.protein_g + proteinBand}) / كارب ${sm.macros_target.carbs_g} / دهون ${sm.macros_target.fat_g} (جم)`;

      // No preset dishes for this member today (the skeleton omitted this day, and
      // the family grid is empty during a shared-group regen) → don't print "—",
      // which the model echoes back as an empty `meals` array (DaySlice requires
      // ≥1 → the day fails, and every retry re-rolls the same empty target). Direct
      // a full fresh day that meets the target instead; the prompt lists every
      // member's dishes, so a shared member can still align to a peer that DOES have
      // this day's dishes.
      const mealsLine =
        meals ||
        "لا أطباق محددة لهذا الفرد اليوم — صمّمي له يوماً كاملاً متنوعاً (فطور، غداء، عشاء، وسناك حسب اللزوم) يحقق هدفه، وشاركيه أطباق الآخرين حين تناسبه.";

      return `• member_id="${sm.member_id}" — ${target}${constraints.length ? `؛ ${constraints.join("؛ ")}` : ""}\n  وجبات اليوم: ${mealsLine}`;
    })
    .join("\n");

  // Dish-once (Stage 3, PLAN_DISH_ONCE=1): each dish written ONCE with one
  // portion line per sharer — the SAME sharing policy, a cheaper wire shape.
  // The mechanical instructions and the الإخراج block move together with the
  // flag; generateDay picks the matching enforced schema, so the model is
  // never asked one shape and constrained to another.
  const dishOnce = DISH_ONCE_EMISSION && !isSolo;
  const sharedRule = isSolo
    ? "كل وجبة مخصصة لها فقط (لا مشاركة)."
    : dishOnce
      ? "اكتبي **كل طبق مرة واحدة فقط** في قائمة ds، ومعه سطر حصة (في ps) لكل فرد يأكله: كمياته من كل مكوّن بنفس ترتيب قائمة المكونات، وسعراته وماكروزه لحصته هو. " +
        "الطبق المشترك = عنصر واحد في ds بعدة أسطر ps؛ والطبق الخاص بفرد = عنصر في ds بسطر ps واحد. " +
        "شاركي الطبق فقط حين يناسب الجميع فعلاً (لا حساسية متعارضة ولا قيد غذائي/كره قوي ولا اختلاف ماكروز/حالة طبية يمنع ذلك). مَن لا يناسبه الطبق — أو مَن وُسم بـ(وجبات مستقلة) — أعطيه طبقاً مختلفاً **باسم مختلف** لتلك الوجبة. " +
        "النظام يجمع الحصص تلقائياً في وصفة عائلية واحدة ويحسب التوزيع — لا تكتبي كميات إجمالية ولا نسباً. للقاصرين: حصة مناسبة للعمر ومرحلة النمو بدون معادلات سعرات — حصة المراهق أكبر بوضوح من حصة الطفل الصغير."
      : "اكتبي لكل فرد وجبته بمقادير **حصته الفردية فقط** (ما يأكله هو وحده)، مع سعراته وماكروزه لحصته. " +
      "حين يناسب نفس الطبق أكثر من فرد، أعطيهم **نفس اسم الطبق ونفس قائمة المكوّنات بالضبط** (نفس الأصناف ونفس الوحدات)، ويختلفون فقط في **كمية** كل مكوّن حسب هدف كل فرد. النظام يجمع حصص المشاركين تلقائياً في وصفة عائلية واحدة بإجمالي الكميات ويحسب التوزيع — لذلك **لا** تكتبي shared_recipe ولا batch_finished_weight_g ولا per_member_portions، و**لا** تضعي الكمية الإجمالية في ingredients (ضعي حصة الفرد فقط). " +
      "شاركي الطبق فقط حين يناسب الجميع فعلاً (لا حساسية متعارضة ولا قيد غذائي/كره قوي ولا اختلاف ماكروز/حالة طبية يمنع ذلك). مَن لا يناسبه الطبق — أو مَن وُسم بـ(وجبات مستقلة) — أعطيه طبقاً مختلفاً **باسم مختلف** لتلك الوجبة. للقاصرين: حصة مناسبة للعمر ومرحلة النمو بدون معادلات سعرات — حصة المراهق أكبر بوضوح من حصة الطفل الصغير.";

  const terseOutputBlock = `# الإخراج
أرجعي JSON صالحاً فقط لهذا اليوم، **مضغوطاً في سطر واحد**: بلا مسافات بادئة، بلا أسطر جديدة، وبلا مسافات بين العناصر (مثل \`{"d":0,"ms":[{"id":"mom",...}]}\`) — التنسيق الجميل يضاعف الحجم بلا فائدة. استخدمي **المفاتيح المختصرة التالية بالضبط** (لتصغير الحجم)، ولا تضيفي أي مفاتيح أخرى (لا day_total ولا slot_name_ar — نحسبهما نحن):
\`\`\`ts
type DaySlice = {
  d: number;                               // day_index = ${dayIndex}
  ms: Array<{                              // الأفراد (members)
    id: string;                            // member_id كما هو أعلاه
    m: Array<{                             // وجبات اليوم (meals)
      s: "breakfast"|"lunch"|"dinner"|"snack";   // الوجبة (slot)
      r: string;                           // اسم الطبق
      ig: Array<{ n: string; a: number; mn?: number; mx?: number; u: "g"|"kg"|"ml"|"l"|"tbsp"|"tsp"|"cup"|"piece"|"serving"|"unlimited" }>;  // المكونات: n=الاسم، a=الكمية، mn/mx=نطاق اختياري، u=الوحدة
      st: string[];                        // خطوات التحضير
      sub?: string[];                      // بدائل (اختياري)
      nt?: string;                         // ملاحظات (اختياري)
      c: number;                           // السعرات
      mc: { p: number; cb: number; f: number };  // ماكروز الحصة: p=بروتين، cb=كارب، f=دهون (جم)
    }>;
  }>;
};
\`\`\``;
  const dishOnceOutputBlock = `# الإخراج
أرجعي JSON صالحاً فقط لهذا اليوم، **مضغوطاً في سطر واحد**: بلا مسافات بادئة وبلا أسطر جديدة — التنسيق الجميل يضاعف الحجم بلا فائدة. **كل طبق يُكتب مرة واحدة** في ds ومعه سطر حصة لكل من يأكله في ps (الكميات بنفس ترتيب ig). لا تضيفي أي مفاتيح أخرى:
\`\`\`ts
type DaySlice = {
  d: number;                               // day_index = ${dayIndex}
  ds: Array<{                              // أطباق اليوم — كل طبق مرة واحدة
    s: "breakfast"|"lunch"|"dinner"|"snack";   // الوجبة (slot)
    r: string;                             // اسم الطبق
    ig: Array<{ n: string; u: "g"|"kg"|"ml"|"l"|"tbsp"|"tsp"|"cup"|"piece"|"serving"|"unlimited" }>;  // المكونات: أسماء ووحدات فقط — الكميات في ps
    st: string[];                          // خطوات التحضير
    sub?: string[];                        // بدائل (اختياري)
    nt?: string;                           // ملاحظات (اختياري)
    ps: Array<{                            // حصة كل فرد يأكل هذا الطبق
      id: string;                          // member_id كما هو أعلاه
      a: number[];                         // كمياته من كل مكوّن، بنفس ترتيب ig وبطولها تماماً
      c: number;                           // سعرات حصته
      mc: { p: number; cb: number; f: number };  // ماكروز حصته (جم)
    }>;
  }>;
};
\`\`\``;
  const outputBlock = dishOnce ? dishOnceOutputBlock : terseOutputBlock;

  return `# المطلوب (المرحلة 2: توسيع يوم واحد)
وسّعي وجبات **${dayName}** (day_index=${dayIndex}) فقط، لكل فرد، إلى وصفات كاملة تحقق هدف كل فرد. **قيد إلزامي**: مجموع سعرات اليوم **ومجموع بروتين اليوم** لكل بالغ يجب أن يقعا داخل النطاقين المقبولين المذكورين بجانب هدفه — اجمعي سعرات وبروتين وجبات كل فرد قبل الإخراج؛ إن خرجت السعرات عن نطاقها فعدّلي أحجام الحصص والمقادير، وإن خرج البروتين عن نطاقه فعدّلي تركيبة المكونات (زيدي أو بدّلي مصادر البروتين ومقابلها أنقصي الكارب أو الدهون) لأن تغيير حجم الحصة وحده لا يصلح البروتين دون كسر السعرات. أسماء الأطباق المعطاة لكل فرد هي خطة العائلة لهذا اليوم: التزمي بها **بنفس الاسم تماماً** حين تناسب الفرد (حتى تبقى وجبة عائلية واحدة تُطبخ مرة واحدة وتُقسَّم). أما إذا كان الطبق لا يناسب فرداً فعلاً — حساسية أو حالة طبية أو اختلاف هدف/ماكروز جذري أو طفل/حمل/رضاعة — فأعطيه بدلاً منه طبقاً مناسباً له **باسم مختلف بوضوح** لتلك الوجبة (سيُعامل تلقائياً كوجبة فردية). الأولوية لملاءمة الفرد، لا لتوحيد الطبق. وإن لم تُعطَ أطباق لفردٍ ما (مكتوب: «لا أطباق محددة»)، فصمّمي له يوماً كاملاً مناسباً لهدفه — ولا تتركي وجباته فارغة أبداً.

${sharedRule}

# الأفراد ووجبات هذا اليوم
${memberBlocks}${familyWideText(context)}${feedbackText(context)}

# الإيجاز
- st (خطوات التحضير): 3 خطوات قصيرة كحد أقصى، صيغة أمر مباشرة بلا حشو.
- الحقول الاختيارية (sub، nt): اتركيها فارغة تماماً إلا عند ضرورة حقيقية.
- قائمة مكونات موجزة. "سلطة حرة" → u:"unlimited".
- ${ownerG(context)(
    "الكتابة بالعربية فقط، بدون علامات تعجب. خاطبي قارئة الخطة بصيغة **المؤنث** (اخلطي، أضيفي، قدّمي).",
    "الكتابة بالعربية فقط، بدون علامات تعجب. خاطبي قارئ الخطة بصيغة **المذكر** (اخلط، أضف، قدّم) — لا تستخدمي صيغة المؤنث في خطوات التحضير أو الملاحظات.",
  )}

${outputBlock}`;
}
