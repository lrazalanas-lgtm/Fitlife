import "server-only";

import { adminDb } from "@/lib/admin/db";
import { chatDailyCap } from "@/lib/chat/dailyCap";
import {
  memberRequiresDoctorSignOff,
  ownerRequiresDoctorSignOff,
} from "@fitlife/plan-engine";
import { paginate } from "@/lib/admin/queries";
import {
  getPeriodPair,
  inRange,
  lastMonths,
  monthKey,
  type MonthPoint,
  type Trend,
} from "@/lib/admin/period";
import { computeMrr, type MrrBreakdown } from "@/lib/admin/revenue";
import {
  computeActivation,
  computeArpu,
  computeEngagement,
  computeLocaleMix,
  computeNrr,
  computePlanFreshness,
  computeQuietPayingWatchlist,
  computeRevenueAtRisk,
  computeRevenueByTier,
  computeTrialWatchlist,
  lastActivityByUser,
  latestSubByUser,
  type LocaleCount,
  type QuietPayingRow,
  type TierRevenue,
  type TrialWatchRow,
} from "@/lib/admin/metrics";
import {
  computeChurnSeries,
  computeCohortMatrix,
  computeMrrMovement,
  type ChurnPoint,
  type CohortRow,
  type MrrMovementPoint,
} from "@/lib/admin/cohorts";
import { computeGrossMargin, type GrossMargin } from "@/lib/admin/margin";
import { computeFailureBuckets, type FailureBucket } from "@/lib/admin/failures";

/**
 * Trends + operational-health data. Loaded separately from the overview dataset
 * so each page fetches only what it shows. Includes a few extra fields the
 * overview deliberately omits (generation error/ids for the failure queue;
 * medical-gate booleans for the support signal — booleans only, never the
 * underlying condition lists).
 */

// The consumer chat route's per-household daily cap — ONE definition, read
// here rather than re-typed (this used to say 30 after the route moved to 100).
const CHAT_DAILY_CAP = chatDailyCap();
const DAY_MS = 86_400_000;
const FAILURE_LIST_LIMIT = 50;

interface InsProfile {
  id: string;
  display_name: string | null;
  preferred_language: string;
  created_at: string;
  onboarding_completed_at: string | null;
  has_medical_conditions: boolean;
  is_pregnant: boolean;
  high_risk_pregnancy: boolean | null;
  consulted_doctor: boolean;
}
interface InsSub {
  user_id: string;
  status: string | null;
  tier: string | null;
  cadence: string | null;
  created_at: string;
  updated_at: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  ends_at: string | null;
  cancel_at_period_end: boolean;
}
interface InsMember {
  user_id: string;
  role: string;
  member_type: string;
  preferred_language: string;
  high_risk_pregnancy: boolean | null;
  consulted_doctor: boolean | null;
  medical_conditions: string[] | null;
}
interface InsPlan {
  user_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}
interface InsGen {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  cost_usd: number | null;
  error_message: string | null;
  failure_reason: string | null;
  meal_plan_id: string | null;
}
interface InsChat {
  user_id: string;
  created_at: string;
  cost_usd: number | null;
}

export interface InsightsDataset {
  profiles: InsProfile[];
  subscriptions: InsSub[];
  members: InsMember[];
  plans: InsPlan[];
  generations: InsGen[];
  chats: InsChat[];
  truncated: string[];
}

export async function loadInsightsDataset(): Promise<InsightsDataset> {
  const db = adminDb();
  const truncated: string[] = [];
  const onTruncate = (l: string) => {
    if (!truncated.includes(l)) truncated.push(l);
  };

  const [profiles, subscriptions, members, plans, generations, chats] =
    await Promise.all([
      paginate<InsProfile>(
        (f, t) =>
          db
            .from("profiles")
            .select(
              "id, display_name, preferred_language, created_at, onboarding_completed_at, has_medical_conditions, is_pregnant, high_risk_pregnancy, consulted_doctor",
            )
            .range(f, t),
        "profiles",
        onTruncate,
      ),
      paginate<InsSub>(
        (f, t) =>
          db
            .from("subscriptions")
            .select(
              "user_id, status, tier, cadence, created_at, updated_at, trial_ends_at, current_period_end, cancelled_at, ends_at, cancel_at_period_end",
            )
            .order("created_at", { ascending: false })
            .range(f, t),
        "subscriptions",
        onTruncate,
      ),
      paginate<InsMember>(
        (f, t) =>
          db
            .from("family_members")
            .select(
              "user_id, role, member_type, preferred_language, high_risk_pregnancy, consulted_doctor, medical_conditions",
            )
            .range(f, t),
        "family_members",
        onTruncate,
      ),
      paginate<InsPlan>(
        (f, t) =>
          db
            .from("meal_plans")
            .select("user_id, status, created_at, updated_at")
            .range(f, t),
        "meal_plans",
        onTruncate,
      ),
      paginate<InsGen>(
        (f, t) =>
          db
            .from("plan_generations")
            .select(
              "id, user_id, status, created_at, cost_usd, error_message, failure_reason, meal_plan_id",
            )
            .order("created_at", { ascending: false })
            .range(f, t),
        "plan_generations",
        onTruncate,
      ),
      paginate<InsChat>(
        (f, t) =>
          db.from("chat_messages").select("user_id, created_at, cost_usd").range(f, t),
        "chat_messages",
        onTruncate,
      ),
    ]);

  return { profiles, subscriptions, members, plans, generations, chats, truncated };
}

// ── Trends ───────────────────────────────────────────────────────────────────

export type { MonthPoint };
export interface MonthSplit {
  monthStart: string;
  completed: number;
  failed: number;
}
export interface FunnelData {
  signups: number;
  onboarded: number;
  firstPlan: number;
  trialing: number;
  active: number;
}
export interface InsightsTrends {
  newSignups: MonthPoint[];
  cumulativeSubscribers: MonthPoint[];
  aiCost: MonthPoint[];
  generations: MonthSplit[];
  funnel: FunnelData;
  costPerPlanUsd: number | null;
  costPerActiveUserUsd: number | null;
  totalAiCostUsd: number;
}

function mostRecentSubByUser(ds: InsightsDataset): Map<string, InsSub> {
  const map = new Map<string, InsSub>();
  for (const s of ds.subscriptions) if (!map.has(s.user_id)) map.set(s.user_id, s);
  return map;
}

export function computeTrends(
  ds: InsightsDataset,
  months = 6,
  now: Date = new Date(),
): InsightsTrends {
  const monthsN = Math.max(1, months);
  const buckets = lastMonths(monthsN, now);
  // Oldest bucket's first day — derived directly so we don't index buckets[0].
  const windowStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() - (monthsN - 1),
    1,
  );

  const countByMonth = (items: Array<{ created_at: string }>) => {
    const m = new Map<string, number>();
    for (const it of items) {
      const k = monthKey(new Date(it.created_at));
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };

  const signupMap = countByMonth(ds.profiles);
  const newSignups: MonthPoint[] = buckets.map((b) => ({
    monthStart: b.monthStart,
    value: signupMap.get(b.key) ?? 0,
  }));

  // Cumulative = profiles created before the window + running sum within it.
  const baseline = ds.profiles.filter(
    (p) => new Date(p.created_at).getTime() < windowStart,
  ).length;
  let running = baseline;
  const cumulativeSubscribers: MonthPoint[] = newSignups.map((pt) => {
    running += pt.value;
    return { monthStart: pt.monthStart, value: running };
  });

  // AI cost per month = generations + chat.
  const costMap = new Map<string, number>();
  for (const g of ds.generations) {
    const k = monthKey(new Date(g.created_at));
    costMap.set(k, (costMap.get(k) ?? 0) + (g.cost_usd ?? 0));
  }
  for (const c of ds.chats) {
    const k = monthKey(new Date(c.created_at));
    costMap.set(k, (costMap.get(k) ?? 0) + (c.cost_usd ?? 0));
  }
  const aiCost: MonthPoint[] = buckets.map((b) => ({
    monthStart: b.monthStart,
    value: Math.round((costMap.get(b.key) ?? 0) * 100) / 100,
  }));

  // Generations completed/failed per month.
  const genMap = new Map<string, { completed: number; failed: number }>();
  for (const g of ds.generations) {
    const k = monthKey(new Date(g.created_at));
    const cur = genMap.get(k) ?? { completed: 0, failed: 0 };
    if (g.status === "completed") cur.completed += 1;
    else if (g.status === "failed") cur.failed += 1;
    genMap.set(k, cur);
  }
  const generations: MonthSplit[] = buckets.map((b) => ({
    monthStart: b.monthStart,
    completed: genMap.get(b.key)?.completed ?? 0,
    failed: genMap.get(b.key)?.failed ?? 0,
  }));

  // Funnel.
  const subByUser = mostRecentSubByUser(ds);
  const subs = [...subByUser.values()];
  const usersWithPlan = new Set(ds.plans.map((p) => p.user_id));
  const funnel: FunnelData = {
    signups: ds.profiles.length,
    onboarded: ds.profiles.filter((p) => p.onboarding_completed_at != null).length,
    firstPlan: usersWithPlan.size,
    trialing: subs.filter((s) => s.status === "trialing").length,
    active: subs.filter((s) => s.status === "active").length,
  };

  // Scalars.
  const totalAiCostUsd =
    Math.round(
      (ds.generations.reduce((s, g) => s + (g.cost_usd ?? 0), 0) +
        ds.chats.reduce((s, c) => s + (c.cost_usd ?? 0), 0)) *
        100,
    ) / 100;
  // Cost PER PLAN is generation-only — the chat assistant (chats) is a separate
  // feature, not part of producing a plan. (totalAiCostUsd above still includes
  // chats for the overall AI-spend figures.)
  const generationCostUsd =
    Math.round(ds.generations.reduce((s, g) => s + (g.cost_usd ?? 0), 0) * 100) / 100;
  const planCount = ds.plans.length;
  const costPerPlanUsd =
    planCount > 0 ? Math.round((generationCostUsd / planCount) * 10000) / 10000 : null;
  const costPerActiveUserUsd =
    funnel.active > 0
      ? Math.round((totalAiCostUsd / funnel.active) * 10000) / 10000
      : null;

  return {
    newSignups,
    cumulativeSubscribers,
    aiCost,
    generations,
    funnel,
    costPerPlanUsd,
    costPerActiveUserUsd,
    totalAiCostUsd,
  };
}

// ── Generation success rate + failure causes ─────────────────────────────────

export interface SuccessRatePoint {
  monthStart: string;
  total: number;
  /** completed ÷ (completed + failed) as a percent; null when no attempts. */
  successPct: number | null;
}

/** Reframe the completed/failed monthly split as a success-RATE line. */
export function computeSuccessRate(
  ds: InsightsDataset,
  months = 6,
  now: Date = new Date(),
): SuccessRatePoint[] {
  const buckets = lastMonths(Math.max(1, months), now);
  const genMap = new Map<string, { completed: number; failed: number }>();
  for (const g of ds.generations) {
    const k = monthKey(new Date(g.created_at));
    const cur = genMap.get(k) ?? { completed: 0, failed: 0 };
    if (g.status === "completed") cur.completed += 1;
    else if (g.status === "failed") cur.failed += 1;
    genMap.set(k, cur);
  }
  return buckets.map((b) => {
    const cur = genMap.get(b.key) ?? { completed: 0, failed: 0 };
    const total = cur.completed + cur.failed;
    return {
      monthStart: b.monthStart,
      total,
      successPct: total > 0 ? Math.round((cur.completed / total) * 1000) / 10 : null,
    };
  });
}

// classifyFailure / computeFailureBuckets live in the pure ./failures module so
// the overview (action queue) can reuse them without importing this loader.
export {
  classifyFailure,
  computeFailureBuckets,
  type FailureCause,
  type FailureBucket,
} from "@/lib/admin/failures";

// ── Operational health ───────────────────────────────────────────────────────

export interface OpsFailure {
  userId: string;
  name: string;
  createdAt: string;
  error: string | null;
  mealPlanId: string | null;
}
export interface OpsUser {
  userId: string;
  name: string;
}
export interface OpsBilling {
  userId: string;
  name: string;
  status: string;
}
export interface InsightsOps {
  failures: OpsFailure[];
  failureTotal: number;
  medicalGate: OpsUser[];
  chatCapToday: number;
  billing: OpsBilling[];
}

export function computeOps(
  ds: InsightsDataset,
  now: Date = new Date(),
): InsightsOps {
  const nameByUser = new Map<string, string>();
  for (const p of ds.profiles) nameByUser.set(p.id, p.display_name ?? "—");
  const nameOf = (id: string) => nameByUser.get(id) ?? "—";

  // Failed generations queue.
  const failed = ds.generations.filter((g) => g.status === "failed");
  const failures: OpsFailure[] = failed.slice(0, FAILURE_LIST_LIMIT).map((g) => ({
    userId: g.user_id,
    name: nameOf(g.user_id),
    createdAt: g.created_at,
    error: g.error_message,
    mealPlanId: g.meal_plan_id,
  }));

  // Medical-gate blocks (booleans only — support signal, not health detail).
  const membersByUser = new Map<string, InsMember[]>();
  for (const m of ds.members) {
    const arr = membersByUser.get(m.user_id);
    if (arr) arr.push(m);
    else membersByUser.set(m.user_id, [m]);
  }
  // The ONE doctor-gate rule (medicalGate.ts) — this used to re-derive it by
  // hand, and the two copies disagreed in opposite directions with detail.ts.
  const medicalGate: OpsUser[] = [];
  for (const p of ds.profiles) {
    const momGate =
      ownerRequiresDoctorSignOff({
        has_medical_conditions: p.has_medical_conditions,
        is_pregnant: p.is_pregnant,
      }) && p.consulted_doctor !== true;
    const memberGate = (membersByUser.get(p.id) ?? []).some(
      (m) =>
        memberRequiresDoctorSignOff({
          medical_conditions: m.medical_conditions,
          high_risk_pregnancy: m.high_risk_pregnancy,
        }) && m.consulted_doctor !== true,
    );
    if (momGate || memberGate) medicalGate.push({ userId: p.id, name: nameOf(p.id) });
  }

  // Chat-cap pressure today (proxy for rate-limit hits).
  const since = now.getTime() - DAY_MS;
  const chatToday = new Map<string, number>();
  for (const c of ds.chats) {
    if (new Date(c.created_at).getTime() >= since) {
      chatToday.set(c.user_id, (chatToday.get(c.user_id) ?? 0) + 1);
    }
  }
  let chatCapToday = 0;
  for (const count of chatToday.values()) if (count >= CHAT_DAILY_CAP) chatCapToday += 1;

  // Billing anomalies.
  const subByUser = mostRecentSubByUser(ds);
  const billing: OpsBilling[] = [];
  for (const s of subByUser.values()) {
    if (s.status === "past_due" || s.status === "expired") {
      billing.push({ userId: s.user_id, name: nameOf(s.user_id), status: s.status });
    }
  }

  return {
    failures,
    failureTotal: failed.length,
    medicalGate,
    chatCapToday,
    billing,
  };
}

// ── Composed view (all five founder sections) ────────────────────────────────

const INSIGHTS_MONTHS = 6;

export interface InsightsView {
  // 1. Growing
  newSignups: MonthPoint[];
  cumulativeSubscribers: MonthPoint[];
  mrrMovement: MrrMovementPoint[];
  // 2. Keeping
  cohort: CohortRow[];
  churn: ChurnPoint[];
  nrr: { value: number | null; trend: Trend };
  quietPaying: QuietPayingRow[];
  // 3. Converting
  funnel: FunnelData;
  activation: { rate: number | null; activated: number; total: number };
  trials: TrialWatchRow[]; // ≤14 days; the page slices ≤7
  // 4. Earning
  mrr: MrrBreakdown;
  arpuSar: number | null;
  grossMargin: GrossMargin;
  revenueByTier: TierRevenue[];
  revenueAtRisk: ReturnType<typeof computeRevenueAtRisk>;
  aiCost: MonthPoint[];
  costPerPlanUsd: number | null;
  costPerActiveUserUsd: number | null;
  totalAiCostUsd: number;
  // 5. Delivering
  successRate: SuccessRatePoint[];
  failureBuckets: FailureBucket[];
  planFreshness: ReturnType<typeof computePlanFreshness>;
  engagement: ReturnType<typeof computeEngagement>;
  localeMix: { users: LocaleCount[]; cooks: LocaleCount[] };
  ops: InsightsOps;
  // meta
  periodDays: number;
  months: number;
}

/**
 * Compute every founder-section metric from one dataset load. KPI deltas
 * (NRR, margin window) use the 30/90 period; trend charts stay monthly.
 * Insights watchlists show name + tier + dates (emails aren't loaded here — the
 * subscriber detail page carries those, one extra-click away).
 */
export function buildInsightsView(
  ds: InsightsDataset,
  periodDays = 30,
  now: Date = new Date(),
): InsightsView {
  const period = getPeriodPair(periodDays, now);
  const subByUser = latestSubByUser(ds.subscriptions);
  const currentSubs = [...subByUser.values()];
  const activeSubs = currentSubs.filter((s) => s.status === "active");
  const mrr = computeMrr(activeSubs.map((s) => ({ tier: s.tier, cadence: s.cadence })));

  const usersWithPlan = new Set(ds.plans.map((p) => p.user_id));
  const nameByUser = new Map<string, string | null>(
    ds.profiles.map((p) => [p.id, p.display_name]),
  );
  const noEmail = new Map<string, string | null>();
  const lastActivity = lastActivityByUser(ds.chats, ds.plans);

  const trends = computeTrends(ds, INSIGHTS_MONTHS, now);

  // Period-window AI cost for the (monthly) gross-margin estimate.
  const aiCostWindow =
    ds.generations
      .filter((g) => inRange(g.created_at, period.current))
      .reduce((s, g) => s + (g.cost_usd ?? 0), 0) +
    ds.chats
      .filter((c) => inRange(c.created_at, period.current))
      .reduce((s, c) => s + (c.cost_usd ?? 0), 0);
  const activeMonthlyCount = activeSubs.filter((s) => s.cadence !== "annual").length;
  const grossMargin = computeGrossMargin({
    mrrUsd: mrr.mrrUsd,
    activeCount: activeSubs.length,
    activeMonthlyCount,
    aiCostUsd: Math.round(aiCostWindow * 100) / 100,
  });

  const baseUsers = new Set(
    currentSubs
      .filter((s) => s.status === "active" || s.status === "trialing")
      .map((s) => s.user_id),
  );
  const cookMembers = ds.members.filter(
    (m) => m.member_type === "housekeeper" || m.role === "housekeeper",
  );

  return {
    newSignups: trends.newSignups,
    cumulativeSubscribers: trends.cumulativeSubscribers,
    mrrMovement: computeMrrMovement(currentSubs, INSIGHTS_MONTHS, now),
    cohort: computeCohortMatrix(ds.profiles, currentSubs, INSIGHTS_MONTHS, now),
    churn: computeChurnSeries(
      currentSubs,
      { activeCount: activeSubs.length, activeMrrSar: mrr.mrrSar },
      INSIGHTS_MONTHS,
      now,
    ),
    nrr: computeNrr(currentSubs, period),
    quietPaying: computeQuietPayingWatchlist({
      currentSubs,
      nameByUser,
      emailByUser: noEmail,
      lastActivity,
      now,
    }),
    funnel: trends.funnel,
    activation: computeActivation(ds.profiles, usersWithPlan),
    trials: computeTrialWatchlist({
      currentSubs,
      nameByUser,
      emailByUser: noEmail,
      usersWithPlan,
      now,
      horizonDays: 14,
    }),
    mrr,
    arpuSar: computeArpu(mrr, activeSubs.length).arpuSar,
    grossMargin,
    revenueByTier: computeRevenueByTier(
      activeSubs.map((s) => ({ tier: s.tier, cadence: s.cadence })),
    ),
    revenueAtRisk: computeRevenueAtRisk(currentSubs, now),
    aiCost: trends.aiCost,
    costPerPlanUsd: trends.costPerPlanUsd,
    costPerActiveUserUsd: trends.costPerActiveUserUsd,
    totalAiCostUsd: trends.totalAiCostUsd,
    successRate: computeSuccessRate(ds, INSIGHTS_MONTHS, now),
    failureBuckets: computeFailureBuckets(ds.generations),
    planFreshness: computePlanFreshness(currentSubs, ds.plans, now),
    engagement: computeEngagement({ baseUsers, lastActivity, now }),
    localeMix: computeLocaleMix(ds.profiles, cookMembers),
    ops: computeOps(ds, now),
    periodDays,
    months: INSIGHTS_MONTHS,
  };
}
