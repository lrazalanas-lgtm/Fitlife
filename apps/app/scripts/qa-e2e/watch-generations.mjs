// Follow every generation opened since WATCH_SINCE (chain hops included) until
// all are terminal; print per-poll status. 45s cadence, 45-minute failsafe.
import { createClient } from "@supabase/supabase-js";

const BASE = "https://fitlife-app-mvp.netlify.app";
// Usage: WATCH_SINCE=2026-08-31T00:00:00Z node watch-generations.mjs
// Follows every generation opened since WATCH_SINCE (chain hops included)
// until all are terminal. Companion to dispatch-household.mjs.
const SINCE = process.env.WATCH_SINCE;
if (!SINCE) throw new Error("WATCH_SINCE required (RFC3339 UTC)");
const DEADLINE = Date.now() + 45 * 60_000;

// Discover the public anon key from the served bundle (NEXT_PUBLIC_*, inlined).
const html = await (await fetch(`${BASE}/auth/login`)).text();
const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
let url = null, anon = null;
for (const s of scripts) {
  const t = await (await fetch(s.startsWith("http") ? s : BASE + s)).text();
  url ??= t.match(/https:\/\/[a-z0-9-]+\.supabase\.co/)?.[0] ?? null;
  for (const tok of t.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try {
      if (JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).role === "anon") anon = tok;
    } catch {}
  }
  if (url && anon) break;
}
if (!url || !anon) throw new Error("could not discover supabase creds");
const sb = createClient(url, anon);
const { data: auth, error } = await sb.auth.signInWithPassword({
  email: "fitlife.qa+brief-tkkuc@gmail.com", password: "FitLifeQA!2026",
});
if (error) throw new Error(error.message);
const uid = auth.user.id;

for (;;) {
  const { data: gens } = await sb.from("plan_generations")
    .select("meal_plan_id,status,tokens_in,tokens_out,cost_usd,duration_ms,error_message")
    .eq("user_id", uid).gte("started_at", SINCE).order("started_at");
  const { data: plans } = await sb.from("meal_plans")
    .select("id,status,plan_data").eq("user_id", uid)
    .gte("created_at", SINCE).order("created_at");
  const now = new Date().toISOString().slice(11, 19);
  for (const g of gens ?? [])
    console.log(`${now} gen ${String(g.meal_plan_id).slice(0,8)} ${g.status} in=${g.tokens_in ?? "-"} out=${g.tokens_out ?? "-"} $${g.cost_usd ?? "-"} ${g.duration_ms ?? "-"}ms ${g.error_message ?? ""}`.trim());
  for (const p of plans ?? []) {
    const fill = (p.plan_data?.members ?? [])
      .map((m) => (m.days ?? []).filter((d) => d?.meals?.length > 0).length).join("/");
    console.log(`${now} plan ${p.id.slice(0,8)} ${p.status} days:${fill || "-"}`);
  }
  console.log("---");
  const anyStarted = (gens ?? []).some((g) => g.status === "started");
  const anyTerminal = (gens ?? []).some((g) => g.status !== "started");
  if (!anyStarted && anyTerminal) { console.log("ALL RUNS TERMINAL"); break; }
  if (Date.now() > DEADLINE) { console.log("FAILSAFE TIMEOUT"); break; }
  await new Promise((r) => setTimeout(r, 45_000));
}
