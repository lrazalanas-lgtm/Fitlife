/**
 * The window of conversation turns the advisor route forwards to the model.
 *
 * The client resends the whole conversation on every turn, so the array is
 * always odd-length and strictly alternating: user, assistant, …, user. A
 * plain `slice(-20)` (even) of an odd-length array therefore ALWAYS starts on
 * an assistant turn once the conversation exceeds 20 messages — and the
 * Messages API requires the first turn to be the user's, so from the 11th
 * exchange on every request 400'd and the customer saw the generic error for
 * the rest of the session. Keep the last `max` turns, then drop leading
 * non-user turns so the window opens on the user. Pure; unit-tested.
 */
export function trimChatHistory<T extends { role: string }>(
  messages: readonly T[],
  max: number,
): T[] {
  const window = messages.slice(-Math.max(1, max));
  let start = 0;
  while (start < window.length && window[start]!.role !== "user") start++;
  return window.slice(start);
}
