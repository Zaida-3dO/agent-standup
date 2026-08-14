// MILESTONES.md #42 — session enforcement (`src/lib/hook/enforcement.ts`).
//
// This is the seam the forced-takeover row drives: once a live session is
// displaced, the mechanism that refuses its subsequent tool calls is this
// hook. The tests below pin the two properties that row depends on, because
// both are easy to break by a change that looks harmless:
//
//   1. **A non-`active` status refuses**, and the refusal names which one.
//   2. **An unrecognised status refuses too.** The tempting implementation
//      — `if (status === "displaced") deny` — passes every happy-path test
//      and silently permits a status added later by the server.
import { describe, expect, it } from "vitest";
import {
  SESSION_STATUSES,
  enforcementRefusal,
  isSessionStatus,
  readSessionStatus,
  type SessionEnforcement,
} from "@/lib/hook/enforcement";

describe("enforcementRefusal lets an ordinary session through", () => {
  it("returns null when nothing is known about the session", () => {
    // The state before the wiring row lands, and on any machine whose
    // enforcement source is absent. It must not deny — that would refuse
    // every tool call everywhere the day this ships.
    expect(enforcementRefusal(undefined)).toBeNull();
  });

  it("returns null for an explicitly active session", () => {
    expect(enforcementRefusal({ status: "active" })).toBeNull();
  });
});

describe("enforcementRefusal refuses a session that may not act", () => {
  it("refuses a displaced session and says the work was taken over", () => {
    const refusal = enforcementRefusal({ status: "displaced" });
    expect(refusal?.status).toBe("displaced");
    // The message has to be actionable: an agent that reads "denied" with no
    // cause retries into the same wall until it exhausts its budget.
    expect(refusal?.reason).toContain("taken over");
    expect(refusal?.reason).toContain("Stop here");
  });

  it("refuses an unregistered session", () => {
    const refusal = enforcementRefusal({ status: "unregistered" });
    expect(refusal?.status).toBe("unregistered");
    expect(refusal?.reason).toContain("register");
  });

  it("refuses a session whose hook is below the minimum supported version", () => {
    const refusal = enforcementRefusal({ status: "incompatible" });
    expect(refusal?.status).toBe("incompatible");
    expect(refusal?.reason).toContain("Update");
  });

  it("refuses every non-active status in the list, not only the ones spelled out above", () => {
    // Guards against a status being added to SESSION_STATUSES without a
    // reason, which would fall through the REASONS lookup to `undefined`.
    for (const status of SESSION_STATUSES) {
      const refusal = enforcementRefusal({ status });
      if (status === "active") {
        expect(refusal).toBeNull();
        continue;
      }
      expect(refusal, `expected ${status} to refuse`).not.toBeNull();
      expect(typeof refusal?.reason).toBe("string");
      expect(refusal?.reason.length).toBeGreaterThan(0);
    }
  });

  it("refuses a status this build does not recognise", () => {
    // The one that a `=== "displaced"` implementation would let through.
    // A status the server invented is a statement this build cannot honour,
    // and "I do not understand what you said about this session" is not a
    // reason to carry on.
    const unknown = { status: "quarantined" } as unknown as SessionEnforcement;
    const refusal = enforcementRefusal(unknown);
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toContain("does not recognise");
  });

  it("appends the server's detail to the reason when there is one", () => {
    const refusal = enforcementRefusal({
      status: "displaced",
      detail: "taken over by session s-9",
    });
    expect(refusal?.reason).toContain("taken over by session s-9");
  });

  it("does not append an empty detail", () => {
    const refusal = enforcementRefusal({ status: "displaced", detail: "" });
    expect(refusal?.reason).not.toContain("()");
  });
});

describe("readSessionStatus normalises what a server or a file volunteered", () => {
  it("reads a status and its detail", () => {
    expect(readSessionStatus({ status: "displaced", detail: "d" })).toEqual({
      status: "displaced",
      detail: "d",
    });
  });

  it("keeps a status it does not recognise rather than dropping it", () => {
    // Dropping it would turn "the server said something unreadable about
    // this session" into "the server said nothing", which is the silent
    // downgrade the module exists to prevent. Kept, so the unrecognised
    // branch of enforcementRefusal is reachable rather than dead.
    const read = readSessionStatus({ status: "quarantined" });
    expect(read).not.toBeUndefined();
    expect(enforcementRefusal(read)).not.toBeNull();
  });

  it("returns undefined for a value carrying no status", () => {
    expect(readSessionStatus(undefined)).toBeUndefined();
    expect(readSessionStatus(null)).toBeUndefined();
    expect(readSessionStatus("displaced")).toBeUndefined();
    expect(readSessionStatus({})).toBeUndefined();
    expect(readSessionStatus({ status: 3 })).toBeUndefined();
  });

  it("drops a non-string detail rather than carrying it into the reason", () => {
    expect(readSessionStatus({ status: "displaced", detail: 7 })).toEqual({ status: "displaced" });
  });
});

describe("the status list", () => {
  it("is exactly the four the hook enforces", () => {
    expect(SESSION_STATUSES).toEqual(["active", "displaced", "unregistered", "incompatible"]);
  });

  it("isSessionStatus rejects non-strings and unknown strings", () => {
    expect(isSessionStatus("displaced")).toBe(true);
    expect(isSessionStatus("Displaced")).toBe(false);
    expect(isSessionStatus(null)).toBe(false);
  });
});
