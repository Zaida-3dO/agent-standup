// A loop's `kind` — what it is tracking, as opposed to where it stands.
//
// **What would make this file hollow.** Asserting that a loop written with
// `kind: "note"` comes back with `kind: "note"` proves only that a string
// survived a round trip; it would pass against a fold that ignored the
// default, ignored edits, and let notes into every count. So each case below
// fixes a *decision* and names the single source change that breaks it, in a
// comment beside the assertion — the discipline `loop-lifecycle-fold.test.ts`
// already follows on this module.
//
// The decisions worth pinning, in the order they can go wrong:
//
//   1. An absent kind reads as `work`. This is the whole of the "no
//      migration, nothing breaks" claim — every loop written before the
//      field existed has no `kind` in its payload.
//   2. `blocked_on_person` COUNTS as work. Getting this wrong reintroduces
//      the harm the field exists to fix, pointed the optimistic way: an item
//      stalled awaiting a human would report zero open loops.
//   3. A kind-only edit is not discarded, and a text-only edit does not
//      reset the kind. These are the two halves of the separate-maps fold,
//      and the first was a silent no-op before it.
import { describe, expect, it } from "vitest";
import {
  countsAsWork,
  DEFAULT_LOOP_KIND,
  deriveLoops,
  deriveOpenLoops,
  LOOP_KINDS,
  parseLoopKind,
  type LoopEventLike,
  type LoopKind,
} from "@/lib/open-loops";
import { countNonWorkExcluded, selectLoops } from "@/lib/service/operations/loop-reads";

/** An opening event. `kind` is omitted entirely when not given — the legacy shape. */
function opened(
  id: number,
  loopId: string,
  text: string,
  kind?: LoopKind,
  ts = "2026-08-01T00:00:00.000Z",
) {
  return {
    id: BigInt(id),
    ts,
    type: "open_loop",
    payload: { loopId, text, ...(kind === undefined ? {} : { kind }) },
  } as LoopEventLike;
}

/** An edit that may carry text, a kind, or both — the three shapes the fold must tell apart. */
function edited(
  id: number,
  loopId: string,
  fields: { text?: string; kind?: LoopKind },
  ts = "2026-08-03T00:00:00.000Z",
) {
  return {
    id: BigInt(id),
    ts,
    type: "open_loop_edited",
    payload: { loopId, ...fields },
  } as LoopEventLike;
}

function closed(id: number, loopId: string, ts = "2026-08-02T00:00:00.000Z") {
  return { id: BigInt(id), ts, type: "open_loop_closed", payload: { loopId } } as LoopEventLike;
}

describe("parseLoopKind", () => {
  it("reads a kind that is one of the known labels", () => {
    // Killed by returning DEFAULT_LOOP_KIND unconditionally — the shape of a
    // parser that looks like it works because everything defaults to `work`.
    expect(parseLoopKind("note")).toBe("note");
    expect(parseLoopKind("blocked_on_person")).toBe("blocked_on_person");
  });

  it("falls back to work when the field is absent", () => {
    // **The migration-free claim, at its root.** Killed by throwing on
    // undefined, or by returning `note` as the default — either would
    // silently reclassify every loop written before this field existed.
    expect(parseLoopKind(undefined)).toBe("work");
    expect(parseLoopKind(null)).toBe("work");
  });

  it("falls back rather than throwing on a kind it does not recognise", () => {
    // Read-path tolerance, matching `deriveLoops`' posture on malformed
    // payloads. Killed by `throw` on an unknown label: a payload written by
    // a newer build would then make the whole item's loops unreadable, which
    // is the failure the fold's existing skip-don't-throw rule exists to
    // prevent. Killed equally by dropping the `includes` check, which would
    // let "urgent" through as if it were a real kind.
    expect(parseLoopKind("urgent")).toBe("work");
    expect(parseLoopKind(42)).toBe("work");
    expect(parseLoopKind({ kind: "note" })).toBe("work");
  });

  it("has work as the declared default", () => {
    // Killed by changing DEFAULT_LOOP_KIND to "note", which would make every
    // legacy loop vanish from every count at once.
    expect(DEFAULT_LOOP_KIND).toBe("work");
    expect(LOOP_KINDS).toEqual(["work", "note", "blocked_on_person"]);
  });
});

describe("countsAsWork", () => {
  it("counts a loop blocked on a person as work", () => {
    // **The finding that changed this design.** Killed by writing the rule
    // as `kind === "work"`, which is the obvious implementation and is
    // wrong: an item entirely stalled awaiting a human would then report
    // zero loops outstanding — misreporting in the optimistic direction,
    // which is exactly the harm this field exists to fix.
    expect(countsAsWork("blocked_on_person")).toBe(true);
  });

  it("counts ordinary work, and does not count a note", () => {
    // Killed by inverting the comparison, or by returning a constant.
    expect(countsAsWork("work")).toBe(true);
    expect(countsAsWork("note")).toBe(false);
  });
});

describe("deriveLoops resolving a loop's kind", () => {
  it("defaults a payload with no kind to work", () => {
    // The legacy row, folded. Killed by reading `payload.kind` directly
    // instead of through `parseLoopKind` — `undefined` would then surface as
    // the loop's kind and fail every `countsAsWork` comparison downstream.
    const [loop] = deriveLoops([opened(1, "loop-a", "the retry path is untested")]);
    expect(loop!.kind).toBe("work");
  });

  it("reads the kind the loop was opened with", () => {
    // Killed by hardcoding `kind: DEFAULT_LOOP_KIND` in the fold's output,
    // which would pass every default-case test in this file.
    const [loop] = deriveLoops([opened(1, "loop-a", "FOR TOMI — awaiting an answer", "note")]);
    expect(loop!.kind).toBe("note");
  });

  it("applies a kind-only edit rather than discarding it", () => {
    // **The silent no-op this design had to fix.** The fold's edited branch
    // `continue`s when there is no usable text, so reading the kind AFTER
    // that guard would throw a reclassification away entirely — the write
    // would succeed, return a receipt, and change nothing anybody could see.
    // Killed by moving the kind read below the `if (typeof text !== ...)
    // continue` line in `deriveLoops`.
    const [loop] = deriveLoops([
      opened(1, "loop-a", "INDEX of loop numbers"),
      edited(2, "loop-a", { kind: "note" }),
    ]);
    expect(loop!.kind).toBe("note");
    expect(loop!.text).toBe("INDEX of loop numbers");
  });

  it("leaves the kind alone when an edit changes only the text", () => {
    // Killed by folding kind edits into the same map as text edits: the
    // newest edit's *absent* kind would then overwrite the classification,
    // silently returning a deliberately-filed note to `work` the next time
    // anyone reworded it.
    const [loop] = deriveLoops([
      opened(1, "loop-a", "rough wording", "note"),
      edited(2, "loop-a", { text: "better wording" }),
    ]);
    expect(loop!.kind).toBe("note");
    expect(loop!.text).toBe("better wording");
  });

  it("takes the newest kind edit by event id, not the last one read", () => {
    // The ledger allows out-of-order reads (`Event.id` is allocated before
    // commit), which is why the fold resolves by id. Killed by weakening the
    // `id > previous.id` comparison to an unconditional assignment — the
    // older edit would then win whenever it arrived second.
    const [loop] = deriveLoops([
      opened(1, "loop-a", "x", "work"),
      edited(3, "loop-a", { kind: "blocked_on_person" }),
      edited(2, "loop-a", { kind: "note" }),
    ]);
    expect(loop!.kind).toBe("blocked_on_person");
  });

  it("lets an explicit kind: work reclassify a note back", () => {
    // Absent means "no statement"; sending `work` is a statement. Killed by
    // treating a falsy/default kind as absent when writing the edit.
    const [loop] = deriveLoops([
      opened(1, "loop-a", "x", "note"),
      edited(2, "loop-a", { kind: "work" }),
    ]);
    expect(loop!.kind).toBe("work");
  });

  it("carries the kind through deriveOpenLoops", () => {
    // The narrower shape `orientation` renders. Killed by omitting `kind`
    // from the projection, which would make every loop read as `work` on the
    // one path a resuming session actually uses.
    const [loop] = deriveOpenLoops([opened(1, "loop-a", "x", "blocked_on_person")]);
    expect(loop!.kind).toBe("blocked_on_person");
  });
});

describe("selectLoops filtering non-work", () => {
  const loops = deriveLoops([
    opened(1, "w", "real work"),
    opened(2, "n", "an index of loop numbers", "note"),
    opened(3, "b", "FOR TOMI — awaiting an answer", "blocked_on_person"),
  ]);

  it("excludes notes by default and keeps work and blocked-on-person", () => {
    // **The counting fix.** Killed by dropping the `countsAsWork` line from
    // `selectLoops`, and — separately and more subtly — by writing that line
    // as `loop.kind !== "work"`, which would also drop the blocked loop.
    const selected = selectLoops(loops, { includeClosed: false, includeDeleted: false });
    expect(selected.map((loop) => loop.loopId).sort()).toEqual(["b", "w"]);
  });

  it("returns notes when they are asked for", () => {
    // Killed by ignoring the flag — a filter with no opt-out would hide
    // deliberately-recorded notes from every read there is.
    const selected = selectLoops(loops, {
      includeClosed: false,
      includeDeleted: false,
      includeNonWork: true,
    });
    expect(selected.map((loop) => loop.loopId).sort()).toEqual(["b", "n", "w"]);
  });

  it("counts how many notes were held back", () => {
    // Killed by returning 0, or by counting every non-selected loop —
    // a closed work loop is withheld by a different rule and must not be
    // reported as a suppressed note.
    expect(countNonWorkExcluded(loops, { includeClosed: false, includeDeleted: false })).toBe(1);
  });

  it("does not count a closed note as held back by the non-work rule", () => {
    // The two exclusion rules are independent and the report must not
    // conflate them. Killed by computing the excluded count over every loop
    // rather than over the ones the status filters would have returned.
    const withClosedNote = deriveLoops([
      opened(1, "w", "real work"),
      opened(2, "n", "a note", "note"),
      closed(3, "n"),
    ]);
    expect(
      countNonWorkExcluded(withClosedNote, { includeClosed: false, includeDeleted: false }),
    ).toBe(0);
  });

  it("still applies the status rules to non-work loops when they are included", () => {
    // Killed by returning `true` early for a note once `includeNonWork` is
    // set, which would leak deleted and closed notes into an ordinary read.
    const withClosedNote = deriveLoops([opened(1, "n", "a note", "note"), closed(2, "n")]);
    expect(
      selectLoops(withClosedNote, {
        includeClosed: false,
        includeDeleted: false,
        includeNonWork: true,
      }),
    ).toEqual([]);
  });
});
