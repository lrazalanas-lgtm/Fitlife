import "server-only";

import { createClient } from "@/lib/supabase/server";
import { MealPlanSchema, planHasContent, type MealPlan } from "@fitlife/plan-engine";

import { resolveStaleness, STALE_GENERATION_MIN } from "./staleness";
import { workerAckedFromPlanData } from "./generationTiming";

export { STALE_GENERATION_MIN };

export interface LatestPlanSummary {
  id: string;
  status: "generating" | "ready" | "failed";
  plan_data: MealPlan | null;
  week_start_date: string | null;
  member_count: number;
  member_ids: string[];
  in_progress: boolean; // still generating later days (progressive rendering)
  /**
   * Whether the background worker ever acknowledged the invocation for this row.
   * False on a 'generating' row means we have no evidence the worker ran at all
   * — the state a rejected shared secret or a missing key produces, which the
   * dispatcher cannot see because Netlify answers a background function with 202
   * before the handler runs.
   */
  worker_acked: boolean;
  error_message: string | null;
  updated_at: string;
  /** When the run that built this plan FINISHED. Null while it never has. */
  generated_at: string | null;
  /**
   * Set when this summary is the PREVIOUS plan served in place of a newer run
   * that failed with nothing to show. The fallback is deliberate (a stale week
   * beats an error screen), but it used to be invisible: a customer's own
   * «إنشاء خطة جديدة» could fail and the old plan simply reappeared with no
   * word said anywhere — and the generating screen, seeing a different id from
   * the one it was watching, silently reloaded. Surfaces read this to say so.
   */
  masked_failure?: { id: string; error_message: string | null } | null;
}

/**
 * Get the user's most recent plan (any status). Returns null if none exists.
 *
 * If status is 'ready' but `plan_data` fails Zod validation (e.g. the AI returned
 * a shape that's slightly off), we surface it as 'failed' with `plan_data: null`
 * — the UI's failed branch will let the user retry rather than rendering broken
 * content.
 */
type MealPlanRow = {
  id: string;
  status: string;
  plan_data: unknown;
  generated_at: string | null;
  error_message: string | null;
  updated_at: string;
};

export async function getLatestPlan(userId: string): Promise<LatestPlanSummary | null> {
  const supabase = await createClient();

  // More than one row: a regeneration that produces NOTHING must not be allowed
  // to hide the week the household already has. Adding a third member triggers a
  // full shared-group rebuild, and when that run came back empty (see the
  // skeleton budget clamp in plan-engine/generate.ts) the failed row — being
  // newest — replaced a complete 7/7 plan with an error screen on every surface.
  // The good plan was never deleted, only shadowed.
  //
  // The window is 5, not 2, because failures STACK: the account this was found
  // on had two consecutive empty runs (the original and the user's retry), which
  // put the last good week third. Reading only one row back would have found
  // another failure and given up. Falling back costs nothing when the newest row
  // is healthy, because then the rest are never examined.
  const { data, error } = await supabase
    .from("meal_plans")
    .select("id, status, plan_data, generated_at, error_message, updated_at")
    .eq("user_id", userId)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(5)
    .returns<MealPlanRow[]>();

  if (error || !data || data.length === 0) return null;

  const row = data[0];
  if (!row) return null;

  const rawStatus = row.status as "generating" | "ready" | "failed" | "archived";
  if (rawStatus === "archived") return null;

  let validatedPlanData: MealPlan | null = null;
  let finalStatus: "generating" | "ready" | "failed" = rawStatus;

  if (rawStatus === "ready") {
    const result = MealPlanSchema.safeParse(row.plan_data);
    if (result.success) {
      validatedPlanData = result.data;
      finalStatus = "ready";
    } else {
      console.warn("[getLatestPlan] plan_data failed Zod validation; surfacing as failed", {
        planId: row.id,
        issues: result.error.issues.slice(0, 5),
      });
      finalStatus = "failed";
    }
  }

  // Dead-man's switch: if the background function was hard-killed at its 15-min
  // budget, its catch never ran, so the row sits in 'generating' (or in a
  // 'ready' shell still flagged generating, or a 'ready' shell with no meals at
  // all) forever and the viewer shows a perpetual loader. (Read-time only — the
  // DB row is left as-is.) Staleness is measured off updated_at: an actively-
  // progressing shell rewrites plan_data every day, so it stays fresh; only a
  // dead one goes stale. The rule — and, crucially, that a partial week is KEPT
  // rather than discarded — lives in resolveStaleness so it can be tested.
  //
  // Second, sharper question: did the worker ever acknowledge the invocation at
  // all? It stamps `worker_ack_at` into plan_data before any model call, so on a
  // 'generating' row the ABSENCE of any write means the run never started — the
  // state a rejected shared secret or a missing key produces, and one the
  // dispatcher cannot see because Netlify answers a background function with 202
  // before the handler runs. "Nothing ever wrote" is exactly "plan_data is still
  // the empty object createPlanRows inserted"; any key at all — the ACK, or a
  // real snapshot — means the worker reached the DB. Anything unreadable counts
  // as ACKed, so a degraded read can only ever be too patient, never falsely
  // fail a live run.
  const workerAcked = workerAckedFromPlanData(row.plan_data);

  const resolved = resolveStaleness({
    status: finalStatus,
    planData: validatedPlanData,
    updatedAt: row.updated_at,
    errorMessage: row.error_message ?? null,
    workerAcked,
  });

  // The newest run died with nothing to show. If the previous plan is still
  // usable, serve THAT — a stale week beats an error screen, and it keeps the
  // drain's `status === "ready"` precondition satisfiable so the household can
  // recover without the customer doing anything.
  if (resolved.status === "failed" && !resolved.planData && data.length > 1) {
    // Skip over any further failed/empty rows to the most recent week that
    // actually has meals in it.
    for (const prev of data.slice(1)) {
      if (!prev || prev.status !== "ready") continue;
      const prevParsed = MealPlanSchema.safeParse(prev.plan_data);
      if (prevParsed.success && planHasContent(prevParsed.data)) {
        const prevResolved = resolveStaleness({
          status: "ready",
          planData: prevParsed.data,
          updatedAt: prev.updated_at,
          errorMessage: null,
          workerAcked: workerAckedFromPlanData(prev.plan_data),
        });
        if (prevResolved.planData) {
          console.warn(
            "[getLatestPlan] newest plan failed with no content; serving the last ready plan",
            { failedId: row.id, servingId: prev.id },
          );
          return {
            id: prev.id,
            status: prevResolved.status,
            plan_data: prevResolved.planData,
            week_start_date: prevResolved.planData.week_start_date ?? null,
            member_count: prevResolved.planData.members.length,
            member_ids: prevResolved.planData.members.map((m) => m.member_id),
            in_progress: prevResolved.inProgress,
            error_message: prevResolved.errorMessage,
            updated_at: prev.updated_at,
            generated_at: prev.generated_at,
            // The ACK belongs to the row being served, not the failed one.
            worker_acked: workerAckedFromPlanData(prev.plan_data),
            masked_failure: {
              id: row.id,
              error_message: resolved.errorMessage ?? row.error_message ?? null,
            },
          };
        }
      }
    }
  }

  return {
    id: row.id,
    status: resolved.status,
    plan_data: resolved.planData,
    week_start_date: resolved.planData?.week_start_date ?? null,
    member_count: resolved.planData?.members.length ?? 0,
    member_ids: resolved.planData?.members.map((m) => m.member_id) ?? [],
    in_progress: resolved.inProgress,
    worker_acked: workerAcked,
    error_message: resolved.errorMessage,
    updated_at: row.updated_at,
    generated_at: row.generated_at,
    masked_failure: null,
  };
}

/**
 * The most recent plan the household can actually COOK FROM — the newest one if
 * it has meals in it, otherwise the last week that did.
 *
 * For the account owner, a plan being regenerated is worth showing as a
 * generating screen: she asked for it and the progress is the answer. For the
 * HOUSEKEEPER it is not. A regeneration inserts an empty `meal_plans` row that
 * immediately supersedes the translated week, so from the moment anyone taps
 * «إنشاء خطة جديدة» she loses the plan entirely — for the eight to fifteen
 * minutes the run takes — while a complete, translated, perfectly cookable week
 * sits in the previous row. She has no Arabic view to fall back to and no
 * history page she can read, so the fallback IS her only path to tonight's
 * dinner.
 *
 * `superseded` says which case it is, so her page can tell her a new week is on
 * the way instead of silently serving an older one.
 */
export async function getCookablePlan(
  userId: string,
): Promise<{ plan: LatestPlanSummary; superseded: boolean } | null> {
  const latest = await getLatestPlan(userId);
  if (!latest) return null;
  if (latest.plan_data && planHasContent(latest.plan_data)) {
    return { plan: latest, superseded: false };
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("meal_plans")
    .select("id, status, plan_data, generated_at, error_message, updated_at")
    .eq("user_id", userId)
    .eq("status", "ready")
    .neq("id", latest.id)
    .order("created_at", { ascending: false })
    .limit(5)
    .returns<MealPlanRow[]>();

  for (const prev of data ?? []) {
    const parsed = MealPlanSchema.safeParse(prev.plan_data);
    if (!parsed.success || !planHasContent(parsed.data)) continue;
    return {
      superseded: true,
      plan: {
        id: prev.id,
        status: "ready",
        plan_data: parsed.data,
        week_start_date: parsed.data.week_start_date ?? null,
        member_count: parsed.data.members.length,
        member_ids: parsed.data.members.map((m) => m.member_id),
        // The older week is finished by definition; the run in flight belongs to
        // the newer row, which this deliberately is not.
        in_progress: false,
        worker_acked: workerAckedFromPlanData(prev.plan_data),
        error_message: null,
        updated_at: prev.updated_at,
        generated_at: prev.generated_at,
      },
    };
  }
  return { plan: latest, superseded: false };
}
