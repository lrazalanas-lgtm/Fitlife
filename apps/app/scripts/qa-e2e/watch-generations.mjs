// Usage: WATCH_SINCE=2026-08-31T00:00:00Z node watch-generations.mjs [email]
//
// Follows every generation opened since WATCH_SINCE — chained hops and sweeper
// dispatches included — until all are terminal; prints one status block per
// poll (45s cadence, 45-minute failsafe). Companion to dispatch-household.mjs;
// credentials come from creds.mjs like every other diagnostic here.
import { createClient } from "@supabase/supabase-js";
import { discoverSupabaseCreds, PASSWORD } from "./creds.mjs";

const EMAIL = process.argv[2] ?? process.env.QA_EMAIL ?? "fitlife.qa+brief-tkkuc@gmail.com";
const SINCE = process.env.WATCH_SINCE;
if (!SINCE) throw new Error("WATCH_SINCE required (RFC3339 UTC)");
const DEADLINE = Date.now() + 45 * 60_000;

const { url, anon } = await discoverSupabaseCreds();
const sb = createClient(url, anon);
const { data: auth, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (error) throw new Error(`sign-in failed: ${error.message}`);
const uid = auth.user.id;

for (;;) {
  const { data: gens } = await sb
    .from("plan_generations")
    .select("meal_plan_id,status,tokens_in,tokens_out,cost_usd,duration_ms,error_message")
    .eq("user_id", uid)
    .gte("started_at", SINCE)
    .order("started_at");
  const { data: plans } = await sb
    .from("meal_plans")
    .select("id,status,plan_data")
    .eq("user_id", uid)
    .gte("created_at", SINCE)
    .order("created_at");
  const now = new Date().toISOString().slice(11, 19);
  for (const g of gens ?? [])
    console.log(
      `${now} gen ${String(g.meal_plan_id).slice(0, 8)} ${g.status} in=${g.tokens_in ?? "-"} out=${g.tokens_out ?? "-"} $${g.cost_usd ?? "-"} ${g.duration_ms ?? "-"}ms ${g.error_message ?? ""}`.trim(),
    );
  for (const p of plans ?? []) {
    const fill = (p.plan_data?.members ?? [])
      .map((m) => (m.days ?? []).filter((d) => d?.meals?.length > 0).length)
      .join("/");
    const gm = p.plan_data?.gen_metrics;
    console.log(
      `${now} plan ${p.id.slice(0, 8)} ${p.status} days:${fill || "-"}${gm ? ` tok/B:[${(gm.day_tok_per_byte ?? []).join(",")}] band:${gm.band_first_pass}/${gm.band_checked_days} trunc:${gm.truncations} salv:${gm.salvages}` : ""}`,
    );
  }
  console.log("---");
  const anyStarted = (gens ?? []).some((g) => g.status === "started");
  const anyTerminal = (gens ?? []).some((g) => g.status !== "started");
  if (!anyStarted && anyTerminal) {
    console.log("ALL RUNS TERMINAL");
    break;
  }
  if (Date.now() > DEADLINE) {
    console.log("FAILSAFE TIMEOUT");
    break;
  }
  await new Promise((r) => setTimeout(r, 45_000));
}
