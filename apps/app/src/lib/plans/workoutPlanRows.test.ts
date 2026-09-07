/**
 * A workout regeneration that came back EMPTY replaced the household's whole
 * working program with a bare retry card: getLatestWorkoutPlan read one row
 * with no fallback, while the meal side had had its previous-plan fallback
 * since August. These pin the pure decision rule the reader now applies.
 */
import { describe, it, expect } from "vitest";
import type { WorkoutPlan } from "@fitlife/plan-engine";
import { pickServedWorkoutRow, resolveWorkoutRow, type WorkoutPlanRow } from "./workoutPlanRows";

const NOW = Date.parse("2026-09-07T12:00:00Z");
const STALE_MIN = 15;

const CONTENT: WorkoutPlan = {
  week_start_date: "2026-09-06",
  members: [
    {
      member_id: "mom",
      member_name_ar: "أم محمد",
      split_name_ar: "علوي/سفلي ×2",
      weekly_sessions: [
        {
          day_index: 0,
          session_name_ar: "علوي أ",
          warmup_ar: ["5 دقائق مشي سريع"],
          exercises: [
            {
              name_ar: "ضغط دمبل على مقعد",
              name_en: "Dumbbell Bench Press",
              target_muscles_ar: "الصدر والترايسبس",
              sets: 3,
              reps: "8-12",
              rest_seconds: 120,
              rir: "أبقي 2 في الخزان",
              home_variant_ar: "ضغط أرضي بالدمبل",
            },
          ],
          cooldown_ar: ["إطالة صدر"],
          duration_min: 40,
        },
      ],
      progression_notes_ar: "زيدي التكرارات حتى 12 ثم زيدي الوزن.",
      cardio_notes_ar: "8 آلاف خطوة يومياً.",
    },
  ],
  safety_disclaimer_ar: "البرنامج إرشادي ولا يغني عن مختص.",
};

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const row = (over: Partial<WorkoutPlanRow>): WorkoutPlanRow => ({
  id: "r",
  status: "ready",
  plan_data: CONTENT,
  error_message: null,
  updated_at: minutesAgo(60),
  ...over,
});

describe("pickServedWorkoutRow", () => {
  it("serves the previous program when the newest run failed with nothing", () => {
    const rows = [
      row({ id: "failed", status: "failed", plan_data: {}, error_message: "Anthropic API 400" }),
      row({ id: "good" }),
    ];
    const served = pickServedWorkoutRow(rows, NOW, STALE_MIN)!;
    expect(served.id).toBe("good");
    expect(served.status).toBe("ready");
    expect(served.plan_data?.members[0]?.member_id).toBe("mom");
  });

  it("skips stacked failures to reach the last good program", () => {
    const rows = [
      row({ id: "f2", status: "failed", plan_data: {} }),
      row({ id: "f1", status: "failed", plan_data: {} }),
      row({ id: "good" }),
    ];
    expect(pickServedWorkoutRow(rows, NOW, STALE_MIN)!.id).toBe("good");
  });

  it("keeps a healthy newest program", () => {
    const rows = [row({ id: "new" }), row({ id: "old" })];
    expect(pickServedWorkoutRow(rows, NOW, STALE_MIN)!.id).toBe("new");
  });

  it("keeps a live in-flight run rather than reaching backwards", () => {
    const rows = [
      row({ id: "gen", status: "generating", plan_data: {}, updated_at: minutesAgo(2) }),
      row({ id: "old" }),
    ];
    const served = pickServedWorkoutRow(rows, NOW, STALE_MIN)!;
    expect(served.id).toBe("gen");
    expect(served.status).toBe("generating");
  });

  it("reclassifies a stale in-flight run as failed, then falls back", () => {
    const rows = [
      row({ id: "stuck", status: "generating", plan_data: {}, updated_at: minutesAgo(40) }),
      row({ id: "old" }),
    ];
    expect(pickServedWorkoutRow(rows, NOW, STALE_MIN)!.id).toBe("old");
  });

  it("surfaces the failure when no previous program exists", () => {
    const rows = [row({ id: "failed", status: "failed", plan_data: {}, error_message: "x" })];
    const served = pickServedWorkoutRow(rows, NOW, STALE_MIN)!;
    expect(served.id).toBe("failed");
    expect(served.status).toBe("failed");
    expect(served.error_message).toBe("x");
  });

  it("downgrades a 'ready' row whose plan_data no longer validates", () => {
    const served = resolveWorkoutRow(row({ plan_data: { members: "nope" } }), NOW, STALE_MIN)!;
    expect(served.status).toBe("failed");
    expect(served.plan_data).toBeNull();
  });
});
