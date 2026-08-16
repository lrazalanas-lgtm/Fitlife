import { Flame, Gauge, Route } from "lucide-react";

import { Reveal, REVEAL_DELAY } from "@/marketing/bundle/Reveal";
import { Badge } from "@/marketing/bundle/ui/badge";
import { SectionEyebrow } from "@/marketing/bundle/ui/section-eyebrow";
import { CHECKOUT_ANCHOR_ID, CONFIG } from "@/marketing/bundle/config";

const PAID_ITEMS = [
  {
    title: "الاستشارة + المتابعة الجماعية",
    value: "قيمتها 700 ر.س",
    description:
      "جلسة استشارية لفهم حالتك وهدفك، ومتابعة جماعية مستمرة تضمن التزامك وتجاوب على أسئلتك أولاً بأول.",
  },
  {
    title: "برنامج تمارين مناسب لك",
    value: "قيمته 300 ر.س",
    description:
      "تختارين البرنامج الأنسب لمستواك وهدفك من برامج التمارين الحالية — سواء كان هدفك شد الجسم، خسارة الوزن، أو بناء لياقتك من الصفر.",
  },
  {
    title: "جدول غذائي حسب سعراتك",
    value: "قيمته 350 ر.س",
    description:
      "جدول مبني على احتياجك الفعلي من السعرات (من 1800 إلى 2900 سعرة)، بأكل واقعي يناسب سفرتنا — بدون حرمان وبدون تعقيد.",
  },
  {
    title: "ملف كنز الوصفات الصحية",
    value: "قيمته 200 ر.س",
    description:
      "أكثر من 100 وصفة صحية بمقاديرها وقيمها الغذائية، عشان الالتزام يصير لذيذ مو عقوبة.",
  },
] as const;

const FREE_ITEMS = [
  {
    icon: Route,
    title: "رحلة اللياقة",
    description: "دليلك خطوة بخطوة من أول يوم حتى تثبيت النتائج.",
  },
  {
    icon: Flame,
    title: "ملف التسخين والإطالة",
    description:
      "تمارين الإحماء والإطالة الصحيحة لحماية جسمك قبل وبعد كل تمرين.",
  },
  {
    icon: Gauge,
    title: "اختبار اللياقة",
    description: "قيّمي مستواك الحالي وقيسي تقدمك بأرقام واضحة.",
  },
] as const;

// Editorial ledger, not a card grid. Each row now reads exactly like a line on
// the hero's فاتورة — index, name, dotted leader, gold figure — so the section
// that explains the offer is built from the same object that sells it. The
// gifts break that rhythm on purpose: elevated paper instead of ruled lines.
export function ValueStack() {
  return (
    <section aria-labelledby="value-stack-title">
      <div className="container-page section-shell">
        <Reveal>
          <SectionEyebrow index="01" />
          <h2
            id="value-stack-title"
            className="text-offer-h2 mt-4 max-w-3xl text-brand-purple-900"
          >
            وش راح يوصلك بالضبط؟
          </h2>
        </Reveal>

        <ol className="mt-14 border-t border-brand-ink/10 md:mt-20">
          {PAID_ITEMS.map((item, i) => (
            <Reveal
              key={item.title}
              as="li"
              delayIndex={i}
              className="border-b border-brand-ink/10"
            >
              <div className="ledger-row group/row grid grid-cols-[auto_1fr] items-start gap-x-5 py-8 md:gap-x-9 md:py-11">
                <span
                  aria-hidden
                  className="mt-0.5 text-3xl leading-none font-extrabold text-brand-purple-300 tabular-nums transition-colors duration-300 select-none group-hover/row:text-gold-700 md:text-5xl"
                >
                  0{i + 1}
                </span>
                <div className="min-w-0">
                  {/* The name reaches across to its figure — the receipt's own
                      row. A long title wraps inside the h3 and the leader
                      settles on its last line, so this needs no breakpoint. */}
                  <div className="flex items-end">
                    <h3 className="text-xl font-bold text-brand-ink md:text-[1.625rem]">
                      {item.title}
                    </h3>
                    <span
                      aria-hidden
                      className="leader-dots text-brand-ink opacity-20 transition-opacity duration-300 group-hover/row:opacity-45"
                    />
                    <span className="text-gold-700 shrink-0 text-sm font-extrabold whitespace-nowrap tabular-nums md:text-base">
                      {item.value}
                    </span>
                  </div>
                  <p className="mt-3 max-w-2xl leading-[1.85] text-brand-ink-muted">
                    {item.description}
                  </p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>

        {/* Free gifts — elevated paper, gold-sealed. Deliberately breaks the
            ruled rhythm above so the bonuses read as their own object. */}
        <Reveal variant="rise" className="mt-12 md:mt-16">
          <div className="panel-elevated edge-gold rounded-3xl p-7 md:p-11">
            <div className="flex items-center gap-4">
              <h3 className="text-xl font-extrabold text-brand-purple-900 md:text-2xl">
                هداياك المجانية 🎁
              </h3>
              <span className="rule-grow h-px flex-1 bg-brand-ink/10" />
            </div>
            <ul className="mt-9 grid gap-8 md:mt-11 md:grid-cols-3 md:gap-10">
              {FREE_ITEMS.map((item, i) => (
                <li
                  key={item.title}
                  className={`${REVEAL_DELAY[i + 1]} flex flex-col gap-3.5`}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="pop-in inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-purple-50 text-brand-purple-700 ring-1 ring-brand-purple-100">
                      <item.icon aria-hidden className="size-5" />
                    </span>
                    <p className="font-bold text-brand-ink">{item.title}</p>
                    <Badge variant="gold">مجاناً</Badge>
                  </div>
                  <p className="text-sm leading-[1.85] text-brand-ink-muted">
                    {item.description}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>

      {/* Closing strip — full-bleed purple ledger total, gold hairline edges. */}
      <div className="bg-noise border-gold-500/25 border-y bg-brand-purple-900">
        <Reveal className="container-page flex flex-col items-start gap-8 py-14 md:flex-row md:items-center md:justify-between md:py-20">
          <p className="max-w-2xl text-lg leading-[1.8] text-white md:text-xl">
            المجموع لو اشتريتيها منفصلة:{" "}
            <s className="font-bold text-white/55">
              <span className="tabular-nums">
                {CONFIG.originalValue.toLocaleString("en-US")}
              </span>{" "}
              ر.س
            </s>{" "}
            — سعرها اليوم ضمن الباقة:{" "}
            <strong className="text-gold-500 text-4xl font-extrabold whitespace-nowrap md:text-5xl">
              <span className="tabular-nums">{CONFIG.bundlePrice}</span> ر.س
            </strong>{" "}
            فقط بعملية شراء واحدة.
          </p>
          {/* Inverse CTA — light focus ring because it sits on purple-900. */}
          <a
            href={`#${CHECKOUT_ANCHOR_ID}`}
            className="lift inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl bg-brand-surface-elevated px-7 text-base font-bold text-brand-purple-900 shadow-[0_10px_28px_-14px_rgba(0,0,0,0.85)] hover:shadow-[0_18px_40px_-16px_rgba(0,0,0,0.95)] focus-visible:outline-white"
          >
            احجزي باقتك الآن
          </a>
        </Reveal>
      </div>
    </section>
  );
}
