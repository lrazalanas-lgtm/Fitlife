"use client";

import { useState } from "react";
import { Loader2, User, UserPlus, Baby, HeartPulse, ChefHat } from "lucide-react";
import { MemberWizard } from "@/app/family/add/MemberWizard";
import { PregLactSwitch } from "@/app/family/add/PregLactSwitch";
import { HousekeeperForm } from "@/app/family/add/HousekeeperForm";
import { CheckRow, StepperRow } from "@/app/family/add/FamilyComposerControls";
import { genderPick } from "@/lib/copy/gender";
import { capture } from "@/lib/analytics";
import { useRouter } from "next/navigation";

// One step of the guided sequence. Husband and maid are singular; the rest carry a count.
type Task =
  | { kind: "husband" }
  | { kind: "adult"; count: number }
  | { kind: "child"; count: number }
  | { kind: "preg"; count: number }
  | { kind: "maid" };

/**
 * The onboarding family builder. Reached after mom finishes her profile. She first
 * SELECTS who's in the household (no navigation on tap), then a single CTA walks her
 * through each selected member's details in order — husband → adults → children →
 * pregnant/lactating → maid — and only at the very end finalizes onboarding and
 * generates the whole family at once. Each member is saved as it's completed;
 * generation stays deferred until the sequence ends.
 */
export function OnboardingFamilyBuilder({
  sex,
  canAddSpouse = true,
}: {
  sex?: "female" | "male";
  /** False once the household already holds a role="dad" — the spouse row is
   * hidden, mirroring /family's canAddHusband. */
  canAddSpouse?: boolean;
}) {
  const g = genderPick(sex);
  const isMale = sex === "male";
  const [phase, setPhase] = useState<"select" | "fill" | "finalizing">("select");
  const [queue, setQueue] = useState<Task[]>([]);
  const [index, setIndex] = useState(0);
  const router = useRouter();

  // Selection: husband/maid are checkmarks; the rest are 0-default steppers.
  const [husband, setHusband] = useState(false);
  const [maid, setMaid] = useState(false);
  const [adult, setAdult] = useState(0);
  const [child, setChild] = useState(0);
  const [preg, setPreg] = useState(0);

  // A spouse that already exists can never be queued, even if stale state says
  // otherwise (the row is hidden, so it can no longer be toggled off).
  const wantsSpouse = husband && canAddSpouse;

  const totalSelected =
    (wantsSpouse ? 1 : 0) + (maid ? 1 : 0) + adult + child + preg;

  // `source` matters: finalize() is reached four very different ways — the
  // queue running out, an empty selection, the skip link on the picker, and
  // bailing out PART-WAY through the per-member sequence. Conflating them
  // would merge "built a household of five" with "declined to add anyone",
  // and household size is exactly what tier value rests on.
  //
  // `members_selected` is what she CHOSE, not what got saved: on an abandoned
  // sequence only the members before `queue_index` exist. Naming it honestly
  // keeps the two apart.
  const finalize = (
    source: "completed" | "empty_selection" | "skipped" | "abandoned_sequence",
  ) => {
    capture("household_submitted", {
      source,
      members_selected: totalSelected,
      queue_index: index,
      husband: wantsSpouse,
      maid,
      adults: adult,
      children: child,
      pregnant_or_lactating: preg,
    });
    // Route through the family-wide questions: that page checks server-side
    // whether the household has more than one person and either renders the
    // 5 questions or falls straight through to the plan-scope fork — so solo
    // users never see the family screen, and skip paths can't dodge it once
    // members were actually saved.
    setPhase("finalizing");
    router.push("/onboarding/family-wide");
  };

  const start = () => {
    const q: Task[] = [];
    if (wantsSpouse) q.push({ kind: "husband" });
    if (adult > 0) q.push({ kind: "adult", count: adult });
    if (child > 0) q.push({ kind: "child", count: child });
    if (preg > 0) q.push({ kind: "preg", count: preg });
    if (maid) q.push({ kind: "maid" });
    if (q.length === 0) {
      finalize("empty_selection");
      return;
    }
    setQueue(q);
    setIndex(0);
    setPhase("fill");
  };

  const advance = () => {
    if (index + 1 >= queue.length) finalize("completed");
    else setIndex(index + 1);
  };

  if (phase === "finalizing") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-brand-surface px-4 text-center">
        <Loader2
          className="size-8 animate-spin motion-reduce:animate-none text-brand-purple-900"
          aria-hidden="true"
        />
        <p className="text-brand-ink font-bold text-lg">نكمل الإعداد…</p>
        <p className="text-brand-ink-muted text-sm">لحظة من فضلك</p>
      </div>
    );
  }

  if (phase === "fill") {
    const task = queue[index]!;
    const isLastTask = index === queue.length - 1;
    // For MemberWizard tasks, label the very last member "التالي" when more types
    // still follow, so it doesn't read "أنشئي الخطة" mid-sequence.
    const terminalLabel = isLastTask ? g("أنشئي الخطة", "أنشئ الخطة") : "التالي";
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto bg-brand-surface">
        {task.kind === "husband" && (
          <MemberWizard
            key={`husband-${index}`}
            type="adult"
            // A male owner's spouse must not carry role="dad" — the engine
            // labels that role الأب in the family summary.
            role={isMale ? "other_adult" : "dad"}
            ownerSex={sex}
            onboarding
            count={1}
            onComplete={advance}
            onSkip={() => finalize("abandoned_sequence")}
            terminalLabel={terminalLabel}
          />
        )}
        {task.kind === "adult" && (
          <MemberWizard
            key={`adult-${index}`}
            type="adult"
            role="other_adult"
            ownerSex={sex}
            onboarding
            count={task.count}
            onComplete={advance}
            onSkip={() => finalize("abandoned_sequence")}
            terminalLabel={terminalLabel}
          />
        )}
        {task.kind === "child" && (
          <MemberWizard
            key={`child-${index}`}
            type="child"
            role="son"
            ownerSex={sex}
            onboarding
            count={task.count}
            onComplete={advance}
            onSkip={() => finalize("abandoned_sequence")}
            terminalLabel={terminalLabel}
          />
        )}
        {task.kind === "preg" && (
          <PregLactSwitch
            key={`preg-${index}`}
            ownerSex={sex}
            onboarding
            count={task.count}
            onComplete={advance}
            onSkip={() => finalize("abandoned_sequence")}
          />
        )}
        {task.kind === "maid" && (
          <HousekeeperForm
            key={`maid-${index}`}
            onboarding
            onComplete={advance}
            onSkip={() => finalize("abandoned_sequence")}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-brand-ink/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="builder-title"
    >
      <div className="w-full max-w-md bg-white rounded-3xl p-6 space-y-5 max-h-[90vh] overflow-y-auto shadow-xl">
        <header className="space-y-2">
          <h2
            id="builder-title"
            className="font-extrabold text-2xl text-brand-ink leading-tight"
          >
            {g("من معكِ في المنزل؟", "من معكَ في المنزل؟")}
          </h2>
          <p className="text-brand-ink-muted text-sm leading-relaxed">
            {g(
              "أضيفي عيلتك، ولكل واحد خطته — أطباق فردية أو مشتركة، بضغطة وحدة",
              "أضف عائلتك، ولكل واحد خطته — أطباق فردية أو مشتركة، بضغطة واحدة",
            )}
          </p>
        </header>

        <div className="space-y-2">
          {canAddSpouse && (
            <CheckRow
              label={g("زوج", "زوجة")}
              Icon={User}
              checked={husband}
              onToggle={() => setHusband((v) => !v)}
            />
          )}
          <StepperRow label="بالغ ثاني" Icon={UserPlus} value={adult} onChange={setAdult} />
          <StepperRow label="طفل" Icon={Baby} value={child} onChange={setChild} />
          <StepperRow
            label="امرأة حامل/مرضعة"
            Icon={HeartPulse}
            value={preg}
            onChange={setPreg}
          />
          <CheckRow
            label="خدامة تطبخ للعائلة"
            Icon={ChefHat}
            checked={maid}
            onToggle={() => setMaid((v) => !v)}
          />
        </div>

        <div className="space-y-1">
          <button
            type="button"
            onClick={start}
            className="w-full flex items-center justify-center gap-2 min-h-11 bg-brand-ink hover:bg-brand-purple-900 text-white font-bold text-base py-3.5 rounded-xl transition-colors shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            {totalSelected > 0
              ? g("التالي — أكملي بيانات العائلة", "التالي — أكمل بيانات العائلة")
              : g("جاهزة — أنشئي خطتي", "جاهز — أنشئ خطتي")}
          </button>

          {/* Family is optional — let her skip and add them later from /family.
              Always visible so the way out is clear before any selection. */}
          <button
            type="button"
            onClick={() => finalize("skipped")}
            className="w-full min-h-11 text-center text-brand-ink-muted hover:text-brand-ink text-sm font-bold py-2 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900"
          >
            تخطّي الآن — أضيفهم لاحقاً
          </button>
        </div>
      </div>
    </div>
  );
}
