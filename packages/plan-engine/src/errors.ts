/**
 * Typed errors for the plan-generation pipeline.
 * Each subclass sets `this.name` so callers can branch on `err.name`.
 */

export class OnboardingIncompleteError extends Error {
  constructor() {
    super("Onboarding incomplete");
    this.name = "OnboardingIncompleteError";
  }
}

export class MedicalGateError extends Error {
  constructor() {
    super("Medical consultation required");
    this.name = "MedicalGateError";
  }
}

export class RateLimitError extends Error {
  constructor(public daysUntilReset: number) {
    super("Rate limit exceeded");
    this.name = "RateLimitError";
  }
}

export class AnthropicCallError extends Error {
  // retryAfterMs: when the failure is a 429/529 carrying a Retry-After header, the
  // server-advised wait (ms). The retry loop honors it so we wait out the actual
  // rate-limit window instead of a much shorter exponential backoff.
  //
  // partialText: whatever had streamed in before the failure. A day call aborted
  // at its timeout used to discard everything it had written — measured at five
  // beneficiaries, six day calls streamed to roughly 25k tokens each and were
  // thrown away whole, about $2.40 of a $2.81 run. A day cut off at 95% should
  // not cost 100%.
  //
  // estimatedOutputTokens / inputTokensAtFailure: what the dead call was BILLED.
  // An aborted stream never delivers the usage event, so it records 0 tokens
  // while Anthropic bills everything that streamed — the recorded cost of every
  // timeout run is a floor, and the gauge omits exactly the waste being managed.
  // Output is estimated from the streamed bytes (marked estimate); input is the
  // real figure when message_start arrived before the death.
  constructor(
    message: string,
    public cause?: unknown,
    public readonly retryAfterMs?: number,
    public readonly partialText?: string,
    public readonly estimatedOutputTokens?: number,
    public readonly inputTokensAtFailure?: number,
  ) {
    super(message);
    this.name = "AnthropicCallError";
  }
}

/**
 * Another generation is already in flight for this user: the plan_generations
 * 'started' insert hit the partial unique index from migration 00012. The
 * dispatcher maps this to its existing "busy" result. Never thrown while the
 * index is not applied (no 23505 can fire), so code degrades gracefully.
 */
export class GenerationInFlightError extends Error {
  constructor() {
    super("Another generation is already in flight");
    this.name = "GenerationInFlightError";
  }
}

export class PlanValidationError extends Error {
  constructor(message: string, public rawResponse?: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}
