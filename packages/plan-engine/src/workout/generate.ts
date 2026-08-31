import type { SupabaseClient } from "@supabase/supabase-js";
import { streamAnthropic, stripMarkdownFence, computeCostUsd } from "../anthropic";

// Workout calls keep the PRE-08/31 timeout curve on purpose. bigCallTimeoutMs
// is now DERIVED from the MEAL day cap at the meal-measured 65 tok/s, which
// silently cut the solo workout expansion's ceiling 240s → ~205s — a rebalance
// nobody measured on workout emissions (caught by the 08/31 code review). The
// meal-side derivation exists to keep the meal cap/ceiling pair consistent;
// workouts have their own cap (dayMaxTokens floor) and their own emission
// profile, so they keep their own explicit bound.
const workoutCallTimeoutMs = (trainees: number): number =>
  Math.min(600_000, 240_000 + 40_000 * Math.max(0, trainees - 2));
import {
  SKELETON_MODEL,
  DAY_MODEL,
  planModelLabel,
  skeletonMaxTokens,
  dayMaxTokens,
} from "../constants";
import { GenerationInFlightError, PlanValidationError } from "../errors";
import { isRetryable, retryWaitMs, MAX_RETRIES } from "../generate";
import { AnthropicCallError } from "../errors";
import type { PlanPromptContext } from "../buildContext";
import {
  WorkoutPlanSchema,
  WorkoutSkeletonSchema,
  MemberWorkoutSchema,
  normalizeWorkoutSkeleton,
  normalizeMemberSessions,
  normalizeExerciseIds,
  type WorkoutPlan,
  type MemberWorkout,
  type WorkoutSkeleton,
} from "./schema";
import {
  WORKOUT_STATIC,
  buildWorkoutSkeletonPrompt,
  buildWorkoutMemberPrompt,
  workoutTrainees,
  type WorkoutTrainee,
} from "./systemPrompt";
import { enforceWorkoutProfileFit, type ProfileFitFlags } from "./equipment";
import { canFit, remainingMs, dayLoopDeadline } from "../budget";

type AnyClient = SupabaseClient<any, any, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What one member's weekly expansion is assumed to cost when deciding whether
 * to start it. A member call is a single week (≤6 sessions) against DAY_MODEL —
 * far smaller than a meal day, hence well under DAY_CALL_ESTIMATE_MS. Measured
 * runs land at ~30-60 s; this leaves headroom without deferring a member that
 * would comfortably have finished.
 */
const WORKOUT_MEMBER_CALL_ESTIMATE_MS = 90_000;

/**
 * Placeholder rows for a workout generation (mirrors createPlanRows):
 * workout_plans 'generating' shell + a plan_generations 'started' lock row
 * with plan_kind='workout'. The composite unique index from 00014 makes the
 * lock authoritative per (user, kind) — a 23505 means another workout run is
 * live: archive our placeholder and surface the busy signal.
 */
export async function createWorkoutPlanRows(
  supabase: AnyClient,
  userId: string,
): Promise<string> {
  const workoutPlanId = crypto.randomUUID();

  const { error: insertPlanError } = await supabase.from("workout_plans").insert({
    id: workoutPlanId,
    user_id: userId,
    status: "generating",
    plan_data: {},
    ai_model: planModelLabel(),
  });
  if (insertPlanError) {
    throw new Error(`Failed to create workout_plan row: ${insertPlanError.message}`);
  }

  const { error: insertGenError } = await supabase.from("plan_generations").insert({
    user_id: userId,
    plan_kind: "workout",
    workout_plan_id: workoutPlanId,
    model: planModelLabel(),
    status: "started",
    started_at: new Date().toISOString(),
  });
  if (insertGenError) {
    if ((insertGenError as { code?: string }).code === "23505") {
      const { error: archiveError } = await supabase
        .from("workout_plans")
        .update({
          status: "archived",
          error_message: "superseded: another workout generation was already in flight",
        })
        .eq("id", workoutPlanId);
      if (archiveError) {
        console.error(
          "[createWorkoutPlanRows] failed to archive raced placeholder",
          archiveError.message,
        );
      }
      throw new GenerationInFlightError();
    }
    await supabase
      .from("workout_plans")
      .update({ status: "failed", error_message: "audit row insert failed" })
      .eq("id", workoutPlanId);
    throw new Error(`Failed to create plan_generations row: ${insertGenError.message}`);
  }

  return workoutPlanId;
}

export interface WorkoutGenerateResult {
  plan: WorkoutPlan;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number };
  missingMembers: string[];
}

// Mirrors the app's STALE_GENERATION_MIN: a 'started' row older than this is a
// hard-killed worker, not live work — it must not block anything.
const MEAL_GEN_STALE_MIN = 15;

/**
 * Meals-first sequencing predicate: should a workout run hold off because a
 * meal generation is live for this user? True iff any row is 'started' and
 * younger than the stale threshold. Pure — the background function polls with
 * it (10 s cadence, capped) so meals always get the full API budget first.
 */
export function mealGenBlocksWorkout(
  rows: Array<{ status?: string | null; started_at?: string | null }>,
  nowMs: number,
): boolean {
  return rows.some((row) => {
    if (row.status !== "started") return false;
    const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
    // Unparseable started_at → treat as stale rather than blocking forever.
    if (Number.isNaN(startedMs)) return false;
    return nowMs - startedMs < MEAL_GEN_STALE_MIN * 60_000;
  });
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(stripMarkdownFence(raw)) as T;
  } catch (err) {
    throw new PlanValidationError(`${label}: invalid JSON — ${String(err)}`, raw);
  }
}

/** Safety posture for deterministic repairs (mirrors describeTrainee's read
 * of the same fields): pregnant → substitutions stay pregnancy-safe;
 * pregnant/early-postpartum → the gym-gear floor is waived. */
function fitFlagsFor(trainee: WorkoutTrainee): ProfileFitFlags {
  const p = trainee.person;
  const pregnant =
    ("is_pregnant" in p && !!p.is_pregnant) || p.member_type === "pregnant";
  return {
    pregnant,
    recentPostpartum: p.months_postpartum != null && p.months_postpartum <= 3,
    // The injuries the trainee declared in onboarding. They already reach the
    // model as a mandatory exclusion clause; passing them here stops the
    // DETERMINISTIC repair — which ships on the final attempt instead of a
    // re-roll — from installing the very movement they rule out.
    injuries: trainee.profile.injuries,
  };
}

/**
 * Two-phase workout generation: one skeleton call (split + named sessions for
 * every opted-in trainee — SKELETON_MODEL because split selection and the
 * pregnancy/injury exclusions are the safety surface), then ONE expansion call
 * per member (a full week ≤6 sessions fits comfortably in a day-slice budget —
 * DAY_MODEL). Sequential; each call is far smaller than a meal day.
 */
export async function generateWorkoutPlan(params: {
  anthropicApiKey: string;
  context: PlanPromptContext;
  weekStartDate: string;
  onMemberDone?: (member: MemberWorkout, done: number, total: number) => Promise<void>;
  /**
   * Running token/cost totals, reported after every accrual.
   *
   * A run that throws still spent whatever it spent — the skeleton call alone is
   * a real charge — but the totals live in this closure, so the caller's catch
   * had nothing to write and every failed workout run was recorded at $0. The
   * meal path was fixed for exactly this; see the `cost_usd NULL and the admin
   * cost view counted it as $0` note in ../generate.ts.
   */
  onUsage?: (usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }) => void;
  /**
   * Wall-clock bound for the whole run, as a Date.now() timestamp. A member
   * expansion is not started when it cannot fit; the members already generated
   * are returned and the rest are reported as missing, exactly as a failed
   * member is. Omitted → unbounded, the pre-deadline behaviour.
   */
  deadlineMs?: number;
}): Promise<WorkoutGenerateResult> {
  const { anthropicApiKey, context, weekStartDate, onMemberDone, onUsage, deadlineMs } =
    params;
  const trainees = workoutTrainees(context);
  if (trainees.length === 0) {
    throw new PlanValidationError("no opted-in workout trainees in context");
  }

  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  const reportUsage = () =>
    onUsage?.({
      input_tokens: totalIn,
      output_tokens: totalOut,
      cost_usd: totalCost,
    });

  // ── Phase 1: skeleton ──
  // Parse + validate INSIDE the retry loop: a malformed/invalid response is
  // re-rolled like any transient failure (a fresh sample usually fixes shape
  // issues), and a shape code can repair — an over-emitted week — is
  // normalized rather than failed.
  const skeletonPrompt = buildWorkoutSkeletonPrompt(context);
  const desiredDaysById = Object.fromEntries(
    trainees.map((t) => [t.member_id, t.profile.desired_days]),
  );
  const preferredDaysById = Object.fromEntries(
    trainees.map((t) => [t.member_id, t.profile.preferred_days ?? undefined]),
  );
  let skeleton: WorkoutSkeleton | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await streamAnthropic({
        apiKey: anthropicApiKey,
        model: SKELETON_MODEL,
        maxTokens: skeletonMaxTokens(trainees.length),
        systemStatic: WORKOUT_STATIC,
        systemPrompt: skeletonPrompt,
        timeoutMs: workoutCallTimeoutMs(trainees.length),
      });
      totalIn += res.tokensIn;
      totalOut += res.tokensOut;
      totalCost += computeCostUsd(
        res.tokensIn,
        res.tokensOut,
        SKELETON_MODEL,
        res.cacheCreationTokens,
        res.cacheReadTokens,
      );
      reportUsage();

      const parsed = WorkoutSkeletonSchema.safeParse(
        parseJson(res.text, "workout skeleton"),
      );
      if (!parsed.success) {
        throw new PlanValidationError(
          `workout skeleton failed validation: ${parsed.error.message}`,
          res.text,
        );
      }
      skeleton = normalizeWorkoutSkeleton(parsed.data, desiredDaysById, preferredDaysById);
      break;
    } catch (err) {
      const retryable = isRetryable(err) || err instanceof PlanValidationError;
      if (attempt >= MAX_RETRIES || !retryable) throw err;
      const ra = err instanceof AnthropicCallError ? err.retryAfterMs : undefined;
      await sleep(retryWaitMs(attempt, ra));
    }
  }
  if (!skeleton) throw new PlanValidationError("workout skeleton unavailable");

  // ── Phase 2: per-member weekly expansion ──
  const members: MemberWorkout[] = [];
  const missingMembers: string[] = [];
  let done = 0;

  for (const trainee of trainees) {
    // Budget gate. Without one, a run could be hard-killed at the platform wall
    // mid-member, leaving workout_plans 'generating' and the plan_generations
    // lock 'started' until the 15-minute reclassifier swept them. Stopping
    // early instead returns the members already built and reports the rest as
    // missing — the same shape a per-member failure produces, which the caller
    // already renders as a partial plan.
    if (!canFit(deadlineMs, WORKOUT_MEMBER_CALL_ESTIMATE_MS)) {
      console.warn("[workout-generate] out of budget — deferring remaining members", {
        member: trainee.member_id,
        remainingSec: Math.round(remainingMs(deadlineMs) / 1000),
      });
      missingMembers.push(trainee.member_id);
      continue;
    }
    let member: MemberWorkout | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await streamAnthropic({
          apiKey: anthropicApiKey,
          model: DAY_MODEL,
          maxTokens: dayMaxTokens(1),
          systemStatic: WORKOUT_STATIC,
          systemPrompt: buildWorkoutMemberPrompt(context, skeleton, trainee.member_id),
          timeoutMs: workoutCallTimeoutMs(1),
        });
        totalIn += res.tokensIn;
        totalOut += res.tokensOut;
        totalCost += computeCostUsd(
          res.tokensIn,
          res.tokensOut,
          DAY_MODEL,
          res.cacheCreationTokens,
          res.cacheReadTokens,
        );
        reportUsage();

        const parsed = MemberWorkoutSchema.safeParse(
          parseJson(res.text, `workout member ${trainee.member_id}`),
        );
        if (!parsed.success) {
          throw new PlanValidationError(
            `member workout failed validation: ${parsed.error.message}`,
            res.text,
          );
        }
        const withIds = normalizeExerciseIds({
          ...parsed.data,
          member_id: trainee.member_id,
          weekly_sessions: normalizeMemberSessions(
            parsed.data.weekly_sessions,
            trainee.profile.desired_days,
            trainee.profile.preferred_days ?? undefined,
          ),
        });
        if (withIds.unknownIds.length > 0) {
          // Log-only (mirrors the cookbook deviation guard): an off-catalog
          // id loses its animation, never the run.
          console.warn("[workout-generate] off-catalog exercise_id(s) nulled", {
            member: trainee.member_id,
            ids: withIds.unknownIds,
          });
        }

        // Location/equipment contract: exercises the trainee cannot do where
        // they train (or a gym program that reads like a home plan) re-roll
        // the call; the final attempt ships the deterministic repair instead
        // of dropping the member.
        const fit = enforceWorkoutProfileFit(
          withIds.member,
          trainee.profile,
          fitFlagsFor(trainee),
        );
        if (fit.violations.length > 0 && attempt < MAX_RETRIES) {
          throw new PlanValidationError(
            `member workout violates location/equipment fit: ${fit.violations.join(", ")}`,
            res.text,
          );
        }
        if (fit.violations.length > 0) {
          console.warn("[workout-generate] location/equipment repair applied", {
            member: trainee.member_id,
            location: trainee.profile.location,
            violations: fit.violations,
            replacements: fit.replacements,
            gymShareOk: fit.gymShareOk,
          });
        }
        member = fit.member;
        break;
      } catch (err) {
        const retryable = isRetryable(err) || err instanceof PlanValidationError;
        if (attempt >= MAX_RETRIES || !retryable) {
          console.warn(
            "[workout-generate] member failed (omitting)",
            trainee.member_id,
            err instanceof Error ? err.message : String(err),
          );
          break;
        }
        const ra = err instanceof AnthropicCallError ? err.retryAfterMs : undefined;
        await sleep(retryWaitMs(attempt, ra));
      }
    }
    done += 1;
    if (member) {
      members.push(member);
      if (onMemberDone) await onMemberDone(member, done, trainees.length);
    } else {
      missingMembers.push(trainee.member_id);
    }
  }

  if (members.length === 0) {
    throw new PlanValidationError("workout generation produced no valid members");
  }

  const plan: WorkoutPlan = {
    week_start_date: weekStartDate,
    members,
    safety_disclaimer_ar: skeleton.safety_disclaimer_ar,
  };
  const finalParsed = WorkoutPlanSchema.safeParse(plan);
  if (!finalParsed.success) {
    throw new PlanValidationError(
      `assembled workout plan failed validation: ${finalParsed.error.message}`,
    );
  }

  return {
    plan: finalParsed.data,
    usage: { input_tokens: totalIn, output_tokens: totalOut, cost_usd: totalCost },
    missingMembers,
  };
}

/**
 * Full run against Supabase: generate, persist progressively (each finished
 * member updates plan_data with generating:true), terminalize both rows.
 * Mirrors runMealPlanGeneration's status discipline.
 */
export async function runWorkoutPlanGeneration(params: {
  supabase: AnyClient;
  anthropicApiKey: string;
  workoutPlanId: string;
  context: PlanPromptContext;
  weekStartDate: string;
}): Promise<void> {
  const { supabase, anthropicApiKey, workoutPlanId, context, weekStartDate } = params;
  const startMs = Date.now();
  // Spend so far, kept outside the try so the catch can record what a failed
  // run actually cost. Previously the catch wrote status/error only, so every
  // failed workout generation was booked at $0 — and workout generation is the
  // expensive two-phase one, so the admin margin view understated spend by
  // exactly the cost of the most costly failures.
  let accrued = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

  try {
    const doneMembers: MemberWorkout[] = [];
    const result = await generateWorkoutPlan({
      anthropicApiKey,
      context,
      weekStartDate,
      onUsage: (u) => {
        accrued = u;
      },
      // Same wall-clock budget the meal run uses, measured from this
      // invocation's start (no translation phase on the workout side).
      deadlineMs: dayLoopDeadline(startMs, false),
      onMemberDone: async (member) => {
        doneMembers.push(member);
        await supabase
          .from("workout_plans")
          .update({
            plan_data: {
              week_start_date: weekStartDate,
              members: doneMembers,
              generating: true,
            },
          })
          .eq("id", workoutPlanId);
      },
    });

    const durationMs = Date.now() - startMs;
    await supabase
      .from("workout_plans")
      .update({
        status: "ready",
        generated_at: new Date().toISOString(),
        plan_data: result.plan,
        ai_input_tokens: result.usage.input_tokens,
        ai_output_tokens: result.usage.output_tokens,
        ai_generation_seconds: Math.round(durationMs / 10) / 100,
        error_message:
          result.missingMembers.length > 0
            ? `partial: members [${result.missingMembers.join(", ")}] failed`
            : null,
      })
      .eq("id", workoutPlanId);

    await supabase
      .from("plan_generations")
      .update({
        status: "completed",
        tokens_in: result.usage.input_tokens,
        tokens_out: result.usage.output_tokens,
        cost_usd: result.usage.cost_usd,
        ai_input_tokens: result.usage.input_tokens,
        ai_output_tokens: result.usage.output_tokens,
        estimated_cost_usd: result.usage.cost_usd,
        duration_ms: durationMs,
        completed_at: new Date().toISOString(),
      })
      .eq("workout_plan_id", workoutPlanId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[workout-generate] failed", message);
    await supabase
      .from("workout_plans")
      .update({ status: "failed", error_message: message.slice(0, 500) })
      .eq("id", workoutPlanId);
    await supabase
      .from("plan_generations")
      .update({
        status: "failed",
        error_message: message.slice(0, 500),
        // Record what the run actually spent before it failed. The skeleton
        // call alone is a real charge; booking it as $0 hid it from the admin
        // cost and margin views.
        tokens_in: accrued.input_tokens,
        tokens_out: accrued.output_tokens,
        cost_usd: accrued.cost_usd,
        ai_input_tokens: accrued.input_tokens,
        ai_output_tokens: accrued.output_tokens,
        estimated_cost_usd: accrued.cost_usd,
        duration_ms: Date.now() - startMs,
        completed_at: new Date().toISOString(),
      })
      .eq("workout_plan_id", workoutPlanId);
    throw err;
  }
}
