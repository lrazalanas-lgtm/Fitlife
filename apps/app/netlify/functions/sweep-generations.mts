// Netlify SCHEDULED function: the 5-minute sweeper (Stage 4 of the delivery
// plan). Does for every account exactly what a page visit's
// DeferredMemberDrain would have done — so a week finishes itself overnight
// with nobody watching, and a hard-killed run's wreckage is reclassified
// without waiting for the next dispatch attempt.
//
// The DECISION lives in apps/app/src/lib/plans/sweep.ts (pure, unit-tested);
// this file is I/O: read state, apply `decideSweep`, dispatch like the chain
// does (mint rows, POST the worker with the in-process secret, require exactly
// 202, roll back on anything else). The 00014 per-kind lock arbitrates every
// race: a 23505 on the child insert means a drain, a chain hop, or the user
// beat us — archive the placeholder and stand down, the createPlanRows
// protocol.
//
// Guard rails, because a cron that dispatches PAID model runs must be unable
// to loop: per-account daily generation budget (SWEEP_DAILY_GEN_CAP, counting
// the account's own activity too), a per-sweep dispatch ceiling, wide refills
// only (absent members keep the drain's routing), meal kind only.
//
// Like generate-plan-background.mts, this bundles the engine by relative
// import and talks PostgREST over plain fetch (no SDK — see that file's
// bundle-safety note).

import {
  planModelLabel,
  MEMBER_GEN_MAX_ATTEMPTS,
} from "../../../../packages/plan-engine/src/constants";
import { MealPlanSchema } from "../../../../packages/plan-engine/src/schema";
import type { MealPlan } from "../../../../packages/plan-engine/src/schema";
import {
  decideSweep,
  decideSweepCheap,
  SWEEP_PLAN_WINDOW,
} from "../../src/lib/plans/sweep";
import { STALE_GENERATION_MIN } from "../../src/lib/plans/generationTiming";

export const config = { schedule: "*/5 * * * *" };

// ONE dispatch per firing. This is a SYNCHRONOUS scheduled function (seconds
// of runtime, not minutes): the cron fires again in 5 minutes, and a single
// bounded dispatch keeps the whole pass safely inside the platform limit —
// three serial 8s enqueue timeouts would not (08/31 code-review finding).
const MAX_DISPATCHES_PER_SWEEP = 1;
// How many users a single firing examines (newest activity first)…
const MAX_CANDIDATES_PER_SWEEP = 20;
// …and how many of those may pay the plan_data jsonb fetch. Cheap gates run
// first; this bounds the expensive tail so the pass cannot crawl.
const MAX_PLAN_FETCHES_PER_SWEEP = 6;
// Reclassification margin ABOVE the 15-minute staleness bound. A healthy run
// legitimately lands terminal writes at ~15.5 min (budget + finalize reserve +
// dispatch latency), and a cron that fires every 5 minutes WILL hit the exact
// boundary a dispatch-time sweep only hits by coincidence — reclassifying a
// still-live run releases its lock and buys a concurrent duplicate run
// (08/31 code-review finding). Liveness is judged on the PLAN row's
// updated_at, which a live run bumps on every emit.
const SWEEP_STALE_MARGIN_MS = 3 * 60_000;

const sbHeaders = (serviceKey: string) => ({
  apikey: serviceKey,
  authorization: `Bearer ${serviceKey}`,
  "content-type": "application/json",
});

async function sbSelect(
  base: string,
  serviceKey: string,
  table: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
    headers: sbHeaders(serviceKey),
  });
  if (!res.ok) throw new Error(`select ${table} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>[];
}

async function sbPatch(
  base: string,
  serviceKey: string,
  table: string,
  filter: string,
  patch: Record<string, unknown>,
): Promise<number> {
  const res = await fetch(`${base}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { ...sbHeaders(serviceKey), prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`patch ${table} → ${res.status}`);
  const rows = (await res.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) ? rows.length : 0;
}

/** Insert; carries PostgREST's error code so 23505 (lock lost) is detectable. */
async function sbInsert(
  base: string,
  serviceKey: string,
  table: string,
  row: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; code?: string; detail: string }> {
  const res = await fetch(`${base}/rest/v1/${table}`, {
    method: "POST",
    headers: sbHeaders(serviceKey),
    body: JSON.stringify(row),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { code?: string }).code;
  } catch {
    /* non-JSON body */
  }
  return { ok: false, code, detail: `${res.status} ${text.slice(0, 200)}` };
}

const handler = async (req: Request): Promise<Response> => {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.INTERNAL_FUNCTION_SECRET?.trim() || serviceKey;
  if (!serviceKey || !supabaseUrl || !secret) {
    console.error("[sweep] missing env", {
      hasServiceKey: !!serviceKey,
      hasUrl: !!supabaseUrl,
    });
    return new Response("misconfigured", { status: 500 });
  }
  // The worker lives beside this function on the same site — req.url is
  // correct by construction, never an env-derived URL (the documented
  // Functions-runtime env-scope hazard).
  const workerUrl = new URL(req.url);
  workerUrl.pathname = "/.netlify/functions/generate-plan-background";

  const summary = {
    staleGenRows: 0,
    stalePlans: 0,
    examined: 0,
    dispatched: 0,
    skipped: [] as string[],
  };

  try {
    // ── 1. Reclassify wreckage the dispatch-time sweeps never saw ──
    // Until now the reclassify only ran when somebody DISPATCHED — one stale
    // row sat 94 hours in the history. Liveness is judged on the PLAN row's
    // updated_at (bumped on every emit), never on created_at/started_at alone:
    // a healthy run's timestamps are its dispatch time, and a cron firing
    // every 5 minutes is guaranteed to catch the boundary minute a live run is
    // still finishing in.
    const staleBoundIso = new Date(
      Date.now() - STALE_GENERATION_MIN * 60_000 - SWEEP_STALE_MARGIN_MS,
    ).toISOString();
    summary.stalePlans = await sbPatch(
      supabaseUrl,
      serviceKey,
      "meal_plans",
      `status=eq.generating&updated_at=lt.${staleBoundIso}`,
      {
        status: "failed",
        error_message: "worker never finished (sweeper reclassify)",
      },
    );
    // Gen rows: candidates by started_at, VERDICT by their plan's updated_at —
    // a stuck lock row whose plan went quiet is swept; a lock row whose plan
    // is still being written is live, whatever the clock says.
    const staleGenCandidates = (await sbSelect(
      supabaseUrl,
      serviceKey,
      "plan_generations",
      `select=id,meal_plan_id&status=eq.started&plan_kind=eq.meal&started_at=lt.${staleBoundIso}&limit=25`,
    )) as Array<{ id: string; meal_plan_id: string | null }>;
    if (staleGenCandidates.length > 0) {
      const planIds = staleGenCandidates
        .map((g) => g.meal_plan_id)
        .filter((id): id is string => id != null);
      const freshPlans =
        planIds.length > 0
          ? await sbSelect(
              supabaseUrl,
              serviceKey,
              "meal_plans",
              `select=id&id=in.(${planIds.join(",")})&updated_at=gte.${staleBoundIso}`,
            )
          : [];
      const fresh = new Set(freshPlans.map((p) => p.id as string));
      const dead = staleGenCandidates.filter(
        (g) => g.meal_plan_id == null || !fresh.has(g.meal_plan_id),
      );
      if (dead.length > 0) {
        summary.staleGenRows = await sbPatch(
          supabaseUrl,
          serviceKey,
          "plan_generations",
          `id=in.(${dead.map((g) => g.id).join(",")})&status=eq.started`,
          {
            status: "failed",
            error_message: "stale generation reclassified (sweeper)",
            completed_at: new Date().toISOString(),
          },
        );
      }
    }

    // ── 2. Candidates: users with recent meal-plan activity ──
    const recentPlans = (await sbSelect(
      supabaseUrl,
      serviceKey,
      "meal_plans",
      "select=id,user_id,status,created_at&order=created_at.desc&limit=100",
    )) as Array<{ id: string; user_id: string; status: string }>;
    const byUser = new Map<string, Array<{ id: string; status: string }>>();
    for (const p of recentPlans) {
      const w = byUser.get(p.user_id) ?? [];
      if (w.length < SWEEP_PLAN_WINDOW) w.push({ id: p.id, status: p.status });
      byUser.set(p.user_id, w);
    }
    const userIds = [...byUser.keys()].slice(0, MAX_CANDIDATES_PER_SWEEP);
    if (userIds.length === 0)
      return Response.json({ ok: true, ...summary });

    const inList = `in.(${userIds.join(",")})`;
    const dayAgoIso = new Date(Date.now() - 24 * 3600_000).toISOString();
    const [profiles, members, recentGens] = await Promise.all([
      sbSelect(
        supabaseUrl,
        serviceKey,
        "profiles",
        `select=id,onboarding_completed_at&id=${inList}`,
      ),
      sbSelect(
        supabaseUrl,
        serviceKey,
        "family_members",
        `select=id,user_id,role&user_id=${inList}`,
      ),
      sbSelect(
        supabaseUrl,
        serviceKey,
        "plan_generations",
        `select=user_id,status,plan_kind,started_at&user_id=${inList}&created_at=gt.${dayAgoIso}`,
      ),
    ]);
    const onboardingByUser = new Map(
      profiles.map((p) => [p.id as string, p.onboarding_completed_at != null]),
    );

    let planFetches = 0;
    for (const userId of userIds) {
      if (summary.dispatched >= MAX_DISPATCHES_PER_SWEEP) break;
      if (planFetches >= MAX_PLAN_FETCHES_PER_SWEEP) break;
      summary.examined++;
      const window = byUser.get(userId)!;
      // MEAL kind only, for the cap AND the lock check: a household's workout
      // runs and translation passes must neither consume the healer's budget
      // nor read as the meal lock (08/31 code-review finding).
      const mealGens = recentGens.filter(
        (g) => g.user_id === userId && (g.plan_kind ?? "meal") === "meal",
      );
      // Date.parse, never string comparison: PostgREST timestamps come back
      // "+00:00"-suffixed while ours are "Z"-suffixed, and lexicographic
      // comparison across the two formats is quietly wrong. Same margined
      // bound as the reclassify above — a run inside it is LIVE.
      const liveBound =
        Date.now() - STALE_GENERATION_MIN * 60_000 - SWEEP_STALE_MARGIN_MS;
      const hasLiveMealRun = mealGens.some(
        (g) =>
          g.status === "started" &&
          Date.parse(String(g.started_at)) >= liveBound,
      );
      // Cheap gates first — the ONE shared implementation, so the logged
      // reason and the actual skip can never drift apart.
      const cheapInputs = {
        onboardingCompleted: onboardingByUser.get(userId) ?? false,
        hasLiveMealRun,
        genRowsLast24h: mealGens.length,
      };
      const cheapVerdict = decideSweepCheap(cheapInputs);
      if (cheapVerdict) {
        summary.skipped.push(`${userId.slice(0, 8)}: ${cheapVerdict.reason}`);
        continue;
      }
      const readyRow = window.find((p) => p.status === "ready");
      if (!readyRow) {
        summary.skipped.push(`${userId.slice(0, 8)}: no ready plan in window`);
        continue;
      }
      planFetches++;
      const planRows = await sbSelect(
        supabaseUrl,
        serviceKey,
        "meal_plans",
        `select=plan_data&id=eq.${readyRow.id}`,
      );
      const parsed = MealPlanSchema.safeParse(planRows[0]?.plan_data);
      const beneficiaryIds = [
        "mom",
        ...members
          .filter((m) => m.user_id === userId && m.role !== "housekeeper")
          .map((m) => m.id as string),
      ];
      const decision = decideSweep({
        userId,
        planWindow: window,
        ...cheapInputs,
        newestReadyPlan: parsed.success ? (parsed.data as MealPlan) : null,
        beneficiaryIds,
      });
      if (decision.action === "skip") {
        summary.skipped.push(`${userId.slice(0, 8)}: ${decision.reason}`);
        continue;
      }

      // ── 3. Dispatch — the chain's hand-off protocol, verbatim ──
      // Residual, stated honestly: a platform kill between the lock claim
      // below and the rollback leaves an orphan 'started' row holding the
      // per-kind lock until the NEXT firing's stale pass sweeps it (~18 min).
      // The rollback is best-effort, not a guarantee — which is why the pass
      // is sized to finish in seconds and dispatches at most once.
      const childId = crypto.randomUUID();
      const planIns = await sbInsert(supabaseUrl, serviceKey, "meal_plans", {
        id: childId,
        user_id: userId,
        status: "generating",
        plan_data: {},
        ai_model: planModelLabel(),
      });
      if (!planIns.ok) {
        console.error("[sweep] child plan insert failed", planIns.detail);
        continue;
      }
      const genIns = await sbInsert(supabaseUrl, serviceKey, "plan_generations", {
        user_id: userId,
        meal_plan_id: childId,
        model: planModelLabel(),
        status: "started",
        started_at: new Date().toISOString(),
      });
      if (!genIns.ok) {
        // 23505 = someone else holds the per-kind lock — they are the healer.
        await sbPatch(supabaseUrl, serviceKey, "meal_plans", `id=eq.${childId}`, {
          status: "archived",
          error_message:
            genIns.code === "23505"
              ? "superseded: another generation was already in flight"
              : "sweeper: audit row insert failed",
        }).catch(() => {});
        if (genIns.code !== "23505")
          console.error("[sweep] gen row insert failed", genIns.detail);
        continue;
      }
      let enqueued = false;
      try {
        const res = await fetch(workerUrl.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-secret": secret,
          },
          body: JSON.stringify({ userId, mealPlanId: childId, carryOver: true }),
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        enqueued = res.status === 202;
        if (!enqueued) console.error("[sweep] enqueue got", res.status);
      } catch (err) {
        console.error("[sweep] enqueue failed", err);
      }
      if (!enqueued) {
        // Roll back — safe even if the POST landed: the late child no-ops at
        // its idempotency probe against the archived/failed rows.
        await sbPatch(supabaseUrl, serviceKey, "meal_plans", `id=eq.${childId}`, {
          status: "archived",
          error_message: "sweeper enqueue failed",
        }).catch(() => {});
        await sbPatch(
          supabaseUrl,
          serviceKey,
          "plan_generations",
          `meal_plan_id=eq.${childId}`,
          {
            status: "failed",
            error_message: "sweeper enqueue failed",
            completed_at: new Date().toISOString(),
          },
        ).catch(() => {});
        continue;
      }
      summary.dispatched++;
      console.log("[sweep] dispatched refill", {
        userId,
        childId,
        reason: decision.reason,
        attemptsCap: MEMBER_GEN_MAX_ATTEMPTS,
      });
    }
  } catch (err) {
    // A sweeper must never crash-loop loudly — log and let the next firing try.
    console.error("[sweep] pass failed", err);
    return Response.json({ ok: false, ...summary }, { status: 200 });
  }

  if (summary.dispatched > 0 || summary.staleGenRows > 0 || summary.stalePlans > 0)
    console.log("[sweep] summary", summary);
  return Response.json({ ok: true, ...summary });
};

export default handler;
