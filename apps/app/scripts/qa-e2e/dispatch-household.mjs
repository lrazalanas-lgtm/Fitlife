// Usage: node dispatch-household.mjs
// Dispatch a whole-household generation WITHOUT a browser: sign in via
// supabase-js, encode the session the way @supabase/ssr's cookie storage does
// (base64url JSON with "base64-" prefix, chunked), and POST the generate route
// with those cookies.
import { createClient } from "@supabase/supabase-js";

const BASE = "https://fitlife-app-mvp.netlify.app";
const html = await (await fetch(`${BASE}/auth/login`)).text();
const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
let url = null, anon = null;
for (const s of scripts) {
  const t = await (await fetch(s.startsWith("http") ? s : BASE + s)).text();
  url ??= t.match(/https:\/\/[a-z0-9-]+\.supabase\.co/)?.[0] ?? null;
  for (const tok of t.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try { if (JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()).role === "anon") anon = tok; } catch {}
  }
  if (url && anon) break;
}
if (!url || !anon) throw new Error("no creds discovered");
const ref = new URL(url).hostname.split(".")[0];
const sb = createClient(url, anon, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({
  email: "fitlife.qa+brief-tkkuc@gmail.com", password: "FitLifeQA!2026",
});
if (error) throw new Error(error.message);

const raw = "base64-" + Buffer.from(JSON.stringify(data.session)).toString("base64url");
const CHUNK = 3180;
const cookies = [];
if (raw.length <= CHUNK) {
  cookies.push(`sb-${ref}-auth-token=${raw}`);
} else {
  for (let i = 0; i * CHUNK < raw.length; i++)
    cookies.push(`sb-${ref}-auth-token.${i}=${raw.slice(i * CHUNK, (i + 1) * CHUNK)}`);
}
const cookieHeader = cookies.join("; ");

// Sanity: does the app see us as signed in?
const st = await fetch(`${BASE}/api/plans/status`, { headers: { cookie: cookieHeader } });
console.log("status probe →", st.status);
if (st.status !== 200) { console.log(await st.text()); process.exit(1); }

const r = await fetch(`${BASE}/api/plans/generate`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieHeader },
  body: JSON.stringify({ issues: "", improvements: "" }),
});
console.log("POST /api/plans/generate →", r.status, (await r.text()).slice(0, 200));
if (r.status !== 200) process.exit(1);
