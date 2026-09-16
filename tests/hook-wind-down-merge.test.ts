// Merging the survey context's two halves — `mergeWindDownContext` in
// `src/lib/hook/run.ts`.
//
// ── Why this is not `mergeStopContext` with a different name ───────────
//
// The stop block is one set of facts that either side might happen to know,
// so the newer side wins field by field and that is the whole rule.
//
// The survey block is **partitioned by who can measure what**. The server
// owns `unrated` and `liveCrew` — they are rows in `intervention_events` and
// `Assignment`. The client owns `idleMs`, because nothing in the database
// advances when a session makes a tool call and every server-side candidate
// timestamp dates something else (see `wind-down-context.ts`'s header).
//
// The merge itself is a plain spread, and that is correct — but only
// because of a property of the OTHER side that nothing local enforces.
//
// ── The real hazard, found by mutating the implementation ──────────────
//
// The first version of this merge carried an explicit guard reinstating the
// client's `idleMs`. Replacing that guard with a bare spread did not break a
// single test, because the server's block does not carry an `idleMs` key at
// all — and a spread only overwrites keys that are PRESENT. The guard was
// defending a case the real path cannot produce, and the test asserting it
// was hollow: a plain spread already satisfied it.
//
// So what actually protects the measurement is not this function. It is
// that `WindDownContextPayload` declares no `idleMs` field and that
// `readWindDownContext` builds its result conditionally, so no block
// arriving over the wire can carry `idleMs: undefined` — the one value that
// would delete the client's number. **That contract is pinned here, against
// the real parser**, because the merge cannot pin it and the type system
// cannot either: `{idleMs: undefined}` is a perfectly good
// `WindDownContext`.

import { describe, expect, it } from "vitest";
import { mergeWindDownContext } from "@/lib/hook/run";
import { shouldSurvey, WIND_DOWN_QUIET_MS } from "@/lib/interventions/survey";
import { readWindDownContext } from "@/lib/hook/stop-catch";

const firings = [{ eventId: "11", entryId: "I10", at: 1_700_000_000_000 }];

/** What the client knows before the round trip: the quiet, and nothing else. */
const local = { idleMs: WIND_DOWN_QUIET_MS + 1 };

/** What the server volunteers: the firings and the crew, and no quiet. */
const volunteered = { unrated: firings, liveCrew: 0, wakeScheduled: false };

describe("the halves combine", () => {
  it("keeps the locally-measured quiet alongside the server's firings", () => {
    const merged = mergeWindDownContext(local, volunteered);
    expect(merged?.idleMs).toBe(WIND_DOWN_QUIET_MS + 1);
  });

  it("takes the firings from the server", () => {
    const merged = mergeWindDownContext(local, volunteered);
    expect(merged?.unrated).toHaveLength(1);
    expect(merged?.unrated?.[0]?.eventId).toBe("11");
  });

  it("produces a context that actually surveys", () => {
    // The two halves are individually insufficient by construction, so the
    // only meaningful assertion is against the real predicate.
    const merged = mergeWindDownContext(local, volunteered);
    expect(merged !== undefined && shouldSurvey(merged)).toBe(true);
  });
});

describe("neither half alone is enough", () => {
  it("the client's quiet alone does not survey", () => {
    // No firings, so nothing to ask about.
    const merged = mergeWindDownContext(local, undefined);
    expect(merged !== undefined && shouldSurvey(merged)).toBe(false);
  });

  it("the server's firings alone do not survey", () => {
    // No idle measurement, so no evidence the session is actually ending.
    // This is the discrimination the brief's second criterion asks for,
    // stated at the merge: a populated server block is not permission.
    const merged = mergeWindDownContext(undefined, volunteered);
    expect(merged !== undefined && shouldSurvey(merged)).toBe(false);
  });
});

describe("precedence", () => {
  it("lets the server override the crew count it owns", () => {
    // Field-by-field, server wins, for the same reason `mergeStopContext`
    // prefers it: the server answered on the round trip this event was
    // already making, so it is strictly newer.
    const merged = mergeWindDownContext({ ...local, liveCrew: 0 }, { ...volunteered, liveCrew: 4 });
    expect(merged?.liveCrew).toBe(4);
    expect(merged !== undefined && shouldSurvey(merged)).toBe(false);
  });

  it("lets a server that does measure idle time overrule the client", () => {
    // A server that some day learns to measure this should win, for the
    // same newest-wins reason it wins on every other field.
    const merged = mergeWindDownContext(local, { ...volunteered, idleMs: 0 });
    expect(merged?.idleMs).toBe(0);
    expect(merged !== undefined && shouldSurvey(merged)).toBe(false);
  });

  it("returns the other side when one is absent", () => {
    expect(mergeWindDownContext(undefined, undefined)).toBeUndefined();
    expect(mergeWindDownContext(local, undefined)).toBe(local);
    expect(mergeWindDownContext(undefined, volunteered)).toBe(volunteered);
  });
});

describe("the producer contract this merge depends on", () => {
  // ── Why these cases live in this file ────────────────────────────────
  //
  // The merge is a spread, so it preserves the client's `idleMs` if and only
  // if the server's block has no such key. That is a fact about the
  // producer and the parser, not about the merge — but the merge is what
  // breaks when it stops being true, so it is asserted where the breakage
  // would be felt.

  it("the real parser never emits an idleMs key from a server block", () => {
    // The exact shape `assembleWindDownContext` produces, through actual
    // JSON, into the real parser. `toHaveProperty` rather than a
    // `=== undefined` check: the whole hazard is the difference between an
    // ABSENT key and a key holding `undefined`, and `?.idleMs` cannot tell
    // them apart.
    const wire = JSON.parse(
      JSON.stringify({ unrated: firings, liveCrew: 0, wakeScheduled: false }),
    );
    const read = readWindDownContext(wire);

    expect(read).not.toHaveProperty("idleMs");
  });

  it("still has no idleMs key when the server sends one that is malformed", () => {
    // `readWindDownContext` validates field by field and drops what it
    // cannot read. A dropped field must be dropped ENTIRELY — writing
    // `idleMs: undefined` on the way out would be indistinguishable to the
    // type system and fatal to the merge.
    const read = readWindDownContext({
      unrated: firings,
      liveCrew: 0,
      wakeScheduled: false,
      idleMs: "not a number",
    });

    expect(read).not.toHaveProperty("idleMs");
  });

  it("a parsed server block merged over a measurement keeps the measurement", () => {
    // The two facts joined: real parser output, real merge, real predicate.
    // This is the case that actually fails if the producer ever starts
    // emitting the key, and it is the reason the survey fires at all.
    const read = readWindDownContext(
      JSON.parse(JSON.stringify({ unrated: firings, liveCrew: 0, wakeScheduled: false })),
    );

    const merged = mergeWindDownContext(local, read);
    expect(merged?.idleMs).toBe(WIND_DOWN_QUIET_MS + 1);
    expect(merged !== undefined && shouldSurvey(merged)).toBe(true);
  });

  it("demonstrates the failure mode, so the guard above is not mistaken for ceremony", () => {
    // A block that DOES carry an explicit undefined deletes the
    // measurement. Constructed by hand because nothing in the real path can
    // produce it — which is precisely the point: the cases above are what
    // keep it unreachable.
    const hostile = { ...volunteered, idleMs: undefined } as typeof volunteered;
    const merged = mergeWindDownContext(local, hostile);

    expect(merged?.idleMs).toBeUndefined();
    expect(merged !== undefined && shouldSurvey(merged)).toBe(false);
  });
});
