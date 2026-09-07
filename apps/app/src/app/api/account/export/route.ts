import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { BODY_PHOTOS_BUCKET } from "@/lib/engagement/types";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// 00017 engagement tables — included in the portability export.
const ENGAGEMENT_TABLES = [
  "meal_checkins",
  "member_exceptions",
  "meal_verdicts",
  "body_logs",
] as const;

async function fetchEngagementRows(
  supabase: SupabaseClient<Database>,
  table: (typeof ENGAGEMENT_TABLES)[number],
  userId: string,
): Promise<unknown[]> {
  const client = supabase;
  const { data } = await client
    .from(table)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return data ?? [];
}

// Internal billing identifiers — not the user's own data, so they're stripped
// from the subscription before it goes into the portability export.
const INTERNAL_SUB_FIELDS = [
  "lemonsqueezy_subscription_id",
  "lemonsqueezy_customer_id",
  "lemonsqueezy_variant_id",
  "ls_subscription_id",
  "ls_customer_id",
  "ls_variant_id",
  "ls_order_id",
] as const;

function stripInternal(
  sub: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!sub) return null;
  const clone = { ...sub };
  for (const f of INTERNAL_SUB_FIELDS) delete clone[f];
  return clone;
}

/**
 * Data export (PDPL right to portability). Returns everything the user owns as
 * a downloadable JSON file. Auth-gated; reads run through the user's own
 * (RLS-scoped) client so a request can only ever export its own rows.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // Every table read keys only on user.id — one parallel batch instead of
  // three sequential await-groups. workout_checkins (00020) is not yet in the
  // generated Database types, so it's read through an untyped cast;
  // best-effort so a pre-apply prod exports [] rather than failing the export.
  const [
    profile,
    family,
    plans,
    workoutPlans,
    subscription,
    generations,
    engagementRows,
    workoutCheckins,
    mealAbsences,
    chatMessages,
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    supabase
      .from("family_members")
      .select("*")
      .eq("user_id", user.id)
      .order("display_order", { ascending: true }),
    supabase
      .from("meal_plans")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("workout_plans")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("plan_generations")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    Promise.all(
      ENGAGEMENT_TABLES.map((table) =>
        fetchEngagementRows(supabase, table, user.id),
      ),
    ),
    (async (): Promise<unknown[]> => {
      try {
        const { data } = await (supabase as unknown as SupabaseClient)
          .from("workout_checkins")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });
        return data ?? [];
      } catch {
        return [];
      }
    })(),
    // meal_absences (00021) — same pre-apply tolerance as workout_checkins.
    (async (): Promise<unknown[]> => {
      try {
        const { data } = await (supabase as unknown as SupabaseClient)
          .from("meal_absences")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });
        return data ?? [];
      } catch {
        return [];
      }
    })(),
    // chat_messages holds usage metadata only (model, tokens, cost, time —
    // never the text), but it IS the customer's data and the policy promises
    // a complete copy. Same tolerance as the rows above.
    (async (): Promise<unknown[]> => {
      try {
        const { data } = await (supabase as unknown as SupabaseClient)
          .from("chat_messages")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false });
        return data ?? [];
      } catch {
        return [];
      }
    })(),
  ]);

  const [mealCheckins, memberExceptions, mealVerdicts] = engagementRows;
  let bodyLogs = engagementRows[3] ?? [];

  // Portability covers the photos too: each body log with a photo_path gets a
  // 24-hour signed URL (the bucket is private — a bare path downloads nothing).
  // Best-effort and tolerant of pre-00018 prod (no column / no bucket).
  try {
    const logRows = (bodyLogs ?? []) as Array<Record<string, unknown>>;
    const photoPaths = logRows
      .map((r) => r.photo_path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (photoPaths.length > 0) {
      const { data: signed } = await supabase.storage
        .from(BODY_PHOTOS_BUCKET)
        .createSignedUrls(photoPaths, 60 * 60 * 24);
      const urlByPath = new Map(
        (signed ?? [])
          .filter((s) => s.signedUrl)
          .map((s) => [s.path, s.signedUrl] as const),
      );
      bodyLogs = logRows.map((r) =>
        typeof r.photo_path === "string" && urlByPath.has(r.photo_path)
          ? { ...r, photo_url: urlByPath.get(r.photo_path) }
          : r,
      );
    }
  } catch {
    // Signing is an enrichment — the rows themselves already exported.
  }

  const data = {
    exported_at: new Date().toISOString(),
    user: {
      email: user.email ?? null,
      signup_date: user.created_at,
    },
    profile: profile.data ?? null,
    family_members: family.data ?? [],
    meal_plans: plans.data ?? [],
    workout_plans: workoutPlans.data ?? [],
    subscription: stripInternal(
      subscription.data as Record<string, unknown> | null,
    ),
    generation_history: generations.data ?? [],
    meal_checkins: mealCheckins,
    member_exceptions: memberExceptions,
    meal_verdicts: mealVerdicts,
    meal_absences: mealAbsences,
    body_logs: bodyLogs,
    workout_checkins: workoutCheckins,
    chat_messages: chatMessages,
  };

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="fitlife-export-${user.id}-${date}.json"`,
    },
  });
}
