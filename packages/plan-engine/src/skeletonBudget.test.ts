/**
 * Phase 1 must leave room for phase 2.
 *
 * Production, 3-member household (Sentry bfda604f): the run spent 856s and
 * $0.46 and every one of the 7 days was deferred with "run budget spent before
 * this day started (no model call made)". `bigCallTimeoutMs` sizes the skeleton
 * call to the WORK (280s at 3 members, up to 600s) and knew nothing about the
 * 15-minute run deadline — and the truncation retry can run it a second time.
 * The result was an EMPTY plan marked failed, which then hid the complete week
 * the family already had.
 */
import { describe, it, expect } from "vitest";
import {
  DAY_CALL_ESTIMATE_MS,
  MIN_VIABLE_CALL_MS,
  canFit,
  remainingMs,
} from "./budget";
import { bigCallTimeoutMs } from "./constants";

/** The clamp applied to the skeleton call in generate.ts. */
function skeletonTimeout(memberCount: number, deadlineMs: number | undefined, now: number) {
  return Math.max(
    MIN_VIABLE_CALL_MS,
    Math.min(
      bigCallTimeoutMs(memberCount),
      remainingMs(deadlineMs, now) - DAY_CALL_ESTIMATE_MS,
    ),
  );
}

describe("skeleton timeout is bounded by the run budget", () => {
  const NOW = 1_000_000;

  it("always leaves room for at least one day call", () => {
    // The shape that broke production: plenty of nominal timeout, little budget.
    const deadline = NOW + 200_000;
    const t = skeletonTimeout(3, deadline, NOW);
    expect(t).toBeLessThanOrEqual(200_000 - DAY_CALL_ESTIMATE_MS);
    // and after spending it, a day still fits
    expect(canFit(deadline, DAY_CALL_ESTIMATE_MS, NOW + t)).toBe(true);
  });

  it("does not inflate the timeout when budget is plentiful", () => {
    // With a full 15-minute box the work-sized value still governs.
    const deadline = NOW + 15 * 60_000;
    expect(skeletonTimeout(3, deadline, NOW)).toBe(bigCallTimeoutMs(3));
  });

  it("never returns a timeout below the viable floor", () => {
    const deadline = NOW + 10_000; // essentially spent
    expect(skeletonTimeout(6, deadline, NOW)).toBe(MIN_VIABLE_CALL_MS);
  });

  it("is unbounded when no deadline is set, preserving old behaviour", () => {
    expect(skeletonTimeout(3, undefined, NOW)).toBe(bigCallTimeoutMs(3));
    expect(skeletonTimeout(6, undefined, NOW)).toBe(bigCallTimeoutMs(6));
  });

  it("the 3-member case can no longer consume the whole box", () => {
    // Two skeleton attempts at the unclamped 280s each, on a 15-min budget,
    // is what left the day loop with nothing.
    const budget = 15 * 60_000;
    const deadline = NOW + budget;
    const first = skeletonTimeout(3, deadline, NOW);
    const afterFirst = NOW + first;
    const second = skeletonTimeout(3, deadline, afterFirst);
    expect(first + second).toBeLessThanOrEqual(budget - DAY_CALL_ESTIMATE_MS);
  });
});

describe("the truncation retry is gated on remaining budget", () => {
  const NOW = 1_000_000;
  // generate.ts refuses the retry unless a second call AND a day call fit.
  const retryAllowed = (deadline: number, now: number) =>
    canFit(deadline, MIN_VIABLE_CALL_MS + DAY_CALL_ESTIMATE_MS, now);

  it("allows the retry when there is room for it and a day", () => {
    expect(retryAllowed(NOW + 10 * 60_000, NOW)).toBe(true);
  });

  it("refuses a retry that would leave no room for any day", () => {
    expect(retryAllowed(NOW + MIN_VIABLE_CALL_MS + 1_000, NOW)).toBe(false);
  });

  it("refuses once the budget is gone", () => {
    expect(retryAllowed(NOW, NOW)).toBe(false);
  });
});
