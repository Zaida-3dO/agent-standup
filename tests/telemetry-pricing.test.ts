// The price table and the cost arithmetic — MILESTONES.md #52 ("Price table
// and cost, always recomputable from the token counts"), SCHEMA.md §11.
//
// **Needs no database, so it runs everywhere.** The arithmetic is pure by
// design, for exactly this reason: a cost that can only be checked by
// writing a run and reading it back is a cost nobody checks.
//
// **What would make this file hollow.** Asserting only that a normal set of
// counts at a normal rate produces the expected number. That case is real
// but it is not where a costing goes wrong — the failures that matter are
// an unpriced model reported as free, four rates collapsing into one, and a
// lookup that matches a *similar* model ID. Each of those is a wrong number
// that looks entirely plausible, and each has its own case below.
import { describe, expect, it } from "vitest";
import {
  TOKENS_PER_PRICE_UNIT,
  costForModel,
  costOf,
  modelPricesSchema,
  modelRateSchema,
  priceOf,
  type ModelPrices,
} from "@/lib/telemetry/pricing";

/**
 * Four deliberately *distinct* rates.
 *
 * Distinctness is the point rather than realism: a table where two rates
 * were equal would let an implementation that read the wrong field still
 * produce the right total, so the numbers are chosen so that any confusion
 * of one rate for another changes the answer.
 */
const RATE = { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 };

const PRICES: ModelPrices = { "vendor-model-a": RATE };

const COUNTS = {
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
  cacheWriteTokens: 4_000_000,
  cacheReadTokens: 8_000_000,
};

describe("costOf — the arithmetic", () => {
  it("prices each of the four counts at its own rate", () => {
    // 1×3 + 2×15 + 4×3.75 + 8×0.3 = 3 + 30 + 15 + 2.4
    const { cost } = costOf(COUNTS, RATE);
    expect(cost).toBeCloseTo(50.4, 10);
  });

  it("charges output above input for the same number of tokens", () => {
    // §10: "Prices ~5× input — never fold into a single total." A single
    // blended rate would make these two equal, which is the specific
    // information the four-count shape exists to preserve.
    const asInput = costOf(
      { inputTokens: 1_000_000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      RATE,
    ).cost;
    const asOutput = costOf(
      { inputTokens: 0, outputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0 },
      RATE,
    ).cost;
    expect(asOutput).toBeGreaterThan(asInput!);
    expect(asOutput).toBeCloseTo(asInput! * 5, 10);
  });

  it("charges a cache read far below input, and a cache write above it", () => {
    const one = (field: keyof typeof COUNTS) =>
      costOf(
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          [field]: 1_000_000,
        },
        RATE,
      ).cost!;
    expect(one("cacheReadTokens")).toBeLessThan(one("inputTokens"));
    expect(one("cacheWriteTokens")).toBeGreaterThan(one("inputTokens"));
  });

  it("quotes rates per million tokens", () => {
    // The unit is the single most plausible 1000× error in this module, so
    // it is asserted against the constant rather than only implied by the
    // numbers above.
    expect(TOKENS_PER_PRICE_UNIT).toBe(1_000_000);
    const { cost } = costOf(
      {
        inputTokens: TOKENS_PER_PRICE_UNIT,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      },
      RATE,
    );
    expect(cost).toBeCloseTo(RATE.input, 10);
  });

  it("returns the rate it applied alongside the cost", () => {
    expect(costOf(COUNTS, RATE).rate).toEqual(RATE);
  });

  it("costs a zero-token run at zero rather than null", () => {
    // Priced-and-free is a real answer and must not read as unpriced.
    expect(
      costOf({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 }, RATE)
        .cost,
    ).toBe(0);
  });
});

describe("costOf — an unpriced model is null, never zero", () => {
  it("returns null for a missing rate", () => {
    // The failure this guards: a total over a mix of priced and unpriced
    // runs reading as complete while being short by whatever the unpriced
    // work cost.
    expect(costOf(COUNTS, null)).toEqual({ cost: null, rate: null });
    expect(costOf(COUNTS, undefined)).toEqual({ cost: null, rate: null });
  });

  it("does not throw on an unknown model", () => {
    // A model this installation holds no rate for is ordinary — a new
    // vendor ID, a locally-hosted model — and refusing would lose the token
    // counts, which are the half that cannot be recovered later.
    expect(() => costForModel("never-configured", COUNTS, PRICES)).not.toThrow();
    expect(costForModel("never-configured", COUNTS, PRICES).cost).toBeNull();
  });
});

describe("costOf — malformed counts cannot poison an aggregate", () => {
  it("treats a negative count as zero", () => {
    const { cost } = costOf({ ...COUNTS, inputTokens: -1_000_000 }, RATE);
    expect(cost).toBeCloseTo(50.4 - 3, 10);
  });

  it("treats NaN and Infinity as zero rather than propagating them", () => {
    // One NaN reaching a sum makes every aggregate built over it NaN, so a
    // single malformed report from one tool version would otherwise destroy
    // the arithmetic for everything it is totalled with.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { cost } = costOf({ ...COUNTS, outputTokens: bad }, RATE);
      expect(Number.isFinite(cost)).toBe(true);
      expect(cost).toBeCloseTo(50.4 - 30, 10);
    }
  });
});

describe("priceOf — the lookup is exact", () => {
  it("finds a rate by its exact vendor ID", () => {
    expect(priceOf("vendor-model-a", PRICES)).toEqual(RATE);
  });

  it("does not match a prefix, a suffix, or a different case", () => {
    // Each of these would price a model at a rate configured for a
    // *different* model, and the resulting figure carries no trace of the
    // substitution — indistinguishable from a correct one.
    for (const near of ["vendor-model", "vendor-model-a-20260101", "Vendor-Model-A", "model-a"]) {
      expect(priceOf(near, PRICES)).toBeNull();
    }
  });

  it("does not resolve a prototype property as a rate", () => {
    // A model named `constructor` would otherwise return a function where a
    // rate is expected, and the arithmetic would silently produce NaN.
    for (const inherited of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(priceOf(inherited, PRICES)).toBeNull();
      expect(costForModel(inherited, COUNTS, PRICES).cost).toBeNull();
    }
  });
});

describe("the schema — what a table may say", () => {
  it("requires all four rates", () => {
    // An omitted `cacheRead` would price every cached token at nothing, and
    // the result is merely low rather than obviously wrong — on exactly the
    // workload where the number matters most.
    for (const missing of ["input", "output", "cacheWrite", "cacheRead"] as const) {
      const partial: Record<string, number> = { ...RATE };
      delete partial[missing];
      expect(modelRateSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("accepts a zero rate", () => {
    expect(
      modelRateSchema.safeParse({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }).success,
    ).toBe(true);
  });

  it("rejects a negative or non-finite rate", () => {
    expect(modelRateSchema.safeParse({ ...RATE, input: -1 }).success).toBe(false);
    expect(modelRateSchema.safeParse({ ...RATE, input: Number.NaN }).success).toBe(false);
    expect(modelRateSchema.safeParse({ ...RATE, input: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });

  it("rejects an unrecognised rate key", () => {
    // `.strict()`: a table written with `cache_read` where the schema says
    // `cacheRead` would otherwise validate and price every cached token at
    // nothing, silently.
    expect(modelRateSchema.safeParse({ ...RATE, cache_read: 0.3 }).success).toBe(false);
  });

  it("rejects an empty model ID as a key", () => {
    expect(modelPricesSchema.safeParse({ "": RATE }).success).toBe(false);
  });

  it("accepts an empty table", () => {
    // The default. A fresh installation prices nothing and says so, rather
    // than carrying figures that were current when the build was made.
    expect(modelPricesSchema.safeParse({}).success).toBe(true);
  });

  it("rejects a table whose entry is not a rate", () => {
    expect(modelPricesSchema.safeParse({ "vendor-model-a": 3 }).success).toBe(false);
  });
});
