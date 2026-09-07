import { Suspense } from "react";
import Link from "next/link";
import { Sparkles, Users, AlertTriangle, MailOpen } from "lucide-react";
import { AddFamilyBanner } from "./AddFamilyBanner";
import { DeepDiveBanner } from "./DeepDiveBanner";
import { PlanCTA, type PlanCTAState } from "./PlanCTA";
import { WorkoutOptInBanner } from "./WorkoutOptInBanner";
import { WorkoutPlanCard } from "./WorkoutPlanCard";
import { staleMemberIds } from "@/lib/plans/memberEdit";
import { DeferredMemberDrain } from "../plan/DeferredMemberDrain";
import { FamilySeasonCard } from "../plan/FamilySeasonCard";
import {
  getCurrentUserProfile,
  getCurrentUserFamilyMembers,
  getCurrentUserLatestPlan,
} from "@/lib/supabase/queries";
import { getLatestWorkoutPlan } from "@/lib/plans/getLatestWorkoutPlan";
import { planHasContent } from "@fitlife/plan-engine";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import {
  getCurrentSubscription,
  hasLiveLemonsqueezySubscription,
} from "@/lib/subscription/state";
import { canGenerateForFamilyChange } from "@/lib/subscription/access";
import { TrialBanner } from "@/components/subscription/TrialBanner";
import { RenewalRecapCard } from "./RenewalRecapCard";
import {
  isWithinRenewalWindow,
  loadFamilyLedger,
} from "@/lib/engagement/ledger";
import { getFamilySeasonProps } from "@/lib/engagement/seasonProps";
import { Logo } from "@/components/Logo";
import { SettingsLink } from "@/components/SettingsLink";
import { LogoutButton } from "./LogoutButton";
import { CheckoutSuccessHandler } from "./CheckoutSuccessHandler";
import { RefreshOnFocus } from "./RefreshOnFocus";
import { BillingPortalButton } from "./BillingPortalButton";
import { genderPick } from "@/lib/copy/gender";

export const metadata = {
  title: "لوحة التحكم",
};

/** «١٧ يوليو — ٢٣ يوليو» for the greeting sub-line (null on a bad date). */
function formatWeekRange(weekStart: string): string | null {
  try {
    const start = new Date(`${weekStart}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    const fmt = new Intl.DateTimeFormat("ar-SA", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
    return `${fmt.format(start)} — ${fmt.format(end)}`;
  } catch {
    return null;
  }
}

export default async function DashboardPage() {
  // Everything in this batch is independent — one parallel round-trip instead
  // of a sequential waterfall (the auth lookup inside each helper is deduped
  // per-request via React.cache).
  const [profile, familyMembers, latestPlan, user, supabase] = await Promise.all([
    getCurrentUserProfile(),
    getCurrentUserFamilyMembers(),
    getCurrentUserLatestPlan(),
    getAuthUser(),
    createClient(),
  ]);

  // A 'ready' plan with empty day shells isn't usable yet — treat it as still
  // generating so downstream gates don't fire early.
  const planHasMeals = latestPlan?.plan_data
    ? planHasContent(latestPlan.plan_data)
    : false;
  const planIsReady = latestPlan?.status === "ready" && planHasMeals;

  const [subscription, workoutPlan] = user
    ? await Promise.all([
        getCurrentSubscription(user.id),
        getLatestWorkoutPlan(user.id),
      ])
    : [null, null];

  if (!profile) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-brand-surface px-4">
        <div className="text-center">
          <p className="text-brand-ink-muted">يتم تحضير حسابك...</p>
        </div>
      </main>
    );
  }

  const g = genderPick(profile.sex);
  const onboardingDone = profile.onboarding_completed_at !== null;
  const beneficiaryCount = familyMembers.filter(
    (m) => m.role !== "housekeeper",
  ).length;
  // Plan doorway state — a 'ready' shell with no meals yet counts as generating.
  const planCtaState: PlanCTAState = !latestPlan
    ? "none"
    : latestPlan.status === "failed"
      ? "failed"
      : planIsReady
        ? "ready"
        : "generating";
  // Mom's plan exists but no other family members yet → nudge to add family.
  const showAddFamily =
    profile.mom_profile_completed_at !== null &&
    planIsReady &&
    !latestPlan?.in_progress &&
    beneficiaryCount === 0;

  // Meals-only user with a ready plan → nudge the workout opt-in. One banner at
  // a time: family > workout > deep-dive.
  const showWorkoutOptIn =
    !showAddFamily &&
    planIsReady &&
    !latestPlan?.in_progress &&
    profile.workout_profile === null &&
    workoutPlan === null;

  // First plan ready + the optional deep-dive questionnaire not done → nudge.
  const showDeepDive =
    !showAddFamily &&
    !showWorkoutOptIn &&
    planIsReady &&
    !latestPlan?.in_progress &&
    profile.deep_dive_completed_at === null;

  // Members who exist but aren't in the current plan yet → auto-generate.
  const planMemberIds = latestPlan?.member_ids ?? [];
  const pendingMembers = familyMembers.filter(
    (m) => m.role !== "housekeeper" && !planMemberIds.includes(m.id),
  );
  const needsFamilyPlan = planIsReady && pendingMembers.length > 0;
  const pendingNames = pendingMembers.map((m) => m.name);
  const pendingNamesText = pendingNames.join("، ");
  // The drain also owns two states that are NOT "someone is missing": a member
  // removed while a run held the lock (still in the plan, gone from the
  // roster), and a member whose row was edited after the plan was built. Both
  // used to be unreachable — the drain mounted only for pending members, so a
  // lone weight edit never regenerated and a ghost tab never left.
  const liveMemberIds = new Set(familyMembers.map((m) => m.id));
  const hasGhostMember = planMemberIds.some(
    (id) => id !== "mom" && !liveMemberIds.has(id),
  );
  const hasStaleMember =
    planIsReady && staleMemberIds(familyMembers, latestPlan?.generated_at).length > 0;
  const drainForAlignment = planIsReady && (hasGhostMember || hasStaleMember);

  // Housekeeper recipe view existence — only used to add a step to the trial
  // checklist (the dashboard shortcut link itself lives on /plan now).
  const housekeeper = familyMembers.find((m) => m.role === "housekeeper");
  const showHousekeeperLink =
    latestPlan?.status === "ready" &&
    !!housekeeper &&
    housekeeper.preferred_language !== "ar";

  // Renewal-week recap — active paid subs within 7 days of period end.
  const showRenewalRecap =
    !!user &&
    subscription?.status === "active" &&
    !!subscription.lemonsqueezy_subscription_id &&
    !subscription.cancel_at_period_end &&
    !!subscription.current_period_end &&
    isWithinRenewalWindow(subscription.current_period_end);

  // The remaining reads are independent of each other — fetch them in one
  // parallel batch instead of four sequential stages.
  const [familyChangeAccess, seasonProps, renewalLedger, trialCounts] =
    await Promise.all([
      // Family-change access gate (only matters when members are pending).
      needsFamilyPlan && user ? canGenerateForFamilyChange(user.id) : null,
      // «موسم بيتنا» leaderboard — the dashboard's centerpiece (first thing to
      // see). Null for solo households or before a plan is ready.
      getFamilySeasonProps(profile, familyMembers, latestPlan, workoutPlan),
      showRenewalRecap && user ? loadFamilyLedger(supabase, user.id) : null,
      // Day-3 trial activation checklist counts — only while trialing.
      user && subscription?.status === "trialing"
        ? Promise.all([
            supabase
              .from("chat_messages")
              .select("id", { count: "exact", head: true })
              .eq("user_id", user.id)
              .limit(1),
            supabase
              .from("body_logs")
              .select("id", { count: "exact", head: true })
              .eq("user_id", user.id)
              .limit(1),
          ])
        : null,
    ]);

  const pendingBlocked = familyChangeAccess?.allowed === false;

  const renewalRecap = renewalLedger
    ? { ledger: renewalLedger, cadence: subscription?.cadence ?? null }
    : null;

  let trialChecklist;
  if (trialCounts) {
    const [chatCount, weightCount] = trialCounts;
    trialChecklist = {
      planReady: planIsReady,
      advisorTried: (chatCount.count ?? 0) > 0,
      weightLogged: !weightCount.error && (weightCount.count ?? 0) > 0,
      showHousekeeperStep: showHousekeeperLink,
    };
  }

  return (
    <main className="min-h-screen bg-brand-surface">
      <header className="bg-white border-b border-brand-ink/5 sticky top-0 z-10">
        <div className="container-app py-4 flex items-center justify-between">
          <Logo className="h-9 w-auto" />
          <div className="flex items-center gap-2">
            <SettingsLink />
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="container-app py-8 md:py-12">
        {/* Marks made on /plan (or another device) only reach an already-open
            dashboard on the next fetch — refresh when the tab wakes so the
            «موسم بيتنا» board is never a day stale. */}
        <RefreshOnFocus />
        <Suspense fallback={null}>
          <CheckoutSuccessHandler />
        </Suspense>

        {subscription?.status === "past_due" && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-start sm:items-center gap-3 rounded-2xl border-2 border-red-300 bg-red-50 px-4 py-3 mb-6"
          >
            <AlertTriangle
              className="size-5 flex-shrink-0 mt-0.5 sm:mt-0 text-red-600"
              aria-hidden="true"
            />
            <p className="flex-1 text-brand-ink text-sm font-medium leading-relaxed">
              فيه مشكلة في تجديد اشتراكك. حدّثي بياناتك الآن لتجنب توقف الخدمة
            </p>
            <div className="flex-shrink-0">
              <BillingPortalButton label="تحديث الدفع" variant="ghost" />
            </div>
          </div>
        )}

        {subscription?.status === "trialing" && (
          <TrialBanner
            subscription={subscription}
            checklist={trialChecklist}
            ownerSex={profile.sex}
          />
        )}

        {showAddFamily && <AddFamilyBanner ownerSex={profile.sex} />}

        {showWorkoutOptIn && <WorkoutOptInBanner ownerSex={profile.sex} />}

        {/* Once she has opted in, the banner is gone for good — and nothing
            else on the dashboard showed the workout plan's state, so a
            5-15 minute generation (or a failure) was invisible here. The
            card was built for exactly this and never mounted. */}
        {profile.workout_profile !== null && (
          <div className="mb-6">
            <WorkoutPlanCard
              state={workoutPlan?.status ?? "optin"}
              waitingForMeals={latestPlan?.in_progress ?? false}
              ownerSex={profile.sex}
            />
          </div>
        )}

        {showDeepDive && <DeepDiveBanner ownerSex={profile.sex} />}

        {onboardingDone && ((needsFamilyPlan && !pendingBlocked) || drainForAlignment) && (
          <DeferredMemberDrain generating={latestPlan?.in_progress ?? false} />
        )}

        {needsFamilyPlan && pendingBlocked && (
          <div className="rounded-2xl border border-brand-purple-900/15 bg-brand-lavender/25 px-4 py-4 mb-6">
            <div className="flex items-start gap-3">
              <Users
                className="size-5 flex-shrink-0 mt-0.5 text-brand-purple-900"
                aria-hidden="true"
              />
              <div className="flex-1">
                <p className="text-brand-ink text-sm font-medium leading-relaxed">
                  {/* An over-limit household already pays: /pricing 409s an
                      existing subscriber, so route them to manage the plan. */}
                  {hasLiveLemonsqueezySubscription(subscription)
                    ? `خطط باقي أفراد العائلة (${pendingNamesText}) تحتاج ترقية الباقة. ${g("رقّي باقتك", "رقِّ باقتك")} ونجهّز خططهم دفعة واحدة مع وجبات العائلة المنسقة.`
                    : `خطط باقي أفراد العائلة (${pendingNamesText}) متاحة مع الاشتراك. ${g("اشتركي", "اشترك")} ونجهّز خططهم دفعة واحدة مع وجبات العائلة المنسقة.`}
                </p>
                <Link
                  href={hasLiveLemonsqueezySubscription(subscription) ? "/subscription" : "/pricing"}
                  className="mt-3 inline-flex items-center gap-2 bg-brand-ink hover:bg-brand-purple-900 text-white font-bold text-sm px-5 py-2.5 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface min-h-11"
                >
                  {hasLiveLemonsqueezySubscription(subscription) ? "إدارة الاشتراك" : "عرض الباقات"}
                </Link>
              </div>
            </div>
          </div>
        )}

        {needsFamilyPlan && !pendingBlocked && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-brand-purple-900/15 bg-brand-lavender/25 px-4 py-3 mb-6 text-brand-ink text-sm font-medium leading-relaxed"
          >
            {latestPlan?.in_progress
              ? `تمت إضافة ${pendingNamesText} — سيُنشأ بعد اكتمال الخطة الحالية`
              : `تمت إضافة ${pendingNamesText} — ${
                  pendingNames.length > 1 ? "جارٍ إنشاء خططهم" : "جارٍ إنشاء خطته"
                } ضمن خطط العائلة المنسقة`}
          </div>
        )}

        {/* Greeting row — the page's anchor: warm opener + week range on the
            start side, the two promoted quick actions on the end side. */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
          <div>
            <h1 className="font-extrabold text-xl md:text-2xl text-brand-ink leading-tight">
              {profile.display_name
                ? `أهلاً، ${profile.display_name}`
                : g("أهلاً بكِ", "أهلاً بك")}
            </h1>
            {seasonProps?.weekStartDate && (
              <p className="text-brand-ink-muted text-xs mt-0.5 tabular-nums">
                أسبوع {formatWeekRange(seasonProps.weekStartDate)}
              </p>
            )}
          </div>
          {onboardingDone && (
            <div className="flex flex-wrap gap-2">
              {/* Outline like its sibling — the PlanCTA band below is the page's
                  single filled-purple action (one dark anchor above the fold). */}
              <Link
                href="/chat"
                className="inline-flex items-center justify-center gap-2 min-h-11 px-5 rounded-full border border-brand-purple-900/20 text-brand-purple-900 hover:bg-brand-lavender/30 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                {g("اسألي المستشارة", "اسأل المستشارة")}
              </Link>
              <Link
                href="/recap"
                className="inline-flex items-center justify-center gap-2 min-h-11 px-5 rounded-full border border-brand-purple-900/20 text-brand-purple-900 hover:bg-brand-lavender/30 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
              >
                <MailOpen className="size-4" aria-hidden="true" />
                رسالتك الأسبوعية
              </Link>
            </div>
          )}
        </div>

        {/* Doorway to /plan — the page's primary action, in every plan state.
            Pre-onboarding the «خطتك على بعد دقيقتين» block below is the CTA. */}
        {onboardingDone && (
          <div className="mb-5">
            <PlanCTA
              state={planCtaState}
              isOnboarded={onboardingDone}
              ownerSex={profile.sex}
              memberCount={beneficiaryCount + 1}
            />
          </div>
        )}

        {/* «موسم بيتنا» leaderboard — the dashboard's centerpiece. Hidden for
            solo households / before a plan is ready (seasonProps is null then). */}
        {seasonProps && <FamilySeasonCard {...seasonProps} />}

        {/* Renewal-week recap — celebratory bookkeeping, never a countdown */}
        {renewalRecap && (
          <div className="mt-6">
            <RenewalRecapCard {...renewalRecap} ownerSex={profile.sex} />
          </div>
        )}

        {!onboardingDone && (
          <div className="bg-brand-purple-900 text-white rounded-3xl p-6 md:p-8 mb-8">
            <div className="flex items-start gap-3 mb-3">
              <Sparkles className="size-6 text-brand-yellow flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-bold text-lg md:text-xl leading-tight">
                  خطتك على بعد دقيقتين
                </h3>
                <p className="text-white/80 text-sm mt-2 leading-relaxed">
                  {g(
                    "جاوبي على أسئلة سريعة عنك وعن عائلتك عشان نصمم لكِ خطة غذائية شخصية.",
                    "جاوب على أسئلة سريعة عنك وعن عائلتك عشان نصمم لك خطة غذائية شخصية.",
                  )}
                </p>
              </div>
            </div>
            <a
              href="/onboarding"
              className="inline-flex items-center gap-2 min-h-11 bg-white text-brand-purple-900 hover:bg-brand-yellow font-bold text-sm px-5 py-2.5 rounded-full mt-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-purple-900"
            >
              {g("ابدئي الآن", "ابدأ الآن")}
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
