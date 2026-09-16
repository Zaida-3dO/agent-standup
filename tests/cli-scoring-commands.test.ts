// The eleven operations that had no command line, and the `score` noun.
//
// These were reachable on MCP and nowhere else. Binding them is what makes it
// legal to waive them off MCP later: `adapter-conformance.test.ts` and
// `adapter-waivers.test.ts` both assert nothing is stranded — reachable on no
// adapter at all — so waiving one of these before binding it here would
// strand it and fail both files.
//
// **What these tests are for.** Not that the operations exist — the registry
// test covers that — but that each command builds the input its operation's
// schema actually declares. A command bound to the right operation that
// builds the wrong shape is the failure this file catches, and it is the one
// a `--help` listing cannot see.
import { describe, expect, it } from "vitest";

import { COMMANDS, lookupCommand, nouns, verbsFor } from "@/lib/cli/commands";
import type { CommandSpec } from "@/lib/cli/commands";

/** Resolves `<noun> <verb>` to its spec, or undefined when nothing is bound. */
function specFor(noun: string, verb: string): CommandSpec | undefined {
  const result = lookupCommand([noun, verb]);
  return result.ok ? result.match.command : undefined;
}

/** Builds a command's input, failing the test if it refused. */
function build(
  noun: string,
  verb: string,
  rest: readonly string[] = [],
  flags: Record<string, string | true> = {},
): Record<string, unknown> {
  const spec = specFor(noun, verb);
  expect(spec, `\`standup ${noun} ${verb}\` should be a command`).toBeTruthy();
  const result = spec!.buildInput(rest, flags);
  if (!result.ok) {
    throw new Error(`\`standup ${noun} ${verb}\` refused: ${JSON.stringify(result.envelope)}`);
  }
  return result.input as Record<string, unknown>;
}

/**
 * Builds and expects a refusal, returning the refusal's own `error` object.
 *
 * The envelope is `{ ok: false, error: { code, message, fields } }`, so the
 * fields a refusal names live one level in. Returning `error` rather than the
 * whole envelope keeps the assertions below reading as "which field did it
 * name", which is the only part worth pinning — the wording is deliberately
 * not asserted, matching §22's rule that adapters may word things
 * differently.
 */
function refuse(
  noun: string,
  verb: string,
  rest: readonly string[] = [],
  flags: Record<string, string | true> = {},
): { readonly code: string; readonly message: string; readonly fields: readonly string[] } {
  const spec = specFor(noun, verb);
  expect(spec).toBeTruthy();
  const result = spec!.buildInput(rest, flags);
  expect(result.ok, `\`standup ${noun} ${verb}\` should have refused`).toBe(false);
  const refused = result as {
    ok: false;
    envelope: {
      error: {
        readonly code: string;
        readonly message: string;
        readonly fields: readonly string[];
      };
    };
  };
  const { error } = refused.envelope;
  expect(error.code).toBe("malformed_command");
  return error;
}

describe("the eleven operations that had no command line", () => {
  // The list is spelled out rather than derived, deliberately. Deriving it
  // from the command table would assert only that the table equals itself;
  // this asserts the table contains the eleven names this commit exists to
  // bind, so deleting one fails here rather than silently reducing scope.
  const BOUND: readonly (readonly [string, string, string])[] = [
    ["score", "run", "score_run"],
    ["score", "derive", "derive_run_score"],
    ["score", "accept", "accept_run_score"],
    ["score", "scores", "get_run_scores"],
    ["score", "list", "list_runs"],
    ["score", "intervention", "score_intervention"],
    ["score", "interventions", "get_intervention_scores"],
    ["item", "blocked-on-tool", "report_blocked_on_tool"],
    ["item", "artifacts", "get_item_artifacts"],
    ["project", "repair", "repair_stuck_projects"],
    ["session", "shape", "get_session_shape"],
  ];

  it.each(BOUND)("`standup %s %s` calls %s", (noun, verb, operation) => {
    expect(specFor(noun, verb)?.operation).toBe(operation);
  });

  it("gives every one of them a non-empty summary, as --help reads it", () => {
    for (const [noun, verb] of BOUND) {
      expect(specFor(noun, verb)!.summary.trim().length, `${noun} ${verb}`).toBeGreaterThan(0);
    }
  });
});

describe("the `score` noun", () => {
  it("exists and carries all seven scoring verbs", () => {
    expect(nouns()).toContain("score");
    expect([...verbsFor("score")].sort()).toEqual(
      ["accept", "derive", "intervention", "interventions", "list", "run", "scores"].sort(),
    );
  });

  it("adds exactly one noun rather than two, which was the point of choosing it", () => {
    // `run` and `intervention` were the obvious pair and were rejected for
    // widening the taxonomy by two. If someone later splits `score` back
    // into those, this fails and the reasoning in `commands-scoring.ts` gets
    // re-read rather than quietly reversed.
    expect(nouns()).not.toContain("run");
    expect(nouns()).not.toContain("intervention");
  });

  it("spells the aggregate read as a plural verb, not a hyphenated pseudo-verb", () => {
    expect(specFor("score", "interventions")).toBeTruthy();
    expect(specFor("score", "score-interventions")).toBeUndefined();
  });
});

describe("each command builds the input its operation's schema declares", () => {
  it("`score run` takes the run id positionally and parses --facets as JSON", () => {
    const input = build("score", "run", ["run-7"], {
      "rater-type": "person",
      "rater-id": "ope",
      facets: '[{"facet":"code","score":4}]',
    });
    expect(input).toEqual({
      runId: "run-7",
      raterType: "person",
      raterId: "ope",
      facets: [{ facet: "code", score: 4 }],
    });
  });

  it("`score run` refuses --facets that is not JSON, naming the flag", () => {
    const envelope = refuse("score", "run", ["run-7"], { facets: "not json at all" });
    expect(envelope.fields).toContain("facets");
  });

  it("`score run` names runId when the positional is missing", () => {
    expect(refuse("score", "run", []).fields).toContain("runId");
  });

  it("`score derive` sends --force only when it is given", () => {
    expect(build("score", "derive", ["run-7"])).toEqual({ runId: "run-7" });
    expect(build("score", "derive", ["run-7"], { force: true })).toEqual({
      runId: "run-7",
      force: true,
    });
  });

  it("`score accept` splits --facets on commas, because the field is plain strings", () => {
    const input = build("score", "accept", ["run-7"], {
      "rater-id": "ope",
      facets: "code, tests",
    });
    expect(input).toEqual({ runId: "run-7", raterId: "ope", facets: ["code", "tests"] });
  });

  it("`score scores` re-types --threshold, which the schema declares as a number", () => {
    const input = build("score", "scores", [], { threshold: "3", source: "effective" });
    expect(input).toEqual({ threshold: 3, source: "effective" });
  });

  it("`score scores` refuses a --threshold that is not a whole number", () => {
    expect(refuse("score", "scores", [], { threshold: "high" }).fields).toContain("threshold");
  });

  it("`score list` reads an item id positionally and --limit as a number", () => {
    expect(build("score", "list", ["item-3"], { limit: "5", scored: "no" })).toEqual({
      itemId: "item-3",
      limit: 5,
      scored: "no",
    });
  });

  it("`score intervention` re-types --score and maps the hyphenated rater flags", () => {
    expect(
      build("score", "intervention", ["ev-1"], {
        score: "2",
        "rater-type": "agent",
        "rater-id": "sess-9",
        note: "right call, unclear wording",
      }),
    ).toEqual({
      eventId: "ev-1",
      score: 2,
      raterType: "agent",
      raterId: "sess-9",
      note: "right call, unclear wording",
    });
  });

  it("`item artifacts` sends the item id as `id`, which is what that schema names", () => {
    // The operation reads one item and calls the field `id`, not `itemId`.
    // Sending `itemId` would be refused by its `.strict()` schema, and this
    // is the assertion that catches the mix-up before a person meets it.
    expect(build("item", "artifacts", ["item-1"], { kind: "plan" })).toEqual({
      id: "item-1",
      kind: "plan",
    });
  });

  it("`item artifacts` reads --full as a switch and --limit as a number", () => {
    expect(build("item", "artifacts", ["item-1"], { full: true, limit: "50" })).toEqual({
      id: "item-1",
      full: true,
      limit: 50,
    });
  });

  it("`item blocked-on-tool` carries the tool and what was needed", () => {
    expect(
      build("item", "blocked-on-tool", ["item-1"], {
        tool: "browser_capture",
        needed: "screenshot the header",
      }),
    ).toEqual({ itemId: "item-1", tool: "browser_capture", needed: "screenshot the header" });
  });

  it("`project repair` withholds --apply unless asked, so a bare run writes nothing", () => {
    expect(build("project", "repair", [], { projectId: "p-1" })).toEqual({ projectId: "p-1" });
    expect(build("project", "repair", [], { projectId: "p-1", apply: true })).toEqual({
      projectId: "p-1",
      apply: true,
    });
  });

  it("`session shape` takes the session id positionally, not from --session", () => {
    // `--session` is the global identity flag — who is calling. The subject
    // of this read is someone the caller names, which is not always itself.
    expect(build("session", "shape", ["sess-1"], { limit: "20" })).toEqual({
      sessionId: "sess-1",
      limit: 20,
    });
  });

  it("`session shape` names sessionId when the positional is missing", () => {
    expect(refuse("session", "shape", []).fields).toContain("sessionId");
  });
});

describe("the new builders pass unknown flags through rather than dropping them", () => {
  // This is the `fa83f2b9` property, asserted at the point it is easiest to
  // lose. A builder that filtered to the fields it knew about would produce
  // an input WITHOUT `--totally-unknown` here and still look correct — the
  // operation's `.strict()` schema is what refuses an unknown field, and it
  // can only refuse what reaches it.
  const CASES: readonly (readonly [string, string, readonly string[]])[] = [
    ["score", "run", ["run-7"]],
    ["score", "derive", ["run-7"]],
    ["score", "accept", ["run-7"]],
    ["score", "scores", []],
    ["score", "list", []],
    ["score", "intervention", ["ev-1"]],
    ["score", "interventions", []],
    ["item", "artifacts", ["item-1"]],
    ["item", "blocked-on-tool", ["item-1"]],
    ["session", "shape", ["sess-1"]],
  ];

  it.each(CASES)("`standup %s %s` forwards a flag it has never heard of", (noun, verb, rest) => {
    const input = build(noun, verb, rest, { "totally-unknown": "kept" });
    expect(input["totally-unknown"]).toBe("kept");
  });

  it("drops the global flags, which belong to the dispatcher and not to any operation", () => {
    const input = build("score", "scores", [], { json: true, direct: true });
    expect(input).not.toHaveProperty("json");
    expect(input).not.toHaveProperty("direct");
  });
});

describe("the new commands do not collide with the existing table", () => {
  it("binds each `<noun> <verb>` pair exactly once", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const command of COMMANDS) {
      const key = `${command.noun} ${command.verb}`;
      if (seen.has(key)) collisions.push(`${key} -> ${seen.get(key)} and ${command.operation}`);
      seen.set(key, command.operation);
    }
    expect(collisions).toEqual([]);
  });

  it("binds each of the eleven operations to exactly one command", () => {
    const counts = new Map<string, number>();
    for (const command of COMMANDS) {
      counts.set(command.operation, (counts.get(command.operation) ?? 0) + 1);
    }
    for (const operation of [
      "score_run",
      "derive_run_score",
      "accept_run_score",
      "get_run_scores",
      "list_runs",
      "score_intervention",
      "get_intervention_scores",
      "report_blocked_on_tool",
      "get_item_artifacts",
      "repair_stuck_projects",
      "get_session_shape",
    ]) {
      expect(counts.get(operation), operation).toBe(1);
    }
  });
});
