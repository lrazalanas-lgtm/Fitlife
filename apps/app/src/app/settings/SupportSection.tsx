import { LifeBuoy, Mail, MessageCircle, ChevronLeft } from "lucide-react";
import { env } from "@/lib/env";
import { genderPick } from "@/lib/copy/gender";

function ContactRow({
  href,
  label,
  value,
  icon: Icon,
}: {
  href: string;
  label: string;
  value: string;
  icon: typeof Mail;
}) {
  return (
    <a
      href={href}
      className="flex items-center justify-between gap-3 min-h-11 py-3 border-b border-brand-ink/5 last:border-0 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white rounded-md"
    >
      <span className="flex items-center gap-2.5">
        <Icon className="size-4 text-brand-purple-900" aria-hidden="true" />
        <span className="text-brand-ink font-bold text-sm group-hover:text-brand-purple-900 transition-colors">
          {label}
        </span>
      </span>
      <span className="flex items-center gap-1.5 text-brand-ink-muted text-xs">
        <span dir="ltr" className="tabular-nums">
          {value}
        </span>
        <ChevronLeft className="size-4 group-hover:text-brand-purple-900 transition-colors" aria-hidden="true" />
      </span>
    </a>
  );
}

export function SupportSection({ ownerSex }: { ownerSex?: string | null }) {
  const g = genderPick(ownerSex);
  const email = env.NEXT_PUBLIC_SUPPORT_EMAIL;
  const whatsapp = env.NEXT_PUBLIC_SUPPORT_WHATSAPP;
  const hasContact = Boolean(email || whatsapp);

  return (
    <section className="bg-white rounded-2xl border border-brand-ink/5 p-6 md:p-7">
      <div className="flex items-center gap-3 mb-3">
        <div className="size-10 rounded-full bg-brand-lavender/30 flex items-center justify-center flex-shrink-0">
          <LifeBuoy className="size-5 text-brand-purple-900" aria-hidden="true" />
        </div>
        <h2 className="font-bold text-lg text-brand-ink">{g("تواصلي معنا", "تواصل معنا")}</h2>
      </div>

      {hasContact ? (
        <div>
          {email && (
            <ContactRow
              href={`mailto:${email}`}
              label="البريد الإلكتروني"
              value={email}
              icon={Mail}
            />
          )}
          {whatsapp && (
            <ContactRow
              href={`https://wa.me/${whatsapp}`}
              label="واتساب"
              value={whatsapp}
              icon={MessageCircle}
            />
          )}
        </div>
      ) : (
        <p className="text-brand-ink-muted text-sm leading-relaxed">
          فريق الدعم متواجد لمساعدتك. تفاصيل التواصل بتكون متوفرة هنا قريباً.
        </p>
      )}
    </section>
  );
}
