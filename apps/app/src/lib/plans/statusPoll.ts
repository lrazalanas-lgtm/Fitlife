/**
 * What a generating screen should do with one /api/plans/status reply.
 *
 * The route only ever reports the LATEST plan — and when the newest run failed
 * with nothing to show, "latest" is the previous good plan served under its
 * own id (getLatestPlan's fallback). A tab watching the failed run then saw a
 * different id and read it as "a newer plan superseded mine", reloading
 * silently onto the old week: a customer's own «إنشاء خطة جديدة» could fail
 * with no word said anywhere. `masked_failure` names the failed run so that
 * case is told apart from a genuine supersession. Pure; unit-tested.
 */
export interface StatusPollBody {
  id: string;
  masked_failure?: { id: string; error_message: string | null } | null;
}

export type StatusPollVerdict = "watching" | "superseded" | "masked_failure";

export function classifyStatusPoll(body: StatusPollBody, planId: string): StatusPollVerdict {
  if (body.masked_failure?.id === planId) return "masked_failure";
  if (body.id !== planId) return "superseded";
  return "watching";
}
