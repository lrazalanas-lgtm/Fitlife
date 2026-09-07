import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { UserRound, HeartPulse, ChevronLeft } from "lucide-react";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { Logo } from "@/components/Logo";
import { BackButton } from "@/components/BackButton";
import { mapSaraGoalToUser, type SaraGoal } from "@/lib/plans/goalMapping";
import { genderPick } from "@/lib/copy/gender";
import { HousekeeperForm } from "../../add/HousekeeperForm";
import { MemberEditedBanner } from "./MemberEditedBanner";
import { riyadhCurrentYear } from "@/lib/plans/dayMapping";
import {
  ACTIVITY_OPTIONS,
  CHILD_ACTIVITY,
  GOALS,
  asStringArray,
  labelFor,
} from "./labels";

type FamilyMemberRow = Database["public"]["Tables"]["family_members"]["Row"];

export const metadata = {
  title: "تعديل فرد — فت لايف",
  robots: { index: false, follow: false },
};

function SectionCard({
  href,
  title,
  summary,
  icon: Icon,
}: {
  href: string;
  title: string;
  summary: string;
  icon: typeof UserRound;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-4 bg-white rounded-2xl border border-brand-ink/5 p-5 md:p-6 group hover:border-brand-purple-900/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
    >
      <div className="size-11 rounded-full bg-brand-lavender/30 flex items-center justify-center flex-shrink-0">
        <Icon className="size-5 text-brand-purple-900" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="font-bold text-brand-ink text-base">{title}</h2>
        <p className="text-brand-ink-muted text-sm mt-0.5 truncate">{summary}</p>
      </div>
      <span className="inline-flex items-center gap-1 text-brand-purple-900 text-sm font-bold flex-shrink-0 group-hover:text-brand-purple-700 transition-colors">
        تعديل
        <ChevronLeft className="size-4" aria-hidden="true" />
      </span>
    </Link>
  );
}

export default async function EditMemberPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const [{ memberId }, user, supabase] = await Promise.all([
    params,
    getAuthUser(),
    createClient(),
  ]);
  if (!user) redirect("/auth/login");

  // Member row + owner profile are independent — one parallel round-trip.
  const [{ data: row }, { data: ownerProfile }] = await Promise.all([
    supabase
      .from("family_members")
      .select("*")
      .eq("id", memberId)
      .eq("user_id", user.id)
      .single(),
    supabase.from("profiles").select("sex").eq("id", user.id).single(),
  ]);
  const m = row as FamilyMemberRow | null;

  if (!m) redirect("/family");

  // The hub addresses the account OWNER ("عدّلي/عدّل بيانات …"), so its copy
  // follows the owner's sex — not the member's.
  const g = genderPick((ownerProfile as { sex?: string | null } | null)?.sex);

  // The maid isn't a plan beneficiary — she has only a name + reading language, so
  // she's edited via the HousekeeperForm (prefilled), not the member sections.
  if (m.role === "housekeeper") {
    return (
      <HousekeeperForm
        editing
        initial={{
          name: m.name,
          preferred_language: m.preferred_language,
          sex: m.sex,
        }}
      />
    );
  }

  const type = (m.member_type ?? "adult") as
    | "adult"
    | "child"
    | "pregnant"
    | "lactating";

  // ── Card summaries (mirror the mom profile hub) ──────────────────────────
  const age = m.birth_year ? riyadhCurrentYear() - m.birth_year : null;
  const personalSummary =
    [
      age ? `${age} سنة` : null,
      m.height_cm ? `${m.height_cm} سم` : null,
      m.weight_kg ? `${m.weight_kg} كجم` : null,
    ]
      .filter(Boolean)
      .join("، ") || g("أكملي المعلومات", "أكمل المعلومات");

  const goalLabel =
    type === "pregnant"
      ? "حامل"
      : type === "lactating"
        ? "مرضعة"
        : type === "child"
          ? "طفل"
          : m.primary_goal
            ? labelFor(GOALS, mapSaraGoalToUser(m.primary_goal as SaraGoal))
            : null;
  const activityLabel = labelFor(
    type === "child" ? CHILD_ACTIVITY : ACTIVITY_OPTIONS,
    m.activity_level,
  );
  const allergyCount = asStringArray(m.allergies).length;
  const conditionCount = (m.medical_conditions ?? []).length;
  const healthSummary =
    [
      goalLabel,
      activityLabel,
      conditionCount > 0 ? `${conditionCount} حالة صحية` : null,
      allergyCount > 0 ? `${allergyCount} حساسية` : null,
    ]
      .filter(Boolean)
      .join("، ") || g("أضيفي التفاصيل الصحية", "أضِف التفاصيل الصحية");

  return (
    <main className="min-h-screen bg-brand-surface">
      <header className="bg-white border-b border-brand-ink/5 sticky top-0 z-10">
        <div className="container-app py-4 flex items-center justify-between">
          <a
            href="/dashboard"
            aria-label="فت لايف — الرئيسية"
            className="inline-flex items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <Logo className="h-9 w-auto" />
          </a>
          <BackButton href="/family" />
        </div>
      </header>

      <div className="container-app py-8 md:py-12 max-w-2xl space-y-6">
        <header>
          <h1 className="font-extrabold text-3xl text-brand-ink leading-tight">
            تعديل بيانات {m.name}
          </h1>
          <p className="mt-2 text-brand-ink-muted text-base leading-relaxed">
            {g(
              "اختاري القسم اللي تبين تعدّلينه.",
              "اختر القسم اللي تبي تعدّله.",
            )}
          </p>
        </header>

        <Suspense fallback={null}>
          <MemberEditedBanner memberId={memberId} ownerSex={(ownerProfile as { sex?: string | null } | null)?.sex} />
        </Suspense>

        <div className="space-y-3">
          <SectionCard
            href={`/family/edit/${memberId}/personal`}
            title="المعلومات الشخصية"
            summary={personalSummary}
            icon={UserRound}
          />
          <SectionCard
            href={`/family/edit/${memberId}/health`}
            title="الصحة والأهداف"
            summary={healthSummary}
            icon={HeartPulse}
          />
        </div>

        <div className="rounded-2xl bg-white/60 border border-brand-ink/5 px-4 py-3">
          <p className="text-brand-ink-muted text-sm leading-relaxed">
            أي تعديل لن يطبق على الخطة حتى تنشئي{" "}
            <Link
              href="/plan"
              className="text-brand-purple-900 font-bold underline underline-offset-4 hover:text-brand-purple-700 transition-colors"
            >
              خطة جديدة من صفحة الخطة
            </Link>
            .
          </p>
        </div>
      </div>
    </main>
  );
}
