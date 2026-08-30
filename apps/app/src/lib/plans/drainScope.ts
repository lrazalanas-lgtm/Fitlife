// One definition. `incompleteInPlanMemberIds` moved into the engine
// (packages/plan-engine/src/chain.ts) when the background worker's continuation
// chaining started deciding from the same rule — the drain and the chain
// re-deriving "who is still short" separately is exactly the same-rule-twice
// drift this repo has already been bitten by (the per-kind lock, the variant
// resolvers, isAdult vs isAdultLike). The re-export keeps every existing app
// import working unchanged.
export { incompleteInPlanMemberIds } from "@fitlife/plan-engine";
