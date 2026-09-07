import { describe, it, expect } from "vitest";
import {
  hasLiveLemonsqueezySubscription,
  isSubscriptionActive,
  type SubscriptionRow,
} from "./state";

/**
 * Guard predicate for /api/checkout: a user with a LIVE Lemonsqueezy
 * subscription must not reach a second checkout (double-billing / orphaned
 * LS sub). Trial users (no LS id) and lapsed/cancelled/expired subs must
 * still be allowed through.
 */

const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

function makeSub(overrides: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    id: "sub-row-1",
    user_id: "user-1",
    tier: "family",
    status: "active",
    cadence: "monthly",
    trial_started_at: null,
    trial_ends_at: null,
    current_period_start: PAST,
    current_period_end: FUTURE,
    ends_at: null,
    cancel_at_period_end: false,
    lemonsqueezy_subscription_id: "ls-123",
    lemonsqueezy_customer_id: "cus-123",
    lemonsqueezy_variant_id: "var-123",
    created_at: PAST,
    updated_at: PAST,
    ...overrides,
  };
}

describe("hasLiveLemonsqueezySubscription", () => {
  it("blocks an active subscription with an LS id", () => {
    expect(hasLiveLemonsqueezySubscription(makeSub({}))).toBe(true);
  });

  it("blocks a paid trial (trialing WITH an LS id)", () => {
    const sub = makeSub({ status: "trialing", trial_ends_at: FUTURE });
    expect(hasLiveLemonsqueezySubscription(sub)).toBe(true);
  });

  it("blocks past_due (LS sub recoverable by paying)", () => {
    const sub = makeSub({ status: "past_due" });
    expect(hasLiveLemonsqueezySubscription(sub)).toBe(true);
  });

  // A paused LS subscription still exists and resumes billing on its own.
  // Treating it as dead sent the customer into a second checkout whose
  // webhook took over the row and orphaned the paused one.
  it("blocks paused (LS sub kept, auto-resumes billing)", () => {
    const sub = makeSub({ status: "paused" });
    expect(hasLiveLemonsqueezySubscription(sub)).toBe(true);
  });

  it("allows when there is no subscription row", () => {
    expect(hasLiveLemonsqueezySubscription(null)).toBe(false);
  });

  it("allows an internal trial (no LS id)", () => {
    const sub = makeSub({
      status: "trialing",
      trial_ends_at: FUTURE,
      lemonsqueezy_subscription_id: null,
    });
    expect(hasLiveLemonsqueezySubscription(sub)).toBe(false);
  });

  it("allows cancelled and expired subs even with an LS id", () => {
    expect(hasLiveLemonsqueezySubscription(makeSub({ status: "cancelled" }))).toBe(false);
    expect(hasLiveLemonsqueezySubscription(makeSub({ status: "expired" }))).toBe(false);
  });

  it("allows an 'active' row whose paid period has lapsed", () => {
    const sub = makeSub({ current_period_end: PAST });
    expect(hasLiveLemonsqueezySubscription(sub)).toBe(false);
  });

  // isSubscriptionActive now grants access through the paid-through date on a
  // cancelled row. Re-subscribing is a DIFFERENT question and must stay open —
  // deriving this predicate from that one would leave her with no checkout
  // button and no un-cancel flow, i.e. stranded.
  it("still allows re-subscribing while a cancelled sub is inside its paid period", () => {
    const sub = makeSub({ status: "cancelled", current_period_end: FUTURE });
    expect(isSubscriptionActive(sub)).toBe(true);
    expect(hasLiveLemonsqueezySubscription(sub)).toBe(false);
  });
});

/**
 * Cancelled means "will not renew", not "access ends now" — 'expired' is what
 * ends access, and subscription_expired sets it.
 *
 * The app's own cancel route never writes status='cancelled': it keeps the row
 * 'active' and flags cancel_at_period_end. Cancelling through the LemonSqueezy
 * customer portal instead arrives as subscription_updated with status
 * 'cancelled'. Before this, those two paths disagreed — the portal one revoked
 * plan generation and the advisor instantly while the subscription page still
 * promised «الخدمة تستمر حتى نهاية فترتك الحالية».
 */
describe("isSubscriptionActive — a cancelled subscription keeps what it paid for", () => {
  it("grants access while the paid period is in the future", () => {
    expect(
      isSubscriptionActive(makeSub({ status: "cancelled", current_period_end: FUTURE })),
    ).toBe(true);
  });

  it("revokes access once the paid period has passed", () => {
    expect(
      isSubscriptionActive(makeSub({ status: "cancelled", current_period_end: PAST })),
    ).toBe(false);
  });

  it("falls back to ends_at when LemonSqueezy sent no renews_at", () => {
    const sub = makeSub({
      status: "cancelled",
      current_period_end: null,
      ends_at: FUTURE,
    });
    expect(isSubscriptionActive(sub)).toBe(true);
  });

  it("denies a cancelled row with NO paid-through date at all", () => {
    // Deliberately unlike 'active', where a null period end means "legacy row,
    // treat as active". A cancellation with no date has nothing to justify it.
    const sub = makeSub({
      status: "cancelled",
      current_period_end: null,
      ends_at: null,
    });
    expect(isSubscriptionActive(sub)).toBe(false);
  });

  it("leaves the terminal states terminal", () => {
    expect(
      isSubscriptionActive(makeSub({ status: "expired", current_period_end: FUTURE })),
    ).toBe(false);
    // Paused: billing has stopped, so access stops with it.
    expect(
      isSubscriptionActive(makeSub({ status: "paused", current_period_end: FUTURE })),
    ).toBe(false);
  });
});
