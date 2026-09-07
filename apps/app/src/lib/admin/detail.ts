import "server-only";

import { PRICING_TIERS, type Tier } from "@fitlife/config";
import {
  memberRequiresDoctorSignOff,
  ownerRequiresDoctorSignOff,
} from "@fitlife/plan-engine";
import { adminDb } from "@/lib/admin/db";

/**
 * Single-subscriber drill-down loaders (service-role, server-only).
 *
 * The main detail loader (`loadSubscriberDetail`) deliberately OMITS sensitive
 * health values (allergies, dislikes, medical conditions, pregnancy/lactation).
 * Those load only through `loadSubscriberHealth`, which the gated, audit-logged
 * /health sub-route calls — data minimization per the spec. The main page shows
 * a derived medical-gate BOOLEAN (an ops flag), never the underlying conditions.
 */

// ── Shapes ─────────────────────────────────────────────────────────────────

export interface SubscriptionRow {
  tier: string | null;
  status: string | null;
  cadence: string | null;
  createdAt: string;
  updatedAt: string;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  lemonsqueezySubscriptionId: string | null;
  lemonsqueezyCustomerId: string | null;
  lemonsqueezyVariantId: string | null;
}

export interface MemberSummary {
  /** "mom" (owner) or family_members.id. */
  id: string;
  name: string;
  role: string;
  memberType: string;
  isHousekeeper: boolean;
  pickyEater: boolean | null;
  /** Goal from the latest plan if present, else the stored profile/member goal. */
  primaryGoal: string | null;
  caloriesTarget: number | null;
  macros: { protein_g: number; carbs_g: number; fat_g: number } | null;
  /** Derived ops flag — this member trips the medical gate (no detail shown). */
  medicalGate: boolean;
  consultedDoctor: boolean | null;
}

export interface PlanSummary {
  id: string;
  status: string;
  createdAt: string;
  generatedAt: string | null;
  daysCovered: number;
  memberCount: number;
  aiInputTokens: number | null;
  aiOutputTokens: number | null;
  aiModel: string | null;
  costUsd: number | null;
}

export interface GenerationSummary {
  id: string;
  status: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  mealPlanId: string | null;
}

export interface SubscriberDetail {
  userId: string;
  email: string | null;
  /** GoTrue ban active (banned_until in the future) → blocked from logging in. */
  deactivated: boolean;
  account: {
    displayName: string | null;
    preferredLanguage: string;
    signupAt: string;
    onboardingCompletedAt: string | null;
    familyWideCompletedAt: string | null;
    momProfileCompletedAt: string | null;
  };
  subscription: SubscriptionRow | null;
  subscriptionHistory: SubscriptionRow[];
  members: MemberSummary[];
  plans: PlanSummary[];
  generations: GenerationSummary[];
  engagement: { chatCount: number; lastChatAt: string | null; chatCostUsd: number };
  flags: {
    medicalGateBlocked: boolean;
    overLimit: boolean;
    failedGenerations: number;
    beneficiaries: number;
  };
}

// ── plan_data (minimal, defensive) ──────────────────────────────────────────

interface PlanMemberMin {
  member_id?: string;
  primary_goal?: string;
  daily_calories_target?: number;
  macros_target?: { protein_g: number; carbs_g: number; fat_g: number };
  days?: unknown[];
}
interface PlanDataMin {
  members?: PlanMemberMin[];
  days_total?: number;
}

function asPlanData(v: unknown): PlanDataMin {
  return v && typeof v === "object" ? (v as PlanDataMin) : {};
}

function daysCovered(pd: PlanDataMin): number {
  if (typeof pd.days_total === "number") return pd.days_total;
  let max = 0;
  for (const m of pd.members ?? []) {
    const n = Array.isArray(m.days) ? m.days.length : 0;
    if (n > max) max = n;
  }
  return max;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

function mapSubscription(s: {
  tier: string | null;
  status: string | null;
  cadence: string | null;
  created_at: string;
  updated_at: string;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  cancelled_at: string | null;
  lemonsqueezy_subscription_id: string | null;
  lemonsqueezy_customer_id: string | null;
  lemonsqueezy_variant_id: string | null;
}): SubscriptionRow {
  return {
    tier: s.tier,
    status: s.status,
    cadence: s.cadence,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    trialStartedAt: s.trial_started_at,
    trialEndsAt: s.trial_ends_at,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    cancelledAt: s.cancelled_at,
    lemonsqueezySubscriptionId: s.lemonsqueezy_subscription_id,
    lemonsqueezyCustomerId: s.lemonsqueezy_customer_id,
    lemonsqueezyVariantId: s.lemonsqueezy_variant_id,
  };
}

export async function loadSubscriberDetail(
  userId: string,
): Promise<SubscriberDetail | null> {
  const db = adminDb();

  const { data: profile } = await db
    .from("profiles")
    .select(
      "id, display_name, preferred_language, created_at, onboarding_completed_at, family_wide_completed_at, mom_profile_completed_at, primary_goal, has_medical_conditions, is_pregnant, high_risk_pregnancy, consulted_doctor, medical_conditions",
    )
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return null;

  const [
    userRes,
    subsRes,
    membersRes,
    plansRes,
    gensRes,
    chatsRes,
  ] = await Promise.all([
    db.auth.admin.getUserById(userId),
    db
      .from("subscriptions")
      .select(
        "tier, status, cadence, created_at, updated_at, trial_started_at, trial_ends_at, current_period_end, cancel_at_period_end, cancelled_at, lemonsqueezy_subscription_id, lemonsqueezy_customer_id, lemonsqueezy_variant_id",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    db
      .from("family_members")
      .select(
        "id, name, role, member_type, primary_goal, picky_eater, high_risk_pregnancy, consulted_doctor, medical_conditions",
      )
      .eq("user_id", userId)
      .order("display_order", { ascending: true }),
    db
      .from("meal_plans")
      .select(
        "id, status, created_at, generated_at, plan_data, ai_input_tokens, ai_output_tokens, ai_model",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    db
      .from("plan_generations")
      .select(
        "id, status, model, tokens_in, tokens_out, cost_usd, duration_ms, created_at, completed_at, error_message, meal_plan_id",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    db.from("chat_messages").select("cost_usd, created_at").eq("user_id", userId),
  ]);

  const subscriptionHistory = (subsRes.data ?? []).map(mapSubscription);
  const subscription = subscriptionHistory[0] ?? null;

  // Per-member goals from the most recent plan that actually has members.
  const latestPlanWithMembers = (plansRes.data ?? []).find(
    (p) => asPlanData(p.plan_data).members?.length,
  );
  const goalByMember = new Map<string, PlanMemberMin>();
  for (const m of asPlanData(latestPlanWithMembers?.plan_data).members ?? []) {
    if (m.member_id) goalByMember.set(m.member_id, m);
  }

  // Cost per meal_plan = sum of its generations' cost_usd.
  const costByPlan = new Map<string, number>();
  for (const g of gensRes.data ?? []) {
    if (g.meal_plan_id && g.cost_usd != null) {
      costByPlan.set(
        g.meal_plan_id,
        (costByPlan.get(g.meal_plan_id) ?? 0) + g.cost_usd,
      );
    }
  }

  // Members: owner ("mom") first, then family members.
  // The ONE doctor-gate rule (medicalGate.ts), not a hand-rolled copy.
  const momGate =
    ownerRequiresDoctorSignOff({
      has_medical_conditions: profile.has_medical_conditions,
      medical_conditions: profile.medical_conditions,
      is_pregnant: profile.is_pregnant,
    }) && profile.consulted_doctor !== true;

  const momGoal = goalByMember.get("mom");
  const momMember: MemberSummary = {
    id: "mom",
    name: profile.display_name ?? "—",
    role: "mom",
    memberType: "adult",
    isHousekeeper: false,
    pickyEater: null,
    primaryGoal: momGoal?.primary_goal ?? profile.primary_goal ?? null,
    caloriesTarget: momGoal?.daily_calories_target ?? null,
    macros: momGoal?.macros_target ?? null,
    medicalGate: momGate,
    consultedDoctor: profile.consulted_doctor ?? null,
  };

  const familyMembers: MemberSummary[] = (membersRes.data ?? []).map((m) => {
    const g = goalByMember.get(m.id);
    const memberGate =
      memberRequiresDoctorSignOff({
        medical_conditions: m.medical_conditions,
        high_risk_pregnancy: m.high_risk_pregnancy,
      }) && m.consulted_doctor !== true;
    return {
      id: m.id,
      name: m.name,
      role: m.role,
      memberType: m.member_type,
      isHousekeeper: m.role === "housekeeper",
      pickyEater: m.picky_eater ?? null,
      primaryGoal: g?.primary_goal ?? m.primary_goal ?? null,
      caloriesTarget: g?.daily_calories_target ?? null,
      macros: g?.macros_target ?? null,
      medicalGate: memberGate,
      consultedDoctor: m.consulted_doctor ?? null,
    };
  });

  const members = [momMember, ...familyMembers];

  const plans: PlanSummary[] = (plansRes.data ?? []).map((p) => {
    const pd = asPlanData(p.plan_data);
    return {
      id: p.id,
      status: p.status,
      createdAt: p.created_at,
      generatedAt: p.generated_at,
      daysCovered: daysCovered(pd),
      memberCount: pd.members?.length ?? 0,
      aiInputTokens: p.ai_input_tokens,
      aiOutputTokens: p.ai_output_tokens,
      aiModel: p.ai_model,
      costUsd: costByPlan.get(p.id) ?? null,
    };
  });

  const generations: GenerationSummary[] = (gensRes.data ?? []).map((g) => ({
    id: g.id,
    status: g.status,
    model: g.model,
    tokensIn: g.tokens_in,
    tokensOut: g.tokens_out,
    costUsd: g.cost_usd,
    durationMs: g.duration_ms,
    createdAt: g.created_at,
    completedAt: g.completed_at,
    errorMessage: g.error_message,
    mealPlanId: g.meal_plan_id,
  }));

  const chats = chatsRes.data ?? [];
  let lastChatAt: string | null = null;
  let chatCostUsd = 0;
  for (const c of chats) {
    if (!lastChatAt || new Date(c.created_at) > new Date(lastChatAt))
      lastChatAt = c.created_at;
    chatCostUsd += c.cost_usd ?? 0;
  }

  const beneficiaries =
    1 + familyMembers.filter((m) => !m.isHousekeeper).length;
  const tierDef =
    subscription?.tier && subscription.tier in PRICING_TIERS
      ? PRICING_TIERS[subscription.tier as Tier]
      : null;

  const bannedUntil =
    (userRes.data?.user as { banned_until?: string | null } | null | undefined)
      ?.banned_until ?? null;
  const deactivated =
    bannedUntil != null && new Date(bannedUntil).getTime() > Date.now();

  return {
    userId,
    email: userRes.data?.user?.email ?? null,
    deactivated,
    account: {
      displayName: profile.display_name,
      preferredLanguage: profile.preferred_language,
      signupAt: profile.created_at,
      onboardingCompletedAt: profile.onboarding_completed_at,
      familyWideCompletedAt: profile.family_wide_completed_at,
      momProfileCompletedAt: profile.mom_profile_completed_at,
    },
    subscription,
    subscriptionHistory,
    members,
    plans,
    generations,
    engagement: {
      chatCount: chats.length,
      lastChatAt,
      chatCostUsd: Math.round(chatCostUsd * 1_000_000) / 1_000_000,
    },
    flags: {
      medicalGateBlocked: members.some((m) => m.medicalGate),
      overLimit: tierDef?.max_people != null && beneficiaries > tierDef.max_people,
      failedGenerations: generations.filter((g) => g.status === "failed").length,
      beneficiaries,
    },
  };
}

// ── Sensitive health detail (gated + audit-logged caller) ────────────────────

export interface MemberHealth {
  id: string;
  name: string;
  role: string;
  isPregnant: boolean | null;
  trimester: number | null;
  monthsPostpartum: number | null;
  highRiskPregnancy: boolean | null;
  consultedDoctor: boolean | null;
  medicalConditions: string[];
  allergies: unknown;
  dislikes: unknown;
}

export interface SubscriberHealth {
  userId: string;
  displayName: string | null;
  members: MemberHealth[];
}

export async function loadSubscriberHealth(
  userId: string,
): Promise<SubscriberHealth | null> {
  const db = adminDb();

  const { data: profile } = await db
    .from("profiles")
    .select(
      "id, display_name, is_pregnant, pregnancy_trimester, months_postpartum, high_risk_pregnancy, consulted_doctor, medical_conditions, allergies, dislikes",
    )
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return null;

  const { data: members } = await db
    .from("family_members")
    .select(
      "id, name, role, trimester, months_postpartum, high_risk_pregnancy, consulted_doctor, medical_conditions, allergies, dislikes",
    )
    .eq("user_id", userId)
    .order("display_order", { ascending: true });

  const mom: MemberHealth = {
    id: "mom",
    name: profile.display_name ?? "—",
    role: "mom",
    isPregnant: profile.is_pregnant ?? null,
    trimester: profile.pregnancy_trimester ?? null,
    monthsPostpartum: profile.months_postpartum ?? null,
    highRiskPregnancy: profile.high_risk_pregnancy ?? null,
    consultedDoctor: profile.consulted_doctor ?? null,
    medicalConditions: profile.medical_conditions ?? [],
    allergies: profile.allergies ?? null,
    dislikes: profile.dislikes ?? null,
  };

  const familyHealth: MemberHealth[] = (members ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    isPregnant: null,
    trimester: m.trimester ?? null,
    monthsPostpartum: m.months_postpartum ?? null,
    highRiskPregnancy: m.high_risk_pregnancy ?? null,
    consultedDoctor: m.consulted_doctor ?? null,
    medicalConditions: m.medical_conditions ?? [],
    allergies: m.allergies ?? null,
    dislikes: m.dislikes ?? null,
  }));

  return {
    userId,
    displayName: profile.display_name,
    members: [mom, ...familyHealth],
  };
}

// ── Raw plan_data inspection (gated + audit-logged caller) ───────────────────

export interface PlanInspect {
  id: string;
  status: string;
  createdAt: string;
  generatedAt: string | null;
  planData: unknown;
}

export async function loadPlanForInspect(
  userId: string,
  planId: string,
): Promise<PlanInspect | null> {
  const db = adminDb();
  const { data } = await db
    .from("meal_plans")
    .select("id, user_id, status, created_at, generated_at, plan_data")
    .eq("id", planId)
    .maybeSingle();

  // Guard: the plan must belong to the subscriber named in the URL.
  if (!data || data.user_id !== userId) return null;

  return {
    id: data.id,
    status: data.status,
    createdAt: data.created_at,
    generatedAt: data.generated_at,
    planData: data.plan_data,
  };
}
