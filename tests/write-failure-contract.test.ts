// What a caller is told when a write fails (MILESTONES.md — the opaque-write
// contract).
//
// A write that fails with nothing but `{"code":"internal"}` leaves an agent
// with no way to act: it cannot tell a rolled-back call from a committed one,
// cannot tell whether sending the same bytes again would work, and has no id
// to quote in a report, so the failure reaches no log line anyone can find.
// An operation reporting that three crews were unblocked can fail exactly
// that way and be believed — that is the failure this file pins.
//
// The tests are grouped by the four things a caller now learns: **whether it
// landed** (`committed`), **whether to retry** (`retryable`), **what to
// quote** (`requestId`), and **how it broke** (`internalKind`, for the
// buckets that disclose nothing about stored rows). Every one of them also
// asserts the other half: that the underlying cause still does not cross.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { callTool, type ServiceCall } from "@/lib/mcp/server";
import { toolRejection } from "@/lib/mcp/result";
import { renderRejection } from "@/lib/conformance/assertions";
import {
  classifyCause,
  GuardRejectedError,
  InternalError,
  INTERNAL_KINDS,
  internalMessageFor,
  NotFoundError,
  retryabilityOf,
  retryableFor,
  SERVICE_ERROR_CODES,
  type InternalKind,
  type ServiceErrorCode,
} from "@/lib/service";
import { captureLogs, oneRecord, type CapturedLogs } from "./helpers/capture-logs";

/** The text no caller-facing payload in this file may ever contain. */
const SECRET = "postgres://user:hunter2@db.internal:5432/app";

let logs: CapturedLogs;
let originalLevel: string | undefined;

beforeEach(() => {
  originalLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

/** A Prisma-shaped driver error, which is all `classifyCause` reads. */
function driverError(code: string): Error & { code: string } {
  return Object.assign(new Error(`driver said ${code}`), { code });
}

/** The structured half of a tool result, as a plain record. */
function structured(result: { structuredContent?: Record<string, unknown> }) {
  const content = result.structuredContent;
  if (content === undefined) throw new Error("expected structuredContent");
  return content;
}

// ── Whether the write landed ─────────────────────────────────────────────

describe("committed", () => {
  // The regression test for the whole item. A call that RESOLVES — the write
  // is durable — and then fails to render must not be reported as a failure
  // that did not happen.
  //
  // The trigger is a `toJSON` that throws, and the choice is load-bearing. A
  // raw `bigint` looks like it would work and does not: `bigintSafe`
  // converts bigints to strings before `JSON.stringify` ever sees them, so
  // that call returns a perfectly good SUCCESS and a test built on it would
  // pass while proving nothing.
  test("is true when the call committed and only the rendering failed", async () => {
    const call: ServiceCall = async () => ({
      id: "1",
      toJSON() {
        throw new Error("this value cannot be rendered");
      },
    });

    const result = await callTool(call, "mcp-http", "note", { body: "x" });
    const body = structured(result);

    expect(result.isError).toBe(true);
    expect(body.committed).toBe(true);
    // The precedence rule: a committed write is never advertised as
    // retryable, because `note` has no dedupe and a retry would write twice.
    expect(body.retryable).toBe(false);
    expect(body.message).toMatch(/re-read/i);
    expect(body.requestId).toBeTypeOf("string");
  });

  test("is false when the call threw before committing", async () => {
    const call: ServiceCall = async () => {
      throw new InternalError(driverError("P2002"));
    };

    const body = structured(await callTool(call, "mcp-http", "note", { body: "x" }));

    expect(body.committed).toBe(false);
    expect(body.message).toMatch(/nothing was recorded/i);
  });

  // The honest residue. A connection lost mid-transaction reports the same
  // way whether the commit landed a moment earlier or never ran, so neither
  // side can tell — and saying `false` there would invite the double write
  // that reporting this at all exists to prevent.
  test("is unknown when the connection was lost mid-transaction", async () => {
    const call: ServiceCall = async () => {
      throw new InternalError(driverError("P2028"));
    };

    const body = structured(await callTool(call, "mcp-http", "checkpoint", {}));

    expect(body.committed).toBe("unknown");
    expect(body.message).toMatch(/may or may not/i);
    // Still retryable — refusing to retry a write that may never have landed
    // is how a checkpoint goes missing silently. The message carries the
    // caution instead.
    expect(body.retryable).toBe(true);
  });

  // A refusal is not a write that failed; it is a call that was declined on
  // its content. "Did it land" has no answer there, and inventing `false`
  // would put a meaningless key on every rejection.
  test("is absent entirely on a caller fault", async () => {
    const call: ServiceCall = async () => {
      throw new NotFoundError("No such item.");
    };

    const body = structured(await callTool(call, "mcp-http", "get_item", {}));

    expect(body).not.toHaveProperty("committed");
    expect(body).not.toHaveProperty("internalKind");
    expect(body.retryable).toBe(false);
  });
});

// ── Whether to retry ─────────────────────────────────────────────────────

describe("retryable", () => {
  // Exhaustive over the closed union rather than spot-checked, so adding a
  // code without classifying it fails to compile here as well as in the
  // source — the property that makes the table safe to extend.
  test("is defined for every service error code", () => {
    const expected: Record<ServiceErrorCode, boolean> = {
      invalid_input: false,
      not_found: false,
      guard_rejected: false,
      conflict: false,
      forbidden: false,
      not_implemented: false,
      internal: true,
    };

    for (const code of SERVICE_ERROR_CODES) {
      expect(retryableFor(code), `retryableFor(${code})`).toBe(expected[code]);
    }
  });

  test("is defined for every internal kind", () => {
    const expected: Record<InternalKind, boolean> = {
      database_unavailable: true,
      timeout: true,
      // The store refused the write on its content, so it will refuse it
      // again. This is the one bucket where an `internal` is really a caller
      // fault wearing a 500.
      constraint_violation: false,
      unexpected: true,
    };

    for (const kind of INTERNAL_KINDS) {
      expect(retryableFor("internal", kind), `retryableFor(internal, ${kind})`).toBe(
        expected[kind],
      );
    }
  });

  // The precedence rule, stated directly against the function rather than
  // only through the adapter, because it is the rule that prevents a double
  // write and it should fail loudly if it is ever reordered.
  test("committed outranks every retryable verdict the table would give", () => {
    for (const kind of INTERNAL_KINDS) {
      expect(retryabilityOf("internal", kind, true), `committed:true with ${kind}`).toBe(false);
    }
    // ...and does not suppress the others.
    expect(retryabilityOf("internal", "timeout", false)).toBe(true);
    expect(retryabilityOf("internal", "timeout", "unknown")).toBe(true);
  });
});

// ── How it broke, and what must never cross ──────────────────────────────

describe("internalKind", () => {
  test("classifies transaction failures as timeouts, not constraint violations", () => {
    // The line these sit on is the whole point. Below the `P2` prefix test
    // they would be unreachable and a transaction timeout would report as
    // `constraint_violation` — naming a specific wrong cause, which is worse
    // than the honest `unexpected` default.
    expect(classifyCause(driverError("P2028"))).toBe("timeout");
    expect(classifyCause(driverError("P2034"))).toBe("timeout");
    // The neighbours it was placed beside, so a reordering that breaks them
    // is caught here too.
    expect(classifyCause(driverError("P2024"))).toBe("timeout");
    expect(classifyCause(driverError("ETIMEDOUT"))).toBe("timeout");
    expect(classifyCause(driverError("P1001"))).toBe("database_unavailable");
    expect(classifyCause(driverError("P2002"))).toBe("constraint_violation");
  });

  test("is rendered for a timeout, which discloses nothing about stored rows", async () => {
    const call: ServiceCall = async () => {
      throw new InternalError(driverError("P2024"));
    };

    const body = structured(await callTool(call, "mcp-http", "note", { body: "x" }));

    expect(body.internalKind).toBe("timeout");
    expect(INTERNAL_KINDS).toContain(body.internalKind);
    expect(body.retryable).toBe(true);
    // `unknown` rather than `false`, and deliberately wider than it strictly
    // has to be. A pool-acquisition timeout could not have committed, but
    // the adapter reads only the coarse bucket, and every bucket member is
    // treated as "the caller cannot tell". The alternative is reading the
    // driver code at this boundary to decide, which would reintroduce the
    // dependency on driver-version-specific codes that the bucket exists to
    // contain — and it errs toward a re-read rather than toward a silent
    // double write.
    expect(body.committed).toBe("unknown");
  });

  // The redaction boundary, which this change must not move. A
  // `constraint_violation` says the caller's input reached a write and
  // collided with a stored row — a fact about stored data, not about the
  // request.
  test("is withheld for a constraint violation, and no schema text crosses", async () => {
    const call: ServiceCall = async () => {
      throw new InternalError(
        Object.assign(new Error(`Unique constraint failed on ${SECRET}`), {
          code: "P2002",
          meta: { target: ["Item_name_key"] },
        }),
      );
    };

    const result = await callTool(call, "mcp-http", "create_item", {});
    const body = structured(result);
    const whole = JSON.stringify(result);

    expect(body).not.toHaveProperty("internalKind");
    expect(body.retryable).toBe(false);
    expect(whole).not.toContain("constraint_violation");
    expect(whole).not.toContain("Item_name_key");
    expect(whole).not.toContain(SECRET);
  });

  // Both channels, because `toolRejection` serialises the same object into
  // `content` *and* `structuredContent` — checking one proves half of what
  // the assertion claims.
  test("leaks nothing into either channel, text or structured", async () => {
    const call: ServiceCall = async () => {
      throw new InternalError(new Error(`connect ECONNREFUSED ${SECRET}`));
    };

    const result = await callTool(call, "mcp-http", "note", { body: "x" });

    const text = result.content.map((block) => block.text).join("");
    const structuredText = JSON.stringify(result.structuredContent);
    for (const channel of [text, structuredText]) {
      expect(channel).not.toContain(SECRET);
      expect(channel).not.toContain("ECONNREFUSED");
      expect(channel).not.toContain("hunter2");
    }
    // `unexpected` is withheld too — not because it is sensitive, but
    // because rendering it would put the key on every failure and make its
    // absence meaningless.
    expect(structured(result)).not.toHaveProperty("internalKind");
  });
});

// ── What to quote ────────────────────────────────────────────────────────

describe("requestId", () => {
  // An id echoed to a caller that names no log line is worse than echoing
  // none: it sends whoever reads the report looking for a record that does
  // not exist.
  test("is byte-equal to the id the failure was logged under", async () => {
    const call: ServiceCall = async () => {
      throw new InternalError(new Error("the service fell over"));
    };

    const body = structured(await callTool(call, "mcp-http", "note", { body: "x" }));
    const record = oneRecord(logs.stderr(), "MCP tool call failed unexpectedly.");

    expect(body.requestId).toBeTypeOf("string");
    expect(body.requestId).not.toBe("");
    expect(record?.requestId).toBe(body.requestId);
  });

  // Driven through a real service failure rather than a withheld tool name:
  // the id is minted before the withheld-tool interception, which returns
  // early without logging, so that path would look for a record that
  // correctly does not exist.
  test("is present on a refusal too, which is logged at debug", async () => {
    const call: ServiceCall = async () => {
      throw new GuardRejectedError("merge.requires_commit", "A merge needs a commit.");
    };

    const body = structured(await callTool(call, "mcp-http", "transition_item", {}));
    const record = oneRecord(logs.stderr(), "MCP tool call refused.");

    expect(body.requestId).toBeTypeOf("string");
    expect(record?.requestId).toBe(body.requestId);
    // A refusal keeps the service's own words: they are what an agent reads
    // to work out how to fix the call.
    expect(body.message).toBe("A merge needs a commit.");
    expect(body.guard).toBe("merge.requires_commit");
  });
});

// ── That saying more did not change what is compared ─────────────────────

describe("the rejection shape", () => {
  // The diagnosis keys are spread *alongside* `Rejection`, never into it.
  // §22 compares rejections across adapters by reducing them through
  // `renderRejection`, which reads only `code`, sorted `fields` and `guard`.
  // A rejection carrying the diagnosis must therefore reduce to the same
  // string as one without it — otherwise MCP's answer and the CLI's differ
  // for the same failure, and the cross-adapter assertion breaks.
  test("reduces identically with and without the diagnosis", () => {
    const error = new GuardRejectedError("merge.requires_commit", "A merge needs a commit.", {
      fields: ["state", "commitSha"],
    });

    const bare = structured(toolRejection(error));
    const diagnosed = structured(
      toolRejection(error, {
        requestId: "11111111-2222-3333-4444-555555555555",
        retryable: false,
        committed: false,
        internalKind: "timeout",
        message: "something else entirely",
      }),
    );

    const reduce = (body: Record<string, unknown>) =>
      renderRejection({
        code: body.code as ServiceErrorCode,
        fields: body.fields as string[],
        ...(typeof body.guard === "string" ? { guard: body.guard } : {}),
      });

    expect(reduce(diagnosed)).toBe(reduce(bare));
    expect(reduce(bare)).toBe("guard_rejected[commitSha,state]merge.requires_commit");
  });

  // A call site that supplies no diagnosis renders exactly what it always
  // did, which is what lets the second argument stay optional across the
  // adapter's other call sites.
  test("is unchanged when no diagnosis is supplied", () => {
    const body = structured(toolRejection(new NotFoundError("No such item.")));

    expect(body).toEqual({ code: "not_found", fields: [], message: "No such item." });
  });
});

// ── The messages themselves ──────────────────────────────────────────────

describe("the message", () => {
  // Every string is from a fixed set. The point is not the wording but that
  // none of it is built from the error, which is what keeps a driver message
  // from reaching a caller through the prose instead of through a field.
  test("tells the caller what to do in each case, and never quotes the cause", () => {
    const committed = internalMessageFor(true, false);
    const unknown = internalMessageFor("unknown", true);
    const transient = internalMessageFor(false, true);
    const terminal = internalMessageFor(false, false);

    expect(committed).toMatch(/completed/i);
    expect(committed).toMatch(/re-read/i);
    expect(unknown).toMatch(/may or may not/i);
    expect(transient).toMatch(/safe to retry/i);
    expect(terminal).toMatch(/request id/i);

    const all = [committed, unknown, transient, terminal];
    expect(new Set(all).size).toBe(all.length);
  });
});
