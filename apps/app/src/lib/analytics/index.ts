// Product analytics — app-wide (authenticated routes AND the landing page).
//
// Moved here from src/marketing/lib/ when the authenticated funnel was
// instrumented: it is a shared concern now, and an authenticated page importing
// @/marketing/lib/... would create a false dependency edge from app → marketing.
//
// posthog-js is ~50KB gz — far too heavy for the landing page's critical
// bundle. It is dynamic-imported after the page goes idle; events fired before
// it loads are queued (bounded) and flushed on load, so early CTA clicks are
// never lost.
//
// ANONYMOUS BY DESIGN: nothing here calls identify(), and posthog is configured
// with person_profiles: "identified_only", so no person profile is ever created.
// The device-level distinct_id still links signup → onboarding → pricing within
// a session, which is what the free-path-vs-paid question needs. Adding
// identify() would make this personally identifiable and require a privacy
// rewrite — don't, without that conversation.

import type { PostHog } from "posthog-js";

let client: PostHog | null = null;
let loadStarted = false;
// null = tracking disabled (no key / consent refused) or already flushed;
// array = queue until load.
let pending: Array<{ event: string; props?: Record<string, unknown> }> | null = [];
const MAX_QUEUE = 20;
// Resolves once the SDK is loaded (or has definitively failed), so a caller
// about to navigate away can wait for real delivery instead of queueing into a
// page that is about to be destroyed.
let loadPromise: Promise<void> | null = null;

// ─── Consent ──────────────────────────────────────────────────────────────
// Storage matches what CookieConsent has always written, so an existing choice
// is honoured rather than re-asked.
export const CONSENT_KEY = "fitlife_cookie_consent";
export type ConsentState = "accepted" | "declined" | "unset";

export function getAnalyticsConsent(): ConsentState {
  if (typeof window === "undefined") return "unset";
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "accepted" || v === "declined" ? v : "unset";
  } catch {
    // Private mode / storage disabled — treat as no consent given.
    return "unset";
  }
}

/**
 * Record the user's choice and act on it immediately.
 *
 * OPT-IN: tracking does not start until this is called with `true`. Previously
 * the banner stored a value that nothing read — init and $pageview both ran
 * ~1.5s before the banner was even shown, and declining still fired an event.
 */
export function setAnalyticsConsent(granted: boolean) {
  try {
    window.localStorage.setItem(CONSENT_KEY, granted ? "accepted" : "declined");
  } catch {
    // Non-fatal: the in-memory decision below still applies for this session.
  }
  if (granted) {
    // Re-accepting after a decline must actually resume capture. initPostHog()
    // alone cannot: it early-returns once `loadStarted` is set, so if the SDK had
    // already loaded and been opted out, accept → decline → accept left the user
    // looking at "measurement on" while PostHog stayed opted out until a full
    // reload. Harmless while the only way to answer was a one-shot banner;
    // reachable now that /settings can change the choice mid-session.
    pending = pending ?? [];
    try {
      client?.opt_in_capturing();
    } catch {
      // never break the UX
    }
    initPostHog();
    return;
  }
  // Refused: drop anything queued and stop the SDK if it already loaded.
  pending = null;
  try {
    client?.opt_out_capturing();
  } catch {
    // never break the UX
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────

export function initPostHog() {
  if (typeof window === "undefined" || loadStarted) return;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    // Expected in CI and any deploy without the key set — stay silent-ish and
    // fully inert rather than erroring.
    console.warn("PostHog key missing. Tracking disabled.");
    pending = null;
    loadStarted = true;
    return;
  }
  // No consent yet (or refused) → do not load, do not queue. Not marking
  // loadStarted, so a later accept can still initialise.
  if (getAnalyticsConsent() !== "accepted") {
    pending = null;
    return;
  }
  loadStarted = true;
  pending = [];

  const load = () =>
    import("posthog-js")
      .then(({ default: posthog }) => {
        // Consent can be withdrawn while the ~50KB SDK is still downloading:
        // setAnalyticsConsent(false) found no client to opt out, so without
        // this check the import lands, initialises, and starts capturing —
        // page-leave events included — for a user who just said no; and a
        // later accept could never recover, because loadStarted was already
        // set. `pending === null` is exactly what the refusal writes and
        // nothing else clears it mid-flight. Hand the module back to its
        // pre-load state so a later accept re-runs initPostHog from scratch.
        if (pending === null) {
          if (posthog.__loaded) {
            try {
              posthog.opt_out_capturing();
            } catch {
              // never break the UX
            }
          }
          loadStarted = false;
          loadPromise = null;
          return;
        }
        if (!posthog.__loaded) {
          posthog.init(key, {
            api_host:
              process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com",
            person_profiles: "identified_only",
            capture_pageview: false,
            capture_pageleave: true,
          });
        }
        client = posthog;
        for (const q of pending ?? []) {
          try {
            client.capture(q.event, q.props);
          } catch {
            // never break the UX
          }
        }
        pending = null;
      })
      .catch(() => {
        // Network/adblock — tracking silently disabled.
        pending = null;
      });

  loadPromise = new Promise<void>((resolve) => {
    const run = () => void load().finally(resolve);
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(run, { timeout: 4000 });
    } else {
      window.setTimeout(run, 2000);
    }
  });
}

/**
 * Resolves once any in-flight SDK load has settled (immediately when none is).
 * captureBeacon races this internally; exported so tests can wait for the
 * real settle instead of guessing a delay — a fixed wait let one test's init
 * land during the next test under CPU load.
 */
export function whenAnalyticsSettled(): Promise<void> {
  return loadPromise ?? Promise.resolve();
}

// ─── Capture ──────────────────────────────────────────────────────────────

/** Capture an event now if PostHog is loaded, else queue it until it is. */
export function capture(event: string, props?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  // Self-initialising. Without this, an event fired before any provider mounts
  // silently fills the queue and is NEVER flushed — invisible data loss.
  if (!loadStarted) initPostHog();
  try {
    if (client) {
      client.capture(event, props);
    } else if (pending && pending.length < MAX_QUEUE) {
      pending.push({ event, props });
    }
  } catch {
    // Swallow tracking errors — never break the UX
  }
}

/** Alias kept for the marketing call sites, which all use `track`. */
export function track(event: string, props?: Record<string, unknown>) {
  capture(event, props);
}

/**
 * Capture an event that is immediately followed by leaving the page.
 *
 * `capture()` alone is not safe there: if the SDK has not lazy-loaded yet the
 * event only lands in the in-memory queue, and `window.location.assign` throws
 * that queue away. Exactly the events that matter most — signup_completed,
 * checkout_initiated, free_path_chosen — sit in front of a hard navigation.
 *
 * So: wait (briefly, bounded) for the SDK, then send via sendBeacon, which the
 * browser is obliged to deliver even as the document unloads. Awaiting the real
 * SDK rather than hand-rolling a beacon to the capture endpoint matters — a
 * hand-rolled call would have to invent a distinct_id and would split the very
 * funnel this exists to measure.
 */
export async function captureBeacon(
  event: string,
  props?: Record<string, unknown>,
  timeoutMs = 1500,
) {
  if (typeof window === "undefined") return;
  if (!loadStarted) initPostHog();
  if (!client && loadPromise) {
    await Promise.race([
      loadPromise,
      new Promise<void>((r) => window.setTimeout(r, timeoutMs)),
    ]);
  }
  try {
    if (client) {
      client.capture(event, props, { transport: "sendBeacon" });
    } else {
      // Still not loaded (no consent, no key, adblock) — normal path, which
      // will no-op or queue. Never block navigation on analytics.
      capture(event, props);
    }
  } catch {
    // never break the UX
  }
}
