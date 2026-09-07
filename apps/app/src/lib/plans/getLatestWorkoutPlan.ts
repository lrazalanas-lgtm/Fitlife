import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { WorkoutPlan } from "@fitlife/plan-engine";
import { STALE_GENERATION_MIN } from "@/lib/plans/getLatestPlan";
import { pickServedWorkoutRow, type WorkoutPlanRow } from "@/lib/plans/workoutPlanRows";

export interface LatestWorkoutPlanSummary {
  id: string;
  status: "generating" | "ready" | "failed";
  plan_data: WorkoutPlan | null;
  member_ids: string[];
  in_progress: boolean;
  error_message: string | null;
  updated_at: string;
}

// Enough rows to reach past a failed regeneration (and a retry of it) to the
// last program that actually has sessions — same window as the meal side.
const WINDOW = 5;

/**
 * The user's most recent workout plan (any status; archived excluded).
 * Mirrors getLatestPlan's discipline, including the previous-plan fallback:
 * see workoutPlanRows.ts for the rules, which are pure and unit-tested.
 */
export async function getLatestWorkoutPlan(
  userId: string,
): Promise<LatestWorkoutPlanSummary | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("workout_plans")
    .select("id, status, plan_data, error_message, updated_at")
    .eq("user_id", userId)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(WINDOW)
    .returns<WorkoutPlanRow[]>();

  if (error || !data || data.length === 0) return null;

  const served = pickServedWorkoutRow(data, Date.now(), STALE_GENERATION_MIN);
  if (!served) return null;

  return {
    id: served.id,
    status: served.status,
    plan_data: served.plan_data,
    member_ids: served.plan_data?.members.map((m) => m.member_id) ?? [],
    in_progress: served.plan_data?.generating === true,
    error_message: served.error_message,
    updated_at: served.updated_at,
  };
}
