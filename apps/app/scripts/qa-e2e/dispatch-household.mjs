// Usage: node dispatch-household.mjs [email]
//
// Dispatch a whole-household generation WITHOUT a browser: sign in via
// supabase-js, encode the session the way @supabase/ssr's cookie storage does
// ("base64-" + base64url JSON, chunked), and POST the generate route with
// those cookies. Exists because Playwright cannot cross some CI/remote
// proxies; credentials come from creds.mjs like every other diagnostic here.
import { createClient } from "@supabase/supabase-js";
import { discoverSupabaseCreds, BASE, PASSWORD } from "./creds.mjs";

const EMAIL = process.argv[2] ?? process.env.QA_EMAIL ?? "fitlife.qa+brief-tkkuc@gmail.com";

const { url, anon } = await discoverSupabaseCreds();
const ref = new URL(url).hostname.split(".")[0];
const sb = createClient(url, anon, { auth: { persistSession: false } });
const { data, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (error) throw new Error(`sign-in failed: ${error.message}`);

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

const st = await fetch(`${BASE}/api/plans/status`, { headers: { cookie: cookieHeader } });
console.log("status probe →", st.status);
if (st.status !== 200) {
  console.log(await st.text());
  process.exit(1);
}

const r = await fetch(`${BASE}/api/plans/generate`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: cookieHeader },
  body: JSON.stringify({ issues: "", improvements: "" }),
});
console.log("POST /api/plans/generate →", r.status, (await r.text()).slice(0, 200));
if (r.status !== 200) process.exit(1);
