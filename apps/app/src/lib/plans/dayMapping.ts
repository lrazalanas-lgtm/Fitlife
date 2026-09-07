/**
 * JavaScript getDay() returns: Sunday=0, Monday=1, …, Saturday=6.
 * Our plan schema uses Khaleeji week ordering:
 *   السبت=0, الأحد=1, الإثنين=2, الثلاثاء=3, الأربعاء=4, الخميس=5, الجمعة=6
 *
 * "Today" is always device-date based (the user's device reflects Saudi UTC+3
 * naturally) — never computed server-side, to avoid a UTC off-by-one at night.
 */

import type { LocaleCode } from "@fitlife/plan-engine";

const DAYS_AR = [
  "السبت",
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
] as const;

export type KhaleejiDayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const JS_TO_KHALEEJI: Record<number, KhaleejiDayIndex> = {
  6: 0, // Saturday
  0: 1, // Sunday
  1: 2, // Monday
  2: 3, // Tuesday
  3: 4, // Wednesday
  4: 5, // Thursday
  5: 6, // Friday
};

export function getCurrentKhaleejiDayIndex(date: Date = new Date()): KhaleejiDayIndex {
  return JS_TO_KHALEEJI[date.getDay()] ?? 0;
}

export function getDayNameAr(index: KhaleejiDayIndex): string {
  return DAYS_AR[index] ?? "";
}

export function getTodayDayName(): string {
  return getDayNameAr(getCurrentKhaleejiDayIndex());
}

// Gregorian calendar forced — ar-SA defaults to the Hijri calendar, which would
// show a Hijri month name. We want e.g. "اليوم الأحد — ١٢ مايو".
const HEADER_DATE_FMT = new Intl.DateTimeFormat("ar-SA-u-ca-gregory", {
  day: "numeric",
  month: "long",
});

export function formatTodayHeader(date: Date = new Date()): string {
  const dayName = getDayNameAr(getCurrentKhaleejiDayIndex(date));
  return `اليوم ${dayName} — ${HEADER_DATE_FMT.format(date)}`;
}

/**
 * Intl locale tag for the week range, with the calendar ALWAYS pinned to
 * Gregorian.
 *
 * The Arabic branch used to be a bare "ar-SA", whose default calendar is NOT
 * stable across JS engines: Node's ICU resolves it to gregory, Chromium's to
 * islamic-umalqura. Server and client therefore rendered different text for the
 * same plan ("٢٦ يوليو — ١ أغسطس" vs "١٢ صفر — ١٨ صفر"), tripping a React
 * hydration text mismatch (#418) on /plan and leaving Arabic users reading Hijri
 * months while the rest of the app (settings, history, recap) showed Gregorian.
 *
 * Exported so a test can assert the TAG rather than the formatted output. That
 * distinction matters: under Node's ICU both the output and the resolved
 * calendar look correct with or without the override, so only the tag itself
 * can catch a regression here.
 */
export function weekRangeLocale(locale?: LocaleCode): string {
  return `${locale && locale !== "ar" ? locale : "ar-SA"}-u-ca-gregory`;
}

/**
 * «١٧ يوليو — ٢٣ يوليو» — the plan week's date range (start + 6 days). Shared
 * by the meal AND workout viewers so the top strip reads identically in both
 * (moved verbatim from PlanViewer when the workout view gained the same strip).
 */
export function formatWeekRange(weekStart: string, locale?: LocaleCode): string {
  try {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = new Intl.DateTimeFormat(weekRangeLocale(locale), {
      day: "numeric",
      month: "long",
    });
    return `${fmt.format(start)} — ${fmt.format(end)}`;
  } catch {
    return weekStart;
  }
}

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** "Today" as a Riyadh (UTC+3) calendar date — matches the engine's anchor. */
export function riyadhTodayISO(): string {
  return new Date(Date.now() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The current Riyadh calendar year, evaluated per call. Ages are derived from
 * birth_year against THIS, not against a module-scope `new Date()` — that
 * value is fixed at the server's cold start, so a long-lived instance kept
 * showing last year's ages after New Year.
 */
export function riyadhCurrentYear(): number {
  return Number(riyadhTodayISO().slice(0, 4));
}

/** YYYY-MM-DD + n days → YYYY-MM-DD (pure calendar math, no TZ). */
export function addDaysISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Whole days from the plan's week_start_date to today (Riyadh). 0 = the plan's
 * first day (its generation day). Can be negative (legacy future-anchored plans)
 * or > 6 (the plan's week has ended).
 */
export function dayIndexFromWeekStart(weekStartISO: string): number {
  const start = Date.parse(`${weekStartISO}T00:00:00Z`);
  const today = Date.parse(`${riyadhTodayISO()}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(today)) return 0;
  return Math.round((today - start) / 86_400_000);
}

/** Arabic weekday name for (weekStartISO + dayIndex) — mirrors the engine. */
export function dayNameFromWeekStart(weekStartISO: string, dayIndex: number): string {
  const d = new Date(`${weekStartISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + dayIndex);
  const khaleeji = (JS_TO_KHALEEJI[d.getUTCDay()] ?? 0) as KhaleejiDayIndex;
  return getDayNameAr(khaleeji);
}

// ─── Localized day + slot names (housekeeper view) ───────────────────────
// Indexed by the plan's Khaleeji day_index (0=Saturday … 6=Friday). Best-effort
// for tl/id/bn/am/ur — review with native speakers before scale.
const DAY_NAMES_BY_LOCALE: Record<LocaleCode, string[]> = {
  ar: ["السبت", "الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"],
  en: ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  tl: ["Sabado", "Linggo", "Lunes", "Martes", "Miyerkules", "Huwebes", "Biyernes"],
  id: ["Sabtu", "Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat"],
  bn: ["শনিবার", "রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার"],
  am: ["ቅዳሜ", "እሁድ", "ሰኞ", "ማክሰኞ", "ረቡዕ", "ሐሙስ", "ዓርብ"],
  ur: ["ہفتہ", "اتوار", "پیر", "منگل", "بدھ", "جمعرات", "جمعہ"],
};

type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";

const SLOT_NAMES_BY_LOCALE: Record<LocaleCode, Record<MealSlot, string>> = {
  ar: { breakfast: "الفطور", lunch: "الغداء", dinner: "العشاء", snack: "وجبة خفيفة" },
  en: { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" },
  tl: { breakfast: "Almusal", lunch: "Tanghalian", dinner: "Hapunan", snack: "Meryenda" },
  id: { breakfast: "Sarapan", lunch: "Makan Siang", dinner: "Makan Malam", snack: "Camilan" },
  bn: { breakfast: "নাস্তা", lunch: "দুপুরের খাবার", dinner: "রাতের খাবার", snack: "হালকা খাবার" },
  am: { breakfast: "ቁርስ", lunch: "ምሳ", dinner: "እራት", snack: "መክሰስ" },
  ur: { breakfast: "ناشتہ", lunch: "دوپہر کا کھانا", dinner: "رات کا کھانا", snack: "ہلکی غذا" },
};

export function getDayNameInLocale(dayIndex: number, locale: LocaleCode): string {
  return DAY_NAMES_BY_LOCALE[locale]?.[dayIndex] ?? DAY_NAMES_BY_LOCALE.en[dayIndex] ?? "";
}

export function getSlotNameInLocale(slot: string, locale: LocaleCode): string {
  const table = SLOT_NAMES_BY_LOCALE[locale];
  return (table as Record<string, string>)[slot] ?? slot;
}

/**
 * Localized weekday name for (weekStart + dayIndex). The plan's day_index is
 * anchored to the generation day, NOT a fixed Saturday=0, so the maid view must
 * derive the real weekday from the date rather than indexing the locale array
 * by day_index directly.
 */
export function getLocalizedDayNameFromWeekStart(
  weekStartISO: string,
  dayIndex: number,
  locale: LocaleCode,
): string {
  const d = new Date(`${weekStartISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + dayIndex);
  const khaleeji = (JS_TO_KHALEEJI[d.getUTCDay()] ?? 0) as KhaleejiDayIndex;
  return getDayNameInLocale(khaleeji, locale);
}
