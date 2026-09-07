import Link from "next/link";
import { CalendarHeart } from "lucide-react";

import type { FamilyLedger } from "@/lib/engagement/ledger";
import { genderPick } from "@/lib/copy/gender";

const AR_NUM = new Intl.NumberFormat("ar-SA", { useGrouping: false });
const DATE_FMT = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
  month: "long",
  year: "numeric",
});

/**
 * Renewal-week recap — celebratory bookkeeping, never a countdown. Shown for
 * active paid subs within 7 days of current_period_end (the moment the mental
 * accounting happens anyway): the ledger does the persuading, and monthly
 * subscribers get the annual switch (20% off is already sanctioned pricing).
 * No red, no urgency, factual numbers only.
 */
export function RenewalRecapCard({
  ledger,
  cadence,
  ownerSex,
}: {
  ledger: FamilyLedger;
  cadence: string | null;
  ownerSex?: string | null;
}) {
  const g = genderPick(ownerSex);
  if (ledger.planWeeks === 0) return null;

  const sinceLabel = ledger.since
    ? DATE_FMT.format(new Date(`${ledger.since}T00:00:00Z`))
    : null;

  return (
    <div className="rounded-2xl border-2 border-brand-lavender/60 bg-brand-lavender/15 px-4 py-3 mb-4 flex flex-wrap items-center gap-3">
      <CalendarHeart
        className="size-5 text-brand-purple-900 flex-shrink-0"
        aria-hidden="true"
      />
      <p className="flex-1 min-w-40 text-sm font-medium text-brand-ink leading-relaxed">
        {sinceLabel ? `منذ ${sinceLabel}: ` : ""}
        {AR_NUM.format(ledger.planWeeks)}{" "}
        {ledger.planWeeks === 1 ? "خطة أسبوعية" : "خطة أسبوعية"} لبيتٍ من{" "}
        {AR_NUM.format(ledger.membersServed)}{" "}
        {ledger.membersServed === 1 ? "شخص" : "أفراد"} — وتجديدك يقترب.
      </p>
      {cadence === "monthly" ? (
        <Link
          href="/subscription#change-plan"
          className="flex-shrink-0 inline-flex items-center justify-center min-h-11 px-5 rounded-full bg-brand-purple-900 text-white hover:bg-brand-purple-700 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
        >
          {g("بدّلي للسنوي — وفّري ٢٠٪", "بدّل للسنوي — وفّر ٢٠٪")}
        </Link>
      ) : (
        <Link
          href="/subscription"
          className="flex-shrink-0 inline-flex items-center justify-center min-h-11 px-5 rounded-full border border-brand-purple-900/20 text-brand-purple-900 hover:bg-brand-lavender/30 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
        >
          إدارة الاشتراك
        </Link>
      )}
    </div>
  );
}
