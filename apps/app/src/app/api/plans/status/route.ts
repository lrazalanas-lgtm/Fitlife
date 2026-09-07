import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getLatestPlan } from "@/lib/plans/getLatestPlan";
import { ageMsFrom } from "@/lib/plans/generationTiming";

export const runtime = "nodejs";

/**
 * GET /api/plans/status
 *
 * Lightweight polling endpoint. Returns the user's most recent plan's id, status,
 * and updated_at. Used by PlanGeneratingState to detect when generation completes.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const latest = await getLatestPlan(user.id);
  if (!latest) {
    return NextResponse.json({ error: "No plan found" }, { status: 404 });
  }

  return NextResponse.json({
    id: latest.id,
    status: latest.status,
    updated_at: latest.updated_at,
    // How long the row has gone unwritten, measured entirely server-side so the
    // generating screen never has to compare a Postgres timestamp against a
    // device clock. This is the signal it uses to tell "still working" from
    // "stuck" — see lib/plans/generationTiming.ts.
    age_ms: ageMsFrom(latest.updated_at, Date.now()),
    // False on a 'generating' row means the worker never acknowledged the
    // invocation — "never started", not "slow". The server already converts a
    // sustained absence into a real failure; this lets the client word its own
    // fallback honestly too.
    acked: latest.worker_acked,
    in_progress: latest.in_progress,
    error_message: latest.status === "failed" ? latest.error_message : null,
    // The id here is the PREVIOUS plan when the newest run failed empty; this
    // names that failed run so a tab watching it can say so instead of
    // treating the id mismatch as "a newer plan superseded mine" and reloading.
    masked_failure: latest.masked_failure ?? null,
  });
}
