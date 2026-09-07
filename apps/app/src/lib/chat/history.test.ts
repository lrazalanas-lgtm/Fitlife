/**
 * The advisor went silent after ten exchanges: the route sliced the last 20
 * turns of an always-odd, alternating array, so the window opened on an
 * assistant turn and the Messages API refused every request from then on.
 */
import { describe, it, expect } from "vitest";
import { trimChatHistory } from "./history";

type Turn = { role: "user" | "assistant"; content: string };

/** k completed exchanges plus the new user turn: [u,a,…,u], length 2k+1. */
function conversation(k: number): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < k; i++) {
    out.push({ role: "user", content: `u${i}` }, { role: "assistant", content: `a${i}` });
  }
  out.push({ role: "user", content: `u${k}` });
  return out;
}

describe("trimChatHistory", () => {
  it("returns short conversations unchanged", () => {
    for (const k of [0, 1, 5, 9]) {
      const msgs = conversation(k);
      expect(trimChatHistory(msgs, 20)).toEqual(msgs);
    }
  });

  it("opens on a user turn at every length past the window (the 11th exchange bug)", () => {
    for (const k of [10, 11, 12, 19, 24, 40]) {
      const trimmed = trimChatHistory(conversation(k), 20);
      expect(trimmed[0]!.role).toBe("user");
      expect(trimmed[trimmed.length - 1]!.role).toBe("user");
      expect(trimmed.length).toBeLessThanOrEqual(20);
      // Still strictly alternating.
      for (let i = 1; i < trimmed.length; i++) {
        expect(trimmed[i]!.role).not.toBe(trimmed[i - 1]!.role);
      }
    }
  });

  it("keeps the most recent turns, dropping only the leading assistant turn", () => {
    const msgs = conversation(10); // 21 turns
    const trimmed = trimChatHistory(msgs, 20);
    expect(trimmed).toHaveLength(19);
    expect(trimmed[0]!.content).toBe("u1");
    expect(trimmed[trimmed.length - 1]!.content).toBe("u10");
  });
});
