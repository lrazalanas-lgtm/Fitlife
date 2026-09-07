/**
 * Read-time guard for the LIVE plan view: drop plan members who are no longer
 * on the household roster.
 *
 * Removing a member while a generation held the lock returned «busy — the
 * removal is saved; defer the regen», and nothing deferred it: the run in
 * flight had already captured the roster and wrote the removed member back
 * into plan_data, and afterwards nobody was "short" or "pending", so no
 * self-heal fired. Their tab and full week stayed on /plan indefinitely. The
 * drain now dispatches a roster-aligning run for such ghosts (see
 * drainDeferredMembers); this hides them from the live view meanwhile. NOT
 * applied to /plan/history, which is a record of what was planned.
 *
 * "mom" is the account owner and always kept. Identity is preserved when
 * nothing is dropped (mirrors applyMemberDisplayNames).
 */
export function dropRemovedMembers<P extends { members: Array<{ member_id: string }> }>(
  plan: P,
  liveMemberIds: ReadonlySet<string>,
): P {
  const kept = plan.members.filter(
    (m) => m.member_id === "mom" || liveMemberIds.has(m.member_id),
  );
  if (kept.length === plan.members.length) return plan;
  return { ...plan, members: kept };
}
