import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { hasAdvisorAccess } from "@/lib/subscription/access";
import {
  getCurrentSubscription,
  hasLiveLemonsqueezySubscription,
} from "@/lib/subscription/state";
import { Logo } from "@/components/Logo";
import { BackToDashboard } from "@/components/BackToDashboard";
import { SettingsLink } from "@/components/SettingsLink";
import { ChatPanel } from "./ChatPanel";
import { genderPick } from "@/lib/copy/gender";

export const metadata = {
  title: "المستشارة الغذائية — فت لايف",
  robots: { index: false, follow: false },
};

export default async function ChatPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const [access, { data: ownerProfile }, subscription] = await Promise.all([
    hasAdvisorAccess(user.id),
    supabase.from("profiles").select("sex").eq("id", user.id).single(),
    getCurrentSubscription(user.id),
  ]);
  const ownerSex = (ownerProfile as { sex?: string | null } | null)?.sex ?? null;
  const g = genderPick(ownerSex);
  // A denied customer who already holds a live LemonSqueezy subscription
  // (past_due, paused) must not be sent to /pricing — checkout 409s them.
  const isSubscriber = hasLiveLemonsqueezySubscription(subscription);

  return (
    <main
      dir="rtl"
      lang="ar"
      className="min-h-screen bg-brand-surface flex flex-col"
    >
      <header className="bg-white border-b border-brand-ink/5 sticky top-0 z-10">
        <div className="container-app py-4 flex items-center justify-between">
          <a
            href="/dashboard"
            aria-label="فت لايف — الرئيسية"
            className="inline-flex items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <Logo className="h-9 w-auto" />
          </a>
          <div className="flex items-center gap-2">
            <BackToDashboard />
            <SettingsLink />
          </div>
        </div>
      </header>

      {access.allowed ? (
        <ChatPanel ownerSex={ownerSex} />
      ) : (
        <div className="container-app py-12 max-w-lg">
          <div className="bg-white rounded-2xl border border-brand-ink/5 p-6 text-center">
            <p className="font-bold text-brand-ink text-lg">
              {g("المستشارة الغذائية حق المشتركات", "المستشارة الغذائية حق المشتركين")}
            </p>
            <p className="mt-2 text-brand-ink-muted text-sm leading-relaxed">
              {isSubscriber
                ? "اشتراكك يحتاج تحديثاً لتعود المستشارة."
                : g(
                    "اشتركي وسأليني مباشرة عن وجباتك وخطتك الغذائية.",
                    "اشترك وسألني مباشرة عن وجباتك وخطتك الغذائية.",
                  )}
            </p>
            <Link
              href={isSubscriber ? "/subscription" : "/pricing"}
              className="inline-flex items-center justify-center min-h-11 mt-4 px-5 rounded-full bg-brand-purple-900 text-white hover:bg-brand-purple-700 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
            >
              {isSubscriber ? "إدارة الاشتراك" : "عرض الباقات"}
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
