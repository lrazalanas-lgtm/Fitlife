import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// posthog-js is stubbed: these tests are about OUR gating logic (consent,
// queueing, lazy init), not about the SDK. Hoisted so the dynamic import
// inside initPostHog resolves to it.
const posthogMock = vi.hoisted(() => ({
  __loaded: false,
  init: vi.fn(),
  capture: vi.fn(),
  opt_out_capturing: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthogMock }));

const CONSENT_KEY = "fitlife_cookie_consent";

/** Minimal window: only the surface lib/analytics actually touches. */
function installWindow(stored?: string) {
  const store = new Map<string, string>();
  if (stored) store.set(CONSENT_KEY, stored);
  const win = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    // Fire immediately so the lazy load resolves within the test.
    requestIdleCallback: (cb: () => void) => void cb(),
    // Must stay genuinely deferred: captureBeacon races the SDK load against
    // this timeout, and a synchronous stub would hand the race to the timeout
    // every time and quietly test the wrong branch.
    setTimeout: (cb: () => void, ms?: number) => globalThis.setTimeout(cb, ms),
  };
  (globalThis as { window?: unknown }).window = win;
  return store;
}

type Analytics = typeof import("./index");
let current: Analytics | null = null;

/** Fresh module per test — the module keeps init state in closure scope. */
async function loadModule() {
  vi.resetModules();
  current = await import("./index");
  return current;
}

// The lazy `import("posthog-js")` settles on the module runner's own schedule,
// not the microtask queue — draining ticks is not enough. This used to be a
// fixed 50ms wait, which under CPU load let one test's init land during the
// NEXT test (read as "the wrong test initialised"). Wait for the module's own
// settle signal instead, then one macrotask for the `.then` handlers.
const flush = async () => {
  await current?.whenAnalyticsSettled();
  await new Promise((r) => globalThis.setTimeout(r, 0));
};

describe("analytics consent gate", () => {
  const OLD_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  beforeEach(() => {
    posthogMock.init.mockClear();
    posthogMock.capture.mockClear();
    posthogMock.opt_out_capturing.mockClear();
    posthogMock.__loaded = false;
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  });

  afterEach(async () => {
    // Drain any load this test started so it cannot fire into the next one.
    await flush();
    current = null;
    delete (globalThis as { window?: unknown }).window;
    if (OLD_KEY === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    else process.env.NEXT_PUBLIC_POSTHOG_KEY = OLD_KEY;
  });

  it("does not load the SDK before consent is given", async () => {
    installWindow();
    const a = await loadModule();

    a.initPostHog();
    a.capture("signup_completed");
    await flush();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  // The regression this exists for: initPostHog() must NOT mark itself as
  // "started" when it bails for lack of consent. If it did, accepting the
  // banner afterwards could never initialise, and every user who accepts
  // would be silently untracked for the rest of the session.
  it("still initialises when consent is granted after a no-consent call", async () => {
    installWindow();
    const a = await loadModule();

    a.initPostHog(); // bails: undecided
    expect(posthogMock.init).not.toHaveBeenCalled();

    a.setAnalyticsConsent(true);
    await flush();

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
  });

  it("loads and flushes queued events once consent is stored", async () => {
    installWindow("accepted");
    const a = await loadModule();

    // Fired before any provider mounts — capture() must self-initialise, or
    // this event would sit in the queue forever.
    a.capture("free_path_chosen", { source: "test" });
    await flush();

    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(posthogMock.capture).toHaveBeenCalledWith("free_path_chosen", {
      source: "test",
    });
  });

  it("sends nothing at all when consent was refused", async () => {
    installWindow("declined");
    const a = await loadModule();

    a.initPostHog();
    a.capture("checkout_initiated", { tier: "family" });
    await flush();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("opts out of an already-loaded SDK when consent is withdrawn", async () => {
    installWindow("accepted");
    const a = await loadModule();

    a.capture("$pageview");
    await flush();
    expect(posthogMock.capture).toHaveBeenCalledTimes(1);

    a.setAnalyticsConsent(false);
    expect(posthogMock.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  // The SDK is ~50KB and lazy-loaded after idle; on a phone the download can
  // outlast a change of mind. Withdrawing consent found no client to opt out,
  // so the import used to land, initialise, and start capturing (page-leave
  // events included) for a user who had just said no — and re-accepting could
  // never recover, because loadStarted was already set.
  it("does not initialise an SDK whose consent was withdrawn while it was loading", async () => {
    installWindow("accepted");
    const a = await loadModule();

    a.initPostHog(); // import in flight
    a.setAnalyticsConsent(false); // change of mind before it lands
    await flush();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();

    // And the module is not wedged: a later accept still initialises.
    a.setAnalyticsConsent(true);
    await flush();
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
  });

  it("records the choice so the banner is not asked again", async () => {
    const store = installWindow();
    const a = await loadModule();

    expect(a.getAnalyticsConsent()).toBe("unset");
    a.setAnalyticsConsent(false);
    expect(store.get(CONSENT_KEY)).toBe("declined");
    expect(a.getAnalyticsConsent()).toBe("declined");
  });

  it("stays inert with no key configured, consent or not", async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    installWindow("accepted");
    const a = await loadModule();

    a.initPostHog();
    a.capture("plan_ready");
    await flush();

    expect(posthogMock.init).not.toHaveBeenCalled();
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("delivers pre-navigation events via sendBeacon", async () => {
    installWindow("accepted");
    const a = await loadModule();

    await a.captureBeacon("signup_completed", { intent_tier: null });

    expect(posthogMock.capture).toHaveBeenCalledWith(
      "signup_completed",
      { intent_tier: null },
      { transport: "sendBeacon" },
    );
  });
});
