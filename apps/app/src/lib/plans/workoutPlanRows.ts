import {
  WorkoutPlanSchema,
  workoutPlanHasContent,
  type WorkoutPlan,
} from "@fitlife/plan-engine";

/**
 * Pure half of getLatestWorkoutPlan — which row to serve and how to read it —
 * kept out of the server-only module so the decision rule is unit-testable.
 *
 * Mirrors the meal side: Zod re-validation downgrades a broken 'ready' row to
 * failed, the read-time dead-man's switch reclassifies a stale in-flight row,
 * and a newest run that FAILED WITH NOTHING TO SHOW does not hide the plan the
 * household already has. That last rule was built for meals in August and not
 * for workouts: a re-run from /onboarding/workout («تعديلها يعيد إنشاء
 * البرنامج») that came back empty replaced the whole household's working
 * program with a bare retry card, since workout_plans is one row per household.
 */
export interface WorkoutPlanRow {
  id: string;
  status: string;
  plan_data: unknown;
  error_message: string | null;
  updated_at: string;
}

export interface ResolvedWorkoutRow {
  id: string;
  status: "generating" | "ready" | "failed";
  plan_data: WorkoutPlan | null;
  error_message: string | null;
  updated_at: string;
}

export function resolveWorkoutRow(
  row: WorkoutPlanRow,
  nowMs: number,
  staleMinutes: number,
): ResolvedWorkoutRow | null {
  const rawStatus = row.status as "generating" | "ready" | "failed" | "archived";
  if (rawStatus === "archived") return null;

  let validated: WorkoutPlan | null = null;
  let finalStatus: "generating" | "ready" | "failed" = rawStatus;

  if (rawStatus === "ready") {
    const result = WorkoutPlanSchema.safeParse(row.plan_data);
    if (result.success) {
      validated = result.data;
    } else {
      console.warn(
        "[getLatestWorkoutPlan] plan_data failed Zod validation; surfacing as failed",
        { planId: row.id, issues: result.error.issues.slice(0, 5) },
      );
      finalStatus = "failed";
    }
  }

  const updatedMs = Date.parse(row.updated_at);
  const ageMin = Number.isNaN(updatedMs) ? Infinity : (nowMs - updatedMs) / 60_000;
  const planEmpty =
    finalStatus === "ready" && (!validated || !workoutPlanHasContent(validated));
  const stillInFlight =
    finalStatus === "generating" ||
    (finalStatus === "ready" && validated?.generating === true) ||
    planEmpty;
  let errorMessage = row.error_message ?? null;
  if (stillInFlight && ageMin >= staleMinutes) {
    console.warn("[getLatestWorkoutPlan] stale in-flight plan; surfacing as failed", {
      planId: row.id,
      ageMin: Math.round(ageMin),
    });
    finalStatus = "failed";
    validated = null;
    errorMessage = errorMessage ?? "تعذّر إكمال إنشاء خطة التمارين. يرجى المحاولة مرة أخرى.";
  }

  return {
    id: row.id,
    status: finalStatus,
    plan_data: validated,
    error_message: errorMessage,
    updated_at: row.updated_at,
  };
}

/**
 * Serve the newest row — unless it resolved to failed-with-no-content and an
 * older READY row in the window still holds a real program, in which case
 * serve that (the meal side's previousPlanFallback rule).
 */
export function pickServedWorkoutRow(
  rows: readonly WorkoutPlanRow[],
  nowMs: number,
  staleMinutes: number,
): ResolvedWorkoutRow | null {
  const newest = rows[0];
  if (!newest) return null;
  const resolved = resolveWorkoutRow(newest, nowMs, staleMinutes);
  if (!resolved) return null;
  if (resolved.status === "failed" && !resolved.plan_data) {
    for (const prev of rows.slice(1)) {
      if (prev.status !== "ready") continue;
      const prevResolved = resolveWorkoutRow(prev, nowMs, staleMinutes);
      if (
        prevResolved?.status === "ready" &&
        prevResolved.plan_data &&
        workoutPlanHasContent(prevResolved.plan_data)
      ) {
        console.warn(
          "[getLatestWorkoutPlan] newest plan failed with no content; serving the last ready plan",
          { failedId: newest.id, servingId: prev.id },
        );
        return prevResolved;
      }
    }
  }
  return resolved;
}
