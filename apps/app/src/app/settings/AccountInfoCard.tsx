import { UserRound } from "lucide-react";
import { genderPick } from "@/lib/copy/gender";
import {
  getTrialDaysRemaining,
  type SubscriptionRow,
} from "@/lib/subscription/state";
import { TIER_DISPLAY_NAMES_AR, buildTrialEndsMessage } from "@/lib/subscription/strings";

// Gregorian calendar + Arabic month names + Arabic-Indic digits → "١٥ مايو ٢٠٢٦".
const DATE_FMT = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-arab", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const CADENCE_AR: Record<string, string> = {
  monthly: "شهري",
  annual: "سنوي",
};

function planLine(sub: SubscriptionRow): string {
  const tier = TIER_DISPLAY_NAMES_AR[sub.tier];
  if (sub.status === "trialing") {
    const days = getTrialDaysRemaining(sub);
    return days > 0 ? `تجربة مجانية — ${buildTrialEndsMessage(days)}` : "تجربة مجانية — منتهية";
  }
  const cadence = sub.cadence ? CADENCE_AR[sub.cadence] : null;
  return cadence ? `خطة ${tier} — ${cadence}` : `خطة ${tier}`;
}

function statusBadge(status: SubscriptionRow["status"]): {
  label: string;
  className: string;
} {
  switch (status) {
    case "active":
      return { label: "نشط", className: "bg-brand-emerald/10 text-brand-emerald" };
    case "trialing":
      return { label: "فترة تجريبية", className: "bg-brand-lavender/30 text-brand-purple-900" };
    case "past_due":
      return { label: "تأخر السداد", className: "bg-red-50 text-red-700" };
    case "cancelled":
      return { label: "مُلغى", className: "bg-brand-ink/5 text-brand-ink-muted" };
    default:
      return { label: "منتهي", className: "bg-brand-ink/5 text-brand-ink-muted" };
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3 border-b border-brand-ink/5 last:border-0">
      <span className="text-brand-ink-muted text-sm flex-shrink-0">{label}</span>
      <span className="text-brand-ink font-bold text-sm text-end">{children}</span>
    </div>
  );
}

export function AccountInfoCard({
  email,
  signupDate,
  subscription,
  ownerSex,
}: {
  email: string;
  signupDate: string;
  subscription: SubscriptionRow | null;
  ownerSex?: string | null;
}) {
  const g = genderPick(ownerSex);
  const badge = subscription ? statusBadge(subscription.status) : null;

  return (
    <section className="bg-white rounded-2xl border border-brand-ink/5 p-6 md:p-7">
      <div className="flex items-center gap-3 mb-4">
        <div className="size-10 rounded-full bg-brand-lavender/30 flex items-center justify-center flex-shrink-0">
          <UserRound className="size-5 text-brand-purple-900" aria-hidden="true" />
        </div>
        <h2 className="font-bold text-lg text-brand-ink">معلومات الحساب</h2>
      </div>

      <div>
        <Row label="البريد الإلكتروني">
          <span dir="ltr" className="tabular-nums">
            {email}
          </span>
        </Row>
        <Row label={g("عضوة منذ", "عضو منذ")}>{DATE_FMT.format(new Date(signupDate))}</Row>
        {subscription ? (
          <>
            <Row label="الاشتراك">{planLine(subscription)}</Row>
            <Row label="الحالة">
              {badge && (
                <span
                  className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${badge.className}`}
                >
                  {badge.label}
                </span>
              )}
            </Row>
          </>
        ) : (
          <Row label="الاشتراك">لا يوجد اشتراك نشط</Row>
        )}
      </div>
    </section>
  );
}
