"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { triggerPlanGeneration, triggerPlanTranslation ,
  triggerWorkoutGeneration,
} from "@/lib/plans/dispatch";
import { getLatestPlan } from "@/lib/plans/getLatestPlan";
import {
  getCurrentSubscription,
  isSubscriptionActive,
  getTierLimit,
  hasLiveLemonsqueezySubscription,
} from "@/lib/subscription/state";
import { isFreeAccessMode } from "@/lib/subscription/freeAccess";
import {
  countBeneficiaries,
  canGenerateForFamilyChange,
} from "@/lib/subscription/access";
import { shouldRegenerateFamilyOnActivation } from "@/lib/plans/familyCoverage";
import { memberEditIsSubstantive, staleMemberIds } from "@/lib/plans/memberEdit";
import { incompleteInPlanMemberIds } from "@/lib/plans/drainScope";
import {
  planHasContent,
  MEMBER_GEN_MAX_ATTEMPTS,
  ownerRequiresDoctorSignOff,
  memberRequiresDoctorSignOff,
  DOCTOR_SIGN_OFF_REQUIRED_AR,
  type MealPlan,
} from "@fitlife/plan-engine";
import { isLocaleCode } from "@/lib/plans/locales";
import { mapUserGoalToSara, type UserGoal } from "@/lib/plans/goalMapping";
import {
  activityLevelFrom,
  type DayNature,
  type ExerciseDays,
  type ExerciseType,
} from "@/lib/plans/activityLevel";
import {
  momProfileInputSchema,
  familyMemberInputSchema,
  familyWideInputSchema,
  profileStepSchema,
  firstFieldErrorAr,
  VALIDATION_ERROR_AR,
} from "./serverSchemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type ProfileUpdates = Partial<{
  sex: "female" | "male";
  display_name: string;
  birth_year: number;
  phone: string | null;
  height_cm: number;
  weight_kg: number;
  waist_cm: number | null;
  hip_cm: number | null;
  activity_level: string;
  day_nature: string;
  exercise_days: string;
  exercise_type: string | null;
  target_weight_kg: number | null;
  primary_goal: string;
  cuisine_preference: string;
  dietary_restrictions: string[];
  has_medical_conditions: boolean;
  medical_conditions: string[];
  is_pregnant: boolean;
  pregnancy_trimester: number | null;
  consulted_doctor: boolean;
}>;

type FamilyMemberRow = Database["public"]["Tables"]["family_members"]["Row"];

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Save partial onboarding state to the caller's profile row.
 * Called after each step for progressive save (resilient to refresh).
 */
export async function saveProfileStep(updates: ProfileUpdates): Promise<ActionResult> {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, error: "Not authenticated" };
  }

  // The update object goes straight into a profiles UPDATE — strict whitelist.
  const parsed = profileStepSchema.safeParse(updates);
  if (!parsed.success) {
    return { ok: false, error: firstFieldErrorAr(parsed.error) };
  }

  const { error } = await supabase
    .from("profiles")
    .update(parsed.data)
    .eq("id", user.id);

  if (error) {
    console.error("[saveProfileStep] error:", error);
    Sentry.captureException(error, {
      tags: { area: "onboarding", step: "saveProfileStep", userId: user.id },
    });
    return { ok: false, error: error.message };
  }

  return { ok: true };
}



// ─── Prompt 1.8c: restructured onboarding ──────────────────────────────────

// Cuisine + cooking methods moved to the personal wizard (saveMomProfile) —
// this screen keeps only the genuinely family-wide preferences.
export interface FamilyWideInput {
  family_dietary_restrictions: string[];
  family_dislikes: string[];
  meal_out_frequency: string;
}

/** Phase 1 — the shared 5-question family-wide screen. */
export async function saveFamilyWidePreferences(
  input: FamilyWideInput,
): Promise<ActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "Not authenticated" };

  if (!familyWideInputSchema.safeParse(input).success) {
    return { ok: false, error: VALIDATION_ERROR_AR };
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      family_dietary_restrictions: input.family_dietary_restrictions,
      family_dislikes: input.family_dislikes,
      meal_out_frequency: input.meal_out_frequency,
      family_wide_completed_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (error) {
    Sentry.captureException(error, {
      tags: { area: "onboarding", step: "saveFamilyWidePreferences", userId: user.id },
    });
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export interface MomProfileInput {
  /** Owner sex (Coach Sara intake). Missing on legacy tabs → female. */
  sex?: "female" | "male";
  display_name: string;
  birth_year: number;
  phone?: string | null;
  height_cm: number;
  weight_kg: number;
  waist_cm?: number | null;
  hip_cm?: number | null;
  // The 07/2026 intake asks the 5-level activity directly; day_nature ×
  // exercise_days remain accepted from legacy tabs, and when both are present
  // the server still derives the level from them (never trusts a client-
  // computed level over concrete answers).
  activity_level?: string;
  day_nature?: DayNature;
  exercise_days?: ExerciseDays;
  exercise_type?: ExerciseType | null;
  target_weight_kg?: number | null;
  water_liters?: "lt1" | "l1_2" | "l2_3" | "gt3" | null;
  sleep_hours?: number | null;
  sleep_band?: "lt5" | "h5_6" | "h7_8" | "gt8" | null;
  stress_level?: "low" | "medium" | "high" | null;
  medications?: string[];
  supplements?: string[];
  nausea_foods?: string[];
  notes?: string | null;
  user_goal: UserGoal;
  pregnancy_status: "none" | "pregnant" | "lactating";
  pregnancy_month?: number;
  trimester?: number;
  high_risk_pregnancy: boolean;
  feeding_mode?: "exclusive" | "mixed" | "formula";
  months_postpartum?: number;
  dietary_restrictions?: string[];
  allergies: string[];
  liked_foods?: string[];
  dislikes: string[];
  never_eat_foods?: string[];
  meals_per_day?: number | null;
  intermittent_fasting?: "yes" | "no" | null;
  food_recall_24h?: string | null;
  previous_diets?: string | null;
  cuisine_preference?: string;
  cooking_methods?: string[];
  conditions: string[];
  other_condition?: string;
  consulted_doctor: boolean;
}

type GenerateActionResult =
  | { ok: true; plan_generation_id: string | null }
  | { ok: false; error: string };

/**
 * Phase 2 — Mom's 8 questions. Maps the friendly goal to a Sara goal, writes
 * her full profile, marks her profile (and overall onboarding) complete, then
 * fires a solo plan generation (rate-limit bypassed).
 */
export async function saveMomProfile(
  input: MomProfileInput,
): Promise<GenerateActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "يجب تسجيل الدخول" };

  if (!momProfileInputSchema.safeParse(input).success) {
    return { ok: false, error: VALIDATION_ERROR_AR };
  }

  // Male owners can never be pregnant/lactating — the wizard skips the step,
  // and the server hard-guards regardless of what the client sends.
  const sex = input.sex ?? "female";
  const isMale = sex === "male";
  const isPregnant = !isMale && input.pregnancy_status === "pregnant";
  const isLactating = !isMale && input.pregnancy_status === "lactating";
  const memberType = isPregnant ? "pregnant" : isLactating ? "lactating" : "adult";

  const conditions = [...input.conditions];
  const other = input.other_condition?.trim();
  if (other) conditions.push(other);
  const hasMedical = conditions.length > 0;

  // Never persist a profile the engine will then refuse to plan for. The wizard
  // requires the confirmation on its own doctor step; this is the server-side
  // guarantee, using the SAME rule the generation gate uses.
  if (
    ownerRequiresDoctorSignOff({
      medical_conditions: conditions,
      is_pregnant: isPregnant,
    }) &&
    !input.consulted_doctor
  ) {
    return { ok: false, error: DOCTOR_SIGN_OFF_REQUIRED_AR };
  }

  const primaryGoal = mapUserGoalToSara(input.user_goal, {
    hasMedical,
    isPregnantOrLactating: isPregnant || isLactating,
    conditions,
  });

  // Derive the canonical level from the concrete answers when available
  // (never trust a client-computed level); legacy clients still send the
  // level directly.
  const derivedActivity =
    input.day_nature && input.exercise_days
      ? activityLevelFrom(input.day_nature, input.exercise_days)
      : (input.activity_level ?? null);

  const now = new Date().toISOString();
  // New 00016 intake keys use plain `input.x` (undefined → dropped at JSON
  // serialization) so a legacy tab that never sent them can't wipe values a
  // newer session already saved.
  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: input.display_name,
      birth_year: input.birth_year,
      phone: input.phone,
      height_cm: input.height_cm,
      weight_kg: input.weight_kg,
      waist_cm: input.waist_cm,
      hip_cm: input.hip_cm,
      activity_level: derivedActivity,
      day_nature: input.day_nature ?? null,
      exercise_days: input.exercise_days ?? null,
      exercise_type: input.exercise_type ?? null,
      target_weight_kg: input.target_weight_kg ?? null,
      water_liters: input.water_liters ?? null,
      sleep_hours: input.sleep_hours ?? null,
      sleep_band: input.sleep_band,
      stress_level: input.stress_level,
      medications: input.medications ?? [],
      supplements: input.supplements ?? [],
      nausea_foods: isPregnant ? (input.nausea_foods ?? []) : [],
      notes: input.notes?.trim() || null,
      sex,
      member_type: memberType,
      primary_goal: primaryGoal,
      dietary_restrictions: input.dietary_restrictions,
      allergies: input.allergies,
      liked_foods: input.liked_foods,
      dislikes: input.dislikes,
      never_eat_foods: input.never_eat_foods,
      meals_per_day: input.meals_per_day,
      intermittent_fasting: input.intermittent_fasting,
      food_recall_24h: input.food_recall_24h,
      previous_diets: input.previous_diets,
      cuisine_preference: input.cuisine_preference,
      cooking_methods: input.cooking_methods,
      has_medical_conditions: hasMedical,
      medical_conditions: conditions,
      is_pregnant: isPregnant,
      pregnancy_month: isPregnant ? (input.pregnancy_month ?? null) : null,
      pregnancy_trimester: isPregnant
        ? input.pregnancy_month != null
          ? Math.ceil(input.pregnancy_month / 3)
          : (input.trimester ?? null)
        : null,
      high_risk_pregnancy: isPregnant ? input.high_risk_pregnancy : false,
      feeding_mode: isLactating ? (input.feeding_mode ?? null) : null,
      // «Months since giving birth», not a lactation flag — a woman who
      // formula-feeds still needs the postpartum recovery rules (and the
      // workout pelvic-floor rules). member_type === "lactating" is what adds
      // the lactation calories. Never set while pregnant, never for a male.
      months_postpartum:
        isMale || isPregnant ? null : (input.months_postpartum ?? null),
      consulted_doctor: input.consulted_doctor,
      mom_profile_completed_at: now,
    })
    .eq("id", user.id);

  if (error) {
    Sentry.captureException(error, {
      tags: { area: "onboarding", step: "saveMomProfile", userId: user.id },
    });
    return { ok: false, error: error.message };
  }

  // Do NOT generate or mark onboarding complete here. The mom wizard now hands off
  // to the add-a-member loop (/onboarding/members); generation for the WHOLE family
  // (mom + everyone she adds) runs after the subscription screen — either the
  // whole family on subscribe (webhook) or mom-only via generateSoloAndContinue.
  revalidatePath("/dashboard");
  return { ok: true, plan_generation_id: null };
}

/**
 * End of the onboarding add-a-member loop: mark onboarding complete and route the
 * user onward. The destination depends on whether they've ALREADY paid:
 *   • PAID active subscription (e.g. they purchased from the dashboard before
 *     finishing the quiz) → skip the pricing screen entirely. Trigger the
 *     whole-family generation (now that onboarding is complete) and send them to
 *     /plan, exactly as the post-checkout handler does.
 *   • Trial / no paid subscription → show the subscription screen, where:
 *       - subscribe → the LemonSqueezy webhook generates the WHOLE family together
 *         on activation (so shared meals group across the full roster), or
 *       - "continue with just my plan" → generateSoloAndContinue() makes the
 *         primary user's plan only.
 */
export async function finishOnboardingToSubscription(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Not authenticated");

  // The error is READ before redirecting. onboarding_completed_at is a gate,
  // not a cosmetic flag: syncFamilyPlanAfterSubscribe returns immediately when
  // it is null, and so does drainDeferredMembers. Discarding a failure here and
  // redirecting anyway meant the customer went on to pay, came back, and NO
  // plan was ever generated — with nothing surfaced anywhere, because the only
  // signal was dropped three steps earlier.
  const { error: completeError } = await supabase
    .from("profiles")
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq("id", user.id);
  if (completeError) {
    Sentry.captureException(completeError, {
      tags: {
        area: "onboarding",
        step: "finishOnboardingToSubscription",
        userId: user.id,
      },
    });
    throw new Error(completeError.message);
  }

  revalidatePath("/dashboard");

  // If the user already paid (e.g. via the dashboard link before taking the quiz),
  // do NOT bounce them back to the pricing page. A PAID active subscription has a
  // lemonsqueezy_subscription_id — trial rows never do. Mirror the post-checkout
  // path: kick off the whole-family generation and land them on /plan.
  const sub = await getCurrentSubscription(user.id);
  // TEMPORARY testing mode treats the household as already covered: there is
  // nothing to buy, so the pricing screen below would be a dead end between
  // finishing the questions and seeing a plan.
  const covered = isFreeAccessMode()
    ? true
    : Boolean(sub && isSubscriptionActive(sub) && sub.lemonsqueezy_subscription_id);
  if (covered) {
    // Always land on /plan: it renders every state correctly (progress while
    // generating, the plan when ready, the retry UI on failure) — bouncing to
    // the dashboard on a declined sync left users staring at "no plan yet".
    await syncFamilyPlanAfterSubscribe().catch(() => ({ triggered: false }));
    redirect("/plan");
  }

  redirect("/pricing?from=onboarding");
}

export type SoloGenResult = { ok: true } | { ok: false; error: string };

/**
 * "Continue with just my plan" from the post-onboarding subscription screen. Runs a
 * normal family generation; on the free trial's starter tier (max 1 person) it caps
 * to the primary user (mom) and defers the rest behind the subscription notice.
 * Subscribing later regenerates the whole family together (see the LemonSqueezy
 * webhook). Onboarding is already completed by finishOnboardingToSubscription.
 *
 * Returns the outcome instead of redirecting so the caller can show a real
 * reason; navigation happens client-side on success.
 */
export async function generateSoloAndContinue(): Promise<SoloGenResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "يجب تسجيل الدخول" };

  // Full run → tier cap (trial starter = 1) yields a mom-only plan; any extra
  // members defer until a covering subscription unlocks the whole-family regen.
  const gen = await runFamilyGeneration(supabase, user.id);
  // Combined generation: fire the workout companion too (no-op unless opted in).
  await maybeTriggerWorkoutGeneration(supabase, user.id);

  // The result used to be discarded and the user redirected to /plan
  // regardless — a medical gate, an inactive subscription, or a dispatch
  // failure all landed her on an empty page with no idea why. Report it
  // instead; the caller navigates only on a real success.
  // 'busy' IS a success from her side: a run is already in flight, and /plan
  // renders its progress. 'upgrade' can't happen on a full run (the tier cap
  // is applied instead of denying), but it is handled for completeness.
  if (gen.ok || gen.kind === "busy") return { ok: true };
  if (gen.kind === "upgrade") {
    return { ok: false, error: "باقتك الحالية لا تكفي عدد أفراد العائلة" };
  }
  return { ok: false, error: gen.error };
}

/**
 * Whole-family (re)generation when a PAID subscription now covers more
 * beneficiaries than the current plan contains — the synchronized path that keeps
 * shared meals grouped across everyone (carryOver:false). Idempotent: a no-op when
 * the plan already covers the tier's capacity, mid-generation, or for trial-only
 * rows. Called right after checkout activates (CheckoutSuccessHandler). Returns
 * whether a run was started so the caller can route to /plan.
 */
export async function syncFamilyPlanAfterSubscribe(): Promise<{ triggered: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { triggered: false };

  const { data: prof } = await supabase
    .from("profiles")
    .select("onboarding_completed_at")
    .eq("id", user.id)
    .returns<{ onboarding_completed_at: string | null }[]>()
    .maybeSingle();
  if (!prof?.onboarding_completed_at) return { triggered: false };

  const sub = await getCurrentSubscription(user.id);
  // Only a PAID active subscription unlocks the family — trial rows (no LS id)
  // never auto-generate beyond the explicit mom-only path.
  //
  // TEMPORARY testing mode is the one exception: there is no LS id to hold,
  // yet the whole household is meant to generate together. Without this the
  // mode would unlock the member LIMIT but still leave everyone past the first
  // person without a plan — the exact thing being tested.
  const freeAccess = isFreeAccessMode();
  if (!freeAccess && (!sub || !isSubscriptionActive(sub) || !sub.lemonsqueezy_subscription_id)) {
    return { triggered: false };
  }

  // Combined generation: the workout companion fires regardless of what the
  // meal decision below concludes (it is often a legitimate no-op re-poll).
  await maybeTriggerWorkoutGeneration(supabase, user.id);

  const latest = await getLatestPlan(user.id);
  if (latest?.in_progress) return { triggered: false }; // already generating

  const { count } = await supabase
    .from("family_members")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .neq("role", "housekeeper");
  const beneficiaryCount = (count ?? 0) + 1; // + mom

  if (
    !shouldRegenerateFamilyOnActivation({
      isPaidActive: true,
      planMemberCount: latest?.member_count ?? 0,
      beneficiaryCount,
      // In free mode `sub` may be absent entirely; the limit is unlimited either
      // way, so fall back to the same null rather than dereferencing it.
      tierMaxPeople: sub ? getTierLimit(sub.tier) : null,
    })
  ) {
    return { triggered: false };
  }

  const gen = await runFamilyGeneration(supabase, user.id, { fullRegen: true });
  return { triggered: gen.ok };
}

/**
 * Combined-generation companion: after a meal generation hand-off, fire the
 * workout generation too — iff anyone opted in (a non-null workout_profile
 * exists on the mom or an eligible member) AND no workout plan is already
 * ready or freshly in flight. Fired regardless of the meal result: the meal
 * call is often a legitimate no-op on re-poll (already generating / roster
 * covered), and tying workout to it would strand opted-in users. Idempotent:
 * the 00014 per-kind unique index makes a double-fire lose cleanly (busy).
 */
async function maybeTriggerWorkoutGeneration(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<void> {
  try {
    const [{ data: prof }, { data: optedMembers }] = await Promise.all([
      supabase
        .from("profiles")
        .select("workout_profile")
        .eq("id", userId)
        .maybeSingle(),
      supabase
        .from("family_members")
        .select("id")
        .eq("user_id", userId)
        .not("workout_profile", "is", null)
        .limit(1),
    ]);
    const anyOptIn =
      prof?.workout_profile != null || (optedMembers?.length ?? 0) > 0;
    if (!anyOptIn) return;

    const { data: existing } = await supabase
      .from("workout_plans")
      .select("id, status, updated_at")
      .eq("user_id", userId)
      .neq("status", "archived")
      .order("created_at", { ascending: false })
      .limit(1)
      .returns<{ id: string; status: string; updated_at: string }[]>();
    const row = existing?.[0];
    if (row) {
      if (row.status === "ready") return;
      const ageMin = (Date.now() - Date.parse(row.updated_at)) / 60_000;
      if (row.status === "generating" && ageMin < 15) return;
    }

    await triggerWorkoutGeneration({ supabase, userId });
  } catch (err) {
    // Never let the workout companion break the meal flow.
    console.error("[maybeTriggerWorkoutGeneration] failed", err);
    Sentry.captureException(err, {
      tags: { area: "workout-generation", step: "companion-trigger", userId },
    });
  }
}

export async function finalizeOnboarding(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) throw new Error("Not authenticated");

  // Same gate, same reason as finishOnboardingToSubscription: a silent failure
  // here leaves every downstream generation trigger permanently short-circuited.
  const { error: completeError } = await supabase
    .from("profiles")
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq("id", user.id);
  if (completeError) {
    Sentry.captureException(completeError, {
      tags: { area: "onboarding", step: "finalizeOnboarding", userId: user.id },
    });
    throw new Error(completeError.message);
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

/**
 * First-run auto-drain, evaluated LAZILY on a post-onboarding read (called from a
 * client effect on /plan and the dashboard). A member added while mom's solo
 * generation was still in flight gets deferred by the dispatch busy guard (saved
 * to family_members but not in plan_data.members). Rather than leave a brand-new
 * user on a "only mom + manual banner" first view, generate the deferred members
 * onto the existing family grid (carry-over) once mom's plan is ready.
 *
 * Fires only when ALL hold: onboarding complete (prevents a mid-wizard partial
 * drain), the latest plan is "ready" (so it's not generating/failed — and so the
 * carry-over has a base to seed from), and at least one beneficiary is pending.
 * Busy/upgrade/error → fired:false; the manual banner stays as the fallback.
 * Terminates: a fired drain flips status to "generating" (blocks re-fire) and
 * seeds the pending members (pending → empty).
 */
/**
 * Returns { fired } when a generation was dispatched, and { busy } when one is
 * already in flight — either way the caller (DeferredMemberDrain) should stop
 * dispatching and just keep refreshing until the server state advances.
 */
export async function drainDeferredMembers(): Promise<{
  fired: boolean;
  busy: boolean;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { fired: false, busy: false };

  const [profileRes, latest, membersRes] = await Promise.all([
    supabase
      .from("profiles")
      .select("onboarding_completed_at, member_addition_order")
      .eq("id", user.id)
      .returns<
        { onboarding_completed_at: string | null; member_addition_order: unknown }[]
      >()
      .maybeSingle(),
    getLatestPlan(user.id),
    supabase
      .from("family_members")
      .select("id, role, display_order, meal_mode, preferred_language, updated_at")
      .eq("user_id", user.id)
      .returns<
        {
          id: string;
          role: string;
          display_order: number;
          meal_mode: string;
          preferred_language: string | null;
          updated_at: string | null;
        }[]
      >(),
  ]);

  if (!profileRes.data?.onboarding_completed_at) return { fired: false, busy: false };
  // Need a ready plan WITH real content — never seed the carry-over off an empty
  // shell (status flips to 'ready' on the first emit while still generating).
  if (
    latest?.status !== "ready" ||
    !latest.plan_data ||
    !planHasContent(latest.plan_data)
  )
    return { fired: false, busy: false };

  const additionOrder = Array.isArray(profileRes.data?.member_addition_order)
    ? (profileRes.data.member_addition_order as string[])
    : [];
  const nextId = pickNextMemberId({
    plan: latest.plan_data,
    members: membersRes.data ?? [],
    additionOrder,
  });

  // Nobody left to generate — but the housekeeper may still be waiting on her
  // cooking instructions, and nothing else will ever retry them.
  //
  // Two paths hand this off to each other and both can decline. Adding a maid
  // fires triggerPlanTranslation, which no-ops while a generation is live on the
  // stated assumption that "the freshly-generated plan lands already
  // translated" — but the generation only translates if budget REMAINS after its
  // day loop, and at five beneficiaries the loop routinely spends the whole box.
  // Observed on a real household: maid added mid-generation, plan finished
  // ready, no translation, no housekeeper view, and no signal that the product's
  // headline feature had silently not happened.
  // Nobody is missing a day — but somebody's DATA may have moved on without the
  // plan. `updateFamilyMember` regenerates on a substantive edit unless a run
  // holds the lock, and in that case it returned ok with no generation under a
  // comment saying "defer the regen". Nothing deferred it: the drain only looks
  // for missing days, and an edited member still has all seven stale ones. So an
  // allergy added while any generation was in flight saved the row, left the
  // old meals in place, and sent her to /plan as if it had worked — the exact
  // failure memberEditIsSubstantive exists to prevent, reachable again through a
  // busy window that every /plan visit opens.
  if (!nextId) {
    const stale = staleMemberIds(membersRes.data ?? [], latest.generated_at);
    if (stale.length > 0) {
      const gen = await runFamilyGeneration(supabase, user.id, {
        regenerateMemberId: stale[0]!,
      });
      // Busy again → the next tick retries; the staleness signal survives
      // because only a completed regeneration can clear it.
      return { fired: gen.ok, busy: !gen.ok && gen.kind === "busy" };
    }
    // A member removed while a run held the lock was never taken out of the
    // plan: the run in flight had already captured the roster and wrote them
    // back, and afterwards nobody was 'short' or 'pending', so nothing fired —
    // their tab stayed indefinitely. A wide carry-over run assembles from the
    // LIVE roster; with every live member's week carried it makes no model
    // call, so this costs nothing but the write.
    const liveIds = new Set((membersRes.data ?? []).map((m) => m.id));
    const ghosts = latest.plan_data.members.filter(
      (m) => m.member_id !== "mom" && !liveIds.has(m.member_id),
    );
    if (ghosts.length > 0) {
      const gen = await runFamilyGeneration(supabase, user.id, {});
      return { fired: gen.ok, busy: !gen.ok && gen.kind === "busy" };
    }
    const hk = (membersRes.data ?? []).find((m) => m.role === "housekeeper");
    const locale = hk?.preferred_language;
    if (
      hk &&
      locale &&
      locale !== "ar" &&
      isLocaleCode(locale) &&
      !planIsTranslated(latest.plan_data, locale)
    ) {
      await triggerPlanTranslation({ supabase, userId: user.id, locale });
      // Not "fired": this writes the same plan row in place rather than starting
      // a generation, so the caller should keep polling, not stop.
      return { fired: false, busy: false };
    }
    return { fired: false, busy: false };
  }

  // An already-in-plan member only missing a failed day is finished alone (no
  // shared-meal impact). An ABSENT (new) member that SHARES the family menu rebuilds
  // the whole shared group together so shared meals merge across everyone (the
  // one-at-a-time path can't merge a newcomer into the others' existing shared
  // meals); an INDEPENDENT newcomer has private dishes — generate only them, carry
  // the rest.
  const inPlan = latest.plan_data.members.some((m) => m.member_id === nextId);
  let gen: FamilyGenResult;
  if (inPlan) {
    // Several people missing days is the NORMAL state after a budget-trimmed
    // run — and filling them one at a time meant one invocation per member,
    // each waiting on a page visit and each holding the lock, so a week that
    // stopped at 4/7 trickled in over five rounds. A carry-over run with no
    // member scope fills every incomplete member at once (the engine's
    // `membersToGenerate` has always done this when `onlyMemberId` is absent),
    // and because members already in the plan carry their targets from it, the
    // run skips phase 1 entirely — day calls only, same total tokens, one
    // invocation instead of five.
    const gaps = incompleteInPlanMemberIds({
      plan: latest.plan_data,
      maxAttempts: MEMBER_GEN_MAX_ATTEMPTS,
    });
    gen =
      gaps.length > 1
        ? await runFamilyGeneration(supabase, user.id, {})
        : await runFamilyGeneration(supabase, user.id, { onlyMemberId: nextId });
  } else {
    const nextMode = (membersRes.data ?? []).find((m) => m.id === nextId)?.meal_mode;
    gen =
      nextMode === "independent"
        ? await runFamilyGeneration(supabase, user.id, { onlyMemberId: nextId })
        : await runFamilyGeneration(supabase, user.id, { regenerateSharedGroup: true });
  }
  return { fired: gen.ok, busy: !gen.ok && gen.kind === "busy" };
}


/**
 * Has this plan already been translated for `locale`? Checked against the meals
 * themselves rather than a plan-level flag, so a half-written translation still
 * counts as pending and gets finished.
 */
function planIsTranslated(plan: MealPlan, locale: string): boolean {
  const meals = plan.members.flatMap((m) => m.days.flatMap((d) => d.meals));
  if (meals.length === 0) return true; // nothing to translate yet
  return meals.every(
    (meal) => meal.prep_steps_translated_locale === locale,
  );
}

/**
 * The single member a generation run should target next, in STRICT order — shared
 * by the deferred drain and addFamilyMember so adds never jump the queue:
 *  1. an in-plan member still missing a mealed day (a day that failed after in-run
 *     retries), under the retry cap → finish it before starting anyone new;
 *  2. else the first ABSENT pending member by member_addition_order (then
 *     display_order);
 *  3. else null (nothing to do).
 * Pure: callers pass the already-loaded plan + members + order.
 */
function pickNextMemberId(params: {
  plan: MealPlan;
  members: { id: string; role: string; display_order: number }[];
  additionOrder: string[];
}): string | null {
  const { plan, members, additionOrder } = params;
  const daysTotal = plan.days_total ?? 7;
  const genAttempts = plan.gen_attempts ?? {};
  const incomplete = plan.members.find(
    (m) =>
      m.days.filter((d) => d.meals.length > 0).length < daysTotal &&
      (genAttempts[m.member_id] ?? 0) < MEMBER_GEN_MAX_ATTEMPTS,
  );
  if (incomplete) return incomplete.member_id;

  const planMemberIds = plan.members.map((m) => m.member_id);
  const pending = members.filter(
    (m) => m.role !== "housekeeper" && !planMemberIds.includes(m.id),
  );
  if (pending.length === 0) return null;

  const orderIndex = (id: string) => {
    const i = additionOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...pending].sort(
    (a, b) =>
      orderIndex(a.id) - orderIndex(b.id) || a.display_order - b.display_order,
  )[0]!.id;
}

/**
 * Trigger generation for onboarding / family changes (rate limit bypassed) and
 * map the dispatch result to a user-facing Arabic message. Shared by
 * saveMomProfile and the Phase 2 family actions.
 */
type FamilyGenResult =
  | { ok: true; plan_generation_id: string }
  | { ok: false; kind: "upgrade"; current: number; max: number }
  | { ok: false; kind: "busy" }
  | { ok: false; kind: "error"; error: string };

async function runFamilyGeneration(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  opts: {
    regenerateMemberId?: string;
    onlyMemberId?: string;
    regenerateSharedGroup?: boolean;
    fullRegen?: boolean;
  } = {},
): Promise<FamilyGenResult> {
  const result = await triggerPlanGeneration({
    supabase,
    userId,
    bypassRateLimit: true,
    // Family changes are incremental: keep already-generated members and
    // generate only the new/edited one (aligned to the family's dishes).
    // regenerateSharedGroup rebuilds the WHOLE shared group together (carry-over
    // ON — independent members are kept) when a new shared member is added.
    // A full regen (fullRegen) is the only one with carry-over OFF — it's needed
    // when the change affects EVERY meal (e.g. adding a housekeeper, which
    // requires translating all recipes).
    carryOver: !opts.fullRegen,
    regenerateMemberId: opts.regenerateMemberId,
    onlyMemberId: opts.onlyMemberId,
    regenerateSharedGroup: opts.regenerateSharedGroup,
  });

  if (result.ok) return { ok: true, plan_generation_id: result.mealPlanId };

  switch (result.kind) {
    case "busy":
      return { ok: false, kind: "busy" };
    case "medical":
      return {
        ok: false,
        kind: "error",
        error: "يجب استشارة الطبيب قبل إنشاء الخطة بسبب حالة صحية مذكورة",
      };
    case "access": {
      if (result.access.reason === "person_count_exceeded") {
        return {
          ok: false,
          kind: "upgrade",
          current: result.access.details?.current_people ?? 0,
          max: result.access.details?.max_people ?? 0,
        };
      }
      return {
        ok: false,
        kind: "error",
        error: "اشتراكك غير نشط. جددي الاشتراك للمتابعة",
      };
    }
    case "onboarding":
      return { ok: false, kind: "error", error: "يلزم إكمال بياناتك أولاً قبل إنشاء الخطة" };
    default:
      return { ok: false, kind: "error", error: "حدث خطأ في إنشاء الخطة — يمكنك المحاولة مرة ثانية" };
  }
}

export type MemberType = "adult" | "child" | "pregnant" | "lactating";

export interface FamilyMemberInput {
  member_type: MemberType;
  role: string; // dad | other_adult | son | daughter | other_child
  name: string;
  birth_year: number;
  sex?: string | null;
  height_cm?: number | null;
  weight_kg?: number | null;
  activity_level?: string | null;
  user_goal?: UserGoal; // adult only
  preferred_language?: string;
  allergies: string[];
  dislikes: string[];
  conditions: string[];
  other_condition?: string;
  consulted_doctor: boolean;
  // Shared family meals (default) vs the member's own independent dishes.
  meal_mode?: "shared" | "independent";
  // Coach questionnaire (00013) — adults; pregnant/lactating get the safe
  // subset (meds/supplements/water); children none.
  day_nature?: DayNature;
  exercise_days?: ExerciseDays;
  exercise_type?: ExerciseType | null;
  target_weight_kg?: number | null;
  water_liters?: "lt1" | "l1_2" | "l2_3" | "gt3" | null;
  sleep_hours?: number | null;
  medications?: string[];
  supplements?: string[];
  // child
  school_meal_handling?: string | null;
  picky_eater?: boolean;
  // pregnant
  trimester?: number | null;
  high_risk_pregnancy?: boolean;
  nausea_foods?: string[];
  // lactating
  months_postpartum?: number | null;
  feeding_mode?: "exclusive" | "mixed" | "formula" | null;
}

type AddMemberResult =
  | { ok: true; member_id: string; plan_generation_id: string | null }
  | {
      ok: false;
      upgrade_required: true;
      member_id: string;
      current: number;
      max: number;
      /**
       * Where the upgrade CTA should actually go. An EXISTING paying subscriber
       * is refused at /pricing — /api/checkout 409s them with «غيّري الباقة من
       * صفحة الاشتراك» — so sending them there made the only exit from the
       * over-limit state a dead end. Resolved server-side, where the
       * subscription is already in hand.
       */
      upgrade_href: "/subscription" | "/pricing";
    }
  | { ok: false; error: string };

/** /subscription for a live subscriber (checkout would 409), /pricing otherwise. */
async function upgradeDestination(
  userId: string,
): Promise<"/subscription" | "/pricing"> {
  const sub = await getCurrentSubscription(userId);
  return hasLiveLemonsqueezySubscription(sub) ? "/subscription" : "/pricing";
}

/** Build the family_members row payload from a wizard input (shared add/update). */
function buildMemberRow(input: FamilyMemberInput, userId: string) {
  const conditions = [...input.conditions];
  const other = input.other_condition?.trim();
  if (other) conditions.push(other);
  const hasMedical = conditions.length > 0;

  let primaryGoal: string | null;
  if (input.member_type === "pregnant" || input.member_type === "lactating") {
    primaryGoal = "pregnancy_lactation";
  } else if (input.member_type === "child") {
    primaryGoal = null; // children: food-pyramid portions, no goal-based calories
  } else {
    primaryGoal = mapUserGoalToSara(input.user_goal ?? "maintain_weight", {
      hasMedical,
      isPregnantOrLactating: false,
      conditions,
    });
  }

  const isAdult = input.member_type === "adult";
  // Pregnancy and lactation calories are maintenance (TDEE) plus a stage
  // addition, so they need an activity factor exactly like an adult does —
  // these fields used to be adult-only, which left activity_level null for
  // both and forced the model to guess the multiplier.
  const isAdultLike =
    isAdult ||
    input.member_type === "pregnant" ||
    input.member_type === "lactating";
  // Derive the canonical level from the concrete answers when available.
  const activityLevel =
    isAdultLike && input.day_nature && input.exercise_days
      ? activityLevelFrom(input.day_nature, input.exercise_days)
      : (input.activity_level ?? null);

  return {
    user_id: userId,
    name: input.name,
    role: input.role,
    member_type: input.member_type,
    sex: input.sex ?? null,
    birth_year: input.birth_year,
    height_cm: input.height_cm ?? null,
    weight_kg: input.weight_kg ?? null,
    activity_level: activityLevel,
    primary_goal: primaryGoal,
    preferred_language: input.preferred_language ?? "ar",
    meal_mode: input.meal_mode ?? "shared",
    medical_conditions: conditions,
    allergies: input.allergies,
    dislikes: input.dislikes,
    consulted_doctor: input.consulted_doctor,
    trimester: input.member_type === "pregnant" ? (input.trimester ?? null) : null,
    months_postpartum:
      input.member_type === "lactating" ? (input.months_postpartum ?? null) : null,
    high_risk_pregnancy:
      input.member_type === "pregnant" ? !!input.high_risk_pregnancy : false,
    school_meal_handling:
      input.member_type === "child" ? (input.school_meal_handling ?? null) : null,
    picky_eater: input.member_type === "child" ? !!input.picky_eater : false,
    // Coach questionnaire (00013). Supplements now land in their OWN column —
    // the old lactating wizard folded them into medical_conditions via
    // other_condition (data corruption, fixed with the wizard in the same
    // release). Children get none of these.
    // A weight target stays adult-only — pregnancy and lactation are not
    // weight-change goals.
    target_weight_kg: isAdult ? (input.target_weight_kg ?? null) : null,
    day_nature: isAdultLike ? (input.day_nature ?? null) : null,
    exercise_days: isAdultLike ? (input.exercise_days ?? null) : null,
    exercise_type: isAdultLike ? (input.exercise_type ?? null) : null,
    sleep_hours: isAdult ? (input.sleep_hours ?? null) : null,
    water_liters: input.member_type === "child" ? null : (input.water_liters ?? null),
    medications: input.member_type === "child" ? [] : (input.medications ?? []),
    supplements: input.member_type === "child" ? [] : (input.supplements ?? []),
    nausea_foods:
      input.member_type === "pregnant" ? (input.nausea_foods ?? []) : [],
    feeding_mode:
      input.member_type === "lactating" ? (input.feeding_mode ?? null) : null,
  };
}

/**
 * Is there room for one more beneficiary on the current tier?
 *
 * The limit is enforced HERE, at the boundary, rather than by the generation
 * that follows an add. Writing the row first and discovering the limit
 * afterwards is what let a household sit permanently above its tier — and
 * because the same count gates generation, that state blocked plans for
 * everyone in the family, not just the member who crossed the line.
 *
 * Free-access mode and unlimited tiers return room unconditionally (getTierLimit
 * already encodes both). A subscription that cannot be read, or a count that
 * cannot be read, refuses — the same fail-closed stance as the access gate.
 */
async function assertRoomForAnotherBeneficiary(
  userId: string,
): Promise<{ ok: true } | { ok: false; error: AddMemberResult }> {
  const sub = await getCurrentSubscription(userId);
  const maxPeople = sub ? getTierLimit(sub.tier) : getTierLimit("starter");
  if (maxPeople === null) return { ok: true };

  const current = await countBeneficiaries(userId);
  if (current === null) {
    return {
      ok: false,
      error: {
        ok: false,
        error: "تعذّر التحقق من عدد أفراد عائلتك. يرجى المحاولة بعد قليل",
      },
    };
  }
  if (current + 1 > maxPeople) {
    return {
      ok: false,
      error: {
        ok: false,
        upgrade_required: true,
        // No row was written, so there is no member id to report.
        member_id: "",
        current: current + 1,
        max: maxPeople,
        upgrade_href: hasLiveLemonsqueezySubscription(sub)
          ? "/subscription"
          : "/pricing",
      },
    };
  }
  return { ok: true };
}

/** Phase 2 — add a family member, then regenerate the whole-family plan (free). */
export async function addFamilyMember(
  input: FamilyMemberInput,
): Promise<AddMemberResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "يجب تسجيل الدخول" };

  const parsedMember = familyMemberInputSchema.safeParse(input);
  if (!parsedMember.success) {
    return { ok: false, error: firstFieldErrorAr(parsedMember.error) };
  }
  // The member half of the ONE doctor-gate rule (medicalGate.ts), enforced
  // server-side like saveMomProfile does for the owner. The wizard already
  // blocks the button, but the server trusted it — and a member row that
  // fails this gate makes buildPlanContext refuse the WHOLE household with
  // no self-service way to clear it (confirmDoctorConsult is owner-only).
  if (
    memberRequiresDoctorSignOff({
      medical_conditions: parsedMember.data.conditions ?? [],
      high_risk_pregnancy: parsedMember.data.high_risk_pregnancy,
    }) &&
    !parsedMember.data.consulted_doctor
  ) {
    return { ok: false, error: DOCTOR_SIGN_OFF_REQUIRED_AR };
  }

  // Tier limit, checked BEFORE the insert. The row used to be written first and
  // the limit consulted only afterwards, by the generation that followed — so
  // an over-limit add saved the member and THEN showed a paywall, leaving the
  // household permanently above its tier. Since countBeneficiaries drives the
  // generation gate, that state also denied plan generation for everyone,
  // including a plain regenerate for mom.
  //
  // A housekeeper is not a beneficiary and is added through addHousekeeper,
  // which is deliberately not gated.
  const capacity = await assertRoomForAnotherBeneficiary(user.id);
  if (!capacity.ok) return capacity.error;

  // Next display_order = current max + 1. This is a read-then-write, so two
  // concurrent adds (a double-tapped submit, or a retried request) can land on
  // the same order and make the member tabs non-deterministic. There is no
  // unique index to lean on, so the client also guards the double-submit; this
  // stays the cheap path and the ordering is cosmetic either way.
  const { data: existingRows } = await supabase
    .from("family_members")
    .select("display_order")
    .eq("user_id", user.id)
    .order("display_order", { ascending: false })
    .limit(1);
  const existing = existingRows as { display_order: number | null }[] | null;
  const nextOrder =
    existing && existing.length > 0 ? (existing[0]!.display_order ?? 0) + 1 : 0;

  const memberId = crypto.randomUUID();
  const row = {
    ...buildMemberRow(input, user.id),
    id: memberId,
    display_order: nextOrder,
  };

  const { error: insertError } = await supabase
    .from("family_members")
    .insert(row);
  if (insertError) {
    Sentry.captureException(insertError, {
      tags: { area: "family", step: "addFamilyMember.insert", userId: user.id },
    });
    return { ok: false, error: insertError.message };
  }

  // Append to member_addition_order (best-effort; not load-bearing).
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("member_addition_order, onboarding_completed_at")
    .eq("id", user.id)
    .single();
  const typedProfile = profileRow as
    | { member_addition_order: unknown; onboarding_completed_at: string | null }
    | null;
  const additionOrder = typedProfile?.member_addition_order;
  const order = Array.isArray(additionOrder) ? (additionOrder as string[]) : [];
  const updatedOrder = [...order, memberId];
  await supabase
    .from("profiles")
    .update({ member_addition_order: updatedOrder })
    .eq("id", user.id);

  revalidatePath("/family");

  // Onboarding add-a-member loop (onboarding not finalized yet): just SAVE the
  // member — no generation. The whole family is generated once at the end of the
  // loop via finishOnboardingAndGenerate. (There's no plan to carry over yet
  // anyway.) Post-onboarding adds (below) generate incrementally.
  if (!typedProfile?.onboarding_completed_at) {
    return { ok: true, member_id: memberId, plan_generation_id: null };
  }

  // Post-onboarding generation. A SHARED add rebuilds the whole shared group
  // together so the existing shared members stream in day-by-day alongside the
  // newcomer; an INDEPENDENT add (or no base plan) keeps the one-at-a-time drain.
  const latest = await getLatestPlan(user.id);
  const basePlan =
    latest?.status === "ready" && latest.plan_data && planHasContent(latest.plan_data)
      ? latest.plan_data
      : null;
  const isSharedAdd = (input.meal_mode ?? "shared") === "shared";

  let gen: FamilyGenResult;
  if (isSharedAdd && basePlan) {
    // Shared add: rebuild the WHOLE shared group together (mom + every shared member
    // + the newcomer) so the new menu is genuinely shared and the existing shared
    // members stream in day-by-day alongside the new one. Independent members + the
    // housekeeper are carried over verbatim. (A lone shared member — no one else
    // shares — just generates itself, handled downstream.)
    gen = await runFamilyGeneration(supabase, user.id, { regenerateSharedGroup: true });
  } else {
    // Independent add (or no base plan to carry): one-at-a-time drain. Generate the
    // NEXT member in order — NOT necessarily the just-added one. If an earlier-added
    // member is still pending (or an in-plan member is incomplete), it goes first;
    // the just-added member waits its turn. Others are carried; never two members
    // generating at once.
    let target = memberId;
    if (basePlan) {
      const { data: famRows } = await supabase
        .from("family_members")
        .select("id, role, display_order")
        .eq("user_id", user.id)
        .returns<{ id: string; role: string; display_order: number }[]>();
      target =
        pickNextMemberId({
          plan: basePlan,
          members: famRows ?? [],
          additionOrder: updatedOrder,
        }) ?? memberId;
    }
    gen = await runFamilyGeneration(supabase, user.id, { onlyMemberId: target });
  }
  if (gen.ok)
    return { ok: true, member_id: memberId, plan_generation_id: gen.plan_generation_id };
  if (gen.kind === "upgrade")
    return {
      ok: false,
      upgrade_required: true,
      member_id: memberId,
      current: gen.current,
      max: gen.max,
      upgrade_href: await upgradeDestination(user.id),
    };
  // Current plan still generating → member is saved; defer their generation (the
  // dashboard "generate plan" banner picks it up once the current plan is ready).
  if (gen.kind === "busy")
    return { ok: true, member_id: memberId, plan_generation_id: null };
  return { ok: false, error: gen.error };
}

/**
 * Add a housekeeper (the cook — not a plan beneficiary, so no tier gating, no
 * physical/medical fields). Triggers a FULL regen so every recipe gets
 * translated into her language. Can be added post-onboarding from /family.
 */
export async function addHousekeeper(input: {
  name: string;
  preferred_language: string;
  // Asked since 08/2026. Before that her wizard had no sex step at all and the
  // column was left null, so every surface that needed one assumed a woman —
  // including the translation prompts, which told the model it was writing for
  // «طبّاخة». A male cook read instructions addressed to someone else.
  sex?: string;
}): Promise<{ ok: true; plan_generation_id: string | null } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "يجب تسجيل الدخول" };

  // One housekeeper per household — reuse the existing row if present.
  const { data: existingHk } = await supabase
    .from("family_members")
    .select("id")
    .eq("user_id", user.id)
    .eq("role", "housekeeper")
    .maybeSingle();

  const { data: orderRows } = await supabase
    .from("family_members")
    .select("display_order")
    .eq("user_id", user.id)
    .order("display_order", { ascending: false })
    .limit(1);
  const ord = orderRows as { display_order: number | null }[] | null;
  const nextOrder = ord && ord.length > 0 ? (ord[0]!.display_order ?? 0) + 1 : 0;

  const existingId = (existingHk as { id: string } | null)?.id;
  const hkName = input.name || "الخدامة";
  if (existingId) {
    const updateRow = {
      name: hkName,
      preferred_language: input.preferred_language,
      // Only written when answered, so editing her name or language cannot
      // silently blank a sex she already gave.
      ...(input.sex === "male" || input.sex === "female" ? { sex: input.sex } : {}),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("family_members")
      .update(updateRow)
      .eq("id", existingId)
      .eq("user_id", user.id);
    if (error) {
      Sentry.captureException(error, {
        tags: { area: "family", step: "addHousekeeper.update", userId: user.id },
      });
      return { ok: false, error: error.message };
    }
  } else {
    const insertRow = {
      id: crypto.randomUUID(),
      user_id: user.id,
      name: hkName,
      role: "housekeeper",
      member_type: "housekeeper",
      preferred_language: input.preferred_language,
      sex: input.sex === "male" || input.sex === "female" ? input.sex : null,
      consulted_doctor: false,
      display_order: nextOrder,
    };
    const { error } = await supabase
      .from("family_members")
      .insert(insertRow);
    if (error) {
      Sentry.captureException(error, {
        tags: { area: "family", step: "addHousekeeper.insert", userId: user.id },
      });
      return { ok: false, error: error.message };
    }
  }

  revalidatePath("/family");
  // Do NOT regenerate the family's meals — just translate the EXISTING plan into
  // her language in place (fire-and-forget). The wife's plan is untouched.
  //
  // Gated on the subscription. A translation is a full paid Anthropic pass over
  // the plan, and this was the only path to one with no access check at all:
  // an inactive account could drive real spend by re-saving the housekeeper's
  // language. She is not a beneficiary, so the person-count limit does not
  // apply — canGenerateForFamilyChange covers exactly the right ground.
  const access = await canGenerateForFamilyChange(user.id);
  if (
    access.allowed &&
    isLocaleCode(input.preferred_language) &&
    input.preferred_language !== "ar"
  ) {
    await triggerPlanTranslation({
      supabase,
      userId: user.id,
      locale: input.preferred_language,
    });
  }
  return { ok: true, plan_generation_id: null };
}

/**
 * Delete every engagement row a removed member owns, and drop them from the
 * addition order.
 *
 * `member_id` on the engagement tables is TEXT with NO foreign key — it has to
 * be, because it also carries the "mom" and "household" sentinels — so nothing
 * cascades when a family_members row is deleted. Their check-ins, verdicts,
 * session marks, absences and weigh-ins simply stayed behind, and the season
 * board still read them: the family ring and strip counted meals for someone no
 * longer in the household while the per-member scores (which do filter the
 * roster) did not, so the family total and the sum of its members could not
 * reconcile. seasonMath now filters as well, but the rows themselves should go.
 *
 * Best-effort: the member is already deleted and that is the user's intent, so
 * a cleanup failure is reported to Sentry rather than surfaced as a failed
 * removal. The stale id is also pruned from member_addition_order, which
 * pickNextMemberId reads to choose the next member to generate.
 */
async function purgeMemberEngagementRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  memberId: string,
): Promise<void> {
  const tables = [
    "meal_checkins",
    "meal_verdicts",
    "workout_checkins",
    "meal_absences",
    "body_logs",
    // Keyed by the EXCEPTED member; the checkin it hangs off may belong to
    // another member (or the household row), so the cascade never reaches it.
    "member_exceptions",
  ] as const;

  for (const table of tables) {
    const { error } = await (supabase as unknown as SupabaseClient)
      .from(table)
      .delete()
      .eq("user_id", userId)
      .eq("member_id", memberId);
    if (error) {
      Sentry.captureException(error, {
        tags: { area: "family", step: `removeFamilyMember.purge.${table}`, userId },
      });
    }
  }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("member_addition_order")
    .eq("id", userId)
    .single();
  const order = (profileRow as { member_addition_order: unknown } | null)
    ?.member_addition_order;
  if (Array.isArray(order) && order.includes(memberId)) {
    await supabase
      .from("profiles")
      .update({
        member_addition_order: (order as string[]).filter((id) => id !== memberId),
      })
      .eq("id", userId);
  }
}

/** Phase 2 — remove a member, then regenerate (or skip if only Mom remains). */
export async function removeFamilyMember(
  memberId: string,
): Promise<{ ok: true; plan_generation_id: string | null } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "يجب تسجيل الدخول" };

  const { error } = await supabase
    .from("family_members")
    .delete()
    .eq("id", memberId)
    .eq("user_id", user.id);
  if (error) {
    Sentry.captureException(error, {
      tags: { area: "family", step: "removeFamilyMember", userId: user.id },
    });
    return { ok: false, error: error.message };
  }

  await purgeMemberEngagementRows(supabase, user.id, memberId);

  revalidatePath("/family");

  const { count } = await supabase
    .from("family_members")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .neq("role", "housekeeper");

  if ((count ?? 0) === 0) {
    return { ok: true, plan_generation_id: null };
  }
  const gen = await runFamilyGeneration(supabase, user.id);
  // Removing a member can't push over a tier limit, so 'upgrade' won't occur here.
  if (gen.ok) return { ok: true, plan_generation_id: gen.plan_generation_id };
  // Current plan still generating → removal is saved; defer the regen.
  if (gen.kind === "busy") return { ok: true, plan_generation_id: null };
  return { ok: false, error: gen.kind === "upgrade" ? "باقتك لا تكفي." : gen.error };
}

/** Phase 2 — edit a member; regenerate only when a substantive field changed. */
export async function updateFamilyMember(
  memberId: string,
  input: FamilyMemberInput,
): Promise<AddMemberResult> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return { ok: false, error: "يجب تسجيل الدخول" };

  const parsedMember = familyMemberInputSchema.safeParse(input);
  if (!parsedMember.success) {
    return { ok: false, error: firstFieldErrorAr(parsedMember.error) };
  }
  // The member half of the ONE doctor-gate rule (medicalGate.ts), enforced
  // server-side like saveMomProfile does for the owner. The wizard already
  // blocks the button, but the server trusted it — and a member row that
  // fails this gate makes buildPlanContext refuse the WHOLE household with
  // no self-service way to clear it (confirmDoctorConsult is owner-only).
  if (
    memberRequiresDoctorSignOff({
      medical_conditions: parsedMember.data.conditions ?? [],
      high_risk_pregnancy: parsedMember.data.high_risk_pregnancy,
    }) &&
    !parsedMember.data.consulted_doctor
  ) {
    return { ok: false, error: DOCTOR_SIGN_OFF_REQUIRED_AR };
  }

  const { data: beforeRow } = await supabase
    .from("family_members")
    .select("*")
    .eq("id", memberId)
    .eq("user_id", user.id)
    .single();
  const before = beforeRow as FamilyMemberRow | null;

  const row = buildMemberRow(input, user.id);
  const { error } = await supabase
    .from("family_members")
    .update(row)
    .eq("id", memberId)
    .eq("user_id", user.id);
  if (error) {
    Sentry.captureException(error, {
      tags: { area: "family", step: "updateFamilyMember", userId: user.id },
    });
    return { ok: false, error: error.message };
  }

  revalidatePath("/family");
  // A name-only edit skips regeneration (below) but still changes the display
  // name the plan tabs / dashboard show via the read-time overlay
  // (applyMemberDisplayNames) — bust their caches so it shows at once.
  revalidatePath("/plan");
  revalidatePath("/dashboard");

  // Substantive change → regenerate; cosmetic (name only) → skip.
  const substantive = memberEditIsSubstantive(
    before as unknown as Record<string, unknown> | null,
    row,
  );

  if (!substantive) {
    return { ok: true, member_id: memberId, plan_generation_id: null };
  }
  const gen = await runFamilyGeneration(supabase, user.id, {
    regenerateMemberId: memberId,
  });
  if (gen.ok)
    return { ok: true, member_id: memberId, plan_generation_id: gen.plan_generation_id };
  if (gen.kind === "upgrade")
    return {
      ok: false,
      upgrade_required: true,
      member_id: memberId,
      current: gen.current,
      max: gen.max,
      upgrade_href: await upgradeDestination(user.id),
    };
  // Current plan still generating → edit is saved; defer the regen.
  if (gen.kind === "busy")
    return { ok: true, member_id: memberId, plan_generation_id: null };
  return { ok: false, error: gen.error };
}
