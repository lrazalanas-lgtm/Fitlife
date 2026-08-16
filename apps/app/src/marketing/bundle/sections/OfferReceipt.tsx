import { Logo } from "@/marketing/components/Logo";
import { NumberTicker } from "@/marketing/bundle/ui/number-ticker";
import { CONFIG } from "@/marketing/bundle/config";

// The page's bespoke centerpiece: the offer rendered as the فاتورة the
// customer will actually send on WhatsApp after buying. Pure CSS object —
// warm paper on the night hero, dotted ledger leaders, struck total, the
// gold 888 (ticker), a barcode strip and a wax-seal savings sticker. All
// server-rendered except the ticker.
// These four figures ARE the struck total: they sum to CONFIG.originalValue
// (700 + 300 + 350 + 200 = 1550), and the savings sticker below is that minus
// the bundle price. The meal-plan row used to read «350–450», which made the
// real sum a RANGE of 1550-1650 — that is why both totals said «أكثر من».
// Owner correction (08/2026): the meal plan is 350 flat, so the sum is now
// exact and the «أكثر من» came off the totals with it. Change a figure here
// and CONFIG.originalValue/savings must move too, or the receipt stops adding
// up in front of the customer.
const PAID_ROWS = [
  { name: "الاستشارة + المتابعة الجماعية", value: "700" },
  { name: "برنامج تمارين مناسب لك", value: "300" },
  { name: "جدول غذائي حسب سعراتك", value: "350" },
  { name: "ملف كنز الوصفات الصحية", value: "200" },
] as const;

const FREE_ROWS = [
  "رحلة اللياقة",
  "ملف التسخين والإطالة",
  "اختبار اللياقة",
] as const;

function Leader() {
  return (
    <span
      aria-hidden
      className="mx-2 mb-1.5 flex-1 border-b-2 border-dotted border-brand-ink/20"
    />
  );
}

export function OfferReceipt() {
  return (
    <div className="relative mx-auto w-full max-w-sm">
      {/* depth card behind the paper */}
      <div
        aria-hidden
        className="absolute inset-0 translate-y-3 -translate-x-3 rotate-[3.5deg] rounded-2xl bg-brand-purple-700/50"
      />
      <div className="bg-noise relative -rotate-2 rounded-2xl bg-[#faf6ec] p-6 text-brand-ink shadow-[0_24px_60px_-12px_rgba(10,4,20,0.55)]">
        <header className="flex items-center justify-between gap-3 border-b border-dashed border-brand-ink/20 pb-4">
          {/* Cream paper is a light surface, so the purple wordmark ships as-is. */}
          <Logo className="h-10 w-auto" />
          <p className="text-sm font-bold text-brand-ink-muted">
            باقة التحوّل الشاملة
          </p>
        </header>

        <ul className="mt-4 space-y-2.5">
          {PAID_ROWS.map((row) => (
            <li key={row.name} className="flex items-end text-sm">
              <span className="font-medium">{row.name}</span>
              <Leader />
              <span className="text-gold-700 font-bold whitespace-nowrap tabular-nums">
                {row.value} ر.س
              </span>
            </li>
          ))}
          {FREE_ROWS.map((name) => (
            <li key={name} className="flex items-end text-sm">
              <span className="font-medium">{name}</span>
              <Leader />
              <span className="font-bold whitespace-nowrap text-brand-purple-700">
                مجاناً
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-5 border-t border-dashed border-brand-ink/20 pt-4">
          <p className="flex flex-wrap items-center justify-between gap-x-3 text-sm text-brand-ink-muted">
            <span>المجموع لو اشتريتيها منفصلة</span>
            <s className="font-bold whitespace-nowrap tabular-nums">
              {CONFIG.originalValue.toLocaleString("en-US")} ر.س
            </s>
          </p>
          <p className="mt-2 flex items-baseline justify-between">
            <span className="font-bold">سعرها اليوم ضمن الباقة</span>
            <span className="flex items-baseline gap-1.5">
              <NumberTicker
                value={CONFIG.originalValue}
                startValue={CONFIG.bundlePrice}
                direction="down"
                className="text-gold-700 min-w-[4.6ch] text-end text-4xl font-extrabold md:text-5xl"
              />
              <span className="text-base font-extrabold">ر.س</span>
            </span>
          </p>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <span aria-hidden className="bg-barcode h-8 flex-1 text-brand-ink/60" />
          <span className="text-xs font-bold whitespace-nowrap text-brand-ink-muted">
            بعملية شراء واحدة
          </span>
        </div>
      </div>

      {/* wax-seal savings sticker */}
      <p className="absolute -bottom-6 -start-3 grid size-24 rotate-[-10deg] place-items-center rounded-full bg-gold-500 p-2 text-center text-[13px] leading-snug font-extrabold text-brand-ink shadow-[0_10px_24px_-6px_rgba(10,4,20,0.5)]">
        وفّري أكثر من 660 ر.س
      </p>
    </div>
  );
}
