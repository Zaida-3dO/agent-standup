// Applying an action to many items — T6-E's second half.
//
// The two things worth proving here are the two the row asks about
// directly: that **every request carries that item's own `expectedFrom`**
// (#257), and that a **partial bulk is reported as partial** rather than as
// a success. Both are assertions about what leaves this module, so the
// `fetch` is stubbed and the recorded calls are the subject.
import { describe, expect, it, vi } from "vitest";
import { describeBulkOutcome, runBulkTransition } from "@/lib/board/bulk";
import type { BoardEntry } from "@/lib/board/types";

function entry(id: string, state: string, title = `Item ${id}`): BoardEntry {
  return {
    item: {
      id,
      title,
      headline: null,
      kind: "task",
      state,
      priority: "P1",
      area: "web",
      repo: null,
      blockedOnPersonId: null,
      blockedOnType: null,
      blockedReason: null,
      pauseReason: null,
    },
    column: "backlog",
    assignments: [],
    trust: null,
    subtasks: null,
  };
}

/** Records every call, answering each URL from `answers` (default: 200). */
function stubFetch(answers: Record<string, { status: number; body?: unknown }> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: JSON.parse(String(init?.body ?? "{}")) });
    const match = Object.keys(answers).find((id) => href.includes(id));
    const answer = match ? answers[match] : undefined;
    if (!answer || answer.status < 400) {
      return new Response(JSON.stringify({ item: {} }), { status: answer?.status ?? 200 });
    }
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

describe("runBulkTransition — expectedFrom", () => {
  it("sends each item's OWN state as expectedFrom, not the target", () => {
    // The property the row calls out: a bulk selects across columns, so a
    // single shared `expectedFrom` would be wrong for all but one item —
    // and would either refuse everything or silently clobber whatever
    // another session had just done. Asserting the whole mapping catches an
    // implementation that reused the first entry's state for all of them.
    const { calls, impl } = stubFetch();
    return runBulkTransition(
      [entry("a", "executing"), entry("b", "on_deck"), entry("c", "planning")],
      "in_review",
      impl,
    ).then(() => {
      expect(calls.map((call) => call.body.expectedFrom)).toEqual([
        "executing",
        "on_deck",
        "planning",
      ]);
    });
  });

  it("sends the requested target as `to` on every item", () => {
    const { calls, impl } = stubFetch();
    return runBulkTransition([entry("a", "executing"), entry("b", "on_deck")], "merged", impl).then(
      () => {
        expect(calls.map((call) => call.body.to)).toEqual(["merged", "merged"]);
      },
    );
  });

  it("posts to each item's own transition endpoint", () => {
    const { calls, impl } = stubFetch();
    return runBulkTransition([entry("a", "executing"), entry("b", "on_deck")], "merged", impl).then(
      () => {
        // Through `uiApiPath`, so the `/api/ui` prefix is present — the
        // exact thing a T17 crew's stub missed while all its pure tests
        // stayed green.
        expect(calls[0]?.url).toContain("/items/a/transition");
        expect(calls[1]?.url).toContain("/items/b/transition");
      },
    );
  });
});

describe("runBulkTransition — partial failure", () => {
  it("continues past a refusal and applies the rest", async () => {
    // The partial decision, asserted as behaviour rather than as prose: a
    // refused second item must not cancel the third. An implementation that
    // stopped at the first refusal (as `runUndo` deliberately does) would
    // send two requests here instead of three.
    const { calls, impl } = stubFetch({
      "/items/b/": { status: 422, body: { error: { message: "A guard said no." } } },
    });
    const outcome = await runBulkTransition(
      [entry("a", "on_deck"), entry("b", "on_deck"), entry("c", "on_deck")],
      "executing",
      impl,
    );
    expect(calls).toHaveLength(3);
    expect(outcome.moved.map((move) => move.itemId)).toEqual(["a", "c"]);
    expect(outcome.refused.map((refusal) => refusal.itemId)).toEqual(["b"]);
  });

  it("carries the server's own refusal message", async () => {
    // A guard's rejection text names the field it wants, so it is worth
    // more than anything invented here.
    const { impl } = stubFetch({
      "/items/a/": { status: 422, body: { error: { message: "needs a blocked_reason" } } },
    });
    const outcome = await runBulkTransition([entry("a", "on_deck")], "blocked", impl);
    expect(outcome.refused[0]?.message).toBe("needs a blocked_reason");
  });

  it("reads the item's actual state out of a 409", async () => {
    // This is what `expectedFrom` buys: the conflict names where the item
    // really is, which is the fact that makes the refusal checkable against
    // the row rather than a shrug.
    const { impl } = stubFetch({
      "/items/a/": {
        status: 409,
        body: {
          error: {
            message: "stale",
            details: { itemId: "a", expectedFrom: "on_deck", currentState: "merged" },
          },
        },
      },
    });
    const outcome = await runBulkTransition([entry("a", "on_deck")], "executing", impl);
    expect(outcome.refused[0]?.currentState).toBe("merged");
  });

  it("leaves currentState null when the server did not name one", async () => {
    // A confidently wrong state would be worse than none — the same rule
    // `conflictDetailsFrom` follows for a 409 whose details cannot be read.
    const { impl } = stubFetch({ "/items/a/": { status: 500, body: {} } });
    const outcome = await runBulkTransition([entry("a", "on_deck")], "executing", impl);
    expect(outcome.refused[0]?.currentState).toBeNull();
  });

  it("reports a network failure as a refusal, not as a move", async () => {
    const impl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const outcome = await runBulkTransition([entry("a", "on_deck")], "executing", impl);
    expect(outcome.moved).toHaveLength(0);
    expect(outcome.refused[0]?.currentState).toBeNull();
  });

  it("records each move with the origin state the undo will need", async () => {
    // `moved` is handed straight to `UndoableAction`'s bulk kind, whose
    // `inverseOf` gives every item its OWN origin back. A move recorded
    // with the wrong `from` would undo the item to a state it was never in.
    const { impl } = stubFetch();
    const outcome = await runBulkTransition(
      [entry("a", "executing"), entry("b", "planning")],
      "in_review",
      impl,
    );
    expect(outcome.moved).toEqual([
      { itemId: "a", from: "executing", to: "in_review" },
      { itemId: "b", from: "planning", to: "in_review" },
    ]);
  });

  it("reports progress after each item", async () => {
    // A bulk is sequential and the reader is watching a count; this is what
    // makes a slow bulk distinguishable from a hung one.
    const { impl } = stubFetch();
    const seen: number[] = [];
    await runBulkTransition(
      [entry("a", "on_deck"), entry("b", "on_deck"), entry("c", "on_deck")],
      "executing",
      impl,
      (done) => seen.push(done),
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("describeBulkOutcome", () => {
  const move = (id: string) => ({ itemId: id, from: "on_deck" as const, to: "executing" as const });
  const refusal = (id: string) => ({
    itemId: id,
    title: `Item ${id}`,
    message: "no",
    currentState: null,
  });

  it("reports a clean bulk plainly", () => {
    expect(describeBulkOutcome({ moved: [move("a"), move("b")], refused: [] }, "executing")).toBe(
      "Moved 2 items to executing.",
    );
  });

  it("agrees the noun for a single item", () => {
    // The single-item selection is the one a demo hits first, and "1 items"
    // in front of a person is the classic version of this bug.
    expect(describeBulkOutcome({ moved: [move("a")], refused: [] }, "executing")).toBe(
      "Moved 1 item to executing.",
    );
  });

  it("leads with the shortfall on a partial, never with the success", () => {
    // This is the sentence the whole partial decision stands on. A bulk
    // that half-worked and said "Moved 4 items" would be exactly the
    // dishonest report the choice was made to avoid — so the assertion is
    // that BOTH numbers are present and the refused count is named.
    const message = describeBulkOutcome(
      { moved: [move("a"), move("b")], refused: [refusal("c"), refusal("d")] },
      "executing",
    );
    expect(message).toBe("Moved 2 of 4 to executing — 2 refused.");
  });

  it("does not claim a move when nothing moved", () => {
    const message = describeBulkOutcome(
      { moved: [], refused: [refusal("a"), refusal("b")] },
      "executing",
    );
    expect(message).toBe("None of the 2 items could be moved to executing.");
    expect(message).not.toContain("Moved");
  });

  it("words the single total refusal without a count", () => {
    expect(describeBulkOutcome({ moved: [], refused: [refusal("a")] }, "executing")).toBe(
      "That item could not be moved to executing.",
    );
  });
});
