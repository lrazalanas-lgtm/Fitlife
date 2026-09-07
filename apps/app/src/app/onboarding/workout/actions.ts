"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { WorkoutProfileSchema } from "@fitlife/plan-engine";
import {
  isWorkoutEligibleMember,
  isWorkoutEligibleMom,
} from "@/lib/plans/workoutEligibility";
import { triggerWorkoutGeneration } from "@/lib/plans/dispatch";
import { finishOnboardingToSubscription } from "../actions";

const EntriesSchema = z
  .array(
    z.object({
      target: z.union([z.literal("mom"), z.string().uuid()]),
      // Write-side only: the chosen weekdays must number exactly the desired
      // training days. The wizard enforces this, but the server trusted the
      // client — a hand-crafted body could store a profile whose sessions
      // then remap onto the wrong number of days. Read-side parsing stays
      // lenient so a legacy profile without preferred_days still generates.
      profile: WorkoutProfileSchema.superRefine((p, ctx) => {
        if (p.preferred_days && p.preferred_days.length !== p.desired_days) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["preferred_days"],
            message: "عدد أيام التدريب المختارة لا يطابق عدد الأيام المطلوبة",
          });
        }
      }),
    }),
  )
  .min(1)
  .max(10);

export type WorkoutOptInEntries = z.infer<typeof EntriesSchema>;

type SaveResult = { ok: true } | { ok: false; error: string };

/**
 * Persist the workout questionnaire answers for the selected people, then
 * route by onboarding state: mid-onboarding → the subscription hand-off
 * (generation for BOTH plans fires after subscribe / solo-continue); after
 * onboarding (dashboard/profile opt-in or edit) → dispatch the workout
 * generation right away and land on the workout view.
 */
export async function saveWorkoutProfiles(
  entries: WorkoutOptInEntries,
): Promise<SaveResult> {
  const parsed = EntriesSchema.safeParse(entries);
  if (!parsed.success) {
    return { ok: false, error: "بيانات غير صالحة — يلزم التحقق من الإجابات والمحاولة مرة أخرى" };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "يجب تسجيل الدخول" };

  for (const entry of parsed.data) {
    if (entry.target === "mom") {
      // The account holder passes the same server-side age gate as members —
      // an under-18 signup must never carry a workout profile.
      const { data: mom } = await supabase
        .from("profiles")
        .select("birth_year")
        .eq("id", user.id)
        .maybeSingle();
      if (!mom || !isWorkoutEligibleMom(mom)) {
        return { ok: false, error: "خطة التمارين متاحة للبالغين فقط" };
      }
      const { error } = await supabase
        .from("profiles")
        .update({ workout_profile: entry.profile })
        .eq("id", user.id);
      if (error) {
        Sentry.captureException(error, {
          tags: { area: "workout-optin", userId: user.id },
        });
        return { ok: false, error: "فشل الحفظ — يمكنك المحاولة مرة أخرى" };
      }
    } else {
      // Eligibility enforced server-side: own member, adult-family beneficiary
      // (children and the housekeeper are never eligible; pregnant/lactating
      // members already carry consulted_doctor=true from their add wizard).
      const { data: member } = await supabase
        .from("family_members")
        .select("id, member_type, role, birth_year")
        .eq("id", entry.target)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!member || !isWorkoutEligibleMember(member)) {
        return { ok: false, error: "أحد الأفراد غير مؤهل لخطة التمارين" };
      }
      const { error } = await supabase
        .from("family_members")
        .update({ workout_profile: entry.profile })
        .eq("id", entry.target)
        .eq("user_id", user.id);
      if (error) {
        Sentry.captureException(error, {
          tags: { area: "workout-optin", userId: user.id },
        });
        return { ok: false, error: "فشل الحفظ — يمكنك المحاولة مرة أخرى" };
      }
    }
  }

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Post-save continuation. Split from saveWorkoutProfiles so the client can
 * show save errors inline, then hand off (redirect() throws NEXT_REDIRECT).
 */
export async function continueAfterWorkoutOptIn(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarding_completed_at")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.onboarding_completed_at) {
    // Mid-onboarding: same hand-off as the meals-only path; the combined
    // generation fires from generateSoloAndContinue / syncFamilyPlanAfterSubscribe.
    await finishOnboardingToSubscription();
    return;
  }

  // Post-onboarding opt-in/edit: dispatch now (busy → the in-flight run wins).
  await triggerWorkoutGeneration({ supabase, userId: user.id });
  redirect("/plan?view=workout");
}

/**
 * Retry a failed workout generation from the plan page. Busy is success from
 * the user's perspective (a run is live) — either way land on the progress
 * view.
 */
export async function retryWorkoutGeneration(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  await triggerWorkoutGeneration({ supabase, userId: user.id });
  revalidatePath("/plan");
  redirect("/plan?view=workout");
}
