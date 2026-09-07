"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { updateMemberPersonal } from "../actions";
import { genderPick } from "@/lib/copy/gender";

const currentYear = new Date().getFullYear();

const FIELD =
  "w-full px-4 py-3 rounded-xl border border-brand-ink/10 bg-white text-brand-ink placeholder:text-brand-ink-muted/40 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:border-transparent transition-colors";

export type MemberPersonalInitial = {
  name: string;
  birth_year: number | null;
  sex: "male" | "female" | null;
  height_cm: number | null;
  weight_kg: number | null;
};

export function MemberPersonalEditForm({
  memberId,
  showSex,
  initial,
  ownerSex,
}: {
  memberId: string;
  showSex: boolean;
  initial: MemberPersonalInitial;
  // Account owner's sex → the form addresses the owner ("عدّلي/عدّل").
  ownerSex?: string | null;
}) {
  const router = useRouter();
  const g = genderPick(ownerSex);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(initial.name ?? "");
  const [birthYear, setBirthYear] = useState(
    initial.birth_year != null ? String(initial.birth_year) : "",
  );
  const [sex, setSex] = useState<"male" | "female" | null>(initial.sex);
  const [heightCm, setHeightCm] = useState(
    initial.height_cm != null ? String(initial.height_cm) : "",
  );
  const [weightKg, setWeightKg] = useState(
    initial.weight_kg != null ? String(initial.weight_kg) : "",
  );

  const submit = () => {
    setError(null);
    const trimmedName = name.trim();
    if (trimmedName.length < 2) return setError("الاسم لازم يكون حرفين أو أكثر");

    const year = Number(birthYear);
    if (!birthYear || Number.isNaN(year)) return setError(g("اكتبي سنة الميلاد", "اكتب سنة الميلاد"));
    if (year < 1940 || year > currentYear)
      return setError(`سنة الميلاد لازم تكون بين 1940 و${currentYear}`);

    const height = heightCm ? Number(heightCm) : null;
    if (height != null && (Number.isNaN(height) || height < 40 || height > 250))
      return setError("الطول لازم يكون بين 40 و250 سم");

    const weight = weightKg ? Number(weightKg) : null;
    if (weight != null && (Number.isNaN(weight) || weight < 5 || weight > 300))
      return setError("الوزن لازم يكون بين 5 و300 كجم");

    startTransition(async () => {
      const result = await updateMemberPersonal(memberId, {
        name: trimmedName,
        birth_year: year,
        sex: showSex ? sex : initial.sex,
        height_cm: height,
        weight_kg: weight,
      });
      if (!result.ok) return setError(result.error);
      // `edited=personal`, not `saved=1`: the banner's regenerate nudge keys
      // off it (the health form already sends `edited=health`). Weight, height,
      // birth year and sex all change the targets the plan was built on.
      router.push(`/family/edit/${memberId}?edited=personal`);
    });
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-extrabold text-3xl text-brand-ink leading-tight">
          المعلومات الشخصية
        </h1>
        <p className="mt-2 text-brand-ink-muted text-base leading-relaxed">
          {g("عدّلي الاسم والبيانات الأساسية.", "عدّل الاسم والبيانات الأساسية.")}
        </p>
      </header>

      <div>
        <label htmlFor="m-name" className="block text-sm font-bold text-brand-ink mb-2">
          الاسم
        </label>
        <input
          id="m-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isPending}
          spellCheck={false}
          className={FIELD}
          placeholder="مثلاً: خالد"
        />
      </div>

      <div>
        <label htmlFor="m-by" className="block text-sm font-bold text-brand-ink mb-2">
          سنة الميلاد
        </label>
        <input
          id="m-by"
          type="number"
          inputMode="numeric"
          dir="ltr"
          value={birthYear}
          onChange={(e) => setBirthYear(e.target.value)}
          disabled={isPending}
          className={FIELD}
          placeholder="1988"
        />
      </div>

      {showSex && (
        <fieldset>
          <legend className="block text-sm font-bold text-brand-ink mb-2">الجنس</legend>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "female", label: "أنثى" },
              { value: "male", label: "ذكر" },
            ].map((o) => {
              const active = sex === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setSex(o.value as "male" | "female")}
                  aria-pressed={active}
                  className={`min-h-11 rounded-2xl border-2 px-4 py-3 text-sm font-bold text-brand-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 ${
                    active
                      ? "border-brand-purple-900 bg-brand-purple-900/5"
                      : "border-brand-ink/10 bg-white hover:border-brand-ink/20"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="m-h" className="block text-sm font-bold text-brand-ink mb-2">
            الطول
          </label>
          <div className="relative" dir="ltr">
            <input
              id="m-h"
              type="number"
              inputMode="numeric"
              dir="ltr"
              value={heightCm}
              onChange={(e) => setHeightCm(e.target.value)}
              disabled={isPending}
              className={`${FIELD} pe-12`}
              placeholder="165"
            />
            <span
              className="absolute inset-y-0 end-3 flex items-center text-brand-ink-muted text-sm pointer-events-none"
              aria-hidden="true"
            >
              سم
            </span>
          </div>
        </div>

        <div>
          <label htmlFor="m-w" className="block text-sm font-bold text-brand-ink mb-2">
            الوزن
          </label>
          <div className="relative" dir="ltr">
            <input
              id="m-w"
              type="number"
              inputMode="decimal"
              dir="ltr"
              step="0.1"
              value={weightKg}
              onChange={(e) => setWeightKg(e.target.value)}
              disabled={isPending}
              className={`${FIELD} pe-12`}
              placeholder="65"
            />
            <span
              className="absolute inset-y-0 end-3 flex items-center text-brand-ink-muted text-sm pointer-events-none"
              aria-hidden="true"
            >
              كجم
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-xl p-3">
          <p className="text-red-700 text-sm leading-relaxed">{error}</p>
        </div>
      )}

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
        <button
          type="button"
          onClick={() => router.push(`/family/edit/${memberId}`)}
          disabled={isPending}
          className="inline-flex items-center justify-center min-h-11 px-5 py-2.5 rounded-full border border-brand-ink/10 text-brand-ink hover:bg-white text-sm font-bold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={isPending}
          className="inline-flex items-center justify-center gap-2 min-h-11 px-6 py-2.5 rounded-full bg-brand-ink hover:bg-brand-purple-900 disabled:bg-brand-ink/40 text-white text-sm font-bold transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
        >
          {isPending && (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
          حفظ
        </button>
      </div>
    </div>
  );
}
