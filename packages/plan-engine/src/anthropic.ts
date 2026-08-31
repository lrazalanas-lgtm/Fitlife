import { pricingForModel } from "./constants";
import { AnthropicCallError } from "./errors";

export interface StreamResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  stopReason: string | null;
  // Prompt-cache traffic from message_start. Billed at 1.25x (writes) and 0.1x
  // (reads) of the input rate — real money that was NEVER in the recorded
  // cost, so every audit figure was a floor. Optional so the many test mocks
  // (and older call sites) need no change; computeCostUsd prices them when
  // callers pass them through.
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Stream the Anthropic Messages API as SSE over plain `fetch` (no SDK, so this
 * bundles cleanly inside the Netlify background function). Non-streaming
 * requests that take >~5 min hit undici's header timeout ("fetch failed");
 * streaming returns headers immediately and Anthropic sends periodic `ping`
 * events that keep the body connection alive, so long generations don't time out.
 */
export async function streamAnthropic(params: {
  apiKey: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  // Large static prefix (e.g. Sara's methodology) identical across calls — sent
  // as a cached system block so repeated parallel calls only pay ~10% input
  // cost for it after the first. Optional; plain string if omitted.
  systemStatic?: string;
  userMessage?: string;
  // Multi-turn conversation (chat). When provided, used as the request `messages`
  // verbatim; otherwise a single user turn is built from `userMessage`. Existing
  // (generation) callers omit this and are unaffected.
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  // Called with each text delta as it streams in, so a caller can forward tokens
  // live (e.g. the chat route piping to the client). Generation callers omit it
  // and just use the buffered `text` returned at the end.
  onText?: (delta: string) => void;
  // Hard wall-clock cap for the whole request — connect AND streaming body. A
  // stalled SSE body (no more pings, half-open socket) would otherwise block
  // reader.read() forever, hanging the day loop and never flipping generating
  // off. Aborting kills both. Defaults to 4 min; callers inherit it.
  timeoutMs?: number;
  // NOTE deliberately absent: assistant prefill. Pinning the reply's opening
  // bytes with a trailing assistant message was tried for compact-JSON
  // enforcement and REJECTED BY THE API — claude-sonnet-4-6 returns 400
  // "This model does not support assistant message prefill" (measured on
  // production, 08/30). Compact emission rides on the prompt directive, and —
  // on models that accept it — the schema-enforced `outputFormat` below.
  //
  // Structured outputs: sent as `output_config.format` verbatim (the raw wire
  // shape: {type: "json_schema", schema: {...}}). The reply's text is then
  // guaranteed valid JSON matching the schema. ONLY pass this for models in
  // supportsStructuredOutputs — claude-sonnet-4-6 rejects it — and remember
  // the API's constraints: additionalProperties:false on every object, no
  // min/max-style keywords (zod keeps enforcing those app-side).
  outputFormat?: Record<string, unknown>;
}): Promise<StreamResult> {
  const {
    apiKey,
    model,
    maxTokens,
    systemPrompt,
    systemStatic,
    userMessage = "أنشئي الخطة الآن.",
    messages,
    onText,
    timeoutMs = 240_000,
    outputFormat,
  } = params;

  const requestMessages =
    messages && messages.length > 0
      ? messages
      : [{ role: "user" as const, content: userMessage }];

  const system = systemStatic
    ? [
        {
          type: "text",
          text: systemStatic,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: systemPrompt },
      ]
    : systemPrompt;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: requestMessages,
          stream: true,
          ...(outputFormat ? { output_config: { format: outputFormat } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Aborted before the body existed — nothing streamed, nothing to salvage.
      if (controller.signal.aborted) {
        throw new AnthropicCallError(
          `Anthropic stream timeout after ${timeoutMs}ms`,
          err,
        );
      }
      throw new AnthropicCallError(
        err instanceof Error ? err.message : "Anthropic request failed",
        err,
      );
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      // Anthropic returns Retry-After (integer seconds) on 429/529. Capture it so
      // the day-loop retry waits out the real rate-limit window instead of the
      // (much shorter) exponential backoff, which otherwise exhausts retries mid-window.
      const ra = res.headers.get("retry-after");
      const retryAfterMs =
        ra && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) * 1000 : undefined;
      throw new AnthropicCallError(
        `Anthropic API ${res.status}: ${errText.slice(0, 500)}`,
        undefined,
        retryAfterMs,
      );
    }

    let text = "";
    let streamedAny = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheCreation = 0;
    let cacheRead = 0;
    let stopReason: string | null = null;

    // What a dead call was billed for its output. A real usage figure (a
    // message_delta that arrived before the death) always beats the estimate;
    // failing that, 0.6 tok/byte over the streamed bytes (the measured
    // compact-mode figure; pretty mode runs ~0.97). An estimate marked as such
    // beats recording 0 for a call that billed 25k.
    const estimatedStreamedTokens = (): number | undefined => {
      if (tokensOut > 0) return tokensOut;
      if (!streamedAny) return undefined;
      const streamedBytes = new TextEncoder().encode(text).length;
      return Math.max(1, Math.round(streamedBytes * 0.6));
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (evt.type) {
            case "message_start": {
              const usage = (
                evt.message as {
                  usage?: {
                    input_tokens?: number;
                    cache_creation_input_tokens?: number;
                    cache_read_input_tokens?: number;
                  };
                }
              )?.usage;
              if (usage?.input_tokens != null) tokensIn = usage.input_tokens;
              if (usage?.cache_creation_input_tokens != null)
                cacheCreation = usage.cache_creation_input_tokens;
              if (usage?.cache_read_input_tokens != null)
                cacheRead = usage.cache_read_input_tokens;
              break;
            }
            case "content_block_delta": {
              const delta = evt.delta as { type?: string; text?: string };
              if (delta?.type === "text_delta") {
                const chunk = delta.text ?? "";
                text += chunk;
                if (chunk) {
                  streamedAny = true;
                  onText?.(chunk);
                }
              }
              break;
            }
            case "message_delta": {
              const usage = evt.usage as { output_tokens?: number } | undefined;
              if (usage?.output_tokens != null) tokensOut = usage.output_tokens;
              const delta = evt.delta as { stop_reason?: string };
              if (delta?.stop_reason) stopReason = delta.stop_reason;
              break;
            }
            case "error": {
              // Carries the streamed text too: a mid-stream overloaded_error
              // used to discard everything already written, exactly like the
              // raw socket death below did.
              throw new AnthropicCallError(
                `Anthropic stream error: ${JSON.stringify(evt.error).slice(0, 500)}`,
                undefined,
                undefined,
                streamedAny ? text : undefined,
                estimatedStreamedTokens(),
                tokensIn || undefined,
              );
            }
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // Hand back what streamed before the abort so the caller can salvage the
        // complete parts of a nearly-finished payload.
        throw new AnthropicCallError(
          `Anthropic stream timeout after ${timeoutMs}ms`,
          err,
          undefined,
          streamedAny ? text : undefined,
          estimatedStreamedTokens(),
          tokensIn || undefined,
        );
      }
      // Already typed (the SSE `error` event above) → it carries its context.
      if (err instanceof AnthropicCallError) throw err;
      // A raw mid-body death — undici's `TypeError: terminated`, a socket
      // reset — used to propagate untyped: it failed isRetryable (which
      // requires this class), had no partialText for the salvage, and killed
      // the day on first occurrence with everything streamed discarded
      // ($2.02 of one recorded run). The message deliberately contains
      // "stream error" so isRetryable matches it.
      throw new AnthropicCallError(
        `Anthropic stream error mid-body: ${err instanceof Error ? err.message : String(err)}`,
        err,
        undefined,
        streamedAny ? text : undefined,
        estimatedStreamedTokens(),
        tokensIn || undefined,
      );
    }

    return {
      text,
      tokensIn,
      tokensOut,
      stopReason,
      cacheCreationTokens: cacheCreation,
      cacheReadTokens: cacheRead,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recover the JSON payload from a model reply.
 *
 * The fast path is a closed fence wrapping the WHOLE reply. That used to be the
 * only path, and everything else fell through to JSON.parse — which cost a whole
 * DAY of a plan each time it happened, because a SyntaxError is treated as a
 * transient content failure: the day re-rolls twice, fails, and the
 * second-chance wave re-rolls it twice more. Six full day-sized calls, then the
 * day ships EMPTY in a paid plan with nothing surfaced in the UI.
 *
 * Two real production failures (2026-07-25/26), both with perfectly good JSON
 * sitting inside the reply:
 *   - an Arabic prose preamble before the object ("أولاً سأحسب…")
 *   - a ```json fence that was opened and never closed
 *
 * So when the reply is not cleanly fenced, fall back to the outermost JSON span.
 *
 * That span is NOT always braces. The comment here used to assert "callers all
 * expect a single JSON OBJECT (day slice, skeleton, translation)" — and the
 * first two do, but BOTH translation schemas are arrays. So an unfenced
 * `[{…},{…}]` was sliced from its first `{` to its last `}`, yielding
 * `{…},{…}` — not JSON at all — and an unfenced single-element `[{…}]` became a
 * bare object that then failed the array schema. Either way the day was left
 * untranslated behind a console.warn, so whether the housekeeper got her recipes
 * came down to whether the model happened to fence that particular reply.
 *
 * Pick the bracket that actually opens the payload, and close with its match. If
 * there is no plausible JSON the text is returned unchanged and the caller's
 * parse fails exactly as it did before — this only ever widens what can be
 * recovered.
 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) return fence[1];
  const objOpen = trimmed.indexOf("{");
  const arrOpen = trimmed.indexOf("[");
  // Whichever comes first is the outer value; an object whose fields hold arrays
  // still starts with `{`, so object payloads behave exactly as before.
  const isArray = arrOpen !== -1 && (objOpen === -1 || arrOpen < objOpen);
  const open = isArray ? arrOpen : objOpen;
  const close = trimmed.lastIndexOf(isArray ? "]" : "}");
  if (open !== -1 && close > open) return trimmed.slice(open, close + 1);
  return trimmed;
}

/**
 * Close off a payload that stopped mid-stream, keeping every element that had
 * finished.
 *
 * A day call aborted at its timeout threw away everything it had written.
 * Measured at five beneficiaries: six day calls streamed to roughly 25k tokens
 * apiece and were discarded whole — about $2.40 of a $2.81 run, for one usable
 * day. The tokens were already paid for; most of them describe complete recipes.
 *
 * Walks the text once, tracking string/escape state so a `{` inside a recipe
 * name is not mistaken for structure, and cuts after the last complete ELEMENT
 * OF THE OUTERMOST ARRAY — the members list in a day slice, the items list in a
 * translation reply.
 *
 * That boundary matters and the first version got it wrong: it cut after the
 * last bracket that closed while merely nested, which in practice is an
 * ingredient object deep inside a half-written meal. The result is
 * structurally-valid JSON describing a meal with no steps, calories or macros —
 * which then fails the schema, so the WHOLE rescue returned null and the day was
 * lost anyway. Cutting at element boundaries means every element that survives
 * is whole by construction.
 *
 * Returns null when nothing whole made it out, so the caller fails exactly as it
 * did before.
 *
 * Deliberately generic: it makes no assumption about the shape, so it works on
 * the terse day slice, the skeleton, and the translation arrays alike. The
 * CALLER decides whether what survived is worth keeping — this only refuses to
 * throw away tokens that already describe finished work.
 */
export function salvageTruncatedJson(text: string): string | null {
  const trimmed = text.trim();
  const objOpen = trimmed.indexOf("{");
  const arrOpen = trimmed.indexOf("[");
  const start =
    objOpen === -1 ? arrOpen : arrOpen === -1 ? objOpen : Math.min(objOpen, arrOpen);
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  // Depth of the outermost array — set when the first `[` is pushed. An element
  // of THAT array is what we are willing to cut after.
  let elementDepth = -1;
  let cut = -1;
  let closers = "";

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      if (ch === "[" && elementDepth === -1) elementDepth = stack.length;
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      // Back at the outermost array's depth → we just closed one of its
      // elements, and everything up to here is whole. Deeper closes are the
      // insides of a half-written element and must not be cut points.
      if (stack.length > 0 && stack.length === elementDepth) {
        cut = i + 1;
        closers = stack.slice().reverse().join("");
      }
    }
  }

  return cut === -1 ? null : trimmed.slice(start, cut) + closers;
}

/**
 * Cache traffic prices off the INPUT rate: writes at 1.25x, reads at 0.1x.
 * The optional params keep every legacy call site compiling, but a caller that
 * has the cache figures and drops them is under-reporting — measured, cache
 * traffic was 10-30% of a generation's real bill and none of it was recorded.
 */
export function computeCostUsd(
  tokensIn: number,
  tokensOut: number,
  model: string,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
): number {
  const rate = pricingForModel(model);
  const cost =
    (tokensIn / 1_000_000) * rate.input +
    (tokensOut / 1_000_000) * rate.output +
    (cacheCreationTokens / 1_000_000) * rate.input * 1.25 +
    (cacheReadTokens / 1_000_000) * rate.input * 0.1;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
