import { Suspense } from "react";
import { Users } from "lucide-react";
import {
  getCurrentUserLatestPlan,
  getCurrentUserProfile,
  getCurrentUserFamilyMembers,
} from "@/lib/supabase/queries";
import { canGenerateForFamilyChange } from "@/lib/subscription/access";
import {
  getCurrentSubscription,
  hasLiveLemonsqueezySubscription,
} from "@/lib/subscription/state";
import {
  isWeighInEligibleMember,
  isWeighInEligibleMom,
} from "@/lib/engagement/eligibility";
import {
  collapseMealAbsences,
  collapseMealMarks,
  collapseWorkoutMarks,
  isISODate,
  workoutMarkingWindow,
  type RawSeasonMealRow,
  type RawSeasonWorkoutRow,
} from "@/lib/engagement/seasonMath";
import { addDaysISO, riyadhTodayISO } from "@/lib/plans/dayMapping";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  planHasContent,
  MEMBER_GEN_MAX_ATTEMPTS,
  ownerRequiresDoctorSignOff,
} from "@fitlife/plan-engine";
import { applyChildDisplayTargets } from "@/lib/plans/childTargets";
import { applyMemberDisplayNames } from "@/lib/plans/memberNames";
import { genderPick } from "@/lib/copy/gender";
import { dropRemovedMembers } from "@/lib/plans/removedMembers";
import { staleMemberIds } from "@/lib/plans/memberEdit";
import { LogoutButton } from "../dashboard/LogoutButton";
import { Logo } from "@/components/Logo";
import { BackToDashboard } from "@/components/BackToDashboard";
import { SettingsLink } from "@/components/SettingsLink";
import { EmptyState } from "./EmptyState";
import { PlanGeneratingState } from "./PlanGeneratingState";
import { PlanFailedState } from "./PlanFailedState";
import { PlanViewer } from "./PlanViewer";
import { WorkoutViewer } from "./WorkoutViewer";
import { WorkoutGeneratingState } from "./WorkoutGeneratingState";
import { RetryWorkoutButton } from "./RetryWorkoutButton";
import { getLatestWorkoutPlan } from "@/lib/plans/getLatestWorkoutPlan";
import {
  isWorkoutEligibleMember,
  isWorkoutEligibleMom,
} from "@/lib/plans/workoutEligibility";
import Link from "next/link";
import { PlanOnboardingBanner } from "./PlanOnboardingBanner";
import { DeferredMemberDrain } from "./DeferredMemberDrain";
import { SubscriptionSelfHeal } from "./SubscriptionSelfHeal";

export const metadata = {
  title: "خطتي — فت لايف",
  robots: { index: false, follow: false },
};

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string; view?: string }>;
}) {
  const [{ member, view }, profile, latest, familyMembers] = await Promise.all([
    searchParams,
    getCurrentUserProfile(),
    getCurrentUserLatestPlan(),
    getCurrentUserFamilyMembers(),
  ]);
  // Live-roster names to overlay onto the frozen plan snapshot at read time, so
  // a member/mom rename in Settings is reflected immediately without a
  // regenerate — the snapshot keeps whatever name it captured at generation.
  // Applied to both the meal plan and the workout plan below. See
  // applyMemberDisplayNames.
  const nameRoster = {
    mom: { display_name: profile?.display_name ?? null },
    members: familyMembers,
  };

  const isOnboarded = !!profile?.onboarding_completed_at;
  // The generation gate (plan-engine/medicalGate) refuses a plan while this is
  // true, and it fails BEFORE any meal_plans row exists — so the user lands on
  // the empty state. Surface the confirmation there rather than a create button
  // that can only ever come back refused.
  const needsDoctorSignOff =
    !!profile &&
    !profile.consulted_doctor &&
    ownerRequiresDoctorSignOff({
      medical_conditions: profile.medical_conditions,
      has_medical_conditions: profile.has_medical_conditions,
      is_pregnant: profile.is_pregnant,
    });
  // Members saved but not yet in the plan (deferred while a prior gen was in
  // flight). When onboarding is done and the plan is ready, a lazy drain fills
  // them in (mirrors the dashboard's pending diff; see DeferredMemberDrain).
  const planMemberIds = latest?.member_ids ?? [];
  const pendingMembers = familyMembers.filter(
    (m) => m.role !== "housekeeper" && !planMemberIds.includes(m.id),
  );

  // The workout chain, the meal marks, and the access gate are mutually
  // independent — fetch them in one parallel batch instead of four stages.
  const [workoutBundle, mealMarks, familyChangeAccess] = await Promise.all([
    // Workout plan (opt-in) + its session marks (the exercise pillar). The
    // toggle renders only when a row exists; the meal view is untouched
    // otherwise. Marks are read by USER + the current marking window
    // (calendar-keyed, same definition as the «موسم بيتنا» board via
    // workoutMarkingWindow) — NOT by workout_plan_id: a workout re-dispatch
    // mints a new plan row and a plan-id read rendered every earlier session
    // mark as unmarked while the board still counted it. collapseWorkoutMarks
    // dedupes the multi-version fan-in (last write wins). Untyped cast:
    // workout_checkins (00020) isn't in the generated Database types until
    // db:types is regenerated; select("*") degrades to [] on a pre-apply prod.
    (async () => {
      const workout = profile ? await getLatestWorkoutPlan(profile.id) : null;
      let workoutCheckins:
        | Array<{
            day_index: number;
            member_id: string;
            status: string;
            intensity?: string | null;
          }>
        | undefined;
      if (profile && workout?.status === "ready") {
        const supabase = await createClient();
        const { start, end } = workoutMarkingWindow(riyadhTodayISO());
        const { data } = await (supabase as unknown as SupabaseClient)
          .from("workout_checkins")
          .select("*")
          .eq("user_id", profile.id)
          .gte("local_date", start)
          .lte("local_date", end)
          .order("created_at", { ascending: true })
          .limit(800);
        const raw: RawSeasonWorkoutRow[] = (
          (data ?? []) as Array<Record<string, unknown>>
        ).map((r) => ({
          local_date: (r.local_date ?? null) as string | null,
          day_index: r.day_index as number,
          member_id: (r.member_id ?? null) as string | null,
          status: r.status as string,
          intensity: (r.intensity ?? null) as string | null,
        }));
        // Within the ≤7-day window each weekday occurs at most once, so
        // member|day_index stays unique after the member|date collapse.
        workoutCheckins = collapseWorkoutMarks(raw)
          .filter((m) => Number.isInteger(m.day_index))
          .map((m) => ({
            day_index: m.day_index as number,
            member_id: m.member_id ?? "",
            status: m.status,
            intensity: m.intensity ?? null,
          }));
      }
      return { workout, workoutCheckins };
    })(),
    // Inline per-meal tracking marks + per-dish verdicts («كيف كانت؟») for this
    // plan (interactive page only — history/housekeeper views never receive
    // them). CHECK-INS are read by USER + the plan's calendar week
    // (local_date), matching the «موسم بيتنا» board: a mid-week regenerate
    // mints a new plan row for the same week, and a plan-id read rendered
    // every earlier mark as unmarked while the board still counted it.
    // collapseMealMarks dedupes the multi-version fan-in (last write wins) and
    // re-derives day_index from local_date. ABSENCES are read the same way
    // (see collapseMealAbsences); verdicts stay plan-id keyed — meal_verdicts
    // has no local_date column, so that one needs a migration first. select("*") on purpose:
    // member_id is a 00019 column — naming it would fail the whole read on a
    // pre-apply prod, while * degrades to rows without it (house tolerance
    // pattern). meal_verdicts is a 00017 table; a missing table degrades to [].
    (async () => {
      if (!profile || latest?.status !== "ready") return null;
      const supabase = await createClient();
      // Malformed/absent week anchor (never expected) — degrade to the legacy
      // plan-id-keyed read rather than an unbounded scan.
      const anchor = isISODate(latest.plan_data?.week_start_date)
        ? latest.plan_data!.week_start_date
        : null;
      const checkinBase = supabase.from("meal_checkins").select("*");
      const checkinQuery = (
        anchor
          ? checkinBase
              .eq("user_id", profile.id)
              .gte("local_date", anchor)
              .lte("local_date", addDaysISO(anchor, 6))
          : checkinBase.eq("meal_plan_id", latest.id)
      )
        .order("created_at", { ascending: true })
        .limit(800);
      // meal_absences (00021) is not in the generated types yet — untyped
      // cast, and a pre-apply prod (missing table) degrades to [] so the plan
      // still renders without absence adjustments.
      const [checkinRes, verdictRes, absenceRes] = await Promise.all([
        checkinQuery,
        supabase.from("meal_verdicts").select("*").eq("meal_plan_id", latest.id).limit(400),
        (async (): Promise<{ data: unknown[] | null }> => {
          try {
            // CALENDAR-keyed, exactly like the check-in read above. Every
            // dispatch mints a new meal_plans row and only archives the old
            // one, so a plan-id read went empty mid-week and stranded the
            // absences on the superseded plan — reverting the batch to its
            // unscaled size and letting an excluded member's personal mark
            // light the shared chip. Falls back to the plan-id read when the
            // week anchor is unusable, matching the check-in query.
            const base = (supabase as unknown as SupabaseClient)
              .from("meal_absences")
              .select("*");
            return await (anchor
              ? base
                  .eq("user_id", profile.id)
                  .gte("local_date", anchor)
                  .lte("local_date", addDaysISO(anchor, 6))
              : base.eq("meal_plan_id", latest.id)
            ).limit(400);
          } catch {
            return { data: null };
          }
        })(),
      ]);
      const rawCheckins: RawSeasonMealRow[] = (
        (checkinRes.data ?? []) as Array<Record<string, unknown>>
      ).map((r) => ({
        local_date: (r.local_date ?? null) as string | null,
        day_index: r.day_index as number,
        slot: r.slot as string,
        status: r.status as string,
        reason: (r.reason ?? null) as string | null,
        member_id: (r.member_id ?? null) as string | null,
      }));
      return {
        checkins: collapseMealMarks(rawCheckins, anchor ?? undefined).map((c) => ({
          day_index: c.day_index,
          slot: c.slot,
          status: c.status ?? "",
          reason: c.reason ?? null,
          member_id: c.member_id ?? null,
        })),
        verdicts: ((verdictRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
          day_index: r.day_index as number,
          slot: r.slot as string,
          member_id: (r.member_id ?? null) as string | null,
          verdict: r.verdict as string,
        })),
        // Same collapse the check-ins get: dedupe the fan-in from several
        // same-week plan versions and re-derive day_index from local_date
        // against the current week anchor.
        absences: collapseMealAbsences(
          ((absenceRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
            local_date: (r.local_date ?? null) as string | null,
            day_index: r.day_index as number,
            slot: r.slot as string,
            member_id: (r.member_id ?? "") as string,
          })),
          anchor ?? undefined,
        ),
      };
    })(),
    // Deferred members the tier can't cover → don't auto-drain or show
    // "preparing" (it never completes); show an upgrade nudge instead.
    // (profiles.id = user id.)
    pendingMembers.length > 0 && profile
      ? canGenerateForFamilyChange(profile.id)
      : null,
  ]);

  const { workout, workoutCheckins } = workoutBundle;
  const workoutView = view === "workout" && workout != null;
  const checkins = mealMarks?.checkins;
  const verdicts = mealMarks?.verdicts;
  const absences = mealMarks?.absences;
  const pendingBlocked = familyChangeAccess ? !familyChangeAccess.allowed : false;
  // Where the banner's CTA should go, and which verb it should use. A user who
  // ALREADY pays cannot check out again — /api/checkout 409s them with «غيّري
  // الباقة من صفحة الاشتراك» — so «اشتركي» + /pricing was a dead end for the
  // very people the banner is aimed at (an over-limit household is by
  // definition one that already has a subscription). Past-due users are in the
  // same position: they need the billing page, not a second checkout.
  const blockedSub =
    pendingBlocked && profile ? await getCurrentSubscription(profile.id) : null;
  const blockedIsSubscriber = hasLiveLemonsqueezySubscription(blockedSub);
  const blockedHref = blockedIsSubscriber ? "/subscription" : "/pricing";
  // Order by add order so the banner shows the member being prepared NOW vs the
  // rest still queued (the drain generates them one at a time, in this order).
  const addOrder = Array.isArray(profile?.member_addition_order)
    ? (profile.member_addition_order as string[])
    : [];
  const orderedPending = [...pendingMembers].sort(
    (a, b) =>
      (addOrder.indexOf(a.id) === -1 ? Infinity : addOrder.indexOf(a.id)) -
      (addOrder.indexOf(b.id) === -1 ? Infinity : addOrder.indexOf(b.id)),
  );
  const firstPendingName = orderedPending[0]?.name ?? "";
  const restPendingNames = orderedPending
    .slice(1)
    .map((m) => m.name)
    .join("، ");
  // An in-plan member with a failed/missing day (fewer mealed days than the plan's
  // day count) that's still under the retry cap — the drain re-targets it to
  // completion before starting the next member, so keep the drain mounted for it.
  const daysTotal = latest?.plan_data?.days_total ?? 7;
  const genAttempts = latest?.plan_data?.gen_attempts ?? {};
  const hasIncompleteMember = !!latest?.plan_data?.members.some(
    (m) =>
      m.days.filter((d) => d.meals.length > 0).length < daysTotal &&
      (genAttempts[m.member_id] ?? 0) < MEMBER_GEN_MAX_ATTEMPTS,
  );
  // Members still in the plan but no longer on the roster: a removal that
  // landed while a run held the lock. Hidden from the live view below and
  // handed to the drain, which dispatches a roster-aligning run.
  const liveMemberIds = new Set(familyMembers.map((m) => m.id));
  const ghostMembers = (latest?.plan_data?.members ?? []).filter(
    (m) => m.member_id !== "mom" && !liveMemberIds.has(m.member_id),
  );
  // A member edited AFTER the plan was built (weight, height, birth year, a
  // new allergy). The drain's staleMemberIds branch existed but the drain only
  // mounted for pending/incomplete members, so a lone edit never regenerated.
  const staleMembers =
    latest?.status === "ready" ? staleMemberIds(familyMembers, latest.generated_at) : [];
  const shouldDrain =
    isOnboarded &&
    latest?.status === "ready" &&
    !!latest.plan_data &&
    planHasContent(latest.plan_data) &&
    !pendingBlocked &&
    (pendingMembers.length > 0 ||
      hasIncompleteMember ||
      ghostMembers.length > 0 ||
      staleMembers.length > 0);
  // «رحلتك الخاصة» entries — one per member who may keep a private weight
  // record (adults AND children now, per owner directive; the housekeeper
  // never — the shared rule in engagement/eligibility.ts). The PlanViewer shows
  // the entry on the matching member tab; a child's journey has no body photos
  // and never feeds the shared goal celebration (both enforced in the journey/
  // action/seasonProps layer, not here).
  const journeyMembers = [
    ...(isWeighInEligibleMom(profile?.birth_year ?? null)
      ? [{ id: "mom", name: null as string | null, sex: profile?.sex ?? null }]
      : []),
    ...familyMembers
      .filter((m) => isWeighInEligibleMember(m))
      .map((m) => ({
        id: m.id,
        name: m.name as string | null,
        sex: m.sex as string | null,
      })),
  ];
  // Where the workout view's «add another adult» CTA leads. Workout plans are
  // adults-only and opt-in per person, so the member switcher only fills once a
  // second adult has their own plan. If an eligible adult already exists in the
  // family but isn't on the workout plan yet, point at the opt-in questionnaire
  // (it lists everyone eligible for selection); otherwise there's nobody to opt
  // in yet, so point at /family to add an adult first. Consumed by WorkoutViewer
  // for both the solo prompt and the member-tab «add» link.
  const workoutMemberIds = workout?.member_ids ?? [];
  const addTraineeHref = familyMembers.some(
    (m) => isWorkoutEligibleMember(m) && !workoutMemberIds.includes(m.id),
  )
    ? "/onboarding/workout"
    : "/family";

  // The Exercise view mirrors the meal view's member tabs (owner directive
  // 07/2026): the SAME people/order appear, so switching to Exercise keeps the
  // exact tab row. A member with a program shows it; one without shows an
  // add-plan CTA (eligible adults) or an adults-only note (children). Built from
  // the meal plan's members (so the tab set/order matches the meal view) with
  // live names overlaid; eligibility (the adults-only workout rule) is resolved
  // here from birth_year, which the frozen plan snapshot doesn't carry.
  const workoutEligibleById = new Map<string, boolean>();
  if (profile)
    workoutEligibleById.set(
      "mom",
      isWorkoutEligibleMom({ birth_year: profile.birth_year }),
    );
  for (const m of familyMembers)
    workoutEligibleById.set(m.id, isWorkoutEligibleMember(m));
  const workoutRoster = latest?.plan_data
    ? applyMemberDisplayNames(latest.plan_data, nameRoster).members.map((m) => ({
        member_id: m.member_id,
        member_name_ar: m.member_name_ar,
        eligible: workoutEligibleById.get(m.member_id) ?? m.is_child !== true,
      }))
    : undefined;

  // Housekeeper view entry: only when a housekeeper exists and reads a non-Arabic language.
  const housekeeper = familyMembers.find((m) => m.role === "housekeeper");
  const housekeeperLocale =
    housekeeper && housekeeper.preferred_language !== "ar"
      ? housekeeper.preferred_language
      : undefined;
  // Who we're generating for: prefer the plan's own targeted member (stamped on
  // single-member add/regenerate/edit) so the loader names the right person even when
  // the URL has no ?member (the regenerate button refreshes without it). The
  // add-member redirect's ?member (a name) and the account owner are fallbacks.
  // Never framed as "the family".
  const genId = latest?.plan_data?.generating_member_id;
  const genName = genId
    ? genId === "mom"
      ? (profile?.display_name ?? null)
      : (familyMembers.find((m) => m.id === genId)?.name ?? null)
    : null;
  const generatingFor = genName ?? member ?? profile?.display_name ?? null;

  // A member added mid-run is saved + queued (the drain generates them once the
  // current run finishes) — reassure rather than show a "wait" error.
  const isGenerating =
    latest?.status === "generating" ||
    (latest?.status === "ready" && latest.in_progress);
  const queuedNames = pendingMembers.map((m) => m.name).join("، ");

  // "Plan ready" nudge must reflect real readiness — content present and no
  // longer progressing — so it never shows over the generating loader.
  const planReady =
    latest?.status === "ready" &&
    !!latest.plan_data &&
    planHasContent(latest.plan_data) &&
    !latest.in_progress;

  // The meal-ready view renders PlanViewer, which hosts the plan-type toggle at
  // the end of its top strip's action cluster (the far/left corner in RTL).
  // Every other state renders the toggle standalone above its content, pinned
  // to the same corner.
  const mealReadyView =
    !workoutView && latest?.status === "ready" && !!latest.plan_data;
  // The workout-ready view renders WorkoutViewer, which hosts the toggle in the
  // SAME top-strip slot as PlanViewer — so it isn't rendered standalone above
  // it, and the toggle never moves when switching views.
  const workoutReadyView =
    workoutView && workout?.status === "ready" && !!workout.plan_data;

  const planTypeToggle =
    workout != null ? (
      // Segmented view switch: brand-purple active segment on a lavender track.
      // The track tint reads on BOTH surfaces the toggle appears on — the white
      // header band and, before a plan is ready, the bare page background.
      // Each Link spans the FULL 44px track height (min-h-11) for the tap
      // target; the inner span is the 36px visual thumb, vertically centered →
      // the 4px inset look. Hover lives on the Link (group) so the strips above
      // and below the thumb respond like they click.
      <div
        className="inline-flex rounded-full bg-brand-lavender/25 px-[3px]"
        role="tablist"
        aria-label="نوع الخطة"
      >
        <Link
          href="/plan"
          role="tab"
          aria-selected={!workoutView}
          className="group min-h-11 inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900"
        >
          <span
            className={`min-h-9 inline-flex items-center rounded-full px-4 py-1.5 text-sm font-bold transition-colors ${
              !workoutView
                ? "bg-brand-purple-900 text-white"
                : "text-brand-ink/70 group-hover:text-brand-ink"
            }`}
          >
            الوجبات
          </span>
        </Link>
        <Link
          href="/plan?view=workout"
          role="tab"
          aria-selected={workoutView}
          className="group min-h-11 inline-flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900"
        >
          <span
            className={`min-h-9 inline-flex items-center rounded-full px-4 py-1.5 text-sm font-bold transition-colors ${
              workoutView
                ? "bg-brand-purple-900 text-white"
                : "text-brand-ink/70 group-hover:text-brand-ink"
            }`}
          >
            التمارين
          </span>
        </Link>
      </div>
    ) : null;

  return (
    <main className="min-h-screen bg-brand-surface">
      <header className="bg-white border-b border-brand-ink/5 sticky top-0 z-10">
        <div className="container-app py-4 flex items-center justify-between">
          <a
            href="/dashboard"
            aria-label="فت لايف — الرئيسية"
            className="inline-flex items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <Logo className="h-9 w-auto" />
          </a>
          <div className="flex items-center gap-2">
            <BackToDashboard />
            <SettingsLink />
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="container-app py-8 md:py-12">
        <Suspense fallback={null}>
          <PlanOnboardingBanner planReady={planReady} ownerSex={profile?.sex} />
        </Suspense>

        {/* Keep a continuous "preparing" indicator for queued members — while the
            current plan generates AND through the hand-off window after it
            finishes (until the new member's own shell lands) — so there is no
            blank gap before the next member shows as loading. */}
        {pendingMembers.length > 0 && !pendingBlocked && (isGenerating || planReady) && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-brand-purple-900/15 bg-brand-lavender/25 px-4 py-3 mb-6 text-brand-ink text-sm font-medium leading-relaxed"
          >
            {isGenerating
              ? `أضفنا ${queuedNames} — ${
                  orderedPending.length > 1 ? "نجهّز خططهم" : "نجهّز الخطة"
                } بعد انتهاء الخطة الحالية`
              : restPendingNames
                ? `نجهّز خطة ${firstPendingName} الآن · التالي: ${restPendingNames}`
                : `نجهّز خطة ${firstPendingName} الآن`}
          </div>
        )}

        {pendingBlocked && (
          <div className="rounded-2xl border border-brand-purple-900/15 bg-brand-lavender/25 px-4 py-4 mb-6">
            {/* A paid user can land here if their activation webhook was missed.
                Reconcile directly with Lemonsqueezy once; if it activates, the
                page refreshes and the drain takes over instead of this banner. */}
            <SubscriptionSelfHeal />
            <div className="flex items-start gap-3">
              <Users
                className="size-5 flex-shrink-0 mt-0.5 text-brand-purple-900"
                aria-hidden="true"
              />
              <div className="flex-1">
                <p className="text-brand-ink text-sm font-medium leading-relaxed">
                  {blockedIsSubscriber
                    ? `جهّزنا خطتك. خطط ${queuedNames} تحتاج باقة أكبر — ${genderPick(
                        profile?.sex,
                      )(
                        "رقّي باقتك",
                        "رقّ باقتك",
                      )} ونجهّزها دفعة واحدة مع وجبات العائلة المنسقة.`
                    : `جهّزنا خطتك. خطط ${queuedNames} متاحة مع الاشتراك — ${genderPick(
                        profile?.sex,
                      )(
                        "اشتركي",
                        "اشترك",
                      )} ونجهّزها دفعة واحدة مع وجبات العائلة المنسقة.`}
                </p>
                <a
                  href={blockedHref}
                  className="mt-3 inline-flex items-center gap-2 bg-brand-ink hover:bg-brand-purple-900 text-white font-bold text-sm px-5 py-2.5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface min-h-11"
                >
                  {blockedIsSubscriber ? "ترقية الباقة" : "عرض الباقات"}
                </a>
              </div>
            </div>
          </div>
        )}

        {/* Standalone in every state except the meal-ready and workout-ready
            views, where the viewer hosts it in the top strip's action cluster.
            justify-end pins it to the same far (left in RTL) corner the ready
            views use, so the toggle never moves across states. */}
        {planTypeToggle && !mealReadyView && !workoutReadyView && (
          <div className="mb-6 flex justify-end">{planTypeToggle}</div>
        )}

        {workoutView && workout && (
          <>
            {workout.status === "generating" && (
              // Server-known initial state: a live meal run means the workout
              // worker is holding (meals-first) — open directly on the
              // "نجهّز وجباتك أولاً" card, no generic flash. `status ===
              // "generating"` covers the first seconds before the meal shell's
              // first emit; `in_progress` covers the rest of the run.
              <WorkoutGeneratingState
                initialWaitingForMeals={
                  !!latest && (latest.status === "generating" || latest.in_progress)
                }
                ownerSex={profile?.sex}
              />
            )}
            {workout.status === "failed" && (
              <div
                role="alert"
                className="rounded-2xl border border-red-200 bg-red-50 px-4 py-4"
              >
                {/* Never surface the raw engine error (English/zod internals);
                    it stays on the DB row for debugging. */}
                <p className="text-sm text-red-700 leading-relaxed">
                  تعذّر إنشاء برنامج التمارين.{" "}
                  {genderPick(profile?.sex)(
                    "أعيدي المحاولة، أو عدّلي إجاباتك من الملف الشخصي.",
                    "أعِد المحاولة، أو عدّل إجاباتك من الملف الشخصي.",
                  )}
                </p>
                <RetryWorkoutButton ownerSex={profile?.sex} />
              </div>
            )}
            {workout.status === "ready" && workout.plan_data && (
              <WorkoutViewer
                plan={applyMemberDisplayNames(workout.plan_data, nameRoster)}
                planId={workout.id}
                checkins={workoutCheckins}
                ownerSex={profile?.sex}
                planTypeToggle={planTypeToggle}
                journeyMembers={journeyMembers}
                roster={workoutRoster}
                addTraineeHref={addTraineeHref}
              />
            )}
          </>
        )}

        {!workoutView && !latest && (
          <EmptyState
            isOnboarded={isOnboarded}
            ownerSex={profile?.sex}
            needsDoctorSignOff={needsDoctorSignOff}
          />
        )}

        {!workoutView && latest?.status === "generating" && (
          <PlanGeneratingState
            planId={latest.id}
            name={generatingFor}
            ownerSex={profile?.sex}
          />
        )}

        {!workoutView && latest?.status === "failed" && (
          <PlanFailedState
            planId={latest.id}
            reason={latest.error_message}
            ownerSex={profile?.sex}
          />
        )}

        {!workoutView && latest?.status === "ready" && latest.plan_data && (
          <>
            {shouldDrain && <DeferredMemberDrain generating={latest.in_progress} />}
            {latest.masked_failure && (
              // The plan below is the PREVIOUS week: the newest run failed with
              // nothing to show. The fallback is deliberate (a stale week beats
              // an error screen) — silence about it was not.
              <div
                role="status"
                className="rounded-2xl border border-brand-purple-900/15 bg-brand-lavender/25 px-4 py-3 mb-6 text-brand-ink text-sm leading-relaxed"
              >
                آخر محاولة لإنشاء خطة جديدة لم تكتمل، وهذه خطتك السابقة كما هي. يمكن
                المحاولة مرة أخرى بعد قليل.
                {latest.masked_failure.error_message && (
                  <details className="mt-2 text-xs text-brand-ink-muted">
                    <summary className="cursor-pointer">تفاصيل تقنية</summary>
                    <p dir="ltr" className="mt-1 break-words text-start">
                      {latest.masked_failure.error_message}
                    </p>
                  </details>
                )}
              </div>
            )}
            <PlanViewer
              plan={applyMemberDisplayNames(
                profile
                  ? applyChildDisplayTargets(
                      dropRemovedMembers(latest.plan_data, liveMemberIds),
                      {
                        mom: {
                          member_type: profile.member_type,
                          birth_year: profile.birth_year,
                        },
                        members: familyMembers,
                      },
                    )
                  : dropRemovedMembers(latest.plan_data, liveMemberIds),
                nameRoster,
              )}
              planId={latest.id}
              generating={latest.in_progress}
              updatedAt={latest.updated_at}
              preselectedMember={member}
              housekeeperLocale={housekeeperLocale}
              showWorkoutOptIn={workout === null}
              checkins={checkins}
              verdicts={verdicts}
              absences={absences}
              journeyMembers={journeyMembers}
              planTypeToggle={planTypeToggle}
              ownerSex={profile?.sex}
              partialWeek={hasIncompleteMember}
            />
          </>
        )}
      </div>
    </main>
  );
}
