// src/lib/costs/state.ts — the fetch shaping over `GET /api/costs` and the
// null-vs-zero total rule.
import { describe, expect, it } from "vitest";
import { emptyCosts, fetchCosts, totalCost } from "@/lib/costs/state";
import type { CostGroup, CostsPayload } from "@/lib/costs/types";

function group(overrides: Partial<CostGroup> = {}): CostGroup {
  return {
    key: "a",
    runs: 1,
    toolCalls: 1,
    inputTokens: 10,
    outputTokens: 10,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    cost: 1,
    unpricedRuns: 0,
    ...overrides,
  };
}

function payload(overrides: Partial<CostsPayload> = {}): CostsPayload {
  return { ...emptyCosts(), ...overrides };
}

describe("totalCost", () => {
  it("sums the priced groups", () => {
    expect(totalCost(payload({ groups: [group({ cost: 1 }), group({ cost: 2.5 })] }))).toBe(3.5);
  });

  it("skips null groups rather than treating them as zero", () => {
    expect(totalCost(payload({ groups: [group({ cost: 3 }), group({ cost: null })] }))).toBe(3);
  });

  it("returns null when every group is unpriced", () => {
    expect(totalCost(payload({ groups: [group({ cost: null })] }))).toBeNull();
  });

  it("returns null for no groups at all", () => {
    expect(totalCost(payload({ groups: [] }))).toBeNull();
  });
});

describe("fetchCosts", () => {
  it("requests the default stage grouping with no since", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => payload(),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchCosts({}, fetchImpl);
    expect(calls[0]).toBe("/api/ui/costs?groupBy=stage");
  });

  it("carries since through when given", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => payload() } as unknown as Response;
    }) as unknown as typeof fetch;
    await fetchCosts({ since: "2026-08-18T00:00:00.000Z" }, fetchImpl);
    expect(calls[0]).toContain("since=2026-08-18T00%3A00%3A00.000Z");
  });

  it("throws a message naming the failing call on a non-ok response", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchCosts({}, fetchImpl)).rejects.toThrow(/GET \/api\/costs returned 500/);
  });

  it("fills a partial response over the empty shape rather than crashing", async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ groups: [group()] }),
      }) as unknown as Response) as unknown as typeof fetch;
    const result = await fetchCosts({}, fetchImpl);
    expect(result.groups).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});
