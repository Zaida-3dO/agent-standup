// `deriveLoops` — the fold that resolves a loop's whole lifecycle from the
// events it is made of.
//
// **What would make this file hollow.** Asserting "three events in, one loop
// out" would pass against a fold that ignored every payload and returned the
// opens unchanged. So each case here fixes a *decision* the fold makes and
// names the single change to the source that breaks it, in a comment beside
// the assertion — the discipline the existing `open-loops.test.ts` follows.
// A test whose breaking mutation cannot be named is not testing anything.
//
// Pure, so no database: the fold is the part that decides what a loop *is*,
// and that decision is worth stating as an assertion about a function rather
// than inferred from what a query returned.
import { describe, expect, it } from "vitest";
import {
  deriveLoops,
  deriveOpenLoops,
  parseOpenLoopDeletedPayload,
  parseOpenLoopEditedPayload,
  InvalidOpenLoopPayloadError,
  type LoopEventLike,
} from "@/lib/open-loops";

function opened(id: number, loopId: string, text: string, ts = "2026-08-01T00:00:00.000Z") {
  return { id: BigInt(id), ts, type: "open_loop", payload: { loopId, text } } as LoopEventLike;
}
function closed(id: number, loopId: string, ts = "2026-08-02T00:00:00.000Z") {
  return { id: BigInt(id), ts, type: "open_loop_closed", payload: { loopId } } as LoopEventLike;
}
function edited(id: number, loopId: string, text: string, ts = "2026-08-03T00:00:00.000Z") {
  return {
    id: BigInt(id),
    ts,
    type: "open_loop_edited",
    payload: { loopId, text },
  } as LoopEventLike;
}
function deleted(
  id: number,
  loopId: string,
  reason = "a duplicate of loop-a",
  ts = "2026-08-04T00:00:00.000Z",
) {
  return {
    id: BigInt(id),
    ts,
    type: "open_loop_deleted",
    payload: { loopId, reason },
  } as LoopEventLike;
}

describe("deriveLoops — status", () => {
  it("reports a loop with only an open as open", () => {
    const loop = deriveLoops([opened(1, "loop-a", "the retry path is untested")])[0]!;
    expect(loop.status).toBe("open");
    expect(loop.closedAt).toBeNull();
    expect(loop.deletedAt).toBeNull();
  });

  it("reports a closed loop as closed, and keeps it in the result", () => {
    // The "keeps it" half is the point: `deriveOpenLoops` drops closed loops
    // entirely, so a fold that merely reused it would return nothing here
    // and `includeClosed` could never work. Killed by changing the
    // `status` ternary's `closed !== null` branch to return "open".
    const loops = deriveLoops([opened(1, "loop-a", "untested"), closed(2, "loop-a")]);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.status).toBe("closed");
    expect(loops[0]!.closedAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("reports a deleted loop as deleted", () => {
    const loops = deriveLoops([opened(1, "loop-a", "untested"), deleted(2, "loop-a")]);
    expect(loops[0]!.status).toBe("deleted");
    expect(loops[0]!.deletedAt).toBe("2026-08-04T00:00:00.000Z");
  });

  it("prefers deleted over closed when a loop was both", () => {
    // The precedence rule, stated as a test because it is a decision and not
    // an accident: a retracted loop must never be reported as resolved.
    // Killed by swapping the order of the two branches in the `status`
    // ternary — `closed !== null ? "closed" : deleted !== null ? ...`.
    const loops = deriveLoops([
      opened(1, "loop-a", "untested"),
      closed(2, "loop-a"),
      deleted(3, "loop-a"),
    ]);
    expect(loops[0]!.status).toBe("deleted");
  });

  it("resolves a close read before its own open", () => {
    // `Event.id` is allocated before commit, so sequence order is not commit
    // order (SCHEMA.md §3) and this ordering is genuinely possible. Killed
    // by collapsing the two passes into one that only cancels a loop it has
    // already seen opened.
    const loops = deriveLoops([closed(2, "loop-a"), opened(1, "loop-a", "untested")]);
    expect(loops[0]!.status).toBe("closed");
  });

  it("resolves a delete read before its own open", () => {
    const loops = deriveLoops([deleted(2, "loop-a"), opened(1, "loop-a", "untested")]);
    expect(loops[0]!.status).toBe("deleted");
  });

  it("ignores a close naming a loop that was never opened", () => {
    // The read is a slice of the ledger and the open may be older than the
    // window, so an orphan close must not invent a loop. Killed by having
    // the first pass push a row for an unmatched close.
    expect(deriveLoops([closed(9, "loop-from-last-week")])).toEqual([]);
  });
});

describe("deriveLoops — edits", () => {
  it("reports the edited text in place of the original", () => {
    // Killed by changing `edit?.text ?? text` to plain `text`.
    const loops = deriveLoops([
      opened(1, "loop-a", "the retry path is untested"),
      edited(2, "loop-a", "the retry path is untested on cold boot"),
    ]);
    expect(loops[0]!.text).toBe("the retry path is untested on cold boot");
    expect(loops[0]!.editedAt).toBe("2026-08-03T00:00:00.000Z");
  });

  it("keeps openedAt at the original open, not the edit", () => {
    // `openedAt` means "when this became an open question", and refining the
    // wording does not restart the question. Killed by sourcing `openedAt`
    // from the edit event.
    const loops = deriveLoops([
      opened(1, "loop-a", "first wording", "2026-08-01T00:00:00.000Z"),
      edited(2, "loop-a", "second wording", "2026-08-09T00:00:00.000Z"),
    ]);
    expect(loops[0]!.openedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("takes the newest edit by event id, not the last one encountered", () => {
    // The out-of-order case, which is the whole reason the fold compares ids
    // rather than overwriting. Killed by replacing the `id > previous.id`
    // comparison with an unconditional `edits.set(...)`.
    const loops = deriveLoops([
      opened(1, "loop-a", "first"),
      edited(9, "loop-a", "newest"),
      edited(4, "loop-a", "middle"),
    ]);
    expect(loops[0]!.text).toBe("newest");
  });

  it("reports editedAt as null for a loop never edited", () => {
    expect(deriveLoops([opened(1, "loop-a", "untested")])[0]!.editedAt).toBeNull();
  });

  it("ignores an edit whose text is empty", () => {
    // Matches the opening event's own rule; an empty edit must not blank a
    // loop. Killed by removing the `text.trim() === ""` guard in the edit
    // branch.
    const loops = deriveLoops([opened(1, "loop-a", "the real text"), edited(2, "loop-a", "   ")]);
    expect(loops[0]!.text).toBe("the real text");
  });

  it("ignores an edit naming a loop that does not exist here", () => {
    expect(deriveLoops([edited(2, "ghost", "text")])).toEqual([]);
  });
});

describe("deriveLoops — tolerance on the read path", () => {
  it("skips an event whose payload is not an object", () => {
    const loops = deriveLoops([
      { id: 1n, ts: "2026-08-01T00:00:00.000Z", type: "open_loop", payload: "nonsense" },
      opened(2, "loop-a", "real"),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-a"]);
  });

  it("skips an open with no loopId rather than throwing", () => {
    // The read path tolerates what the write path refuses — one bad
    // historical row must not make an item's loops permanently unreadable.
    // Killed by making the fold throw on a missing loopId.
    const loops = deriveLoops([
      { id: 1n, ts: "2026-08-01T00:00:00.000Z", type: "open_loop", payload: { text: "orphan" } },
      opened(2, "loop-a", "real"),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-a"]);
  });

  it("ignores an unrelated event type entirely", () => {
    // Killed by loosening either type comparison from `===`/`!==` to a
    // truthiness check — a checkpoint would then be folded in as a loop.
    const loops = deriveLoops([
      { id: 1n, ts: "2026-08-01T00:00:00.000Z", type: "checkpoint", payload: { loopId: "x" } },
      opened(2, "loop-a", "real"),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["loop-a"]);
  });

  it("treats a loop opened twice as one loop, keeping the first", () => {
    const loops = deriveLoops([
      opened(1, "loop-a", "first", "2026-08-01T00:00:00.000Z"),
      opened(2, "loop-a", "second", "2026-08-05T00:00:00.000Z"),
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.openedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns an empty list for no events", () => {
    expect(deriveLoops([])).toEqual([]);
  });
});

describe("deriveOpenLoops, expressed over deriveLoops", () => {
  it("hides a deleted loop from the open-loop read", () => {
    // This is the assertion that makes deletion mean something. Every
    // whole-context read — orientation, progress_report, the item-detail
    // status view — goes through `deriveOpenLoops`, so if a deleted loop
    // survived here, "delete" would only mean "hidden from loop_list".
    // Killed by changing the `status === "open"` filter to
    // `status !== "closed"`.
    const events = [opened(1, "loop-a", "untested"), deleted(2, "loop-a")];
    expect(deriveLoops(events)).toHaveLength(1);
    expect(deriveOpenLoops(events)).toEqual([]);
  });

  it("carries an edit's text through to the open-loop read", () => {
    // Killed by having `deriveOpenLoops` map `text` from the raw opening
    // event rather than from the derived loop.
    const loops = deriveOpenLoops([
      opened(1, "loop-a", "old wording"),
      edited(2, "loop-a", "new wording"),
    ]);
    expect(loops[0]!.text).toBe("new wording");
  });

  it("still hides a closed loop", () => {
    expect(deriveOpenLoops([opened(1, "loop-a", "x"), closed(2, "loop-a")])).toEqual([]);
  });

  it("returns only the four fields its own shape declares", () => {
    // `OpenLoop` is a narrower type than `DerivedLoop`, and its consumers
    // render it. Killed by spreading the derived loop instead of naming the
    // four fields, which would leak `status`/`deletedReason` into a shape
    // that does not declare them.
    const loop = deriveOpenLoops([opened(1, "loop-a", "untested")])[0]!;
    expect(Object.keys(loop).sort()).toEqual(["eventId", "loopId", "openedAt", "text"]);
  });
});

describe("the lifecycle payload parsers", () => {
  it("accepts a well-formed edit payload", () => {
    expect(parseOpenLoopEditedPayload({ loopId: "a", text: "b" })).toEqual({
      loopId: "a",
      text: "b",
    });
  });

  it("refuses an edit payload with no text", () => {
    // The write path guards, where the read path tolerates. Killed by
    // having `parseOpenLoopEditedPayload` return a default instead of
    // throwing.
    expect(() => parseOpenLoopEditedPayload({ loopId: "a" })).toThrow(InvalidOpenLoopPayloadError);
  });

  it("refuses an edit payload with a blank loopId", () => {
    expect(() => parseOpenLoopEditedPayload({ loopId: "  ", text: "b" })).toThrow(
      InvalidOpenLoopPayloadError,
    );
  });

  it("reads a deletion reason when one is present", () => {
    expect(parseOpenLoopDeletedPayload({ loopId: "a", reason: "duplicate" })).toEqual({
      loopId: "a",
      reason: "duplicate",
    });
  });

  it("accepts a deletion payload with no reason, reporting null", () => {
    // Optional on the READ parser and required by the operation — a
    // historical row must stay readable. Killed by making `reason` required
    // here, which would make the fold throw on any row written before the
    // rule existed.
    expect(parseOpenLoopDeletedPayload({ loopId: "a" })).toEqual({ loopId: "a", reason: null });
  });

  it("refuses a deletion payload with no loopId", () => {
    expect(() => parseOpenLoopDeletedPayload({ reason: "x" })).toThrow(InvalidOpenLoopPayloadError);
  });
});
