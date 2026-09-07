import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import {
  streamAnthropic,
  computeCostUsd,
  PLAN_MODEL,
} from "@fitlife/plan-engine";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { getAnthropicKey } from "@/lib/env";
import { hasAdvisorAccess } from "@/lib/subscription/access";
import { buildHouseholdContext } from "@/lib/chat/context";
import { CHAT_SYSTEM_STATIC, buildChatSystemPrompt } from "@/lib/chat/systemRules";
import { dailyCapMessage } from "@/lib/chat/capMessage";
import { chatDailyCap } from "@/lib/chat/dailyCap";
import { trimChatHistory } from "@/lib/chat/history";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Per-ACCOUNT rolling-24h message cap — shared by the whole household, since one
 * subscription serves everyone.
 *
 * Was 30, which measured out at roughly $0.35/day of protection: 30 advisor
 * messages cost $0.352 in production, about $0.012 each. That is not what a
 * six-person household costs — it is what stops one from using the advisor at
 * all. A single tester exercising one feature exhausted an entire family's daily
 * allowance during the live run, and at six people the old cap works out to five
 * messages each.
 *
 * 100 keeps the runaway protection the cap exists for (~$1.2/day/account worst
 * case) without rationing the product's flagship feature at the household size
 * it is sold to. Env-overridable so it can be tuned without a deploy, matching
 * PLAN_DAY_CONCURRENCY / PLAN_RUN_BUDGET_MS.
 */
const dailyCap = chatDailyCap;
// Cap turns sent to the model (token budget); keep the most recent.
const MAX_HISTORY = 20;

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * POST /api/chat — read-only Arabic advisor (Sara). Streams the reply token-by-
 * token as plain text. Hard read-only: the ONLY write is a metadata-only usage
 * audit row (no chat content) for the daily cap + model-aware cost logging. No
 * plan/profile/family writes, no generation trigger, no admin client, no tools.
 */
export async function POST(request: Request) {
  // Typed as the supabase-js client so the .insert() below validates columns:
  // the @supabase/ssr return type trips a postgrest-js@2.106 generic bug that
  // resolves write params to `never` (same one-cast pattern as lib/admin/db.ts).
  const supabase = (await createClient()) as unknown as SupabaseClient<Database>;
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "يجب تسجيل الدخول" }, { status: 401 });
  }

  const access = await hasAdvisorAccess(user.id);
  if (!access.allowed) {
    return NextResponse.json(
      { error: "المستشارة للمشتركات فقط — فعّلي اشتراكك للوصول" },
      { status: 402 },
    );
  }

  // Daily cap from the usage-audit table. Fail-open if the table isn't present
  // yet (preview before the migration is applied) — never block the feature on
  // a missing audit table.
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Ordered rather than head-only: when the cap is hit we need the OLDEST
    // row's timestamp to say when a slot actually frees. The window is 24h
    // rolling, so "tomorrow" was both wrong and unhelpful.
    const { data: recent, error } = await supabase
      .from("chat_messages")
      .select("created_at")
      .eq("user_id", user.id)
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .returns<{ created_at: string }[]>();
    if (!error && (recent?.length ?? 0) >= dailyCap()) {
      return NextResponse.json(
        { error: dailyCapMessage(recent?.[0]?.created_at ?? null) },
        { status: 429 },
      );
    }
  } catch {
    // fail-open
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  if (parsed.messages[parsed.messages.length - 1]?.role !== "user") {
    return NextResponse.json({ error: "طلب غير صالح" }, { status: 400 });
  }
  // Last MAX_HISTORY turns, opened on a user turn — see lib/chat/history.ts
  // for why a bare slice 400'd every request after the tenth exchange.
  const history = trimChatHistory(parsed.messages, MAX_HISTORY);

  const householdContext = await buildHouseholdContext(user.id);
  const systemPrompt = buildChatSystemPrompt(householdContext);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const result = await streamAnthropic({
          apiKey: getAnthropicKey(),
          model: PLAN_MODEL,
          maxTokens: 1500,
          systemStatic: CHAT_SYSTEM_STATIC,
          systemPrompt,
          messages: history,
          // Must finish under the route's maxDuration (60s): the engine
          // default (240s) would let the platform kill a stalled stream with
          // the usage-audit row below never written.
          timeoutMs: 55_000,
          onText: (delta) => controller.enqueue(encoder.encode(delta)),
        });
        // Audit-only write: rate-limit source + model-aware cost. No content.
        try {
          await supabase.from("chat_messages").insert({
            user_id: user.id,
            model: PLAN_MODEL,
            tokens_in: result.tokensIn,
            tokens_out: result.tokensOut,
            cost_usd: computeCostUsd(
              result.tokensIn,
              result.tokensOut,
              PLAN_MODEL,
              result.cacheCreationTokens,
              result.cacheReadTokens,
            ),
          });
        } catch (logErr) {
          console.error("[chat] usage log failed", logErr);
        }
      } catch (err) {
        console.error("[chat] stream failed", err);
        Sentry.captureException(err, {
          tags: { area: "advisor-chat", userId: user.id },
        });
        controller.enqueue(
          encoder.encode("\n\nصار خطأ غير متوقع. يرجى المحاولة مرة أخرى."),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
