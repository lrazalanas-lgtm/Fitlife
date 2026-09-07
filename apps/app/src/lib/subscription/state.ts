import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { isFreeAccessMode } from "./freeAccess";
import {
  PRICING_TIERS,
  type Tier,
  type Cadence,
  type SubscriptionStatus,
} from "@fitlife/config";

/**
 * Subscription row shape, including the new columns added in migration 00004.
 * The generated database.types.ts is behind; we annotate explicitly via
 * `.returns<SubscriptionRow[]>()` to keep reads strongly typed without
 * regenerating types.
 */
export interface SubscriptionRow {
  id: string;
  user_id: string;
  tier: Tier;
  status: SubscriptionStatus;
  cadence: Cadence | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  // LemonSqueezy's paid-through date on a cancelled/paused subscription. Read
  // because a cancellation often arrives with renews_at null and ends_at set,
  // and isSubscriptionActive needs a date to justify the remaining access.
  ends_at: string | null;
  cancel_at_period_end: boolean;
  lemonsqueezy_subscription_id: string | null;
  lemonsqueezy_customer_id: string | null;
  lemonsqueezy_variant_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Uncached fetch of the user's most recent subscription row (any status).
 * No `unique(user_id)` constraint, so we sort by created_at desc.
 *
 * Use this ONLY in write-then-read flows that must observe rows updated
 * earlier in the same request (e.g. reconcile). Everything else should use
 * getCurrentSubscription below.
 */
export async function getCurrentSubscriptionFresh(
  userId: string,
): Promise<SubscriptionRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("subscriptions")
    .select(
      "id, user_id, tier, status, cadence, trial_started_at, trial_ends_at, current_period_start, current_period_end, ends_at, cancel_at_period_end, lemonsqueezy_subscription_id, lemonsqueezy_customer_id, lemonsqueezy_variant_id, created_at, updated_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .returns<SubscriptionRow[]>();

  if (error || !data || data.length === 0) return null;
  return data[0] ?? null;
}

/**
 * The user's most recent subscription row, memoized per request with
 * React.cache: pages often need the subscription both directly (banners) and
 * inside access checks (canGenerateForFamilyChange) within one request — one
 * query serves both.
 */
export const getCurrentSubscription = cache(getCurrentSubscriptionFresh);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Number of whole days remaining in the trial (clamped to >= 0).
 * Returns 0 for non-trialing subscriptions or expired trials.
 */
export function getTrialDaysRemaining(sub: SubscriptionRow): number {
  if (sub.status !== "trialing" || !sub.trial_ends_at) return 0;
  const remainingMs = new Date(sub.trial_ends_at).getTime() - Date.now();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / MS_PER_DAY);
}

export function isTrialExpired(sub: SubscriptionRow): boolean {
  if (sub.status !== "trialing") return false;
  if (!sub.trial_ends_at) return true;
  return new Date(sub.trial_ends_at).getTime() <= Date.now();
}

/**
 * True if the subscription should grant access right now:
 *   - status === 'active' AND current_period_end > now (handles the
 *     cancel-at-period-end case where the row stays 'active' until the
 *     paid-through date and then transitions to 'expired' via the webhook
 *     or a stale-period check)
 *   - status === 'cancelled' AND the paid-through date is still in the future.
 *     Cancelled means "will not renew", NOT "access ends now" — that is what
 *     'expired' is for, and subscription_expired sets it. Our own cancel route
 *     never writes this status (it keeps the row 'active' and only flags
 *     cancel_at_period_end), so before this branch existed the two cancellation
 *     paths disagreed: cancelling through the LemonSqueezy portal arrived as
 *     subscription_updated with status='cancelled' and killed access instantly,
 *     while the subscription page went on promising «الخدمة تستمر حتى نهاية
 *     فترتك الحالية». A customer three days into a paid month lost plan
 *     generation and the advisor while still being told, on screen, that they
 *     had 27 days left.
 *   - status === 'trialing' AND trial_ends_at is in the future
 *
 * 'paused' is deliberately NOT here: billing has stopped, so access should too.
 */
export function isSubscriptionActive(sub: SubscriptionRow): boolean {
  // TEMPORARY testing mode — see lib/subscription/freeAccess.ts. Placed at the
  // very top so it covers every status, including trials that have run out:
  // during testing an expired trial must not quietly re-lock the app. Every
  // downstream surface (access gates, banners, the family sync) reads through
  // this one predicate, so this single line unlocks them consistently.
  if (isFreeAccessMode()) return true;

  if (sub.status === "active") {
    // If we have a current_period_end, require it to be in the future.
    // Webhooks fill this; only legacy/seed rows may have it null — treat as active.
    if (!sub.current_period_end) return true;
    return new Date(sub.current_period_end).getTime() > Date.now();
  }
  if (sub.status === "cancelled") {
    // Unlike 'active', a missing date is NOT treated as open-ended access — a
    // cancelled row with no paid-through date has nothing to justify it.
    const paidThrough = sub.current_period_end ?? sub.ends_at;
    if (!paidThrough) return false;
    return new Date(paidThrough).getTime() > Date.now();
  }
  if (sub.status === "trialing") return !isTrialExpired(sub);
  return false;
}

/**
 * True when a renewal payment has failed and the user needs to update their
 * card. Distinct from 'cancelled' / 'expired' — the user can recover by
 * paying, no need to start a new subscription.
 */
export function isPastDue(sub: SubscriptionRow): boolean {
  return sub.status === "past_due";
}

/**
 * True when the user already holds a LIVE Lemonsqueezy subscription — a new
 * checkout would create a SECOND LS subscription that keeps billing while our
 * single subscriptions row points at the newer one (orphaned, uncancellable
 * from the UI). Tier changes go through /api/subscription/change, which swaps
 * the variant on the EXISTING LS subscription instead.
 *
 * past_due counts as live: the LS sub is recoverable by paying — a second
 * checkout would orphan it. Internal trials never carry an LS id, so trial
 * users still check out normally; cancelled/expired/lapsed rows fall through
 * (starting a fresh subscription is the correct recovery there).
 *
 * 'cancelled' is excluded EXPLICITLY rather than by falling out of
 * isSubscriptionActive, which now grants access through the paid-through date.
 * Those are two different questions: she may still USE what she paid for, and
 * she may still RE-SUBSCRIBE. Deriving the second from the first would strand
 * her — no checkout button, and no un-cancel flow to reach either. The
 * cancelled LS subscription will not renew, so a fresh one cannot double-bill.
 *
 * 'paused' IS live for the same reason past_due is: the LemonSqueezy
 * subscription still exists under its id and will resume billing itself at
 * resumes_at. Treating it as dead sent a paused customer into a brand-new
 * checkout, whose subscription_created webhook then took over the single
 * unique(user_id) row — orphaning the paused subscription, which LemonSqueezy
 * kept and later billed with no id left in the app to manage it.
 */
export function hasLiveLemonsqueezySubscription(
  sub: SubscriptionRow | null,
): boolean {
  if (!sub?.lemonsqueezy_subscription_id) return false;
  if (sub.status === "cancelled") return false;
  return isSubscriptionActive(sub) || isPastDue(sub) || sub.status === "paused";
}

/**
 * Maximum number of beneficiaries the tier allows (Mom + family_members,
 * excluding the housekeeper). null means unlimited.
 */
export function getTierLimit(tier: Tier): number | null {
  // TEMPORARY testing mode — null means unlimited, so a household of any size
  // passes the person-count check. This is the switch that makes "add as many
  // members as I want" work; the tier's real max_people is left untouched so
  // pricing copy and the plan-comparison table still show the true numbers.
  if (isFreeAccessMode()) return null;

  return PRICING_TIERS[tier].max_people;
}
