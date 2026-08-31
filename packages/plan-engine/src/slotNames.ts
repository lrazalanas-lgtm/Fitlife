/**
 * Arabic slot labels — ONE definition. Both day-slice expanders (terse
 * per-member in generate.ts, dish-once in dishOnceDaySlice.ts) fill
 * slot_name_ar from this map, and the dish-once/terse equivalence contract
 * depends on the two emission modes labeling a slot identically. A second
 * hand-copy of this map is how they'd drift (same-rule-twice, the repo's
 * documented root cause) — import it, never re-declare it.
 */
export const SLOT_NAME_AR: Record<string, string> = {
  breakfast: "الفطور",
  lunch: "الغداء",
  dinner: "العشاء",
  snack: "سناك",
};
