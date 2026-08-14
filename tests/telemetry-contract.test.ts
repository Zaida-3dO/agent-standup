// The shared tool-call telemetry contract — MILESTONES.md #50 (the ingest)
// and #88 (the hook's spool), SCHEMA.md §10.
//
// This covers `@/lib/telemetry/contract`, the one module both halves of
// this feature import: the record shape, the caps, and the two functions
// that apply them. The last `describe` block is specifically about the
// module being the *only* definition — properties like "capping twice is
// identical to capping once" that no test of either side alone can see,
// and that exist because the two sides were briefly separate copies and
// disagreed on every value they could.
//
// These are pure functions with no database, so every case here runs
// everywhere rather than skipping without `TEST_DATABASE_URL`. That is
// deliberate: the caps are the part of #50 most likely to be quietly
// weakened by a later edit (a constant nudged upward, a `<=` relaxed to
// `<`), and a test that only runs where Postgres is available is one that
// does not protect them on the machine the edit is made on.
//
// **Boundaries are asserted on both sides of every limit**, because a
// cap is exactly the kind of code where the off-by-one is the bug and the
// happy path is not. `MAX - 1`, `MAX`, and `MAX + 1` each get a case, and
// the `MAX` case asserts the value comes back *unmarked* — a cap that
// truncated at its own limit would pass any test that only checked length.
import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_CHARS,
  MAX_PATHS,
  MAX_PATH_CHARS,
  MAX_SESSION_ID_CHARS,
  MAX_TOOL_CHARS,
  MAX_BATCH_SIZE,
  TRUNCATION_MARKER,
  capPaths,
  capText,
  type ToolCallBatch,
} from "@/lib/telemetry/contract";

/** `n` copies of `char` — a string whose length is the only thing that matters. */
function repeat(n: number, char = "x"): string {
  return char.repeat(n);
}

describe("capText — the boundary", () => {
  it("returns a value shorter than the limit unchanged, with no marker", () => {
    const value = repeat(10);
    expect(capText(value, 100)).toBe(value);
    expect(capText(value, 100)).not.toContain(TRUNCATION_MARKER);
  });

  it("returns a value of EXACTLY the limit unchanged, with no marker", () => {
    // The boundary case that a `<` instead of a `<=` in `capText` breaks,
    // and that no length-only assertion would catch: truncating here would
    // still produce a string of `limit` characters, so only the absence of
    // the marker distinguishes "complete" from "cut at exactly the cap".
    const value = repeat(50);
    const result = capText(value, 50);
    expect(result).toBe(value);
    expect(result).not.toContain(TRUNCATION_MARKER);
  });

  it("cuts a value ONE character over the limit, and marks it", () => {
    const value = repeat(51);
    const result = capText(value, 50);
    expect(result).not.toBe(value);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("never returns more than the limit — the marker is counted INSIDE the cap", () => {
    // The failure this catches is a cap implemented as
    // `slice(0, limit) + MARKER`, which is the obvious way to write it and
    // is wrong: it stores `limit + marker.length` characters, so the cap is
    // not a bound on what is stored. Asserted across a spread of overflows
    // rather than one, so an implementation that happens to be right at a
    // single size cannot pass.
    for (const over of [1, 2, 10, 500, 10_000]) {
      const result = capText(repeat(100 + over), 100);
      expect(result.length).toBe(100);
    }
  });

  it("keeps the PREFIX, not the tail — a command is identified by how it starts", () => {
    const result = capText("npm run build --workspace=some-very-long-workspace-name", 20);
    expect(result.startsWith("npm run")).toBe(true);
  });

  it("degrades to a bare prefix when the limit is too small to hold the marker", () => {
    // A limit shorter than the marker cannot express "this was cut". The
    // choice is between all-marker-no-content and content-with-no-marker,
    // and content is what the field is for. No production cap is this
    // small; the case exists so the function has no input that returns
    // something longer than its limit.
    const result = capText(repeat(100), 5);
    expect(result.length).toBe(5);
    expect(result).toBe(repeat(5));
  });

  it("is a no-op on an empty string at any limit", () => {
    expect(capText("", 0)).toBe("");
    expect(capText("", MAX_COMMAND_CHARS)).toBe("");
  });
});

describe("capPaths — two independent caps, applied in the right order", () => {
  it("keeps a list at exactly MAX_PATHS entries whole", () => {
    const paths = Array.from({ length: MAX_PATHS }, (_, i) => `src/file-${i}.ts`);
    expect(capPaths(paths)).toEqual(paths);
  });

  it("cuts a list ONE entry over MAX_PATHS", () => {
    const paths = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `src/file-${i}.ts`);
    expect(capPaths(paths)).toHaveLength(MAX_PATHS);
  });

  it("caps a very wide list to MAX_PATHS, not to something proportional to it", () => {
    const paths = Array.from({ length: 10_000 }, (_, i) => `src/file-${i}.ts`);
    expect(capPaths(paths)).toHaveLength(MAX_PATHS);
  });

  it("keeps entries from the FRONT, so the same call truncates the same way twice", () => {
    // Repeat detection (#54) compares calls. A sample that varies between
    // two runs of the same glob would make one call look like two.
    const paths = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
    expect(capPaths(paths)[0]).toBe("src/file-0.ts");
    expect(capPaths(paths).at(-1)).toBe(`src/file-${MAX_PATHS - 1}.ts`);
    expect(capPaths(paths)).toEqual(capPaths(paths));
  });

  it("caps each entry's LENGTH as well as the count — the product is the real bound", () => {
    // The failure this catches is capping only the count: the surviving
    // entries would still be individually unbounded, so the field's worst
    // case would be MAX_PATHS × unbounded. Asserted as a total size, which
    // is the number that decides whether this table stays small.
    const paths = Array.from({ length: MAX_PATHS * 2 }, () => repeat(50_000, "d"));
    const result = capPaths(paths);
    expect(result).toHaveLength(MAX_PATHS);
    for (const path of result) {
      expect(path.length).toBeLessThanOrEqual(MAX_PATH_CHARS);
    }
    const total = result.reduce((sum, path) => sum + path.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_PATHS * MAX_PATH_CHARS);
  });

  it("marks an over-long entry, so a clipped path is not read as a real one", () => {
    const result = capPaths([repeat(MAX_PATH_CHARS + 1)]);
    expect(result[0]).toContain(TRUNCATION_MARKER);
    expect(result[0]!.length).toBe(MAX_PATH_CHARS);
  });

  it("leaves an entry of exactly MAX_PATH_CHARS unmarked", () => {
    const exact = repeat(MAX_PATH_CHARS);
    expect(capPaths([exact])).toEqual([exact]);
  });

  it("returns an empty array for an empty list", () => {
    expect(capPaths([])).toEqual([]);
  });
});

describe("the cap values themselves", () => {
  // These assert the *chosen* numbers, not merely that numbers exist. A
  // later edit that relaxes a cap has to change this file too, which is the
  // point: the caps are a decision recorded in the PR that chose them, and
  // moving one should be a visible act rather than a one-character diff in
  // a constant nobody is watching.
  it("caps a command at 4096 characters", () => {
    expect(MAX_COMMAND_CHARS).toBe(4096);
  });

  it("caps a path list at 64 entries of 256 characters", () => {
    expect(MAX_PATHS).toBe(64);
    expect(MAX_PATH_CHARS).toBe(256);
  });

  it("caps a tool name at 200 and a session id at 128 characters", () => {
    expect(MAX_TOOL_CHARS).toBe(200);
    expect(MAX_SESSION_ID_CHARS).toBe(128);
  });

  it("keeps every text cap large enough to hold the truncation marker", () => {
    // A cap at or below the marker's length silently degrades to a bare
    // prefix (see `capText`), which would make truncation invisible in
    // production. This asserts no production text cap is in that range.
    // `MAX_BATCH_SIZE` is deliberately excluded — it counts records, not
    // characters, so the marker has nothing to do with it.
    for (const cap of [MAX_COMMAND_CHARS, MAX_PATH_CHARS, MAX_TOOL_CHARS, MAX_SESSION_ID_CHARS]) {
      expect(cap).toBeGreaterThan(TRUNCATION_MARKER.length);
    }
  });

  it("keeps the server's batch ceiling above the client's own batch size", () => {
    // The client (MILESTONES.md #88) flushes in batches of 200. A server
    // ceiling at or below that would refuse a full, correctly-formed flush
    // — and the client's flush treats a refusal as keep-and-stop, so the
    // spool would grow forever while every flush failed. The headroom is
    // the point, not the exact number.
    const CLIENT_BATCH_SIZE = 200;
    expect(MAX_BATCH_SIZE).toBeGreaterThan(CLIENT_BATCH_SIZE);
  });
});

describe("the contract both halves speak", () => {
  // These are the assertions that exist because the ingest (#50) and the
  // hook's spool (#88) were briefly two agreeing copies and disagreed on
  // every field they could. They are about the *shared module being the
  // only definition*, which is a property no test of either side alone can
  // see.

  it("puts the truncation marker INSIDE the cap, which is what makes it composable", () => {
    // The sharpest of the four disagreements. A client that appends its
    // marker *past* its own cap emits a string longer than the cap; the
    // server then truncates it a second time and the value ends
    // `…[truncated]…[truncated]`, with a shorter prefix than either side
    // intended. Capping twice must be identical to capping once — that is
    // the property, and it is the reason both halves import this function
    // rather than each writing one.
    const once = capText("z".repeat(10_000), MAX_COMMAND_CHARS);
    const twice = capText(once, MAX_COMMAND_CHARS);
    expect(twice).toBe(once);
    expect(once.length).toBe(MAX_COMMAND_CHARS);
    // Exactly one marker, not two.
    expect(once.split(TRUNCATION_MARKER)).toHaveLength(2);
  });

  it("is idempotent for paths too — a capped list re-capped is unchanged", () => {
    const once = capPaths(Array.from({ length: 500 }, () => "p".repeat(1_000)));
    expect(capPaths(once)).toEqual(once);
  });

  it("puts the session on the BATCH and not on each record", () => {
    // A compile-time assertion as much as a runtime one. The client and the
    // server disagreed about exactly this: a record carrying its own
    // `sessionId` posted as a bare array, against an envelope carrying it
    // once. Constructing the batch here is what makes the shape a shared
    // fact rather than each side's private assumption — a record that grew
    // a `sessionId` back, or a batch that lost it, stops typechecking.
    const batch: ToolCallBatch = {
      sessionId: "s1",
      calls: [
        {
          ts: new Date().toISOString(),
          tool: "Bash",
          command: "npm test",
          paths: ["src/a.ts"],
          inputTokens: 1,
          outputTokens: 2,
          cacheWriteTokens: 3,
          cacheReadTokens: 4,
          usage5h: 0.5,
          usageWeekly: 0.25,
        },
      ],
    };
    expect(batch.sessionId).toBe("s1");
    expect(batch.calls).toHaveLength(1);
    // The body is an object, not a bare array — the difference between a
    // batch that can carry a session (and, later, an idempotency key) and
    // one that has nowhere to put either.
    expect(Array.isArray(batch)).toBe(false);
  });
});
