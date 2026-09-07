/**
 * A member removed during a busy generation lock stayed in plan_data — and on
 * /plan — indefinitely: the in-flight run wrote the pre-removal roster back,
 * and no later self-heal considered a complete ghost "short" or "pending".
 */
import { describe, it, expect } from "vitest";
import { dropRemovedMembers } from "./removedMembers";

const plan = {
  week_start_date: "2026-09-01",
  members: [{ member_id: "mom" }, { member_id: "m1" }, { member_id: "m2" }],
};

describe("dropRemovedMembers", () => {
  it("drops a member no longer on the roster and keeps everyone else", () => {
    const out = dropRemovedMembers(plan, new Set(["m1"]));
    expect(out.members.map((m) => m.member_id)).toEqual(["mom", "m1"]);
    expect(out.week_start_date).toBe("2026-09-01");
  });

  it("always keeps the account owner, even with an empty roster", () => {
    const out = dropRemovedMembers(plan, new Set());
    expect(out.members.map((m) => m.member_id)).toEqual(["mom"]);
  });

  it("returns the same object when nothing is dropped", () => {
    expect(dropRemovedMembers(plan, new Set(["m1", "m2"]))).toBe(plan);
  });
});
