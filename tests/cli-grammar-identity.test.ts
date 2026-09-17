// The user-visible CLI grammar, pinned byte for byte.
//
// ── Why this file exists ──────────────────────────────────────────────
//
// The compaction that added it folds eight hand-written command modules
// into one table plus a shared builder factory, and generates the `http`
// binding's route map from the route tree instead of hand-writing 68
// entries. Every one of those changes is maintainer-side by intent:
// **nothing a person types is meant to change.**
//
// That intent cannot be checked by reading the diff, because the diff being
// enormous is the whole point of the change. A reviewer reading ~1,800
// deleted lines cannot see that `crew wait` survived, that `ls` still
// resolves to `item list`, or that `score run` still calls `score_run` and
// not `derive_run_score`. So the grammar is captured as text and compared
// against a committed baseline taken from the commit before the fold.
//
// ── Why a committed baseline rather than a self-comparison ────────────
//
// A test that renders the grammar twice and compares it to itself passes
// forever and proves nothing. The baseline in
// `tests/fixtures/cli-grammar-baseline.txt` was generated on `main` at
// `b2a2aa4`, BEFORE any module was folded, and committed unchanged. Evidence
// captured independently of the code under test is the only kind that can
// testify about a change to it.
//
// **Updating this fixture is how the grammar changes.** That is deliberate
// friction: a row that genuinely adds a verb updates the fixture in the same
// commit, and the diff on the fixture is then a precise, readable statement
// of what a person can now type that they could not before — which is
// exactly the review that a thousand-line refactor otherwise buries.
//
// ── What a green run here means, and what it does not ─────────────────
//
// It means the same `<noun> <verb>` pairs exist, resolve through the same
// aliases, call the same operations, and render the same help summaries.
// It does **not** mean each command still builds the same input from the
// same words — a builder could keep its name and drop a field, which is the
// `fa83f2b9` defect class and is the job of `cli-merged-builder-fields`
// and `cli-loop-noun-fields`, not of this file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ALIASES, COMMANDS, nouns, verbsFor } from "@/lib/cli/commands";
// A plain `.mjs` script, imported for the one renderer it owns, so the text
// this asserts on and the text a person can print by hand come from a single
// function rather than from two that merely agree.
import { renderGrammar } from "../scripts/cli-grammar-snapshot.mjs";

const BASELINE = path.join(process.cwd(), "tests", "fixtures", "cli-grammar-baseline.txt");

function currentGrammar(): string {
  return renderGrammar({
    commands: COMMANDS,
    aliases: ALIASES,
    nouns,
    verbsFor,
  }) as string;
}

describe("the user-visible CLI grammar", () => {
  it("is identical to the baseline captured before the compaction", () => {
    const baseline = readFileSync(BASELINE, "utf8");
    // Compared as whole text rather than as sets, so an added line, a
    // removed line and a changed line all fail the same way and the
    // failure output names which.
    expect(currentGrammar()).toEqual(baseline);
  });

  it("the baseline is not empty, and covers every command", () => {
    // Asserted directly because the comparison above is vacuously true for
    // two empty strings — an import that silently resolved to an empty
    // table would pass it while proving nothing. This pins the count to the
    // live table, so it tracks real growth rather than freezing a number.
    const baseline = readFileSync(BASELINE, "utf8");
    const commandLines = baseline.split("\n").filter((line) => line.startsWith("command\t"));
    expect(COMMANDS.length).toBeGreaterThan(50);
    expect(commandLines).toHaveLength(COMMANDS.length);
  });

  it("every alias resolves to a command that exists", () => {
    // Not a restatement of the baseline: an alias pointing at a deleted
    // command would still match a baseline captured with the same broken
    // pair. This checks the grammar is internally coherent, which is a
    // property the fixture cannot testify to.
    for (const [alias, [noun, verb]] of Object.entries(ALIASES)) {
      const target = COMMANDS.find((spec) => spec.noun === noun && spec.verb === verb);
      expect(
        target,
        `alias \`${alias}\` resolves to \`${noun} ${verb}\`, which does not exist`,
      ).toBeDefined();
    }
  });
});
