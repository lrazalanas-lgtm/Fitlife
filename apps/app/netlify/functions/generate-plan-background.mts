// Netlify background function (15-min budget) for AI meal-plan generation.
//
// Bundle-safety: zip-it-and-ship-it (esbuild) chokes on @supabase/supabase-js
// (optional native/realtime deps), which crashed this function at cold-start
// import time. So we talk to Supabase over plain `fetch` (PostgREST) and import
// only the PURE, fetch-based engine generator (no SDK) — its transitive deps are
// just zod + pure code, which always bundle. The generation logic (per-member
// parallel calls, system prompt, schema) stays the single source of truth in
// @fitlife/plan-engine; the relative path lets esbuild inline it.

import {
  generateMealPlan,
  translateMealPlan,
  runMealPlanTranslation,
  generationAlreadySettled,
  prepareSharedGroupRegen,
} from "../../../../packages/plan-engine/src/generate";
import {
  runWorkoutPlanGeneration,
  mealGenBlocksWorkout,
} from "../../../../packages/plan-engine/src/workout/generate";
import { WorkoutProfileSchema } from "../../../../packages/plan-engine/src/workout/schema";
import { summarizeWorkoutFeedback } from "../../../../packages/plan-engine/src/workout/feedback";
import {
  dayLoopDeadline,
  planRunBudgetMs,
  canFit,
  FINALIZE_RESERVE_MS,
  MIN_VIABLE_CALL_MS,
} from "../../../../packages/plan-engine/src/budget";
import { LOCALE_CODES, MealPlanSchema } from "../../../../packages/plan-engine/src/schema";
import type { MealPlan, LocaleCode } from "../../../../packages/plan-engine/src/schema";
import type {
  PlanPromptContext,
  PlanPromptContextMember,
} from "../../../../packages/plan-engine/src/buildContext";
import {
  ownerRequiresDoctorSignOff,
  memberRequiresDoctorSignOff,
} from "../../../../packages/plan-engine/src/medicalGate";
import { getBeneficiaries } from "../../../../packages/plan-engine/src/buildContext";
import {
  shouldChainContinuation,
  PLAN_CHAIN_MAX_HOPS,
} from "../../../../packages/plan-engine/src/chain";
import { planModelLabel } from "../../../../packages/plan-engine/src/constants";
import { isChildByAge } from "../../../../packages/plan-engine/src/childRule";
// Error reporting over plain fetch — @sentry/* cannot be bundled here for the
// same reason @supabase/supabase-js cannot (see the note above). Without this
// the function reported nothing at all: every failure died in the Netlify log.
import { captureToSentry } from "../../../../packages/plan-engine/src/sentryReport";
import { computeEngagementDigest } from "../../../../packages/plan-engine/src/engagementDigest";
import type {
  EngagementCheckinRow,
  EngagementVerdictRow,
} from "../../../../packages/plan-engine/src/engagementDigest";

type Activity =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active"
  | null;

// ─── Supabase PostgREST over fetch (service-role) ──────────────────────────
/**
 * Constant-time string compare for the shared secret. `!==` leaks length and
 * prefix information through timing; the secret is long-lived, so that is worth
 * closing even though the window is small.
 */
function timingSafeEqualStr(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sbHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };
}

async function sbSelectOne(
  base: string,
  serviceKey: string,
  table: string,
  query: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
    headers: sbHeaders(serviceKey),
  });
  if (!res.ok) throw new Error(`PostgREST select ${table} → ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function sbSelectMany(
  base: string,
  serviceKey: string,
  table: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
    headers: sbHeaders(serviceKey),
  });
  if (!res.ok) throw new Error(`PostgREST select ${table} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>[];
}

async function sbUpdate(
  base: string,
  serviceKey: string,
  table: string,
  filter: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...sbHeaders(serviceKey), prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PostgREST update ${table} → ${res.status} ${text}`);
  }
}

/** Defensive jsonb parse — malformed workout_profile means "not opted in". */
function parseWorkoutProfileLoose(v: unknown) {
  if (v == null) return undefined;
  const parsed = WorkoutProfileSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Minimal SDK-free adapter exposing the tiny client surface
 * runWorkoutPlanGeneration uses (from(t).update(v).eq(c, val), optional
 * second .eq) over the existing PostgREST fetch helpers. Keeps the function
 * bundle free of @supabase/supabase-js like the rest of this file.
 */
/**
 * A minimal PostgREST stand-in shaped like the supabase-js calls the engine
 * makes, so engine functions can run inside this SDK-free bundle.
 *
 * It grew `insert().select().maybeSingle()` when translate mode stopped having
 * its own copy of the translation logic. That copy was the problem: the lock,
 * the run deadline and the cook's gender were all added to
 * `runMealPlanTranslation` while PRODUCTION went through a duplicate here that
 * had none of them — the exact "same rule implemented twice, one copy drifted"
 * pattern this codebase has been bitten by repeatedly. One implementation now.
 */
function makeFetchSupabase(base: string, serviceKey: string) {
  return {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          return {
            select() {
              return {
                async maybeSingle() {
                  try {
                    const row = await sbInsertReturning(base, serviceKey, table, values);
                    return { data: row, error: null };
                  } catch (e) {
                    // The unique-violation code is what the caller keys off to
                    // decide "someone else holds the lock" rather than "broken".
                    const code =
                      e instanceof PostgrestInsertError ? e.code : undefined;
                    return { data: null, error: { code, message: String(e) } };
                  }
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          const filters: string[] = [];
          const runner = {
            eq(col: string, val: string) {
              filters.push(`${col}=eq.${encodeURIComponent(val)}`);
              return {
                ...runner,
                then(resolve: (v: { error: null | { message: string } }) => void) {
                  sbUpdate(base, serviceKey, table, filters.join("&"), values).then(
                    () => resolve({ error: null }),
                    (e) => resolve({ error: { message: String(e) } }),
                  );
                },
              };
            },
          };
          return runner;
        },
      };
    },
  } as never;
}

/** Carries PostgREST's error code (23505 = unique violation) to the caller. */
class PostgrestInsertError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PostgrestInsertError";
  }
}

/** Insert and return the created row, so a caller can keep its id. */
async function sbInsertReturning(
  base: string,
  serviceKey: string,
  table: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(serviceKey), prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let code: string | undefined;
    try {
      code = (JSON.parse(text) as { code?: string }).code;
    } catch {
      /* non-JSON body — the message alone has to do */
    }
    throw new PostgrestInsertError(
      `PostgREST insert ${table} → ${res.status} ${text}`,
      code,
    );
  }
  try {
    const rows = JSON.parse(text) as Record<string, unknown>[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}


/**
 * Mint the next hop's rows and POST this function to itself.
 *
 * Sequenced against the 00014 per-kind lock: the caller has already closed its
 * own plan_generations row ('completed'), so the child's 'started' insert here
 * is the lock CLAIM. A 23505 means a page-mounted drain or a manual regenerate
 * legitimately won the seconds-wide unlock window — archive our child row (the
 * exact createPlanRows race protocol) and yield: someone else is continuing.
 *
 * The POST targets `req.url` with the in-process secret, never an env-derived
 * URL — CLAUDE.md documents Next-runtime/Functions-runtime env-scope mismatch
 * as a real silent failure mode, and req.url is correct by construction.
 *
 * On ANY enqueue failure — non-202 or an exception (the 8s abort included) —
 * roll back: archive the child plan row, fail its gen row. This is safe even if
 * the POST actually WAS enqueued and the abort was just slow plumbing: a late-
 * starting child hits its idempotency probe, finds the archived/failed rows,
 * and no-ops ("Already settled"). What must NOT be copied here is dispatch.ts's
 * "timeout = probably enqueued" optimism — the app-side dispatcher has a user
 * watching a spinner and a sweeper to clean up; a leaked orphan lock from a
 * background hop has neither, it just blocks the household's next run for 90s+.
 * Rollback restores today's exact drain-recoverable state; the chain is an
 * upgrade over it, never a new way to wedge.
 *
 * Returns true when the continuation was dispatched (exactly 202).
 */
async function dispatchChainContinuation(params: {
  reqUrl: string;
  secret: string;
  supabaseUrl: string;
  serviceKey: string;
  userId: string;
  /** The CHILD's depth (parent's + 1). */
  chainDepth: number;
  feedback?: string;
  limitMemberIds?: string[];
}): Promise<boolean> {
  const { reqUrl, secret, supabaseUrl, serviceKey, userId, chainDepth } = params;
  const childId = crypto.randomUUID();

  // Child rows, mirroring createPlanRows (meal_plans first, then the gen row —
  // whose insert is the lock claim under the 00014 partial unique index).
  try {
    await sbInsertReturning(supabaseUrl, serviceKey, "meal_plans", {
      id: childId,
      user_id: userId,
      status: "generating",
      plan_data: {},
      ai_model: planModelLabel(),
    });
  } catch (err) {
    console.error("[generate-plan-background] chain: child plan insert failed", err);
    await captureToSentry(err, { step: "chain-child-plan-insert", userId });
    return false;
  }
  try {
    await sbInsertReturning(supabaseUrl, serviceKey, "plan_generations", {
      user_id: userId,
      meal_plan_id: childId,
      model: planModelLabel(),
      status: "started",
      started_at: new Date().toISOString(),
    });
  } catch (err) {
    const raced =
      err instanceof PostgrestInsertError && err.code === "23505";
    // Archive, never fail: a 'failed' row would become the household's latest
    // plan and flash the failure UI over a healthy in-flight run.
    await sbUpdate(supabaseUrl, serviceKey, "meal_plans", `id=eq.${childId}`, {
      status: "archived",
      error_message: raced
        ? "superseded: another generation was already in flight"
        : "chain continuation: audit row insert failed",
    }).catch((e) =>
      console.error("[generate-plan-background] chain: archive failed", e),
    );
    if (!raced) {
      console.error("[generate-plan-background] chain: gen row insert failed", err);
      await captureToSentry(err, { step: "chain-child-gen-insert", userId });
    }
    return false;
  }

  try {
    const res = await fetch(reqUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({
        userId,
        mealPlanId: childId,
        carryOver: true,
        chainDepth,
        feedback: params.feedback,
        limitMemberIds: params.limitMemberIds,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 202) {
      throw new Error(`chain enqueue: expected 202, got ${res.status}`);
    }
    console.log("[generate-plan-background] chained continuation", {
      userId,
      childId,
      chainDepth,
    });
    return true;
  } catch (err) {
    console.error("[generate-plan-background] chain: enqueue failed", err);
    await captureToSentry(err, { step: "chain-enqueue", userId });
    await sbUpdate(supabaseUrl, serviceKey, "meal_plans", `id=eq.${childId}`, {
      status: "archived",
      error_message: "chain enqueue failed",
    }).catch((e) =>
      console.error("[generate-plan-background] chain: rollback archive failed", e),
    );
    await sbUpdate(
      supabaseUrl,
      serviceKey,
      "plan_generations",
      `meal_plan_id=eq.${childId}`,
      {
        status: "failed",
        error_message: "chain enqueue failed",
        completed_at: new Date().toISOString(),
      },
    ).catch((e) =>
      console.error("[generate-plan-background] chain: rollback gen row failed", e),
    );
    return false;
  }
}

// Read a single plan_data row by id and validate it. Returns the parsed MealPlan
// or null (no row / unparseable). Used by translate mode so the whole plan no
// longer has to ride in the invocation body.
async function fetchPlanById(
  base: string,
  serviceKey: string,
  mealPlanId: string,
): Promise<MealPlan | null> {
  const row = await sbSelectOne(
    base,
    serviceKey,
    "meal_plans",
    `id=eq.${mealPlanId}&select=plan_data`,
  );
  if (!row) return null;
  const parsed = MealPlanSchema.safeParse(row.plan_data);
  return parsed.success ? parsed.data : null;
}

// The carry-over source for an incremental run: the user's latest READY plan
// OTHER than the one we're generating now. createPlanRows inserts the new row as
// 'generating', so the prior plan is unambiguously the newest 'ready' row with a
// different id. Re-read here instead of receiving it by value — passing the prior
// plan in the POST body grew the payload with every carried-over member and, past
// ~3 members, crossed Netlify's background-function invoke payload limit → a
// platform 500 at invoke time.
async function fetchPriorPlan(
  base: string,
  serviceKey: string,
  userId: string,
  currentMealPlanId: string,
): Promise<MealPlan | null> {
  const row = await sbSelectOne(
    base,
    serviceKey,
    "meal_plans",
    `user_id=eq.${userId}&status=eq.ready&id=neq.${currentMealPlanId}&select=plan_data&order=created_at.desc&limit=1`,
  );
  if (!row) return null;
  const parsed = MealPlanSchema.safeParse(row.plan_data);
  return parsed.success ? parsed.data : null;
}

// ─── Context shaping (mirror of buildContext, but fed by PostgREST rows) ────
function ageFromBirthYear(birthYear: number | null): number | null {
  if (!birthYear) return null;
  return new Date().getFullYear() - birthYear;
}
function arabicNumber(n: number): string {
  return new Intl.NumberFormat("ar-SA", { useGrouping: false }).format(n);
}
function pluralizeAr(c: number, s: string, d: string, p: string) {
  if (c === 1) return s;
  if (c === 2) return d;
  return p;
}
function buildCompositionSummary(
  members: PlanPromptContextMember[],
  ownerIsMale: boolean,
): string {
  const partners = members.filter((m) => m.role === "dad");
  const kids = members.filter((m) => m.role === "son" || m.role === "daughter");
  const housekeepers = members.filter((m) => m.role === "housekeeper");
  const total = 1 + partners.length + kids.length;
  const parts: string[] = [
    `عائلة من ${arabicNumber(total)} ${pluralizeAr(total, "فرد", "فردين", "أفراد")}: ${ownerIsMale ? "الأب" : "الأم"}`,
  ];
  if (partners.length > 0) parts.push("الأب");
  if (kids.length > 0) {
    const ages = kids.map((k) => k.age).filter((a): a is number => a !== null);
    if (ages.length === kids.length) {
      parts.push(
        `و${pluralizeAr(kids.length, "طفل", "طفلان", "أطفال")} (${ages.map((a) => `${arabicNumber(a)} سنة`).join("، ")})`,
      );
    } else {
      parts.push(
        `و${arabicNumber(kids.length)} ${pluralizeAr(kids.length, "طفل", "طفلان", "أطفال")}`,
      );
    }
  }
  let summary = parts.join("، ") + ".";
  if (housekeepers.length > 0) {
    summary +=
      " يوجد خادمة تطبخ للعائلة وتنفذ الوصفات (ليست من المستفيدين من الخطة الغذائية).";
  }
  return summary;
}

class GateError extends Error {}

async function buildContextViaFetch(
  base: string,
  serviceKey: string,
  userId: string,
): Promise<PlanPromptContext> {
  const profile = await sbSelectOne(
    base,
    serviceKey,
    "profiles",
    `id=eq.${userId}&select=*`,
  );
  if (!profile) throw new GateError("Onboarding incomplete");
  if (!profile.onboarding_completed_at) throw new GateError("Onboarding incomplete");

  const medicalConditions = (profile.medical_conditions as string[] | null) ?? [];
  // Same rule as the app — imported, not mirrored. medicalGate.ts is pure and
  // dependency-free, so the bundle stays SDK-free.
  if (
    ownerRequiresDoctorSignOff({
      medical_conditions: medicalConditions,
      has_medical_conditions: profile.has_medical_conditions as boolean | null,
      is_pregnant: profile.is_pregnant as boolean | null,
    }) &&
    !profile.consulted_doctor
  ) {
    throw new GateError("Medical consultation required");
  }

  const family = await sbSelectMany(
    base,
    serviceKey,
    "family_members",
    `user_id=eq.${userId}&select=*&order=display_order.asc`,
  );

  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  // Per-member medical gate (same shared rule as the engine's buildContext).
  for (const m of family) {
    if (
      memberRequiresDoctorSignOff({
        medical_conditions: asStrings(m.medical_conditions),
        high_risk_pregnancy: m.high_risk_pregnancy as boolean | null,
      }) &&
      m.consulted_doctor !== true
    ) {
      throw new GateError("Medical consultation required");
    }
  }

  const family_members: PlanPromptContextMember[] = family.map((m) => {
    const age = ageFromBirthYear((m.birth_year as number | null) ?? null);
    const memberType = (m.member_type as string | null) ?? "adult";
    return {
      id: m.id as string,
      name: m.name as string,
      role: m.role as string,
      member_type: memberType,
      sex: (m.sex as string | null) ?? null,
      age,
      height_cm: (m.height_cm as number | null) ?? null,
      weight_kg: (m.weight_kg as number | null) ?? null,
      activity_level: ((m.activity_level as string | null) ?? null) as Activity,
      primary_goal: (m.primary_goal as string | null) ?? null,
      dietary_restrictions: asStrings(m.dietary_restrictions),
      medical_conditions: asStrings(m.medical_conditions),
      allergies: asStrings(m.allergies),
      dislikes: asStrings(m.dislikes),
      trimester: (m.trimester as number | null) ?? null,
      months_postpartum: (m.months_postpartum as number | null) ?? null,
      high_risk_pregnancy: !!m.high_risk_pregnancy,
      school_meal_handling: (m.school_meal_handling as string | null) ?? null,
      picky_eater: !!m.picky_eater,
      consulted_doctor: m.consulted_doctor === true,
      is_child: isChildByAge(memberType, age),
      preferred_language: m.preferred_language as string,
      meal_mode: m.meal_mode === "independent" ? "independent" : "shared",
      target_weight_kg: (m.target_weight_kg as number | null) ?? null,
      day_nature: (m.day_nature as string | null) ?? null,
      exercise_days: (m.exercise_days as string | null) ?? null,
      exercise_type: (m.exercise_type as string | null) ?? null,
      water_cups: (m.water_cups as number | null) ?? null,
      water_liters: (m.water_liters as string | null) ?? null,
      sleep_hours: (m.sleep_hours as number | null) ?? null,
      medications: asStrings(m.medications),
      supplements: asStrings(m.supplements),
      nausea_foods: asStrings(m.nausea_foods),
      feeding_mode: (m.feeding_mode as string | null) ?? null,
      workout_profile: parseWorkoutProfileLoose(m.workout_profile),
    };
  });

  // Housekeeper's reading language (only when she exists and it's not Arabic) —
  // drives the day-prompt translation directive. Mirrors buildContext.ts.
  const housekeeper = family_members.find((m) => m.role === "housekeeper");
  const hkLang = housekeeper?.preferred_language;
  const housekeeper_locale =
    hkLang && hkLang !== "ar" && (LOCALE_CODES as readonly string[]).includes(hkLang)
      ? (hkLang as LocaleCode)
      : undefined;

  return {
    mom: {
      id: profile.id as string,
      display_name: (profile.display_name as string | null) ?? null,
      sex: (profile.sex as string | null) ?? null,
      member_type: (profile.member_type as string | null) ?? "adult",
      age: ageFromBirthYear((profile.birth_year as number | null) ?? null),
      height_cm: (profile.height_cm as number | null) ?? null,
      weight_kg: (profile.weight_kg as number | null) ?? null,
      activity_level: ((profile.activity_level as string | null) ?? null) as Activity,
      primary_goal: (profile.primary_goal as string | null) ?? null,
      dietary_restrictions: (profile.dietary_restrictions as string[] | null) ?? [],
      cuisine_preference: profile.cuisine_preference as string,
      medical_conditions: medicalConditions,
      allergies: asStrings(profile.allergies),
      dislikes: asStrings(profile.dislikes),
      is_pregnant: !!profile.is_pregnant,
      pregnancy_trimester: (profile.pregnancy_trimester as number | null) ?? null,
      months_postpartum: (profile.months_postpartum as number | null) ?? null,
      high_risk_pregnancy: !!profile.high_risk_pregnancy,
      consulted_doctor: !!profile.consulted_doctor,
      // Mirror buildContext.ts — mom's meal_mode was missing here, leaving it
      // undefined on the prod context (PlanPromptContextMom requires it).
      meal_mode: profile.meal_mode === "independent" ? "independent" : "shared",
      target_weight_kg: (profile.target_weight_kg as number | null) ?? null,
      day_nature: (profile.day_nature as string | null) ?? null,
      exercise_days: (profile.exercise_days as string | null) ?? null,
      exercise_type: (profile.exercise_type as string | null) ?? null,
      water_cups: (profile.water_cups as number | null) ?? null,
      water_liters: (profile.water_liters as string | null) ?? null,
      sleep_hours: (profile.sleep_hours as number | null) ?? null,
      medications: asStrings(profile.medications),
      supplements: asStrings(profile.supplements),
      nausea_foods: asStrings(profile.nausea_foods),
      notes: (profile.notes as string | null) ?? null,
      never_eat_foods: asStrings(profile.never_eat_foods),
      sleep_band: (profile.sleep_band as string | null) ?? null,
      feeding_mode: (profile.feeding_mode as string | null) ?? null,
      pregnancy_month: (profile.pregnancy_month as number | null) ?? null,
      workout_profile: parseWorkoutProfileLoose(profile.workout_profile),
      deep_dive: {
        waist_cm: (profile.waist_cm as number | null) ?? null,
        hip_cm: (profile.hip_cm as number | null) ?? null,
        steps_daily: (profile.steps_daily as number | null) ?? null,
        exercise_duration: (profile.exercise_duration as string | null) ?? null,
        liked_foods: asStrings(profile.liked_foods),
        meals_per_day: (profile.meals_per_day as number | null) ?? null,
        snacks_habit: (profile.snacks_habit as string | null) ?? null,
        breakfast_habit: (profile.breakfast_habit as string | null) ?? null,
        intermittent_fasting: (profile.intermittent_fasting as string | null) ?? null,
        food_recall_24h: (profile.food_recall_24h as string | null) ?? null,
        sleep_quality: (profile.sleep_quality as string | null) ?? null,
        stress_level: (profile.stress_level as string | null) ?? null,
        who_cooks: (profile.who_cooks as string | null) ?? null,
        cooking_time: (profile.cooking_time as string | null) ?? null,
        previous_diets: (profile.previous_diets as string | null) ?? null,
        food_budget: (profile.food_budget as string | null) ?? null,
      },
    },
    family_members,
    family_wide: {
      dietary_restrictions: asStrings(profile.family_dietary_restrictions),
      dislikes: asStrings(profile.family_dislikes),
      cooking_methods: asStrings(profile.cooking_methods),
      meal_out_frequency: (profile.meal_out_frequency as string | null) ?? null,
    },
    composition_summary: buildCompositionSummary(
      family_members,
      (profile.sex as string | null) === "male",
    ),
    housekeeper_locale,
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────
const handler = async (req: Request): Promise<Response> => {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // The caller's shared secret. Prefer a dedicated value; fall back to the
  // service-role key so a deployment that has not set INTERNAL_FUNCTION_SECRET
  // yet keeps working. See getInternalFunctionSecret in the app.
  const expected =
    process.env.INTERNAL_FUNCTION_SECRET?.trim() || serviceKey;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // A missing SUPABASE_SERVICE_ROLE_KEY is a MISCONFIGURATION, not a failed
  // auth. It used to be folded into the 401 below, so the one variable whose
  // absence stops this worker dead reported itself as "Unauthorized" — the
  // least diagnosable answer available. Check the env first, and NAME what is
  // missing.
  if (!serviceKey || !supabaseUrl || !anthropicKey) {
    const missingEnv = [
      !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
      !supabaseUrl && "NEXT_PUBLIC_SUPABASE_URL",
      !anthropicKey && "ANTHROPIC_API_KEY",
    ].filter(Boolean) as string[];
    console.error("[generate-plan-background] missing env", { missingEnv });
    await captureToSentry(
      new Error(`background function missing env: ${missingEnv.join(", ")}`),
      { step: "bg-env-gate", tags: { missing: missingEnv.join(",") } },
    );
    return new Response("Server misconfigured", { status: 500 });
  }
  if (
    !expected ||
    !timingSafeEqualStr(req.headers.get("x-internal-secret"), expected)
  ) {
    // Netlify answers a *-background function with 202 BEFORE this handler runs,
    // so the dispatcher can never observe this refusal — and until now it also
    // printed NOTHING. That made a secret mismatch the most invisible way for
    // generation to stop working: the plan row sits 'generating', the app
    // believes it enqueued fine, and no log anywhere mentions the run. Record
    // it. Presence and lengths only — never the values themselves.
    const received = req.headers.get("x-internal-secret");
    console.error("[generate-plan-background] auth rejected", {
      hasInternalSecret: !!process.env.INTERNAL_FUNCTION_SECRET?.trim(),
      receivedLen: received?.length ?? 0,
      expectedLen: expected?.length ?? 0,
    });
    await captureToSentry(new Error("background function auth rejected"), {
      step: "bg-auth-gate",
      tags: {
        hasInternalSecret: String(!!process.env.INTERNAL_FUNCTION_SECRET?.trim()),
        secretsMatchLength: String((received?.length ?? 0) === (expected?.length ?? 0)),
      },
    });
    return new Response("Unauthorized", { status: 401 });
  }

  let body: {
    userId?: string;
    mealPlanId?: string;
    // Carry-over INTENT only. When true the fn re-reads the prior plan from the DB
    // (fetchPriorPlan) — the plan is no longer shipped in the body (payload limit).
    carryOver?: boolean;
    mode?: "generate" | "translate" | "workout";
    workoutPlanId?: string;
    weekStartDate?: string;
    locale?: LocaleCode;
    feedback?: string;
    independentRegen?: boolean;
    // One-at-a-time add: generate ONLY this member; carry everyone else over.
    onlyMemberId?: string;
    // Shared-group regen (a new SHARED member was added): rebuild every shared
    // beneficiary together; carry independent members + the housekeeper verbatim.
    regenerateSharedGroup?: boolean;
    // Per-member edit/regenerate target — authoritative for the loading screen's
    // member name (generating_member_id), even with other members still incomplete.
    regenerateMemberId?: string;
    // Literal partial regenerate scope (regenerate-scope dialog). With this set,
    // the carried prior plan is kept WHOLE (target not stripped).
    regenScope?: "individual" | "shared" | "both";
    // Tier cap: when the family exceeds the plan limit, the allow-list of non-mom
    // beneficiary ids to generate this run (mom is always included). Others defer.
    limitMemberIds?: string[];
    // Continuation chaining: how many hops deep this invocation is. 0 (absent)
    // for a user-dispatched run; each self-dispatched continuation increments.
    // Clamped, never trusted raw — the cap is what bounds a poisoned chain.
    chainDepth?: number;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const { userId, mealPlanId } = body;
  // Mode-aware validation: workout runs carry workoutPlanId instead of
  // mealPlanId; the meal/translate paths keep their original contract.
  if (!userId || (body.mode === "workout" ? !body.workoutPlanId : !mealPlanId)) {
    return new Response("Missing userId or plan id", { status: 400 });
  }

  // ── Workout mode: generate the opt-in exercise program ──
  if (body.mode === "workout") {
    const workoutPlanId = body.workoutPlanId!;
    // Idempotency guard (same contract as the meal path): a replayed invoke
    // for a settled row must not burn a second run. Oldest generation row for
    // this workout_plan_id is the dispatch row.
    try {
      const planRow = await sbSelectOne(
        supabaseUrl,
        serviceKey,
        "workout_plans",
        `id=eq.${workoutPlanId}&select=status`,
      );
      const genRows = await sbSelectMany(
        supabaseUrl,
        serviceKey,
        "plan_generations",
        `workout_plan_id=eq.${workoutPlanId}&select=status&order=created_at.asc&limit=1`,
      );
      if (
        generationAlreadySettled({
          mealPlanStatus: (planRow?.status as string | undefined) ?? null,
          dispatchGenStatus: (genRows[0]?.status as string | undefined) ?? null,
        })
      ) {
        console.log(
          "[generate-plan-background] duplicate/settled workout invocation — no-op",
          { userId, workoutPlanId },
        );
        return new Response("Already settled", { status: 200 });
      }
    } catch (guardErr) {
      console.error("[generate-plan-background] workout idempotency probe failed", guardErr);
      // Warning, not error: the run proceeds. But a probe that keeps failing
      // means duplicate-run protection is silently off.
      await captureToSentry(guardErr, {
        step: "workout-idempotency-probe",
        userId,
        level: "warning",
      });
    }

    // Meals-first sequencing: while a meal generation is live for this user,
    // hold off so meals get the full API budget (the user's explicit priority
    // — both plans share one Anthropic key). Capped: past the cap we proceed
    // in the meal run's tail rather than never finishing; the workout itself
    // takes ~1-3 min, well inside the 15-min function budget. No meal run
    // (dashboard opt-in, retry) → the first check falls through instantly.
    {
      const WAIT_POLL_MS = 10_000;
      const WAIT_MAX_MS = 8 * 60_000;
      const waitStart = Date.now();
      let waited = false;
      for (;;) {
        let mealGens: Array<{ status?: string; started_at?: string }> = [];
        try {
          mealGens = (await sbSelectMany(
            supabaseUrl,
            serviceKey,
            "plan_generations",
            `user_id=eq.${userId}&status=eq.started&plan_kind=eq.meal&select=status,started_at&limit=1`,
          )) as Array<{ status?: string; started_at?: string }>;
        } catch (waitErr) {
          // Probe failure must not stall the workout — proceed.
          console.error("[generate-plan-background] meal-gen probe failed", waitErr);
          break;
        }
        if (!mealGenBlocksWorkout(mealGens, Date.now())) break;
        if (Date.now() - waitStart >= WAIT_MAX_MS) {
          console.log(
            "[generate-plan-background] meal generation still live after cap — proceeding in parallel tail",
            { userId, workoutPlanId, waitedMs: Date.now() - waitStart },
          );
          break;
        }
        waited = true;
        await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      }
      if (waited) {
        console.log("[generate-plan-background] meals-first wait finished", {
          userId,
          workoutPlanId,
          waitedMs: Date.now() - waitStart,
        });
      }
    }

    try {
      const context = await buildContextViaFetch(supabaseUrl, serviceKey, userId);
      // Intensity feedback (00022): recent per-member ratings steer this
      // week's volume/intensity via the trainee prompt's adaptation clause.
      // Best-effort — a pre-apply prod (no table / no column) simply yields
      // no clause, never a failed run.
      try {
        const since = new Date(Date.now() - 21 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const rows = (await sbSelectMany(
          supabaseUrl,
          serviceKey,
          "workout_checkins",
          `user_id=eq.${userId}&local_date=gte.${since}&select=member_id,status,intensity&limit=500`,
        )) as Array<{ member_id: string | null; status: string; intensity?: string | null }>;
        const feedback = summarizeWorkoutFeedback(rows);
        if (feedback["mom"]) context.mom.workout_feedback = feedback["mom"];
        for (const m of context.family_members) {
          if (feedback[m.id]) m.workout_feedback = feedback[m.id];
        }
      } catch (fbErr) {
        console.log(
          "[generate-plan-background] workout feedback unavailable (pre-00022 prod?) — proceeding without",
          String(fbErr),
        );
      }
      const sb = makeFetchSupabase(supabaseUrl, serviceKey);
      await runWorkoutPlanGeneration({
        supabase: sb,
        anthropicApiKey: anthropicKey,
        workoutPlanId,
        context,
        weekStartDate: body.weekStartDate ?? new Date().toISOString().slice(0, 10),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } catch (err) {
      // runWorkoutPlanGeneration already terminalized both rows on failure.
      console.error("[generate-plan-background] workout generation failed", err);
      await captureToSentry(err, { step: "workout-generation", userId });
      return new Response("Workout generation failed", { status: 200 });
    }
  }

  // Beyond this point every mode operates on the meal plan row.
  if (!mealPlanId) {
    return new Response("Missing mealPlanId", { status: 400 });
  }

  // ── Translate mode: translate the existing plan IN PLACE (no regen) ──
  if (body.mode === "translate") {
    if (!body.locale) {
      return new Response("Missing locale", { status: 400 });
    }
    // Re-read the plan from the DB by id instead of taking it in the body.
    const planToTranslate = await fetchPlanById(supabaseUrl, serviceKey, mealPlanId);
    if (!planToTranslate) {
      // No row, or plan_data no longer parses — nothing to translate. Non-fatal:
      // the maid view falls back to Arabic and re-triggers on her next visit.
      return new Response("No plan to translate", { status: 200 });
    }
    // The cook's reading language is on her row; so is her answered الجنس, which
    // decides whether the instructions address a طبّاخ or a طبّاخة.
    const hkRow = await sbSelectOne(
      supabaseUrl,
      serviceKey,
      "family_members",
      `user_id=eq.${userId}&role=eq.housekeeper&select=sex&limit=1`,
    );
    try {
      // ONE implementation. This branch used to carry its own copy of the
      // translation logic, which is how it ended up without the generation lock,
      // without a run deadline and without the cook's gender while all three
      // were added to runMealPlanTranslation — production going through the
      // drifted copy.
      await runMealPlanTranslation({
        supabase: makeFetchSupabase(supabaseUrl, serviceKey),
        anthropicApiKey: anthropicKey,
        userId,
        mealPlanId,
        plan: planToTranslate,
        locale: body.locale,
        cookSex: (hkRow?.sex as string | null) ?? null,
      });
      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("[generate-plan-background] translate failed", err);
      // Non-fatal for the run, but the housekeeper silently gets Arabic she may
      // not read — worth an alert rather than a log line nobody opens.
      await captureToSentry(err, { step: "translate", userId });
      return new Response("Translate failed", { status: 200 });
    }
  }

  // Idempotency guard: a replayed/duplicate invocation for a row that is
  // already terminal, already streaming ('ready'), or whose dispatch
  // generation row finished must not burn a second full Anthropic run.
  // Oldest plan_generations row = the dispatch row (translation audit rows
  // share meal_plan_id but are inserted later, already 'completed').
  try {
    const planRow = await sbSelectOne(
      supabaseUrl,
      serviceKey,
      "meal_plans",
      `id=eq.${mealPlanId}&select=status`,
    );
    const genRows = await sbSelectMany(
      supabaseUrl,
      serviceKey,
      "plan_generations",
      `meal_plan_id=eq.${mealPlanId}&select=status&order=created_at.asc&limit=1`,
    );
    if (
      generationAlreadySettled({
        mealPlanStatus: (planRow?.status as string | undefined) ?? null,
        dispatchGenStatus: (genRows[0]?.status as string | undefined) ?? null,
      })
    ) {
      console.log(
        "[generate-plan-background] duplicate/settled invocation — no-op",
        { userId, mealPlanId },
      );
      return new Response("Already settled", { status: 200 });
    }
  } catch (guardErr) {
    // The guard is best-effort: if the probe itself fails, proceed — the run
    // would rather risk a duplicate than drop a legitimate generation.
    console.error("[generate-plan-background] idempotency probe failed", guardErr);
    await captureToSentry(guardErr, {
      step: "meal-idempotency-probe",
      userId,
      mealPlanId,
      level: "warning",
    });
  }

  // ── Invocation ACK ──────────────────────────────────────────────────────
  // The worker's "I exist" write, made as early as it safely can be: after the
  // idempotency probe (so a duplicate invocation on a finished row returns above
  // and never touches plan_data) and before any model call.
  //
  // Why it has to exist: every refusal above this line — the 401, the env 500, a
  // 400 on a malformed body — returns BEFORE the try block whose catch is the
  // only code that terminalizes the row, and Netlify's pre-handler 202 hides all
  // of it from the dispatcher. So "the worker never ran" and "the worker is
  // still working" were the SAME observable state: status 'generating', empty
  // plan_data, for fifteen minutes. This write separates them, and
  // resolveStaleness turns its ABSENCE into a real, retryable error after
  // WORKER_ACK_LIMIT_MS instead of a blank spinner.
  //
  // It lives in plan_data rather than a new column so this ships with no
  // migration: the field is inert while generating (getLatestPlan only Zod-parses
  // plan_data once status is 'ready') and the first real emit() overwrites the
  // object wholesale. The write also bumps updated_at through the meal_plans
  // trigger, a truthful "alive" signal for the existing staleness contract.
  //
  // `status=eq.generating` is belt-and-braces on top of the probe: a row that
  // already holds a plan can never be blanked by an ACK, whatever order things
  // arrive in. Not wrapped in a swallowing try — a worker that cannot write this
  // cannot persist a result later either, so failing loudly beats running a full
  // generation whose output has nowhere to go.
  await sbUpdate(
    supabaseUrl,
    serviceKey,
    "meal_plans",
    `id=eq.${mealPlanId}&status=eq.generating`,
    { plan_data: { worker_ack_at: new Date().toISOString() } },
  );

  const startMs = Date.now();
  // Netlify kills this function at its budget without running any catch, so the
  // deadline has to be enforced from inside. Computed once from the invocation's
  // own start; the housekeeper reserve is applied by dayLoopDeadline.
  let deadlineMs = dayLoopDeadline(startMs, false);
  // The outer bound: everything except the final DB writes must be done by here.
  const hardDeadlineMs = startMs + planRunBudgetMs() - FINALIZE_RESERVE_MS;
  // Running usage, mirrored out of the engine so a failed or trimmed run is
  // still costed — the totals used to die with the exception, which is why
  // failed generations read $0 in the admin cost view.
  let accrued = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  try {
    const context = await buildContextViaFetch(supabaseUrl, serviceKey, userId);
    // Re-derive now that the context (and so the housekeeper locale) is known:
    // the end-of-run translation pass runs after the day loop and needs its own
    // slice of the same box.
    deadlineMs = dayLoopDeadline(startMs, !!context.housekeeper_locale);
    if (body.feedback) context.user_feedback = body.feedback;

    // «خطة تشبهك»: recent check-in/verdict digest, PostgREST flavor of
    // lib/engagement/digest.ts. Best-effort — pre-00017 prod (missing tables)
    // or any fetch failure leaves the digest undefined and the run unchanged.
    try {
      const sinceIso = new Date(
        Date.now() - 14 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const [checkinRows, verdictRows] = await Promise.all([
        sbSelectMany(
          supabaseUrl,
          serviceKey,
          "meal_checkins",
          // local_date identifies the MEAL — rows are per person since 00019;
          // computeEngagementDigest collapses them so counts stay meal-true.
          `user_id=eq.${userId}&created_at=gte.${sinceIso}&select=slot,status,reason,local_date&limit=800`,
        ),
        sbSelectMany(
          supabaseUrl,
          serviceKey,
          "meal_verdicts",
          `user_id=eq.${userId}&created_at=gte.${sinceIso}&select=recipe_name_ar,canonical_key,verdict&limit=400`,
        ),
      ]);
      context.engagement_digest = computeEngagementDigest(
        checkinRows as unknown as EngagementCheckinRow[],
        verdictRows as unknown as EngagementVerdictRow[],
      );
    } catch (digestErr) {
      console.warn(
        "[generate-plan-background] engagement digest unavailable — generating without it",
        digestErr,
      );
    }

    // Carry-over source, re-read from the DB (not received by value — see
    // fetchPriorPlan). A plain per-member regen strips the target so it
    // regenerates entirely; a partial-scope regen keeps the WHOLE prior plan so
    // the engine can preserve out-of-scope meals and recompute co-sharers. This
    // mirrors the stripping triggerPlanGeneration did before it stopped sending
    // the plan in the body.
    let existingPlan: MealPlan | null = null;
    if (body.carryOver) {
      const prior = await fetchPriorPlan(supabaseUrl, serviceKey, userId, mealPlanId);
      if (prior) {
        existingPlan =
          body.regenerateMemberId && !body.regenScope && !body.regenerateSharedGroup
            ? {
                ...prior,
                members: prior.members.filter(
                  (m) => m.member_id !== body.regenerateMemberId,
                ),
              }
            : prior;
      }
    }

    // One-at-a-time add: restrict this run to the existing plan's members plus
    // the single target, so other pending members are NOT generated here (they
    // generate later, one at a time). Mirrors triggerPlanGeneration's filter.
    if (body.onlyMemberId && existingPlan) {
      const keep = new Set(existingPlan.members.map((m) => m.member_id));
      keep.add(body.onlyMemberId);
      context.family_members = context.family_members.filter((m) =>
        keep.has(m.id),
      );
    }

    // Shared-group regen (a new SHARED member was added): rebuild every shared
    // beneficiary together, carrying independent members + the housekeeper. Mirrors
    // triggerPlanGeneration. No single generating_member_id → the UI shows them all
    // loading.
    if (body.regenerateSharedGroup && existingPlan) {
      const prep = prepareSharedGroupRegen(context, existingPlan);
      existingPlan = prep.existingPlan;
      context.family_members = prep.familyMembers;
    }

    // Tier cap (full run): restrict to mom + the allow-listed beneficiaries; keep
    // housekeepers (they cook, aren't beneficiaries). Mirrors triggerPlanGeneration.
    if (body.limitMemberIds && !body.onlyMemberId) {
      const keep = new Set(body.limitMemberIds);
      context.family_members = context.family_members.filter(
        (m) => m.role === "housekeeper" || keep.has(m.id),
      );
    }

    const { plan, usage, missingDays, missingDaysCause, daysCompleted } =
      await generateMealPlan({
      anthropicApiKey: anthropicKey,
      context,
      existingPlan: existingPlan ?? null,
      independentRegen: body.independentRegen,
      onlyMemberId: body.onlyMemberId,
      regenerateMemberId: body.regenerateMemberId,
      regenScope: body.regenScope,
      // THE budget that matters: this function is the one Netlify hard-kills at
      // 15 minutes. Measured in production, a 6-member household reached 6/7 days
      // and a 4-member one 4/7 before the kill — which runs neither the success
      // path nor the catch below, so the row stayed 'started' with a NULL cost
      // and the customer's finished days were thrown away. With a deadline the
      // run ends itself, hands back the days it has, and DeferredMemberDrain
      // fills the rest in a fresh invocation with a fresh budget.
      deadlineMs,
      onUsage: (u) => {
        accrued = u;
      },
      // Shared-group regen rebuilds multiple members → don't pin the loader to one.
      suppressTargetedMember:
        !!body.regenerateSharedGroup && !!body.regenerateMemberId,
      // Persist progressively + flip "ready" on the first emit (the shell), so
      // the plan opens showing all days as loading and they fill in 1→7.
      onProgress: async (snapshot) => {
        await sbUpdate(
          supabaseUrl,
          serviceKey,
          "meal_plans",
          `id=eq.${mealPlanId}`,
          { status: "ready", plan_data: snapshot },
        );
      },
    });

    // End-of-run housekeeper translation. Re-read the housekeeper FRESH (catches
    // a maid added mid-generation, whose locale wasn't in the start context, so
    // the meals weren't born-translated). Runs here — while this generation's
    // plan_generations 'started' row is still live — so triggerPlanTranslation's
    // busy guard keeps any concurrent translate from racing us. The translated
    // plan becomes the final plan_data. Born-translated plans find nothing to do.
    let finalPlan = plan;
    let extraIn = 0;
    let extraOut = 0;
    let extraCost = 0;
    try {
      const hkRows = await sbSelectMany(
        supabaseUrl,
        serviceKey,
        "family_members",
        `user_id=eq.${userId}&role=eq.housekeeper&select=preferred_language&limit=1`,
      );
      const hkLang = hkRows[0]?.preferred_language as string | undefined;
      const endLocale =
        hkLang && hkLang !== "ar" && (LOCALE_CODES as readonly string[]).includes(hkLang)
          ? (hkLang as LocaleCode)
          : undefined;
      const needsTranslate =
        !!endLocale &&
        plan.members.some((m) =>
          m.days.some((d) =>
            d.meals.some((meal) => meal.prep_steps_translated_locale !== endLocale),
          ),
        );
      // Translate WHAT THIS RUN PRODUCED. This branch is a mirror of
      // runMealPlanGeneration's end-of-run pass and it had drifted: the engine
      // stopped waiting for the whole household (at the 6-member cap a run yields
      // ~2 of 7 days, so the cook — the only person who cannot read the Arabic
      // view — was last in the queue by construction) while PRODUCTION, which
      // comes through here, still waited. translateMealPlan skips meals already
      // carrying the locale, so a partial pass costs the same in total; only the
      // number of passes grows.
      const hkSex = (
        await sbSelectOne(
          supabaseUrl,
          serviceKey,
          "family_members",
          `user_id=eq.${userId}&role=eq.housekeeper&select=sex&limit=1`,
        )
      )?.sex as string | null | undefined;
      // Budget gate: a run that filled days right up to its deadline could still
      // start a multi-call translation with nothing left. Skipping is free — the
      // pass is non-fatal and her page re-triggers it.
      const roomToTranslate = canFit(hardDeadlineMs, MIN_VIABLE_CALL_MS);
      if (endLocale && needsTranslate && !roomToTranslate) {
        console.warn(
          "[generate-plan-background] skipping housekeeper translation (run budget spent)",
        );
      }
      if (endLocale && needsTranslate && roomToTranslate) {
        const { plan: translated, usage: tUsage } = await translateMealPlan({
          anthropicApiKey: anthropicKey,
          plan,
          locale: endLocale,
          // Bounded by the run, not just gated on 45s to start. Without this the
          // pass could begin with a minute left and run for several more, and the
          // hard kill takes the terminal write with it — leaving the audit row
          // 'started', which blocks the household's NEXT generation for 15 min.
          deadlineMs: hardDeadlineMs,
          cookSex: hkSex ?? null,
          onDayTranslated: async (p) => {
            await sbUpdate(supabaseUrl, serviceKey, "meal_plans", `id=eq.${mealPlanId}`, {
              plan_data: p,
            });
          },
        });
        finalPlan = translated;
        extraIn = tUsage.input_tokens;
        extraOut = tUsage.output_tokens;
        extraCost = tUsage.cost_usd;
      }
    } catch (hkErr) {
      // Non-fatal: leave the (untranslated) plan as-is; the maid view falls back
      // to Arabic and her page re-triggers a translate on next visit.
      console.warn(
        "[generate-plan-background] end-of-run housekeeper translate failed",
        hkErr,
      );
    }

    const durationMs = Date.now() - startMs;
    const generatedAt = new Date().toISOString();

    // Partial plan: some days were dropped after retries. Status stays
    // "completed" (the CHECK allows only started/completed/failed), but record a
    // PII-safe note (day indices only — never recipe/member content) so partials
    // are auditable.
    const partialNote =
      missingDays.length > 0
        ? `partial: days [${missingDays.join(", ")}] failed${missingDaysCause ? ` — ${missingDaysCause}` : ""}`
        : null;
    if (partialNote) {
      console.warn(`[generate-plan-background] ${partialNote}`, { userId, mealPlanId });
    }

    await sbUpdate(supabaseUrl, serviceKey, "meal_plans", `id=eq.${mealPlanId}`, {
      status: "ready",
      plan_data: finalPlan,
      generated_at: generatedAt,
      ai_input_tokens: usage.input_tokens,
      ai_output_tokens: usage.output_tokens,
      ai_generation_seconds: durationMs / 1000,
    });
    await sbUpdate(
      supabaseUrl,
      serviceKey,
      "plan_generations",
      `meal_plan_id=eq.${mealPlanId}`,
      {
        status: "completed",
        tokens_in: usage.input_tokens + extraIn,
        tokens_out: usage.output_tokens + extraOut,
        cost_usd: usage.cost_usd + extraCost,
        duration_ms: durationMs,
        completed_at: generatedAt,
        error_message: partialNote,
      },
    );

    console.log("[generate-plan-background] completed", {
      userId,
      mealPlanId,
      tokensOut: usage.output_tokens,
      durationMs,
      missingDays,
    });

    // ── Continuation chaining (success path ONLY — a failed run never chains:
    // its row is 'failed', so a child's carry-over would skip it and re-buy a
    // pre-parent week). A run that ends short used to just END, and the partial
    // week then waited for a logged-in browser to mount /plan or /dashboard —
    // the only place DeferredMemberDrain fires. Instead, dispatch our own
    // successor inside the finalize reserve: both terminal writes above are
    // done (the 'ready' plan is the child's carry-over source, and closing the
    // audit row is what releases the 00014 per-kind lock BEFORE the child
    // claims it). Only ever a WIDE fill — scoped runs (add-member, per-member
    // regen, shared-group rebuild) have their own owners in the drain/add flow,
    // whose routing (regenerateSharedGroup, onlyMemberId) this worker does not
    // carry.
    const chainDepth = Math.min(
      Math.max(0, Math.trunc(body.chainDepth ?? 0)),
      PLAN_CHAIN_MAX_HOPS,
    );
    const wideRun =
      !body.onlyMemberId &&
      !body.regenerateMemberId &&
      !body.regenerateSharedGroup &&
      !body.regenScope;
    if (
      wideRun &&
      shouldChainContinuation({
        plan: finalPlan,
        // From the RUN's context — already narrowed by limitMemberIds above, so
        // a tier-capped household's deferred members do not read as "absent".
        beneficiaryIds: getBeneficiaries(context).map((b) => b.member_id),
        missingDays,
        daysCompleted,
        chainDepth,
      })
    ) {
      const hop = chainDepth + 1;
      const chained = await dispatchChainContinuation({
        reqUrl: req.url,
        secret: expected,
        supabaseUrl,
        serviceKey,
        userId,
        chainDepth: hop,
        feedback: body.feedback,
        limitMemberIds: body.limitMemberIds,
      });
      if (chained) {
        // Keep the audit trail legible: the parent's row says its short week is
        // being continued, not abandoned. Best-effort — the chain is already
        // dispatched either way.
        await sbUpdate(
          supabaseUrl,
          serviceKey,
          "plan_generations",
          `meal_plan_id=eq.${mealPlanId}`,
          {
            error_message: `${partialNote ?? "partial"} — chained continuation (hop ${hop})`,
          },
        ).catch((e) =>
          console.warn("[generate-plan-background] chain note write failed", e),
        );
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;
    console.error("[generate-plan-background] error", { userId, mealPlanId, errorMessage });
    // The one that matters: a whole meal generation died. The DB row only ever
    // kept the message, so the stack and the failing step were unrecoverable.
    await captureToSentry(err, { step: "meal-generation", userId, mealPlanId });
    try {
      await sbUpdate(supabaseUrl, serviceKey, "meal_plans", `id=eq.${mealPlanId}`, {
        status: "failed",
        error_message: errorMessage,
      });
      await sbUpdate(
        supabaseUrl,
        serviceKey,
        "plan_generations",
        `meal_plan_id=eq.${mealPlanId}`,
        {
          status: "failed",
          error_message: errorMessage,
          duration_ms: durationMs,
          completed_at: new Date().toISOString(),
          // The run failed; the bill did not. Without these the admin cost view
          // counts every failed generation as $0 — and the largest households
          // are both the most expensive and the most likely to fail, so the
          // undercount lands exactly where margin is thinnest.
          tokens_in: accrued.input_tokens,
          tokens_out: accrued.output_tokens,
          cost_usd: accrued.cost_usd,
        },
      );
    } catch (updateErr) {
      // This is the last line of defence: the run already failed, and if THIS
      // write is also lost the row stays 'generating' with no explanation — the
      // exact silent state the invocation ACK exists to expose. A bare
      // console.error made it invisible outside Netlify's log retention, so
      // retry the plan row once (the row the customer's screen actually reads)
      // and report either way.
      console.error("[generate-plan-background] failed to mark rows failed", updateErr);
      try {
        await sbUpdate(supabaseUrl, serviceKey, "meal_plans", `id=eq.${mealPlanId}`, {
          status: "failed",
          error_message: errorMessage,
        });
      } catch (retryErr) {
        console.error("[generate-plan-background] terminalize retry failed", retryErr);
      }
      await captureToSentry(updateErr, {
        step: "meal-terminalize",
        userId,
        mealPlanId,
      });
    }
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

export default handler;
