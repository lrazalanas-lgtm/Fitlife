"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { genderPick } from "@/lib/copy/gender";
import {
  SERVER_VERDICT_MARGIN_MS,
  WORKER_ACK_LIMIT_MS,
  generationHasStalled,
} from "@/lib/plans/generationTiming";
import { classifyStatusPoll } from "@/lib/plans/statusPoll";

const POLL_INTERVAL_MS = 3000;
// Generation runs one concurrent Anthropic call per family member; the slowest
// member can take ~2-3 min. After this we soften the copy (but keep waiting) so
// a normal run never looks broken.
const LONG_RUNNING_MS = 90_000;
// The genuine-stuck threshold is no longer a wall clock — see
// lib/plans/generationTiming.ts. We now give up only once the plan ROW has gone
// silent, which is the same signal the server reclassifies on, so a run that is
// still writing is never called stuck no matter how long it legitimately takes.

// Rotating reassurance copy (this phase has no real per-day signal yet, so these
// are presentational — they cycle to convey active work during a short wait).
const GENERATING_STEPS = [
  "نحسب احتياجك من السعرات",
  "نختار وصفات تناسب ذوق عائلتك",
  "نوازن البروتين والنشويات والدهون",
  "نرتّب وجباتك على أيام الأسبوع السبعة",
];

export function PlanGeneratingState({
  planId,
  name,
  ownerSex,
}: {
  planId: string;
  name?: string | null;
  ownerSex?: string | null;
}) {
  const g = genderPick(ownerSex);
  const [timedOut, setTimedOut] = useState(false);
  // The run this tab started failed empty and the server is serving the
  // previous plan instead (string = its error detail, "" = none).
  const [maskedFailure, setMaskedFailure] = useState<string | null>(null);
  const [isLong, setIsLong] = useState(false);
  const [progress, setProgress] = useState(6);
  const [stepIndex, setStepIndex] = useState(0);
  // Client-clock instant of the last SERVER write, rebuilt from the route's
  // server-measured `age_ms` on every poll. Starts at "just now" — the patient
  // default — and the first poll (fired immediately below) corrects it, so a
  // reload can no longer hand a long-dead run a fresh window.
  const lastWriteAtRef = useRef(0);
  // Whether ANY poll has ever come back 2xx. If none has, the silence we are
  // measuring is our own — an expired session (401) or a missing row (404) —
  // not the worker's, and saying «العملية تاخذ وقت أطول من المتوقع» would blame
  // the wrong thing.
  const sawAnyPollRef = useRef(false);
  const [pollBroken, setPollBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const mountedAt = Date.now();
    lastWriteAtRef.current = mountedAt;

    // Time-based progress estimate (no real signal from the bg function): ease
    // toward ~95% over the expected window, then snap to 100% on completion.
    // Deliberately anchored to THIS mount rather than to the run's true age: the
    // bar is presentational, and restarting it on a refresh is honest about the
    // fact that we have no per-day signal to report. Only the stall clock below
    // needs the server's real age, and it gets it from `age_ms`.
    const progressTimer = setInterval(() => {
      if (cancelled) return;
      const elapsed = Date.now() - mountedAt;
      const pct = Math.max(
        6,
        Math.min(95, Math.round(100 * (1 - Math.exp(-elapsed / 45000)))),
      );
      setProgress(pct);
      // Advance the reassurance copy every ~4s off the same timer (no extra
      // interval to clean up).
      setStepIndex(Math.floor(elapsed / 4000) % GENERATING_STEPS.length);
      if (elapsed >= LONG_RUNNING_MS) setIsLong(true);
    }, 1000);

    const checkStatus = async () => {
      if (cancelled) return;

      try {
        const res = await fetch("/api/plans/status", { cache: "no-store" });
        if (res.ok) {
          sawAnyPollRef.current = true;
          const body = (await res.json()) as {
            id: string;
            status: string;
            age_ms?: number;
            masked_failure?: { id: string; error_message: string | null } | null;
          };
          const verdict = classifyStatusPoll(body, planId);
          if (verdict === "masked_failure") {
            // The run THIS tab started failed with nothing to show, and the
            // server is serving the previous plan under its own id. Say so —
            // reading the id mismatch as "superseded" reloaded onto the old
            // week with no word said anywhere.
            stopTimers();
            setMaskedFailure(body.masked_failure?.error_message ?? "");
            return;
          }
          if (verdict === "superseded") {
            // A newer plan superseded the one this tab is watching (add-member
            // sync, a second generation). The status route only ever reports the
            // latest, so this tab can never see its own plan finish — reload and
            // let the server render whatever is actually current.
            stopTimers();
            window.location.reload();
            return;
          }
          if (typeof body.age_ms === "number" && Number.isFinite(body.age_ms)) {
            lastWriteAtRef.current = Date.now() - Math.max(0, body.age_ms);
          }
          if (body.status === "ready" || body.status === "failed") {
            stopTimers();
            setProgress(100);
            // Let the bar visibly complete, then hard-reload (a fresh server
            // render guarantees the plan/failed state shows automatically).
            setTimeout(() => window.location.reload(), 500);
            return;
          }
        }
      } catch {
        // network blip — fall through to the stall check, which is what turns a
        // permanently-broken poll into an answer instead of an endless spinner.
      }

      // A poll that has NEVER succeeded is a different failure with a different
      // remedy, and it resolves much sooner: the server can't be telling us
      // anything, so there is nothing to wait for. Sits just past the server's
      // own ACK verdict so a working session always gets the specific answer
      // first.
      if (
        !sawAnyPollRef.current &&
        Date.now() - mountedAt >= WORKER_ACK_LIMIT_MS + SERVER_VERDICT_MARGIN_MS
      ) {
        stopTimers();
        setPollBroken(true);
        setTimedOut(true);
        return;
      }

      // Stuck means "nothing has written to the row", never "the wall clock ran
      // out". A run still emitting day snapshots keeps this from firing for as
      // long as it legitimately needs.
      if (generationHasStalled(lastWriteAtRef.current, Date.now())) {
        stopTimers();
        setTimedOut(true);
      }
    };

    const poll = setInterval(checkStatus, POLL_INTERVAL_MS);
    // Fire once immediately so a reloaded tab learns the row's true age within
    // network latency rather than after a full interval.
    void checkStatus();

    // Declared after both intervals so neither identifier is referenced before
    // its binding is initialised; every call site runs inside a later tick.
    function stopTimers() {
      clearInterval(poll);
      clearInterval(progressTimer);
    }

    return () => {
      cancelled = true;
      stopTimers();
    };
  }, [planId]);

  if (maskedFailure !== null) {
    return (
      <div className="max-w-md mx-auto bg-white rounded-3xl border border-brand-ink/5 p-8 text-center">
        <h1 className="font-extrabold text-xl text-brand-ink leading-tight">
          لم تكتمل الخطة الجديدة
        </h1>
        <p className="mt-3 text-brand-ink-muted text-sm leading-relaxed">
          {g(
            "آخر محاولة لم تكتمل، وخطتك السابقة ما زالت كما هي. جرّبي مرة أخرى بعد قليل.",
            "آخر محاولة لم تكتمل، وخطتك السابقة ما زالت كما هي. جرّب مرة أخرى بعد قليل.",
          )}
        </p>
        {maskedFailure && (
          <details className="mt-3 text-xs text-brand-ink-muted text-start">
            <summary className="cursor-pointer">تفاصيل تقنية</summary>
            <p dir="ltr" className="mt-1 break-words text-start">
              {maskedFailure}
            </p>
          </details>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex items-center justify-center w-full bg-brand-ink hover:bg-brand-purple-900 text-white font-bold py-3 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
        >
          {g("اعرضي خطتي السابقة", "اعرض خطتي السابقة")}
        </button>
      </div>
    );
  }

  if (timedOut) {
    return (
      <div className="max-w-md mx-auto bg-white rounded-3xl border border-brand-ink/5 p-8 text-center">
        <h1 className="font-extrabold text-xl text-brand-ink leading-tight">
          {pollBroken ? "انقطع الاتصال بالخادم" : "العملية تاخذ وقت أطول من المتوقع"}
        </h1>
        <p className="mt-3 text-brand-ink-muted text-sm leading-relaxed">
          {pollBroken
            ? g(
                "ما قدرنا نتابع حالة الخطة. تأكدي من الاتصال وحدّثي الصفحة — إذا استمرت المشكلة سجّلي الدخول من جديد.",
                "ما قدرنا نتابع حالة الخطة. تأكد من الاتصال وحدّث الصفحة — إذا استمرت المشكلة سجّل الدخول من جديد.",
              )
            : g(
                "حدّثي الصفحة عشان تشيكين إذا الخطة جاهزة، أو حاولي مرة ثانية بعد دقيقة.",
                "حدّث الصفحة عشان تشيك إذا الخطة جاهزة، أو حاول مرة ثانية بعد دقيقة.",
              )}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex items-center justify-center w-full bg-brand-ink hover:bg-brand-purple-900 text-white font-bold py-3 rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
        >
          تحديث
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto bg-white rounded-3xl border border-brand-ink/5 p-8 text-center">
      <div className="inline-flex items-center justify-center size-16 rounded-full bg-brand-purple-900/10 mb-4">
        <Loader2
          className="size-8 text-brand-purple-900 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      </div>
      <h1 className="font-extrabold text-2xl text-brand-ink leading-tight">
        {name ? `نحضّر خطة ${name}...` : "نحضّر خطتك..."}
      </h1>
      <p className="mt-3 text-brand-ink-muted text-sm leading-relaxed">
        {/* Measured on production: a one-member week took 9 minutes wall clock,
            a two-member week 12. The old copy promised «دقيقة إلى دقيقتين»,
            so every real run overran its own estimate by 5x and looked stuck.
            The page keeps working if she leaves — say that instead. */}
        {isLong
          ? g(
              "الخطة تحتاج وقتاً أطول قليلاً. يمكنكِ إغلاق الصفحة، ونكمل التحضير.",
              "الخطة تحتاج وقتاً أطول قليلاً. يمكنك إغلاق الصفحة، ونكمل التحضير.",
            )
          : g(
              "تستغرق عادة من خمس إلى عشر دقائق. يمكنكِ إغلاق الصفحة، ونكمل التحضير.",
              "تستغرق عادة من خمس إلى عشر دقائق. يمكنك إغلاق الصفحة، ونكمل التحضير.",
            )}
      </p>
      <div
        className="mt-6 h-1.5 bg-brand-surface rounded-full overflow-hidden"
        role="progressbar"
        aria-busy="true"
        aria-label="جاري إنشاء الخطة"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-gradient-to-l from-brand-purple-900 via-brand-pink to-brand-yellow transition-[width] duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p
        className="mt-3 text-brand-purple-900 text-xs font-bold leading-relaxed"
        aria-hidden="true"
      >
        {GENERATING_STEPS[stepIndex]}…
      </p>
    </div>
  );
}
