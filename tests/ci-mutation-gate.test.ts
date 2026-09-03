// The `mutation-testing-gate` job in `.github/workflows/ci.yml` is a required
// check, and it decides its verdict from the `mutation-testing` job's
// `result` rather than from running anything itself. That makes it entirely a
// matter of which result values it treats as acceptable — and getting that
// wrong is invisible until a pull request is blocked by it.
//
// The failure this test exists to prevent, because it happened: the gate
// failed on `needs.mutation-testing.result != 'success'`, which is true for
// `skipped` as well as `failure`. While the mutation job is paused it reports
// `skipped` on every source change, so every pull request touching `src/`
// carried a red required check that no change to the pull request could
// clear. The pause and the gate were each individually correct and did not
// work together.
//
// **What a green run here does and does not mean.** These assertions read the
// workflow's own conditions as text and check which result values each step
// reacts to. That proves the gate is *configured* to distinguish `skipped`
// from `failure`; it does not execute GitHub Actions' expression evaluator,
// so it cannot prove the runner agrees with this reading of an `if:`. It is a
// backstop against the specific regression above — a condition that lumps the
// two together — not a simulation of the pipeline.
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function leadingSpaces(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? (match[1]?.length ?? 0) : 0;
}

/**
 * The text of one top-level job block, from its key line to the next key at
 * the same indentation. Scoped rather than searched whole-file so that a
 * condition belonging to a *different* job cannot satisfy an assertion about
 * this one — the same reason `ci-docker-paths-filter.test.ts` walks the
 * structure instead of substring-matching.
 */
export function extractJobBlock(yamlText: string, jobKey: string): string {
  const lines = yamlText.split("\n");
  const startIndex = lines.findIndex((line) => new RegExp(`^\\s*${jobKey}:\\s*$`).test(line));
  if (startIndex === -1) return "";

  const indent = leadingSpaces(lines[startIndex] ?? "");
  const block: string[] = [lines[startIndex] ?? ""];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() !== "" && leadingSpaces(line) <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

/**
 * The text of the single step within `jobBlock` whose `if:` condition contains
 * `conditionNeedle`, from its `- name:` line to the next step at the same
 * indentation. Returns `""` when no such step exists.
 *
 * Why this is structural rather than a regex: the assertion it serves is "this
 * step's own `run:` block exits non-zero", and a regex spanning from an `if:`
 * to the next `exit 1` does not express that. A lazy `(?:.|\n)*?exit 1` will
 * happily cross into a *later* step and match that step's `exit 1` — which is
 * exactly how the previous version of this assertion came to be defeatable by
 * deleting the very line it was written to require (#129). Walking to the step
 * boundary makes the scope a property of the parser rather than a hope about
 * the input.
 */
export function extractStepBlock(jobBlock: string, conditionNeedle: string): string {
  const lines = jobBlock.split("\n");
  // Step starts are `- name:` entries; collect their indices so a step can be
  // bounded by the next one rather than by whatever text happens to follow.
  const stepStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*-\s+name:/.test(line))
    .map(({ index }) => index);

  for (let i = 0; i < stepStarts.length; i += 1) {
    const start = stepStarts[i] ?? 0;
    const end = stepStarts[i + 1] ?? lines.length;
    const stepLines = lines.slice(start, end);
    const step = stepLines.join("\n");
    // Only an `if:` match counts. Matching anywhere in the step would let a
    // diagnostic `echo` quoting the condition stand in for the condition.
    // Folded scalars (`if: >-` continued on following lines) are joined back
    // into one line first — the mutation gate's failing step is written that
    // way, and a single-line regex silently finds nothing there.
    const ifIndex = stepLines.findIndex((line) => /^\s*if:/.test(line));
    if (ifIndex === -1) continue;
    const ifLine = stepLines[ifIndex] ?? "";
    let condition = ifLine.replace(/^\s*if:\s*/, "");
    if (/^[>|][-+]?$/.test(condition.trim())) {
      const foldedIndent = leadingSpaces(ifLine);
      condition = "";
      for (const line of stepLines.slice(ifIndex + 1)) {
        if (line.trim() === "") break;
        if (leadingSpaces(line) <= foldedIndent) break;
        condition += ` ${line.trim()}`;
      }
    }
    if (condition.replace(/\s+/g, " ").includes(conditionNeedle)) return step;
  }
  return "";
}

const WORKFLOW = readFileSync(path.join(repoRoot(), ".github/workflows/ci.yml"), "utf8");
const GATE = extractJobBlock(WORKFLOW, "mutation-testing-gate");

/** The `if:` conditions inside the gate, with whitespace and folding flattened. */
function gateConditions(): string[] {
  return [...GATE.matchAll(/if:\s*(?:>-\s*\n)?((?:.|\n)*?)(?=\n\s*(?:run|name|-|\w+):)/g)]
    .map((match) => (match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter((condition) => condition.length > 0);
}

describe("the block this test reads", () => {
  it("finds the gate job and does not run vacuously", () => {
    // Guards the guard: every assertion below is about the contents of
    // GATE, so an empty GATE would make several of them trivially true.
    expect(GATE).not.toBe("");
    expect(GATE).toContain("Mutation testing gate (required)");
  });

  it("scopes to the gate rather than the whole workflow", () => {
    // The mutation job itself must not be inside the block, or a condition
    // of *its* could satisfy an assertion meant for the gate.
    expect(GATE).not.toContain("npm run test:mutate:changed");
  });
});

describe("the gate distinguishes a paused job from a failing one", () => {
  it("has a step that passes specifically on a skipped result", () => {
    // The fix. Without a branch naming `skipped`, a paused job blocks every
    // source-touching pull request.
    const passesOnSkipped = gateConditions().some(
      (condition) =>
        condition.includes("needs.mutation-testing.result == 'skipped'") &&
        condition.includes("needs.changes.outputs.source == 'true'"),
    );
    expect(passesOnSkipped).toBe(true);
  });

  it("never fails on a result of skipped", () => {
    // The assertion that would have caught the original bug. The failing
    // step's condition must exclude `skipped`; a bare
    // `result != 'success'` does not, and this is exactly that check.
    //
    // Anchored on `mutation-testing.result` specifically. A looser search for
    // any `!= 'success'` also matches the *pass* branch that reads
    // `build-and-test.result != 'success'`, and would then assert about the
    // wrong step entirely — passing or failing for reasons unconnected to the
    // regression this guards.
    const failingStep = gateConditions().find((condition) =>
      condition.includes("needs.mutation-testing.result != 'success'"),
    );
    expect(failingStep).toBeDefined();
    expect(failingStep).toContain("needs.mutation-testing.result != 'skipped'");
  });

  it("still fails when mutation testing ran and did not succeed", () => {
    // The other half, and the one that must not be softened: a gate that
    // forgave a real failure because some other run had been paused would
    // be worse than no gate at all.
    expect(GATE).toMatch(/needs\.mutation-testing\.result\s*!=\s*'success'/);

    // Scoped to the failing step itself. A bare `GATE.toContain("exit 1")`
    // passes on any `exit 1` anywhere in the job, including one belonging to a
    // different step — so it survived deleting this step's own `exit 1` (#129).
    const failingStep = extractStepBlock(GATE, "needs.mutation-testing.result != 'success'");
    expect(failingStep).not.toBe("");
    expect(failingStep).toContain("exit 1");
  });

  it("passes without qualification when no source files changed", () => {
    const passesOnNoSource = gateConditions().some(
      (condition) => condition === "needs.changes.outputs.source == 'false'",
    );
    expect(passesOnNoSource).toBe(true);
  });

  // Mutation testing runs on any pull request that changes `src/**/*.ts(x)`,
  // so exactly ONE skip reason is legitimate: `build-and-test` was not green,
  // which stops the mutation job from starting. Every other skip on a source
  // change means the mutation job's `if:` fails to match a pull request, and
  // the gate must fail rather than guess.
  //
  // A required gate whose stated reason is not the actual reason is the same
  // class of defect as one that passes without checking: the log is the only
  // thing a reader has. These pin each branch to the condition that makes its
  // own message true.
  describe("each pass branch states the reason that actually applies", () => {
    /** The step whose `if:` contains every one of `needles`. */
    function stepMatching(...needles: string[]): string {
      const conditions = gateConditions().filter((c) => needles.every((n) => c.includes(n)));
      expect(
        conditions.length,
        `expected exactly one gate branch matching ${JSON.stringify(needles)}`,
      ).toBe(1);
      return extractStepBlock(GATE, conditions[0] as string);
    }

    // The gate must not carry a branch that passes because of the EVENT
    // rather than because of the code. Such a branch matched every pull
    // request, so the required check reported success in seconds on 100% of
    // pull requests including ones that changed `src/` — a green tick
    // asserting something nobody had checked.
    //
    // Fails the moment any `github.event_name` test reappears anywhere in
    // this gate's conditions, which is the single edit that would restore
    // the unconditional pass.
    it("has no branch that passes on the triggering event rather than on a result", () => {
      const eventBranches = gateConditions().filter((c) => c.includes("github.event_name"));
      expect(
        eventBranches,
        `the gate must decide from job results, not from the event that triggered it; found: ${JSON.stringify(eventBranches)}`,
      ).toEqual([]);
    });

    it("blames build-and-test only when build-and-test actually failed", () => {
      const step = stepMatching(
        "needs.mutation-testing.result == 'skipped'",
        "needs.build-and-test.result != 'success'",
      );
      expect(step).not.toBe("");
      expect(step).toContain("already red");
    });

    it("fails on a skip that neither reason explains", () => {
      // A narrowed `if:` on the mutation job that nobody mirrored here. The
      // gate must not guess which of the two it was and pass anyway.
      const step = stepMatching(
        "needs.mutation-testing.result == 'skipped'",
        "needs.build-and-test.result == 'success'",
      );
      expect(step).not.toBe("");
      expect(step).toContain("exit 1");
    });
  });

  // ── The job the gate reads must actually run on a pull request ────────
  //
  // Every assertion above is about `mutation-testing-gate`, which decides a
  // verdict from `mutation-testing`'s result. None of them can see the
  // mutation job's OWN `if:`, and that condition is what determines whether
  // there is ever a result to read. A condition no pull request can satisfy
  // makes the whole gate vacuous while every assertion above still passes —
  // the required check goes green in seconds having mutated nothing, which is
  // the precise failure this file exists to prevent, relocated one job away.
  //
  // Fails if `github.event_name` is reintroduced into the mutation job's
  // condition — the single edit that would switch the gate off wholesale.
  describe("the mutation job's own trigger condition", () => {
    const JOB = extractJobBlock(WORKFLOW, "mutation-testing");

    it("finds the job block and does not run vacuously", () => {
      expect(JOB).not.toBe("");
      expect(JOB).toContain("name: Mutation testing (changed files)");
    });

    it("is not gated on the triggering event, so a pull request reaches it", () => {
      const condition =
        /if:\s*(?:>-\s*\n)?((?:.|\n)*?)(?=\n\s*(?:runs-on|services|env|steps):)/.exec(JOB);
      expect(condition, "the mutation job has no parseable if: condition").not.toBeNull();
      const flattened = (condition?.[1] ?? "").replace(/\s+/g, " ").trim();
      expect(flattened).not.toBe("");
      expect(
        flattened,
        `the mutation job must run on pull requests, not only on a chosen event; got: ${flattened}`,
      ).not.toContain("github.event_name");
      // And it must still be scoped to a source change, so a docs-only pull
      // request does not pay for a run with nothing to mutate.
      expect(flattened).toContain("needs.changes.outputs.source == 'true'");
    });
  });

  // The unrecognised-skip branch is the one that refuses to guess. Its value
  // is entirely in failing loudly, so both halves are pinned: it must emit a
  // workflow error annotation (what surfaces on the run page) AND exit
  // non-zero. Softening either one turns it into a silent pass.
  it("annotates and exits non-zero on a skip it cannot explain", () => {
    const step = extractStepBlock(GATE, "needs.build-and-test.result == 'success'");
    expect(step).not.toBe("");
    expect(step).toContain("::error::");
    expect(step).toContain("exit 1");
  });

  it("always runs, so a skipped dependency cannot skip the required check itself", () => {
    // A required check that is itself skipped never reports, which reads as
    // quiet rather than red — the same trap CLAUDE.md names for a pull
    // request opened against a non-main branch.
    expect(GATE).toMatch(/if:\s*always\(\)/);
  });

  it("declares every job whose result it reads", () => {
    // A `needs` context only carries jobs named here. An unnamed job's
    // `result` is the empty string rather than an error, so a branch reading
    // it matches nothing and the gate falls off the end reporting success
    // having verified nothing — the exact failure mode the fail-closed
    // pattern exists to prevent, reintroduced through the back door.
    //
    // So this is derived from the conditions rather than pinned to a literal
    // list: a branch that starts reading a new job's result fails here until
    // that job is declared.
    const declared = /needs:\s*\[([^\]]*)\]/.exec(GATE)?.[1] ?? "";
    const names = declared.split(",").map((n) => n.trim());
    expect(names).toContain("changes");
    expect(names).toContain("mutation-testing");

    const read = new Set(
      [...GATE.matchAll(/needs\.([\w-]+)\.(?:result|outputs)/g)].map((m) => m[1] as string),
    );
    // Not vacuous: the gate does read at least one job's result.
    expect(read.size).toBeGreaterThan(0);
    for (const job of read) expect(names).toContain(job);
  });
});

describe("extractJobBlock", () => {
  it("returns an empty string for a job that is not there", () => {
    expect(extractJobBlock(WORKFLOW, "no-such-job")).toBe("");
  });

  it("stops at the next job rather than running to the end of the file", () => {
    const changes = extractJobBlock(WORKFLOW, "changes");
    expect(changes).not.toBe("");
    expect(changes).not.toContain("mutation-testing-gate:");
  });
});

describe("extractStepBlock", () => {
  // This helper is now what makes the fail-closed assertions non-defeatable,
  // so it carries its own tests: an extractor that silently over-reached would
  // reintroduce #129 while every assertion above still read as scoped.
  const TWO_STEPS = [
    "    steps:",
    "      - name: Fail — no usable scope",
    "        if: needs.changes.outputs.docker != 'true'",
    "        run: |",
    '          echo "::error::unusable"',
    "      - name: Fail — docker-build failed",
    "        if: needs.docker-build.result != 'success'",
    "        run: exit 1",
  ].join("\n");

  it("does not reach past the end of its step", () => {
    // The regression itself. The first step has no `exit 1`; the second does.
    // A scan that crossed the boundary would return text containing it.
    const step = extractStepBlock(TWO_STEPS, "needs.changes.outputs.docker != 'true'");
    expect(step).not.toBe("");
    expect(step).toContain("::error::unusable");
    expect(step).not.toContain("exit 1");
  });

  it("returns the step's own body when it does exit non-zero", () => {
    const step = extractStepBlock(TWO_STEPS, "needs.docker-build.result != 'success'");
    expect(step).toContain("exit 1");
    expect(step).not.toContain("::error::unusable");
  });

  it("returns an empty string when no step carries the condition", () => {
    expect(extractStepBlock(TWO_STEPS, "needs.changes.outputs.nonesuch == 'true'")).toBe("");
  });

  it("reads a folded `if: >-` condition spanning several lines", () => {
    // The mutation gate's failing step is written this way. A single-line
    // regex finds nothing there and the assertion using it would fail on
    // correct YAML — which is how this helper's first draft behaved.
    const folded = [
      "      - name: Fail — mutation testing ran and did not pass",
      "        if: >-",
      "          needs.changes.outputs.source == 'true' &&",
      "          needs.mutation-testing.result != 'success'",
      "        run: exit 1",
    ].join("\n");
    expect(extractStepBlock(folded, "needs.mutation-testing.result != 'success'")).toContain(
      "exit 1",
    );
  });

  it("matches on the step's `if:` rather than anywhere in the step", () => {
    // A diagnostic echo that quotes a condition must not stand in for the
    // condition — otherwise a step could claim a branch it does not guard.
    const echoOnly = [
      "      - name: Diagnose",
      "        if: always()",
      "        run: echo \"needs.changes.outputs.docker != 'true'\"",
    ].join("\n");
    expect(extractStepBlock(echoOnly, "needs.changes.outputs.docker != 'true'")).toBe("");
  });
});

// ── A pass that verified nothing has to say so where it is seen ─────────
//
// The gate's conclusion cannot carry this. A workflow job reports `success`
// or `failure` and nothing else — there is no way to emit the `neutral`
// conclusion that would mean "did not run", and a `neutral` required check
// would not satisfy branch protection anyway, so it would block every pull
// request rather than inform anyone. What is left is the check's NAME and
// its job summary, and these assert both.
//
// Each assertion below names the single edit that would make it fail, per
// this file's own convention.
describe("a branch that passes without verifying anything says so in the job summary", () => {
  /** The gate's passing branches, by the condition that selects each. */
  const PASSING_BRANCHES = [
    // No source changed — nothing to mutate.
    "needs.changes.outputs.source == 'false'",
    // Build & test is red, which is reported by that check instead.
    "needs.build-and-test.result != 'success'",
  ] as const;

  // Fails if `>> "$GITHUB_STEP_SUMMARY"` is dropped from any passing branch
  // — which is precisely the regression that would restore a green tick
  // carrying no visible statement about what it checked.
  it.each(PASSING_BRANCHES)("writes a job summary on the branch guarded by %s", (condition) => {
    const step = extractStepBlock(GATE, condition);
    expect(step, `no step in the gate is guarded by ${condition}`).not.toBe("");
    expect(step).toContain("GITHUB_STEP_SUMMARY");
  });

  /**
   * Just the `{ ... } >> "$GITHUB_STEP_SUMMARY"` block of a step — the part
   * that reaches the run page — with the plain `echo` log lines above it
   * excluded.
   *
   * **Scoping this is what makes the next assertion able to fail.** Its
   * first draft searched the whole step, and these steps also carry a log
   * line from #244 reading "has verified nothing about the code". That line
   * satisfied the assertion on its own, so gutting the *summary's* claim to
   * "This gate completed successfully" left the suite green — confirmed by
   * running that mutant. The test was checking that the step mentioned the
   * phrase somewhere, which is not the claim being made.
   */
  function summaryBlockOf(step: string): string {
    const lines = step.split("\n");
    const open = lines.findIndex((line) => line.trim() === "{");
    if (open === -1) return "";
    const close = lines.findIndex(
      (line, index) => index > open && line.includes('>> "$GITHUB_STEP_SUMMARY"'),
    );
    if (close === -1) return "";
    return lines.slice(open, close + 1).join("\n");
  }

  // The summary has to state the absence of verification, not merely exist.
  // Fails if the wording inside the summary block is softened to something
  // that reads as a pass — that statement is the whole point of the block.
  it.each(PASSING_BRANCHES)(
    "states plainly that nothing was verified, on the branch guarded by %s",
    (condition) => {
      const summary = summaryBlockOf(extractStepBlock(GATE, condition));
      expect(
        summary,
        `no $GITHUB_STEP_SUMMARY block on the branch guarded by ${condition}`,
      ).not.toBe("");
      expect(summary.toLowerCase()).toContain("verified nothing");
    },
  );

  // The name is the only part a reader sees without clicking through, and
  // "Mutation testing (required): pass" asserted that mutants had been
  // killed. Fails if the job is renamed back to claim it runs the testing.
  it("is named as a gate rather than as the testing it does not perform", () => {
    expect(GATE).toContain("name: Mutation testing gate (required)");
    // The bare old name must not reappear: it is the claim being corrected.
    expect(GATE).not.toContain("name: Mutation testing (required)");
  });

  // The failing branches must NOT be softened into summary-only reporting.
  // Fails if `exit 1` is removed from the unrecognised-skip branch — the
  // one that refuses to guess why the job did not run.
  it("still fails, rather than merely reporting, on an unrecognised skip", () => {
    const step = extractStepBlock(GATE, "needs.build-and-test.result == 'success'");
    expect(step).toContain("exit 1");
  });
});
