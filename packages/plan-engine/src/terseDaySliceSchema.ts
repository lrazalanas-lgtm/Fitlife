/**
 * The terse day-slice as a STRUCTURED-OUTPUTS JSON schema — the enforcement
 * half of "compact by construction".
 *
 * Three attempts at holding emission in the compact mode preceded this, all
 * measured on production: a prompt directive (didn't hold — 26k, then >32k
 * tokens for a day the model used to write in 10-20k), an assistant prefill
 * (API 400: not supported on claude-sonnet-4-6), and cap/ceiling headroom
 * (bounded the damage, fixed nothing). A schema the API enforces is not a
 * request — a reply that exists at all matches it, and it cannot open with a
 * fence, a prose preamble, or keys the expander doesn't read.
 *
 * The shape mirrors `expandTerseDaySlice`'s TERSE branch exactly (d/ms/id/m/
 * s/r/ig/st/sub/nt/c/mc) — the expander and downstream zod validation are
 * untouched, so a structured reply flows through the SAME parse, band, rescale
 * and assembly path as an unstructured one. Divergence between this schema and
 * the expander is pinned by terseDaySliceSchema.test.ts.
 *
 * API constraints honored (docs.claude.com structured-outputs, 08/2026):
 * every object carries `additionalProperties: false`; NO numeric/length
 * keywords (minimum, minLength, …) — zod still enforces those app-side; no
 * recursion. `slot` and `unit` enums are string literals here and MUST match
 * the zod enums in schema.ts — also pinned by the test.
 *
 * Sent only when the day model supports the feature (supportsStructuredOutputs
 * — claude-sonnet-4-6 does NOT; flipping PLAN_DAY_MODEL to claude-sonnet-5 or
 * claude-haiku-4-5 is what turns enforcement on).
 */

const INGREDIENT = {
  type: "object",
  properties: {
    n: { type: "string" },
    a: { type: "number" },
    mn: { type: "number" },
    mx: { type: "number" },
    u: {
      type: "string",
      enum: [
        "g",
        "kg",
        "ml",
        "l",
        "tbsp",
        "tsp",
        "cup",
        "piece",
        "serving",
        "unlimited",
      ],
    },
  },
  required: ["n", "a", "u"],
  additionalProperties: false,
} as const;

const MEAL = {
  type: "object",
  properties: {
    s: {
      type: "string",
      enum: ["breakfast", "lunch", "dinner", "snack"],
    },
    r: { type: "string" },
    ig: { type: "array", items: INGREDIENT },
    st: { type: "array", items: { type: "string" } },
    sub: { type: "array", items: { type: "string" } },
    nt: { type: "string" },
    c: { type: "number" },
    mc: {
      type: "object",
      properties: {
        p: { type: "number" },
        cb: { type: "number" },
        f: { type: "number" },
      },
      required: ["p", "cb", "f"],
      additionalProperties: false,
    },
  },
  required: ["s", "r", "ig", "st", "c", "mc"],
  additionalProperties: false,
} as const;

export const TERSE_DAY_SLICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    d: { type: "integer" },
    ms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          m: { type: "array", items: MEAL },
        },
        required: ["id", "m"],
        additionalProperties: false,
      },
    },
  },
  required: ["d", "ms"],
  additionalProperties: false,
} as const;

/** The value streamAnthropic sends as `output_config.format`, verbatim. */
export function terseDaySliceOutputFormat(): Record<string, unknown> {
  return { type: "json_schema", schema: TERSE_DAY_SLICE_JSON_SCHEMA };
}
