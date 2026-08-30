import { describe, it, expect, vi, afterEach } from "vitest";
import { streamAnthropic } from "./anthropic";
import { AnthropicCallError } from "./errors";
import { isRetryable } from "./generate";

/**
 * The real streaming path, against a faked SSE body. Everything else in the
 * suite mocks `streamAnthropic` wholesale, so these are the only tests that
 * pin its contract — two clauses of which the whole reliability layer leans on:
 *
 * 1. `text` (and any error's `partialText`) INCLUDES the assistant prefill, so
 *    parse and salvage paths never prepend anything. A regression here breaks
 *    the salvage silently: rescueDaySlice would see JSON missing its opening
 *    bytes and return null on every rescue — the exact bug class the verifier
 *    flagged.
 * 2. A mid-body death of ANY kind surfaces as AnthropicCallError with the
 *    streamed text attached and "stream error" in the message, so it is
 *    retryable AND salvageable, and carries the billed-but-unreported token
 *    estimate. undici's `TypeError: terminated` used to propagate raw: not
 *    retryable, not salvageable, $2.02 of one production run discarded whole.
 */

const enc = new TextEncoder();

function sseEvent(obj: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function sseResponse(chunks: Array<Uint8Array | Error>): Response {
  // Pull-based on purpose: erroring inside start() DISCARDS queued chunks
  // (streams spec), which is not how a socket dies — bytes arrive, then the
  // connection drops. One chunk per read, then the error.
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const c = chunks[i++]!;
      if (c instanceof Error) controller.error(c);
      else controller.enqueue(c);
    },
  });
  return new Response(stream, { status: 200 });
}

const messageStart = sseEvent({
  type: "message_start",
  message: { usage: { input_tokens: 1234 } },
});
const delta = (text: string) =>
  sseEvent({ type: "content_block_delta", delta: { type: "text_delta", text } });
const messageDelta = sseEvent({
  type: "message_delta",
  usage: { output_tokens: 42 },
  delta: { stop_reason: "end_turn" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assistant prefill", () => {
  it("returns text WITH the prefill, and sends it as the final assistant turn", async () => {
    let sentBody: { messages?: Array<{ role: string; content: string }> } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return sseResponse([messageStart, delta('0,"ms":[]}'), messageDelta]);
      }),
    );
    const res = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
      assistantPrefill: '{"d":',
    });
    expect(res.text).toBe('{"d":0,"ms":[]}');
    const last = sentBody.messages![sentBody.messages!.length - 1]!;
    expect(last).toEqual({ role: "assistant", content: '{"d":' });
    expect(res.tokensIn).toBe(1234);
    expect(res.tokensOut).toBe(42);
  });

  it("changes nothing when no prefill is given (chat callers)", async () => {
    let sentBody: { messages?: unknown[] } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return sseResponse([messageStart, delta("hello"), messageDelta]);
      }),
    );
    const res = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
    });
    expect(res.text).toBe("hello");
    expect(sentBody.messages).toHaveLength(1);
  });
});

describe("mid-body stream death", () => {
  it("wraps a raw socket error as a retryable, salvageable AnthropicCallError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          messageStart,
          delta('0,"ms":[{"id":"mom"}'),
          new TypeError("terminated"),
        ]),
      ),
    );
    const err = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
      assistantPrefill: '{"d":',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnthropicCallError);
    const e = err as AnthropicCallError;
    // partialText includes the prefill — the salvage parses it as-is.
    expect(e.partialText).toBe('{"d":0,"ms":[{"id":"mom"}');
    // "stream error" in the message is what isRetryable keys on.
    expect(isRetryable(e)).toBe(true);
    // The billed-but-unreported spend: estimated from streamed bytes only
    // (never the prefill — that is prompt-side), input from message_start.
    expect(e.estimatedOutputTokens).toBeGreaterThan(0);
    expect(e.inputTokensAtFailure).toBe(1234);
  });

  it("the SSE error event carries the streamed text too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          messageStart,
          delta('0,"ms":['),
          sseEvent({ type: "error", error: { type: "overloaded_error" } }),
        ]),
      ),
    );
    const err = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
      assistantPrefill: '{"d":',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnthropicCallError);
    const e = err as AnthropicCallError;
    expect(e.message).toContain("overloaded_error");
    expect(e.partialText).toBe('{"d":0,"ms":[');
    expect(isRetryable(e)).toBe(true);
  });

  it("a death before any delta reports NO partial output — the diagnostics depend on the distinction", async () => {
    // "(no partial output)" vs "(salvage: nothing whole streamed)" point at
    // different fixes (call length vs match strictness); a prefill-only
    // partialText would collapse them again.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([messageStart, new TypeError("terminated")])),
    );
    const err = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
      assistantPrefill: '{"d":',
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const e = err as AnthropicCallError;
    expect(e.partialText).toBeUndefined();
    expect(e.estimatedOutputTokens).toBeUndefined();
  });
});
