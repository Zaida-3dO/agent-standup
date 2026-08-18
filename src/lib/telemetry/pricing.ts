// The price table and the arithmetic over it — MILESTONES.md #52 ("Price
// table and cost, always recomputable from the token counts"), SCHEMA.md §11
// (`runs.cost`: "Denormalised convenience for sorting and rollups.
// **Recomputable** from the counts + `model`; the counts are the truth.").
//
// ── "Always recomputable" is a constraint on the design, not a property ──
//
// The phrase reads like a note about a pleasant quality of the stored
// number. It is not; it decides the shape of this module. A cost that
// cannot be re-derived is a number nobody can check and nobody can correct:
// when a vendor changes a price, or when a rate is discovered to have been
// entered wrong, the only repair available for a stored-and-forgotten
// figure is to believe it. So the arithmetic lives in one pure function
// over (counts, rate), the four counts are stored beside the cost on every
// row, and the rates are configuration rather than literals compiled into a
// build. Given those three, any cost in the database can be recomputed from
// data the database already holds, and a wrong rate is a settings edit and
// a re-run rather than an archaeology exercise.
//
// The corollary is what this module refuses to do: **nothing here reads or
// writes a stored cost**. Costing is a function; storing it is the caller's
// business. That keeps the recompute path and the write path the same code,
// so a recompute cannot drift from the original computation by being a
// second implementation of the same sum.
//
// ── Four counts, four rates, never a total ──────────────────────────────
//
// §10 states it outright and §11 repeats it: the four token counts price at
// wildly different rates, so folding them into one total destroys the
// information. Output prices around 5× input; a cache read around a tenth
// of input; a cache write above input rather than below, because it buys a
// discount later at a premium now. A single blended rate applied to a
// single total is therefore not an approximation of this — it is a number
// whose error depends on a workload's cache behaviour, which is precisely
// the thing anyone reading these figures wants to see.
//
// ── Rates are per million tokens, and the unit is stated ────────────────
//
// Vendors publish per-million figures, so that is the unit configured here:
// a rate a person can check against a public price page without arithmetic
// is a rate that gets noticed when it is wrong. The per-token conversion is
// one division, done here, once.
import { z } from "zod";

/**
 * How many tokens a published rate is quoted against.
 *
 * Named rather than inlined because it appears both in the setting's help
 * text and in the arithmetic, and the two must not be able to disagree — a
 * divisor saying "per million" beside a field documented as "per thousand"
 * is a 1000× error that looks entirely plausible on a dashboard.
 */
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * What one model costs, per million tokens, in whatever currency the
 * installation states its table in.
 *
 * **All four rates are required, including zeroes.** A model whose entry
 * omitted `cacheRead` would silently price every cached token at nothing,
 * and the resulting figure is not obviously wrong — it is merely low, on a
 * workload that caches heavily, which is exactly the workload where the
 * number matters most. Requiring the field means a genuinely free rate is
 * written as `0` by someone who decided it, and an absent one is a
 * validation error at the moment the table is edited.
 *
 * Non-negative rather than positive, because zero is legitimate: a vendor
 * promotion, a locally-hosted model, or an installation that only wants to
 * meter one dimension.
 */
export const modelRateSchema = z
  .object({
    input: z.number().nonnegative().finite(),
    output: z.number().nonnegative().finite(),
    cacheWrite: z.number().nonnegative().finite(),
    cacheRead: z.number().nonnegative().finite(),
  })
  .strict();

export type ModelRate = z.infer<typeof modelRateSchema>;

/**
 * The whole table: exact vendor model ID → its four rates.
 *
 * **Keyed by the exact vendor model ID**, per §2 and §11 — never a friendly
 * form. §11 is explicit that a family name spans several generations, so a
 * friendly key pools materially different models into one price and makes
 * the run unpriceable in the direction that matters: a run recorded against
 * a cheaper generation and priced at a dearer one is wrong by a factor
 * nobody can detect from the row.
 *
 * A record rather than an array of `{model, ...rates}` objects, because the
 * lookup is by id on every costing call and a JSON object gives uniqueness
 * of the key for free. An array would permit two entries for one model, and
 * whichever the code happened to find first would decide the price.
 *
 * The default is empty, which is §17.2's first property applied here: a
 * fresh installation boots with no rates, prices nothing, and says so —
 * rather than booting with a table of figures that were current when this
 * version was built and are quietly stale by the time anyone reads a total.
 */
export const modelPricesSchema = z.record(z.string().min(1), modelRateSchema);

export type ModelPrices = z.infer<typeof modelPricesSchema>;

/**
 * The four counts any costing reads. Deliberately the minimum: this module
 * prices tokens and knows nothing about runs, rows or sessions.
 */
export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
}

/**
 * A costing, and the rate it was computed against.
 *
 * The rate comes back with the number rather than being looked up and
 * discarded, because a reader asking "why is this figure what it is" has
 * exactly one useful question — which rate applied — and answering it from
 * the return value costs nothing. It is also what lets a test assert the
 * arithmetic against the same rate the caller used, rather than against one
 * the test looked up separately and might have looked up differently.
 */
export interface Costing {
  /** The cost, or `null` when the model has no entry in the table. */
  readonly cost: number | null;
  /** The rate applied, or `null` for an unpriced model. */
  readonly rate: ModelRate | null;
}

/**
 * Costs a set of token counts at one model's rate.
 *
 * **An unpriced model returns `null`, never `0`.** The two are opposite
 * claims — "this cost nothing" against "nobody has told this installation
 * what this model costs" — and collapsing them is the failure mode that
 * makes a cost table untrustworthy without ever looking broken: a total
 * over a mix of priced and unpriced runs would read as a complete figure
 * that is quietly short by however much the unpriced work cost. A null
 * propagates as "not known", which a reader can see.
 *
 * That is also why an unknown model is not an error. A model this
 * installation holds no rate for is an ordinary event — a vendor ships a
 * new ID, an agent is pointed at a locally-hosted model — and refusing to
 * record telemetry over it would lose the token counts too, which are the
 * truth the cost is derived from and the only half that cannot be recovered
 * later. Record the counts, decline to price them, and the figure appears
 * the moment somebody adds a rate.
 *
 * Negative and non-finite counts are treated as zero rather than refused,
 * for the same reason the hook's `countOf` floors them: this is measurement
 * code, and the alternative to a slightly-wrong number here is no number at
 * all. One `NaN` reaching the sum makes every aggregate built over it
 * `NaN`, so a single malformed report from one tool version would otherwise
 * destroy the arithmetic for everything it is totalled with.
 */
export function costOf(counts: TokenCounts, rate: ModelRate | undefined | null): Costing {
  if (!rate) return { cost: null, rate: null };
  const cost =
    (nonNegative(counts.inputTokens) * rate.input +
      nonNegative(counts.outputTokens) * rate.output +
      nonNegative(counts.cacheWriteTokens) * rate.cacheWrite +
      nonNegative(counts.cacheReadTokens) * rate.cacheRead) /
    TOKENS_PER_PRICE_UNIT;
  return { cost, rate };
}

/**
 * The rate for one model, looked up by its exact ID.
 *
 * The lookup is exact and case-sensitive, with no normalisation, no prefix
 * matching and no nearest-match. Every one of those would let a model be
 * priced at a rate somebody configured for a *different* model — and the
 * resulting figure carries no trace of the substitution, so it would be
 * indistinguishable from a correct one. A miss is visible as a null; a
 * silent near-match is not visible at all.
 *
 * `Object.hasOwn` rather than a bare property read, so a model named
 * `constructor` or `toString` cannot pick up a "rate" from the prototype
 * chain — a lookup returning a function where a rate is expected is a shape
 * the schema never validated and the arithmetic would turn into `NaN`.
 */
export function priceOf(model: string, prices: ModelPrices): ModelRate | null {
  return Object.hasOwn(prices, model) ? (prices[model] ?? null) : null;
}

/** Costs `counts` for `model` against `prices`. The whole of the public path. */
export function costForModel(model: string, counts: TokenCounts, prices: ModelPrices): Costing {
  return costOf(counts, priceOf(model, prices));
}

/** A count as the arithmetic may use it. See `costOf` for why this floors rather than refuses. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
