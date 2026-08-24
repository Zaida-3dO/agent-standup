// MILESTONES.md #115 — a read that will not fit should say so.
//
// **What would make this file hollow.** Three ways, named first so they can
// be checked against what follows:
//
//   1. **Asserting the ceiling exists rather than that it fires.** A test
//      reading `MAX_RESPONSE_CHARS` and checking it is a positive number
//      passes against a constant nothing consumes. So the load-bearing
//      cases build an actually-oversized response and require the call to
//      be *refused* — and one runs through the real runtime, not just the
//      helper, because a guard that is never wired is a guard that never
//      fires.
//   2. **Testing size in row counts.** The row says the assertion is about
//      response size and not row count, and that distinction is the whole
//      lesson of #107 — so the oversized fixtures below are a *few* rows
//      carrying large fields, which is the shape that actually overflowed.
//      A fixture of many small rows would pass a row-count cap and prove
//      nothing about this one.
//   3. **Accepting any refusal as the right refusal.** A call can fail for
//      a dozen reasons. The assertions therefore check the `guard`
//      identifier and the message's contents — the size, the ceiling and
//      the narrower call — rather than merely that something threw.
import { describe, expect, it } from "vitest";
import { ServiceRuntime, isServiceError } from "@/lib/service";
import {
  MAX_RESPONSE_CHARS,
  RESPONSE_TOO_LARGE_GUARD,
  enforceResponseSize,
  narrowerCallFor,
  responseSize,
  responseTooLargeMessage,
  wireCopiesFor,
} from "@/lib/service/response-size";
import { defaultSnapshot } from "@/lib/settings";
import { listOperations, operationsOfKind } from "@/lib/service/registry";

/** A value whose serialised form is comfortably over the ceiling. */
function oversized(): unknown {
  // A handful of rows carrying long fields — the shape that actually
  // overflowed (#107) — rather than a great many small ones.
  return {
    items: Array.from({ length: 5 }, (_, i) => ({
      id: `item-${i}`,
      body: "x".repeat(MAX_RESPONSE_CHARS / 2),
    })),
  };
}

describe("measuring a response", () => {
  // What lands in a caller's context is the serialised form, not the object
  // graph — so that is what is measured.
  it("measures the serialised JSON, which is what a caller actually receives", () => {
    expect(responseSize({ a: "bc" })).toBe(JSON.stringify({ a: "bc" }).length);
  });

  it("measures a large payload as large", () => {
    expect(responseSize(oversized())!).toBeGreaterThan(MAX_RESPONSE_CHARS);
  });

  it("treats an empty response as no size at all", () => {
    expect(responseSize(undefined)).toBe(0);
  });

  // A circular structure is a different defect, and reporting it as a size
  // problem would send a caller to narrow a query that was never too big.
  it("reports an unserialisable value as unmeasurable rather than as oversized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(responseSize(circular)).toBeNull();
  });
});

describe("the refusal a read gets when it will not fit", () => {
  it("refuses an oversized read", () => {
    expect(() => enforceResponseSize("get_board", "read", "mcp-http", oversized())).toThrow();
  });

  it("returns an ordinary read untouched", () => {
    expect(() => enforceResponseSize("get_board", "read", "mcp-http", { items: [] })).not.toThrow();
  });

  // The boundary itself, both sides. A cap tested only far from its edge
  // does not pin down whether it fires at, above, or well past the limit.
  it("allows a response exactly at the ceiling and refuses one character more", () => {
    // A JSON string of length n serialises to n + 2 characters (the quotes).
    const atLimit = "x".repeat(MAX_RESPONSE_CHARS - 2);
    expect(responseSize(atLimit)).toBe(MAX_RESPONSE_CHARS);
    expect(() => enforceResponseSize("list_items", "read", undefined, atLimit)).not.toThrow();

    const overLimit = "x".repeat(MAX_RESPONSE_CHARS - 1);
    expect(responseSize(overLimit)).toBe(MAX_RESPONSE_CHARS + 1);
    expect(() => enforceResponseSize("list_items", "read", undefined, overLimit)).toThrow();
  });

  // A write's response is a receipt for work that already committed —
  // refusing it would report a failure for something that succeeded.
  it("does not refuse a write, whose response is a receipt for committed work", () => {
    expect(() => enforceResponseSize("create_item", "write", "http", oversized())).not.toThrow();
  });

  it("refuses with the response-size guard, not some other failure", () => {
    try {
      enforceResponseSize("get_board", "read", "mcp-http", oversized());
      expect.unreachable("an oversized read should have been refused");
    } catch (error) {
      expect(isServiceError(error)).toBe(true);
      expect(error).toMatchObject({
        code: "guard_rejected",
        guard: RESPONSE_TOO_LARGE_GUARD,
      });
    }
  });

  it("carries the measured size and the ceiling as structured detail", () => {
    try {
      enforceResponseSize("get_board", "read", "mcp-http", oversized());
      expect.unreachable("an oversized read should have been refused");
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(details.operation).toBe("get_board");
      expect(details.limit).toBe(MAX_RESPONSE_CHARS);
      expect(Number(details.size)).toBeGreaterThan(MAX_RESPONSE_CHARS);
    }
  });
});

describe("what a surface actually puts on the wire", () => {
  // **A ceiling on the payload is not a ceiling on what arrives.** The MCP
  // adapter renders every success twice — once as `text`, once as
  // `structuredContent` — so a payload just under the ceiling would deliver
  // just under twice it, on the surface an agent is most likely reading
  // through. Measured: a result the payload check scores at ~180k leaves as
  // a ~360k envelope.
  it("counts an MCP response twice, because that surface sends it twice", () => {
    expect(wireCopiesFor("mcp")).toBe(2);
  });

  it("counts every other surface once", () => {
    expect(wireCopiesFor("http")).toBe(1);
    expect(wireCopiesFor("cli")).toBe(1);
    // An unknown surface is not assumed to duplicate — one copy is the
    // honest default.
    expect(wireCopiesFor(undefined)).toBe(1);
  });

  // The behavioural half, and the load-bearing one: the same payload is
  // accepted on a single-copy surface and refused on the doubling one. A
  // guard that ignored the multiplier would accept it on both.
  it("refuses on MCP a payload it accepts on HTTP", () => {
    // Over half the ceiling, under the whole of it — the band where the two
    // surfaces must disagree.
    const payload = "x".repeat(MAX_RESPONSE_CHARS * 0.6);
    expect(responseSize(payload)!).toBeLessThan(MAX_RESPONSE_CHARS);
    expect(() => enforceResponseSize("get_board", "read", "http", payload)).not.toThrow();
    expect(() => enforceResponseSize("get_board", "read", "mcp-http", payload)).toThrow();
  });

  // The refusal quotes what the caller would have received, not the payload
  // — a caller told "180,000 characters, over the 200,000 limit" would have
  // a refusal that contradicts itself.
  it("reports the delivered size, and keeps the payload size beside it", () => {
    const payload = "x".repeat(MAX_RESPONSE_CHARS * 0.6);
    try {
      enforceResponseSize("get_board", "read", "mcp-stdio", payload);
      expect.unreachable("an oversized MCP response should have been refused");
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect(Number(details.size)).toBeGreaterThan(MAX_RESPONSE_CHARS);
      expect(Number(details.size)).toBe(Number(details.payload) * 2);
    }
  });
});

describe("what the refusal tells a caller to do instead", () => {
  // The row's actual content: a refusal "naming the offending call and the
  // narrower one that would work". A message that only said "too large"
  // would satisfy a weaker reading of the row and leave the caller stuck.
  it("names the call that was too large", () => {
    expect(responseTooLargeMessage("get_board", 999_999, "mcp")).toContain("get_board");
  });

  it("names a narrower call that would work", () => {
    const message = responseTooLargeMessage("get_board", 999_999, "mcp");
    expect(message).toMatch(/column/);
    expect(message).toMatch(/limit/);
  });

  it("states the size and the ceiling, so a caller knows what to aim at", () => {
    const message = responseTooLargeMessage("list_items", 999_999, "cli");
    expect(message).toContain("999,999");
    expect(message).toContain(MAX_RESPONSE_CHARS.toLocaleString("en-GB"));
  });

  // Same principle the rest of the refusals here follow: a message naming an
  // MCP tool to someone in a terminal costs the round trip it exists to save.
  it("is spelled for the surface the caller is on", () => {
    expect(responseTooLargeMessage("list_items", 999_999, "cli")).toContain("standup list items");
    expect(responseTooLargeMessage("list_items", 999_999, "mcp")).toContain("`list_items`");
  });

  // The fallback path — an operation with no bespoke advice still has to say
  // something a caller can act on, rather than trailing off.
  it("routes an unlisted read to search rather than saying nothing useful", () => {
    const message = responseTooLargeMessage("some_future_read", 999_999, "mcp");
    expect(message).toContain("search");
  });

  // The house style this row cites: reject, never truncate. Stating it in
  // the message is what stops a caller assuming a partial result arrived.
  it("says outright that nothing was truncated", () => {
    expect(responseTooLargeMessage("get_board", 999_999, undefined)).toMatch(/not be truncated/i);
  });
});

describe("the advice names a remedy the operation actually has", () => {
  // **The defect class this block exists for: advice that outlives the
  // operation it describes.** `orientation`'s line told callers to use
  // `get_item` instead, written before `orientation` had a `limit` — and
  // `my_work`'s told them to send "a smaller `limit`" when `my_work` accepts
  // only a `sessionId` and has never had one. Both refuse correctly and
  // advise wrongly, which costs a caller the same debugging time as a
  // refusal with no advice at all, plus a wasted attempt.
  //
  // Asserted generically rather than string-by-string so a future edit that
  // recommends a parameter into existence is caught by the suite instead of
  // by whoever follows the advice.
  it("never recommends a `limit` to an operation that has no `limit`", () => {
    const offenders: string[] = [];
    for (const operation of listOperations()) {
      const advice = narrowerCallFor(operation.name);
      if (advice === undefined) continue;
      // A *recommendation* to send one, not merely the word. `my_work`'s
      // advice says it "takes no `limit`" — mentioning the parameter in
      // order to rule it out is the opposite of the defect, so match the
      // phrasings that ask the caller to supply one.
      const recommendsALimit = /(?:smaller|a|raise the|lower the|with a)\s+`limit`/i.test(advice);
      if (!recommendsALimit) continue;
      const shape = (operation.input as unknown as { shape?: Record<string, unknown> }).shape;
      // Only object schemas have a named-field shape to check; anything
      // else is out of scope for this assertion rather than a failure.
      if (shape === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(shape, "limit")) offenders.push(operation.name);
    }
    expect(offenders).toEqual([]);
  });

  it("points `orientation` at the parameter that bounds it", () => {
    // Fails if the advice reverts to redirecting at `get_item` without
    // naming the control that actually answers the caller's question.
    const message = responseTooLargeMessage("orientation", 999_999, "mcp");
    expect(message).toContain("`limit`");
  });

  it("gives `my_work` a remedy that is not a parameter it lacks", () => {
    // `my_work` returns everything a session holds and takes no `limit`, so
    // the honest remedy is holding less. Fails if "a smaller `limit`" comes
    // back.
    const message = responseTooLargeMessage("my_work", 999_999, "mcp");
    expect(message).toContain("release");
    expect(message).not.toMatch(/smaller `limit`/);
  });
});

describe("every read the registry declares is subject to the cap", () => {
  // The generic assertion, in the same spirit as the bounded-reads sweep:
  // the guard is applied by operation *kind*, so a read registered later is
  // covered without anyone remembering to cover it.
  it("refuses an oversized response for every registered read", () => {
    const reads = operationsOfKind("read");
    expect(reads.length).toBeGreaterThanOrEqual(10);
    for (const operation of reads) {
      expect(
        () => enforceResponseSize(operation.name, operation.kind, "mcp-http", oversized()),
        `${operation.name} should refuse an oversized response`,
      ).toThrow();
    }
  });
});

describe("the guard is wired into the runtime, not merely available", () => {
  /**
   * A runtime whose "database" returns whatever rows a test hands it.
   *
   * `list_items` is a real registered read whose handler's response size is
   * a direct function of the rows it reads, so feeding it oversized rows
   * exercises the genuine path — registry lookup, schema parse, handler,
   * then the size check — rather than calling the helper directly.
   */
  function runtimeReturning(rows: unknown[]): ServiceRuntime {
    return new ServiceRuntime({
      transaction: async (body) =>
        body({
          $queryRawUnsafe: async () => rows,
          $executeRawUnsafe: async () => 0,
        } as never),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }

  /** Rows shaped like `list_items`' full projection, carrying large bodies. */
  function heavyRows(count: number, bodyChars: number): unknown[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `heavy-${i}`,
      parentId: null,
      kind: "task",
      title: `heavy ${i}`,
      headline: null,
      body: "x".repeat(bodyChars),
      state: "executing",
      priority: "P2",
      originType: "auto",
      originPersonId: null,
      area: "a",
      areas: ["a"],
      repo: null,
      branch: null,
      needsVisualReview: false,
      driveMode: "autonomous",
      mergeAuthority: "agent_judgement",
      blockedReason: null,
      blockedOnType: null,
      blockedOnPersonId: null,
      unblockAt: null,
      pauseReason: null,
      resumeCondition: null,
      resumeAttempts: 0,
      difficulty: null,
      sourceRef: null,
      notify: null,
      estimatedCost: null,
      customFields: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      completedAt: null,
    }));
  }

  // THE load-bearing test of this file. Without it, every assertion above
  // could pass while the guard was never called on a real request — which
  // is precisely the failure mode #104 and the bounded-reads sweep exist to
  // rule out elsewhere.
  it("refuses an oversized read made through the runtime", async () => {
    // Five rows, each carrying a body half the ceiling — over the limit by
    // size, and nowhere near any row-count bound.
    const runtime = runtimeReturning(heavyRows(5, MAX_RESPONSE_CHARS / 2));
    await expect(runtime.call("list_items", { full: true })).rejects.toMatchObject({
      code: "guard_rejected",
      guard: RESPONSE_TOO_LARGE_GUARD,
    });
  });

  // The negative control: the same path, the same operation, a response
  // that fits. Without this, a guard that refused *everything* would pass
  // the test above.
  it("returns a read that fits, through the same path", async () => {
    const runtime = runtimeReturning(heavyRows(2, 100));
    const result = await runtime.call("list_items", { full: true });
    expect(result.items).toHaveLength(2);
  });

  // A write on the same runtime is not size-checked, proving the guard
  // discriminates by kind rather than refusing any large payload anywhere.
  it("does not apply the cap to a write", () => {
    expect(() =>
      enforceResponseSize("create_item", "write", "mcp-http", oversized()),
    ).not.toThrow();
  });
});
