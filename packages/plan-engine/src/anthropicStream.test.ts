import { describe, it, expect, vi, afterEach } from "vitest";
import { streamAnthropic } from "./anthropic";
import { AnthropicCallError } from "./errors";
import { isRetryable } from "./generate";

/**
 * The real streaming path, against a faked SSE body. Everything else in the
 * suite mocks `streamAnthropic` wholesale, so these are the only tests that
 * pin its error contract — which the whole reliability layer leans on:
 *
 * A mid-body death of ANY kind must surface as AnthropicCallError with the
 * streamed text attached and "stream error" in the message, so it is retryable
 * AND salvageable, and carries the billed-but-unreported token estimate.
 * undici's `TypeError: terminated` used to propagate raw: not retryable, not
 * salvageable, $2.02 of one production run discarded whole.
 *
 * (Assistant prefill was tried here for compact-JSON pinning and REJECTED by
 * the API — claude-sonnet-4-6 answers 400 "This model does not support
 * assistant message prefill", measured on production 08/30. So there is no
 * prefill contract to pin; compact rides on the prompt directive alone.)
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

describe("the happy path", () => {
  it("accumulates deltas and usage; no extra messages are fabricated", async () => {
    let sentBody: { messages?: unknown[] } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return sseResponse([messageStart, delta('{"d":0,'), delta('"ms":[]}'), messageDelta]);
      }),
    );
    const res = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
    });
    expect(res.text).toBe('{"d":0,"ms":[]}');
    expect(res.tokensIn).toBe(1234);
    expect(res.tokensOut).toBe(42);
    expect(res.stopReason).toBe("end_turn");
    // The conversation must end with a user message — claude-sonnet-4-6
    // rejects a trailing assistant turn outright (API 400, measured on prod).
    const messages = sentBody.messages as Array<{ role: string }>;
    expect(messages[messages.length - 1]!.role).toBe("user");
  });
});

describe("mid-body stream death", () => {
  it("wraps a raw socket error as a retryable, salvageable AnthropicCallError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          messageStart,
          delta('{"d":0,"ms":[{"id":"mom"}'),
          new TypeError("terminated"),
        ]),
      ),
    );
    const err = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnthropicCallError);
    const e = err as AnthropicCallError;
    expect(e.partialText).toBe('{"d":0,"ms":[{"id":"mom"}');
    // "stream error" in the message is what isRetryable keys on.
    expect(isRetryable(e)).toBe(true);
    // The billed-but-unreported spend: estimated from streamed bytes, input
    // real from message_start.
    expect(e.estimatedOutputTokens).toBeGreaterThan(0);
    expect(e.inputTokensAtFailure).toBe(1234);
  });

  it("the SSE error event carries the streamed text too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          messageStart,
          delta('{"d":0,"ms":['),
          sseEvent({ type: "error", error: { type: "overloaded_error" } }),
        ]),
      ),
    );
    const err = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
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
    // different fixes (call length vs match strictness); a non-empty
    // partialText for a stream that never wrote anything would collapse them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([messageStart, new TypeError("terminated")])),
    );
    const err = await streamAnthropic({
      apiKey: "k",
      model: "m",
      maxTokens: 100,
      systemPrompt: "s",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    const e = err as AnthropicCallError;
    expect(e.partialText).toBeUndefined();
    expect(e.estimatedOutputTokens).toBeUndefined();
  });
});
