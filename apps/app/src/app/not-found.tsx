import Link from "next/link";
import { Logo } from "@/components/Logo";

// The app-wide 404. Without this file Next renders its own English,
// unstyled "This page could not be found" — reachable by any customer who
// opens a stale link (a deleted plan-history entry calls notFound()).
// Logged-out visitors read the house feminine default.
export const metadata = {
  title: "الصفحة غير موجودة — فت لايف",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="min-h-screen bg-brand-surface" dir="rtl">
      <header className="bg-white border-b border-brand-ink/5">
        <div className="container-app py-4">
          <Link
            href="/"
            aria-label="فت لايف — الرئيسية"
            className="inline-flex items-center rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <Logo className="h-9 w-auto" />
          </Link>
        </div>
      </header>

      <section className="container-app py-16 md:py-24 max-w-lg">
        <p className="text-brand-purple-900 font-bold text-sm">٤٠٤</p>
        <h1 className="mt-2 text-3xl md:text-4xl font-extrabold text-brand-ink leading-tight">
          الصفحة غير موجودة
        </h1>
        <p className="mt-4 text-brand-ink-muted leading-relaxed">
          الرابط الذي فتحتِه لم يعد موجوداً أو تغيّر عنوانه. خطتك وبياناتك في مكانها.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center min-h-11 px-5 rounded-full bg-brand-purple-900 text-white hover:bg-brand-purple-700 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
          >
            لوحة التحكم
          </Link>
          <Link
            href="/"
            className="inline-flex items-center justify-center min-h-11 px-5 rounded-full border border-brand-purple-900/25 text-brand-purple-900 hover:bg-brand-lavender/30 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple-900 focus-visible:ring-offset-2 focus-visible:ring-offset-brand-surface"
          >
            الصفحة الرئيسية
          </Link>
        </div>
      </section>
    </main>
  );
}
