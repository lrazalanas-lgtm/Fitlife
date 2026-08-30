export { buildPlanContext, getBeneficiaries } from "./buildContext";

export {
  HIGH_RISK_MEDICAL_FLAGS,
  ownerRequiresDoctorSignOff,
  memberRequiresDoctorSignOff,
  hasHighRiskCondition,
  DOCTOR_SIGN_OFF_REQUIRED_AR,
} from "./medicalGate";
export type { OwnerMedicalFacts, MemberMedicalFacts } from "./medicalGate";

export {
  CHILD_AGE_CUTOFF,
  ADOLESCENT_AGE_MIN,
  isChildByAge,
  isChildByBirthYear,
  minorStage,
} from "./childRule";
export type { MinorStage } from "./childRule";

export {
  GATE_CONDITIONS,
  STABLE_CONDITIONS,
  conditionLabelAr,
  conditionLabels,
} from "./medicalConditionLabels";
export type { ConditionOption } from "./medicalConditionLabels";

export type {
  PlanPromptContext,
  PlanPromptContextMom,
  PlanPromptContextMember,
  Beneficiary,
} from "./buildContext";

export {
  createPlanRows,
  runMealPlanGeneration,
  generateMealPlan,
  prepareSharedGroupRegen,
  reconcileChildTargets,
  translateMealPlan,
  runMealPlanTranslation,
  hasPendingGeneration,
  generationAlreadySettled,
} from "./generate";
export type { GenerateResult } from "./generate";

export {
  STATIC_SYSTEM,
  buildSkeletonPrompt,
  buildDayPrompt,
  buildTranslatePrompt,
} from "./systemPrompt";

export { streamAnthropic, stripMarkdownFence, computeCostUsd } from "./anthropic";
export type { StreamResult } from "./anthropic";
export {
  PLAN_CHAIN_MAX_HOPS,
  incompleteInPlanMemberIds,
  shouldChainContinuation,
} from "./chain";

export {
  planRunBudgetMs,
  dayLoopDeadline,
  remainingMs,
  canFit,
  DEFAULT_PLAN_RUN_BUDGET_MS,
  FINALIZE_RESERVE_MS,
  TRANSLATION_RESERVE_MS,
  DAY_CALL_ESTIMATE_MS,
  MIN_VIABLE_CALL_MS,
} from "./budget";

export {
  canonicalRecipeKey,
  CANONICAL_KEY_VERSION,
} from "./canonicalRecipeKey";

export {
  computeEngagementDigest,
  engagementText,
  MIN_SIGNAL_EVENTS,
  GOLDEN_LOVED_THRESHOLD,
} from "./engagementDigest";
export type {
  EngagementDigest,
  EngagementCheckinRow,
  EngagementVerdictRow,
} from "./engagementDigest";

export {
  MacrosSchema,
  IngredientSchema,
  PerMemberPortionSchema,
  MealSchema,
  DaySchema,
  MemberPlanSchema,
  MealPlanSchema,
  WeekChangeSchema,
  planHasContent,
  PRIMARY_GOALS,
  LOCALE_CODES,
} from "./schema";
export type {
  Macros,
  Ingredient,
  PerMemberPortion,
  Meal,
  Day,
  MemberPlan,
  MealPlan,
  WeekChange,
  LocaleCode,
} from "./schema";

export {
  PLAN_MODEL,
  PLAN_MAX_TOKENS,
  PRICING_USD_PER_MTOK_BY_MODEL,
  pricingForModel,
  MEMBER_GEN_MAX_ATTEMPTS,
} from "./constants";

export * from "./errors";

// ── Workout plans (separate opt-in program; meals-first fork) ───────────────
export * from "./workout/schema";
export * from "./workout/exerciseCatalog";
export * from "./workout/equipment";
export * from "./workout/feedback";
export {
  WORKOUT_STATIC,
  WORKOUT_METHODOLOGY,
  buildWorkoutSkeletonPrompt,
  buildWorkoutMemberPrompt,
  workoutTrainees,
} from "./workout/systemPrompt";
export {
  createWorkoutPlanRows,
  generateWorkoutPlan,
  runWorkoutPlanGeneration,
  mealGenBlocksWorkout,
} from "./workout/generate";
