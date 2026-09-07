/**
 * A failed manual regenerate used to be invisible: the status route served the
 * previous plan under its own id, and the generating screen read the id
 * mismatch as "superseded" and reloaded onto the old week without a word.
 */
import { describe, it, expect } from "vitest";
import { classifyStatusPoll } from "./statusPoll";

describe("classifyStatusPoll", () => {
  it("keeps watching while the route reports the same plan", () => {
    expect(classifyStatusPoll({ id: "p1", masked_failure: null }, "p1")).toBe("watching");
  });

  it("names a masked failure when the served plan hides the run this tab started", () => {
    expect(
      classifyStatusPoll(
        { id: "old", masked_failure: { id: "p1", error_message: "Anthropic API 400" } },
        "p1",
      ),
    ).toBe("masked_failure");
  });

  it("still treats a genuinely newer plan as supersession", () => {
    expect(classifyStatusPoll({ id: "p2", masked_failure: null }, "p1")).toBe("superseded");
    // A masked failure of SOME OTHER run is not this tab's business either.
    expect(
      classifyStatusPoll(
        { id: "old", masked_failure: { id: "p9", error_message: null } },
        "p1",
      ),
    ).toBe("superseded");
  });
});
