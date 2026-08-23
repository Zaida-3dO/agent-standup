// The status block's derivations — the answers to "why is this stuck",
// asserted as values before anything renders them.
//
// Every test here names a single behaviour that a one-character change to
// `src/lib/item-detail/status.ts` would break. That is the bar deliberately:
// a test that passes whatever the module does is a test that will keep
// passing when the module stops being right.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ageMsOf,
  blockedLabel,
  blockedOn,
  isKnownLiveness,
  latestCheckpoint,
  livenessPresentation,
  openLoops,
  roleLabel,
  statusSummary,
  type DetailLiveness,
} from "@/lib/item-detail/status";
import {
  checkpointHeadline,
  deriveHeadlineFromBody,
  CHECKPOINT_HEADLINE_MAX_CHARS,
} from "@/lib/item-detail/checkpoint-headline";
// The SERVER's copy of the same rule. Imported here and nowhere else in the
// front end: this file is the seam that pins the two together, and importing
// it is safe precisely because the only thing the server module pulls in is
// a *type* (`TransactionHandle`), which is erased at build time and so never
// reaches a bundle. See the pinning suite at the bottom of this file.
import {
  checkpointHeadline as serverCheckpointHeadline,
  deriveHeadlineFromBody as serverDeriveHeadlineFromBody,
  CHECKPOINT_HEADLINE_MAX_CHARS as SERVER_CHECKPOINT_HEADLINE_MAX_CHARS,
} from "@/lib/service/items/checkpoint-headline";
import type {
  DetailAssignment,
  DetailHistoryEntry,
  DetailItem,
  ItemDetail,
} from "@/lib/item-detail/types";

function item(overrides: Partial<DetailItem> = {}): DetailItem {
  return {
    id: "item-1",
    parentId: null,
    title: "An item",
    headline: null,
    body: "",
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: null,
    branch: null,
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    unblockAt: null,
    pauseReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    originType: "person",
    ...overrides,
  };
}

function event(overrides: Partial<DetailHistoryEntry> = {}): DetailHistoryEntry {
  return {
    id: "1",
    ts: "2026-01-01T00:00:00.000Z",
    type: "checkpoint",
    actorType: "agent",
    actorId: null,
    sessionId: null,
    body: null,
    payload: null,
    headline: null,
    ...overrides,
  };
}

function assignment(overrides: Partial<DetailAssignment> = {}): DetailAssignment {
  return {
    id: "asn-1",
    holderId: "agent-1",
    holderType: "agent",
    displayName: "A holder",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: "2026-01-01T00:00:00.000Z",
    machine: "a-machine",
    branch: null,
    worktree: null,
    model: null,
    effort: null,
    sessionId: "sess-1",
    rootSessionId: "sess-1",
    pid: null,
    claimedAt: "2026-01-01T00:00:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

describe("livenessPresentation", () => {
  const values: DetailLiveness[] = ["running", "stalled", "dead", "superseded"];

  it("gives all four values a distinct word AND a distinct shape", () => {
    // The acceptance criterion stated as an assertion. Collapsing any two
    // — most temptingly `superseded` into `dead` — makes one of these sets
    // three long and fails.
    const words = values.map((v) => livenessPresentation(v).word);
    const shapes = values.map((v) => livenessPresentation(v).shape);
    expect(new Set(words).size).toBe(4);
    expect(new Set(shapes).size).toBe(4);
  });

  it("does not treat superseded as dead", () => {
    // Stated separately from the set-size check above because that check
    // would still pass if `superseded` and `dead` swapped presentations
    // with each other. This one pins the pair specifically.
    const superseded = livenessPresentation("superseded");
    const dead = livenessPresentation("dead");
    expect(superseded.word).not.toBe(dead.word);
    expect(superseded.shape).not.toBe(dead.shape);
    // A takeover is a normal handover, so its hint must not read as failure.
    expect(superseded.hint).toContain("handover");
  });

  it("falls back to the dead presentation for a value it has never seen", () => {
    // Degrading to "we cannot vouch for this session" is the honest reading
    // of an unknown value, and it keeps the screen up.
    expect(livenessPresentation("hibernating")).toEqual(livenessPresentation("dead"));
  });

  it("knows exactly the four values, and no others", () => {
    for (const value of values) expect(isKnownLiveness(value)).toBe(true);
    expect(isKnownLiveness("live")).toBe(false);
    expect(isKnownLiveness("hibernating")).toBe(false);
    // Not fooled by inherited object properties — `"toString" in LIVENESS`
    // is true, so a membership test written with `in` would answer yes here.
    expect(isKnownLiveness("toString")).toBe(false);
  });
});

describe("roleLabel", () => {
  it("reads an underscored role as words", () => {
    expect(roleLabel({ role: "visual_reviewer", roleCustom: null })).toBe("visual reviewer");
  });

  it("shows a custom role's own name rather than the word custom", () => {
    // `roleCustom` exists precisely so a custom role can say what it is;
    // falling through to "custom" would render the placeholder.
    expect(roleLabel({ role: "custom", roleCustom: "release captain" })).toBe("release captain");
  });

  it("falls back to the word when a custom role has no name recorded", () => {
    expect(roleLabel({ role: "custom", roleCustom: null })).toBe("custom");
  });

  it("ignores roleCustom on a non-custom role", () => {
    // A stale `roleCustom` on a builder must not override the real role —
    // otherwise a leftover value silently relabels a known role.
    expect(roleLabel({ role: "builder", roleCustom: "something else" })).toBe("builder");
  });
});

describe("blockedOn", () => {
  it("is null when the item is not blocked, even with a reason left on the row", () => {
    // The column is not cleared when an item moves on, so reading the
    // reason as the trigger would report a long-unblocked item as blocked.
    expect(
      blockedOn(item({ state: "executing", blockedReason: "a stale reason from before" })),
    ).toBeNull();
  });

  it("tells the three kinds apart", () => {
    const person = blockedOn(
      item({ state: "blocked", blockedOnType: "person", blockedOnPersonId: "p-1" }),
    );
    const external = blockedOn(item({ state: "blocked", blockedOnType: "external_process" }));
    const time = blockedOn(
      item({ state: "blocked", blockedOnType: "time", unblockAt: "2026-02-01T00:00:00.000Z" }),
    );
    expect(person?.kind).toBe("person");
    expect(external?.kind).toBe("external_process");
    expect(time?.kind).toBe("time");
  });

  it("carries the person on a person block", () => {
    const blocked = blockedOn(
      item({ state: "blocked", blockedOnType: "person", blockedOnPersonId: "p-1" }),
    );
    expect(blocked).toEqual({ kind: "person", personId: "p-1", reason: null });
  });

  it("carries the unblock time on a time block", () => {
    const blocked = blockedOn(
      item({ state: "blocked", blockedOnType: "time", unblockAt: "2026-02-01T00:00:00.000Z" }),
    );
    expect(blocked).toEqual({
      kind: "time",
      unblockAt: "2026-02-01T00:00:00.000Z",
      reason: null,
    });
  });

  it("does not put a person or a clock on an external-process block", () => {
    // The union's whole point: only the fields that mean something for a
    // kind are present, so a renderer cannot print "unblocks at —" on a
    // blocker with no clock.
    const blocked = blockedOn(
      item({
        state: "blocked",
        blockedOnType: "external_process",
        blockedOnPersonId: "p-1",
        unblockAt: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(blocked).toEqual({ kind: "external_process", reason: null });
  });

  it("says so rather than guessing when the kind was never recorded", () => {
    // Guessing `person` would route the item into somebody's queue on no
    // evidence — a sibling surface reads exactly this distinction.
    const blocked = blockedOn(item({ state: "blocked", blockedReason: "something" }));
    expect(blocked).toEqual({ kind: "unspecified", reason: "something" });
  });

  it("gives each kind its own label", () => {
    const labels = (["person", "external_process", "time", "unspecified"] as const).map(
      blockedLabel,
    );
    expect(new Set(labels).size).toBe(4);
    expect(blockedLabel("person")).toContain("person");
  });
});

describe("latestCheckpoint", () => {
  it("is null when there is no checkpoint", () => {
    expect(
      latestCheckpoint([event({ type: "state_change", body: "not a checkpoint" })]),
    ).toBeNull();
  });

  it("ignores non-checkpoint events even when they carry a headline", () => {
    // Otherwise any headlined event would masquerade as "where this got to".
    expect(latestCheckpoint([event({ type: "note", headline: "a note's headline" })])).toBeNull();
  });

  it("takes the NEWEST checkpoint, not the first one it walks past", () => {
    const result = latestCheckpoint([
      event({ id: "2", headline: "newer" }),
      event({ id: "1", headline: "older" }),
    ]);
    expect(result?.headline).toBe("newer");
  });

  it("orders by id numerically, not as strings", () => {
    // A string compare puts "9" after "10", so this fixture is the one that
    // separates the two implementations.
    const result = latestCheckpoint([
      event({ id: "9", headline: "nine" }),
      event({ id: "10", headline: "ten" }),
    ]);
    expect(result?.headline).toBe("ten");
  });

  it("orders ids beyond Number.MAX_SAFE_INTEGER correctly", () => {
    // Past 2^53 a `Number` comparison reports these two distinct ids as
    // equal, and the first one walked would win by accident.
    const result = latestCheckpoint([
      event({ id: "9007199254740993", headline: "lower" }),
      event({ id: "9007199254740995", headline: "higher" }),
    ]);
    expect(result?.headline).toBe("higher");
  });

  it("prefers a stored headline over one derived from the prose", () => {
    // The precedence rule. A version that derived first and used the column
    // as ITS fallback returns a plausible line every time and is caught
    // only here, where the two sources disagree.
    const result = latestCheckpoint([
      event({ headline: "the stored line", body: "a different first line\nmore prose" }),
    ]);
    expect(result?.headline).toBe("the stored line");
  });

  it("derives from the prose when no headline was stored", () => {
    const result = latestCheckpoint([event({ headline: null, body: "  first line  \nsecond" })]);
    expect(result?.headline).toBe("first line");
  });

  it("is null when the newest checkpoint has neither a headline nor prose", () => {
    // And specifically does NOT fall back to an older checkpoint that does
    // have one — the newest is the answer, and a stale resume point
    // presented as current is worse than none.
    const result = latestCheckpoint([
      event({ id: "2", headline: null, body: null }),
      event({ id: "1", headline: "an older line" }),
    ]);
    expect(result).toBeNull();
  });

  it("carries the checkpoint's own timestamp, not the item's", () => {
    const result = latestCheckpoint([
      event({ headline: "a line", ts: "2026-05-05T05:05:05.000Z" }),
    ]);
    expect(result?.ts).toBe("2026-05-05T05:05:05.000Z");
  });

  it("survives a malformed event id rather than throwing", () => {
    const result = latestCheckpoint([
      event({ id: "not-a-number", headline: "malformed" }),
      event({ id: "5", headline: "well formed" }),
    ]);
    expect(result?.headline).toBe("well formed");
  });
});

describe("the front end's checkpoint-headline rule", () => {
  // The copy exists because the server's version of this rule sits behind
  // the database-import boundary. What stops the copy drifting is that both
  // are asserted, so these tests are the boundary rather than a duplicate.
  it("returns the stored headline untouched", () => {
    expect(checkpointHeadline({ headline: "stored", body: "prose" })).toBe("stored");
  });

  it("prefers an EMPTY stored headline over the prose", () => {
    // `""` is not null, so the stored value still wins. This is the case a
    // `??`-based implementation gets wrong — `"" ?? derived` is `""`, but
    // `row.headline || derived` would silently fall through to the prose.
    expect(checkpointHeadline({ headline: "", body: "prose" })).toBe("");
  });

  it("derives the first non-empty line, trimmed", () => {
    expect(deriveHeadlineFromBody("\n\n  the line  \nand more")).toBe("the line");
  });

  it("is null for prose that is only whitespace", () => {
    expect(deriveHeadlineFromBody("   \n\t\n")).toBeNull();
  });

  it("is null for absent prose", () => {
    expect(deriveHeadlineFromBody(null)).toBeNull();
  });

  it("caps and ellipsises a single-paragraph checkpoint", () => {
    // The cap is what makes this a derivation rather than a split on "\n":
    // an unbroken paragraph's "first line" is the whole checkpoint.
    const long = "x".repeat(CHECKPOINT_HEADLINE_MAX_CHARS + 50);
    const derived = deriveHeadlineFromBody(long);
    expect(derived).toHaveLength(CHECKPOINT_HEADLINE_MAX_CHARS);
    expect(derived?.endsWith("…")).toBe(true);
  });

  it("does not ellipsise a line exactly at the cap", () => {
    // The boundary. An off-by-one in the comparison truncates a line that
    // fits, which is the mistake worth pinning.
    const exact = "y".repeat(CHECKPOINT_HEADLINE_MAX_CHARS);
    expect(deriveHeadlineFromBody(exact)).toBe(exact);
  });
});

describe("openLoops", () => {
  function loopEvent(id: string, type: string, payload: unknown): DetailHistoryEntry {
    return event({ id, type, payload });
  }

  it("shows a loop that was opened and never closed", () => {
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "the retry path is untested" }),
    ]);
    expect(loops.map((l) => l.text)).toEqual(["the retry path is untested"]);
  });

  it("does NOT show a loop that was closed", () => {
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "a resolved thing" }),
      loopEvent("2", "open_loop_closed", { loopId: "l-1" }),
    ]);
    expect(loops).toEqual([]);
  });

  it("resolves a close that arrives before its open in the slice", () => {
    // `events.id` is allocated before commit, so sequence order is not
    // commit order — a single-pass fold would report this loop as open.
    const loops = openLoops([
      loopEvent("2", "open_loop_closed", { loopId: "l-1" }),
      loopEvent("1", "open_loop", { loopId: "l-1", text: "closed out of order" }),
    ]);
    expect(loops).toEqual([]);
  });

  it("keeps other loops open when one is closed", () => {
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "still open" }),
      loopEvent("2", "open_loop", { loopId: "l-2", text: "will be closed" }),
      loopEvent("3", "open_loop_closed", { loopId: "l-2" }),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["l-1"]);
  });

  it("ignores events that are not loops at all", () => {
    const loops = openLoops([event({ type: "checkpoint", headline: "not a loop" })]);
    expect(loops).toEqual([]);
  });

  // ── The delete/edit half of the lifecycle ──────────────────────────────
  //
  // The cross-surface test in `loop-reads-and-lifecycle.test.ts` asserts the
  // real guarantee for `loop_list`, `orientation`, `search` and
  // `progress_report`, but its `get_item_detail` limb can only assert a
  // PRECONDITION — that the deleting event reaches the client — because the
  // fold on this surface happens here, client-side, not in the operation.
  // These are the matching guarantee assertions for that surface.
  //
  // What they protect: `get-item-detail.ts` selects from `Event` with no
  // type filter, so all four loop event types arrive. If anyone ever adds
  // one for payload-size reasons, this fold silently narrows and starts
  // reporting deleted loops as open — with the existing precondition
  // assertion still passing, because the event would be in `history` while
  // the fold's output was never checked.

  it("does NOT show a loop that was deleted", () => {
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "should never have existed" }),
      loopEvent("2", "open_loop_deleted", { loopId: "l-1", reason: "a duplicate" }),
    ]);
    expect(loops).toEqual([]);
  });

  it("does not show a deleted loop as open even though it was never closed", () => {
    // Deletion outranks closure, and it is not a close: a loop that should
    // never have existed must not appear in a list whose whole meaning is
    // "somebody meant to come back to this".
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "gone" }),
      loopEvent("2", "open_loop", { loopId: "l-2", text: "still here" }),
      loopEvent("3", "open_loop_deleted", { loopId: "l-1", reason: null }),
    ]);
    expect(loops.map((l) => l.loopId)).toEqual(["l-2"]);
  });

  it("shows an edited loop with its CURRENT text, not the text it opened with", () => {
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "the retyr path is untested" }),
      loopEvent("2", "open_loop_edited", { loopId: "l-1", text: "the retry path is untested" }),
    ]);
    expect(loops.map((l) => l.text)).toEqual(["the retry path is untested"]);
  });

  it("takes the NEWEST edit by event id, not whichever it walked past first", () => {
    // The LOWER id is placed first in the slice deliberately. `events.id` is
    // allocated before commit, so slice order is not id order — a fold that
    // simply kept the first edit it encountered would return "older" here,
    // and a fixture listing them already in id order could not tell the two
    // rules apart.
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "first" }),
      loopEvent("2", "open_loop_edited", { loopId: "l-1", text: "older" }),
      loopEvent("3", "open_loop_edited", { loopId: "l-1", text: "newest" }),
    ]);
    expect(loops.map((l) => l.text)).toEqual(["newest"]);
  });

  it("orders edits beyond Number.MAX_SAFE_INTEGER correctly", () => {
    // Event ids are `bigint` columns stringified for the JSON boundary, and
    // these two ids are chosen because they collapse: `Number` rounds both
    // ...995 and ...996 to 9007199254740996, so `newer > older` is FALSE and
    // the newest edit loses to the stale one. Compared as `BigInt` for
    // exactly this reason.
    const loops = openLoops([
      loopEvent("9007199254740994", "open_loop", { loopId: "l-1", text: "opened" }),
      loopEvent("9007199254740995", "open_loop_edited", { loopId: "l-1", text: "older" }),
      loopEvent("9007199254740996", "open_loop_edited", { loopId: "l-1", text: "newest" }),
    ]);
    expect(loops.map((l) => l.text)).toEqual(["newest"]);
  });

  it("keeps an edited loop's original openedAt, because refining wording does not restart the question", () => {
    const loops = openLoops([
      event({
        id: "1",
        type: "open_loop",
        ts: "2026-01-01T00:00:00.000Z",
        payload: { loopId: "l-1", text: "original" },
      }),
      event({
        id: "2",
        type: "open_loop_edited",
        ts: "2026-02-02T00:00:00.000Z",
        payload: { loopId: "l-1", text: "reworded" },
      }),
    ]);
    expect(loops.map((l) => l.openedAt)).toEqual(["2026-01-01T00:00:00.000Z"]);
  });

  it("does not resurrect a deleted loop just because it was edited afterwards", () => {
    const loops = openLoops([
      loopEvent("1", "open_loop", { loopId: "l-1", text: "original" }),
      loopEvent("2", "open_loop_deleted", { loopId: "l-1", reason: null }),
      loopEvent("3", "open_loop_edited", { loopId: "l-1", text: "reworded after deletion" }),
    ]);
    expect(loops).toEqual([]);
  });
});

describe("ageMsOf", () => {
  it("is the difference between now and the timestamp", () => {
    expect(ageMsOf("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T01:00:00.000Z"))).toBe(
      60 * 60 * 1000,
    );
  });

  it("floors at zero for a timestamp in the future", () => {
    // Clock skew between the writer and this reader must read as fresh, not
    // as a negative age falling through every staleness band.
    expect(ageMsOf("2026-01-02T00:00:00.000Z", Date.parse("2026-01-01T00:00:00.000Z"))).toBe(0);
  });

  it("is zero rather than NaN for an unparseable timestamp", () => {
    // NaN propagates into `stalenessOf`, where every comparison is false —
    // so a single bad row would silently paint an item as fresh anyway, but
    // via a value that also breaks any arithmetic downstream.
    expect(ageMsOf("not a date", Date.parse("2026-01-01T00:00:00.000Z"))).toBe(0);
  });
});

describe("statusSummary", () => {
  function detail(overrides: Partial<ItemDetail> = {}): Parameters<typeof statusSummary>[0] {
    return {
      item: item(),
      assignments: [],
      previousHolders: [],
      history: [],
      ...overrides,
    };
  }

  it("reports an item nobody holds as unowned", () => {
    expect(statusSummary(detail(), 0).unowned).toBe(true);
  });

  it("is not unowned when somebody holds it", () => {
    expect(statusSummary(detail({ assignments: [assignment()] }), 0).unowned).toBe(false);
  });

  it("is not unowned when the only holder is dead", () => {
    // A dead holder is still a claim on the item — a hole in the fleet, not
    // an empty slot. Reporting it as unowned would hide the fact that
    // somebody took this and never let go, which is the likeliest answer to
    // "why is this stuck".
    const summary = statusSummary(detail({ assignments: [assignment({ liveness: "dead" })] }), 0);
    expect(summary.unowned).toBe(false);
    expect(summary.holders).toHaveLength(1);
  });

  it("keeps live holders and released ones apart", () => {
    const summary = statusSummary(
      detail({
        assignments: [assignment({ id: "live-1", displayName: "Current" })],
        previousHolders: [
          assignment({
            id: "old-1",
            displayName: "Earlier",
            releasedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      }),
      0,
    );
    expect(summary.holders.map((h) => h.displayName)).toEqual(["Current"]);
    expect(summary.previousHolders.map((h) => h.displayName)).toEqual(["Earlier"]);
  });

  it("measures age against the item's updatedAt", () => {
    const summary = statusSummary(
      detail({ item: item({ updatedAt: "2026-01-01T00:00:00.000Z" }) }),
      Date.parse("2026-01-03T00:00:00.000Z"),
    );
    expect(summary.ageMs).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it("gathers the blocker, the checkpoint and the loops in one pass", () => {
    const summary = statusSummary(
      detail({
        item: item({ state: "blocked", blockedOnType: "person", blockedOnPersonId: "p-1" }),
        history: [
          event({ id: "1", type: "checkpoint", headline: "half way" }),
          event({ id: "2", type: "open_loop", payload: { loopId: "l-1", text: "unverified" } }),
        ],
      }),
      0,
    );
    expect(summary.blocked?.kind).toBe("person");
    expect(summary.checkpoint?.headline).toBe("half way");
    expect(summary.loops.map((l) => l.text)).toEqual(["unverified"]);
  });
});

describe("the copy is pinned to the server's rule", () => {
  // `src/lib/item-detail/checkpoint-headline.ts` is a deliberate copy of
  // `src/lib/service/items/checkpoint-headline.ts`, because the server's
  // module sits behind the database-import boundary that
  // `npm run check:db-imports` enforces. Its header claims the two are
  // "pinned to each other by a test that feeds the same rows to both and
  // requires the same answer" — THIS is that test, and without it the claim
  // was false: each side merely hard-coded the same constant independently,
  // which catches a symmetric edit and misses the realistic drift, where
  // somebody improves one side only.
  //
  // Feeding both the same rows is the whole point. An assertion that each
  // side "returns something sensible" would pass either through a
  // one-sided change; an assertion that they return THE SAME THING cannot.
  const rows: { readonly headline: string | null; readonly body: string | null }[] = [
    { headline: "stored wins", body: "a different line" },
    { headline: null, body: "derive from this\nnot this" },
    { headline: null, body: "   leading and trailing   " },
    { headline: null, body: "\n\n\nonly blank lines above" },
    { headline: null, body: "   \n\t\n" },
    { headline: null, body: "" },
    { headline: null, body: null },
    { headline: "", body: "an empty stored headline still wins" },
    { headline: null, body: "x".repeat(CHECKPOINT_HEADLINE_MAX_CHARS + 50) },
    { headline: null, body: "y".repeat(CHECKPOINT_HEADLINE_MAX_CHARS) },
    { headline: null, body: "z".repeat(CHECKPOINT_HEADLINE_MAX_CHARS + 1) },
    { headline: "  padded stored  ", body: "prose" },
  ];

  it("agrees with the server on the cap", () => {
    expect(CHECKPOINT_HEADLINE_MAX_CHARS).toBe(SERVER_CHECKPOINT_HEADLINE_MAX_CHARS);
  });

  it.each(rows)("agrees with the server on checkpointHeadline for %j", (row) => {
    expect(checkpointHeadline(row)).toBe(serverCheckpointHeadline(row));
  });

  it.each(rows)("agrees with the server on deriveHeadlineFromBody for %j", (row) => {
    expect(deriveHeadlineFromBody(row.body)).toBe(serverDeriveHeadlineFromBody(row.body));
  });
});

// ── The invariant the client-side loop fold rests on ────────────────────
//
// `openLoops` can only exclude a deleted loop if the deleting event actually
// reaches it. `get_item_detail` guarantees that by selecting history with no
// type predicate at all — every event on the item, capped only by count.
// That is a property of one SQL statement, and the fold above cannot detect
// its loss: a narrowed history would simply stop containing
// `open_loop_deleted`, and every assertion up there would still pass while
// the screen reported deleted loops as open.
//
// Asserted against the source rather than a database so it runs in the
// ordinary suite, the way `tests/auth-route-coverage.test.ts` asserts its
// own cross-cutting rule. Same idea as the DB-gated cases, but this one
// cannot be skipped for want of a `TEST_DATABASE_URL`.
describe("get_item_detail's history query", () => {
  it("applies NO event-type filter, which is what lets the loop fold see deletes and edits", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/service/operations/get-item-detail.ts"),
      "utf-8",
    );
    const query = source.match(/FROM "Event" WHERE[^`]*/);
    expect(query, 'the history query should still read FROM "Event"').not.toBeNull();
    // Narrowing by type is the specific regression: it would drop
    // `open_loop_deleted`/`open_loop_edited` from the payload and silently
    // un-fix the lifecycle bug. Ordering and the LIMIT are fine.
    expect(query![0]).not.toMatch(/"type"\s*(=|IN|::)/i);
    expect(query![0]).not.toMatch(/open_loop/);
  });
});
