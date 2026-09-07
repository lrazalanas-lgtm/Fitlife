import Link from "next/link";
import { User, Baby, HeartPulse, Milk } from "lucide-react";
import { RemoveMemberButton } from "./RemoveMemberButton";

const TYPE_META: Record<
  string,
  { label: string; Icon: typeof User }
> = {
  adult: { label: "بالغ", Icon: User },
  child: { label: "طفل", Icon: Baby },
  pregnant: { label: "حامل", Icon: HeartPulse },
  lactating: { label: "مرضعة", Icon: Milk },
};

const GOAL_LABELS: Record<string, string> = {
  fat_loss: "نزول الوزن",
  muscle_gain: "زيادة العضل",
  body_recomposition: "إعادة تركيب الجسم",
  athletic_performance: "الأداء الرياضي",
  metabolic_health: "الصحة الأيضية",
  digestive_health: "صحة الجهاز الهضمي",
  pregnancy_lactation: "الحمل والرضاعة",
  posture_recovery: "القوام والتعافي",
  // Promoted to first-class goals in the 07/2026 questionnaire rework; both
  // are reachable from ordinary UI choices and rendered as a blank line here.
  maintain: "ثبات الوزن",
  general_health: "الصحة العامة",
};

export function FamilyMemberCard({
  id,
  name,
  memberType,
  primaryGoal,
  ownerSex,
}: {
  id: string;
  name: string;
  memberType: string;
  primaryGoal: string | null;
  ownerSex?: string | null;
}) {
  const meta = TYPE_META[memberType] ?? TYPE_META.adult!;
  const { Icon } = meta;

  return (
    <div className="flex items-center gap-3 bg-white rounded-2xl p-4 border border-brand-ink/5">
      <div className="size-10 rounded-full bg-brand-lavender/30 flex items-center justify-center flex-shrink-0">
        <Icon className="size-5 text-brand-purple-900" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-brand-ink truncate">{name}</p>
        <p className="text-brand-ink-muted text-xs mt-0.5">
          {meta.label}
          {primaryGoal && GOAL_LABELS[primaryGoal]
            ? ` · ${GOAL_LABELS[primaryGoal]}`
            : ""}
        </p>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <Link
          href={`/family/edit/${id}`}
          className="text-brand-purple-900 hover:text-brand-purple-700 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 rounded-md px-1 min-h-11 inline-flex items-center"
        >
          تعديل
        </Link>
        <RemoveMemberButton memberId={id} name={name} ownerSex={ownerSex} />
      </div>
    </div>
  );
}
