/**
 * The advisor's per-household message cap over a rolling 24 hours. A COST
 * guard, not a paywall — free-access mode does not lift it. One definition:
 * the chat route enforces it and the admin ops dashboard counts households
 * pressing against it; the admin copy had drifted to a stale hard-coded 30
 * after the route moved to 100.
 */
export const DEFAULT_CHAT_DAILY_CAP = 100;

export function chatDailyCap(): number {
  const n = Number(process.env.CHAT_DAILY_CAP?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CHAT_DAILY_CAP;
}
