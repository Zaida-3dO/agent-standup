// The self-test for `scripts/lib/db-gate-status.mjs` — the module that
// decides what a run's database situation is and says it in a sentence.
//
// What it is for, stated as the defect: `npm test` without
// `TEST_DATABASE_URL` skips 133 of 497 test files, exits 0, and used to close
// with a sentence that a full run could also have produced. Three separate
// crews trusted that green on 2026-09-16; one had three of its four test
// changes hidden behind it.
//
// So the property under test throughout is **distinguishability**. Not "a
// message is printed" — a message that says the same thing in both cases is
// the bug. Every assertion below is written so that collapsing two states
// into one wording fails it.
//
// Each test names the single change to the source that would break it. A test
// whose mutation cannot be named is a test that has never been shown to be
// able to fail.
import { describe, expect, it } from "vitest";

import {
  APP_URL_ENV,
  DB_URL_ENV,
  PINNED_PLACEHOLDER_URL,
  banner,
  classify,
} from "../scripts/lib/db-gate-status.mjs";

/** A real-looking URL that is NOT the pinned placeholder. */
const REAL_URL = "postgresql://someone:secret@db.example:5432/production";

const NOTHING_SET = {};
const NEAR_MISS = { [APP_URL_ENV]: REAL_URL };
const ENABLED = { [DB_URL_ENV]: REAL_URL };

describe("classify — which of the three situations is this", () => {
  it("calls it `absent` when neither variable is set", () => {
    // Mutation: return "near-miss" unconditionally.
    expect(classify(NOTHING_SET).state).toBe("absent");
  });

  it("calls it `enabled` when TEST_DATABASE_URL is set", () => {
    // The check must be able to say yes, or it is a broken build that
    // reports a problem on every run.
    // Mutation: drop the `if (testUrlSet)` branch.
    expect(classify(ENABLED).state).toBe("enabled");
  });

  it("calls it `near-miss` when only DATABASE_URL is set", () => {
    // THE load-bearing case. This is the reasonable guess three crews made:
    // DATABASE_URL is the variable everything else in the project uses, so
    // it is the one a newcomer sets. Without this branch the suite punishes
    // that guess in silence.
    // Mutation: drop the `if (appUrlSet)` branch — it then reports "absent"
    // and the advice below never renders.
    expect(classify(NEAR_MISS).state).toBe("near-miss");
  });

  it("prefers TEST_DATABASE_URL when both are set, since that is the gate", () => {
    // Mutation: order the two branches the other way round — a developer who
    // did everything right would be told they had guessed wrong.
    expect(classify({ ...NEAR_MISS, ...ENABLED }).state).toBe("enabled");
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // `TEST_DATABASE_URL=` in a shell exports an empty string, which is set
    // as far as `in` is concerned but useless as a connection string — and
    // the test files' own `url ? describe : describe.skip` gate treats it as
    // falsy, so reporting it as enabled would contradict what actually runs.
    // Mutation: test `env[DB_URL_ENV] !== undefined` instead of trimming.
    expect(classify({ [DB_URL_ENV]: "" }).state).toBe("absent");
    expect(classify({ [DB_URL_ENV]: "   " }).state).toBe("absent");
  });

  // ── The cries-wolf trap ────────────────────────────────────────────────

  it("does NOT call the placeholder DATABASE_URL a near-miss", () => {
    // `vitest.config.ts` pins `DATABASE_URL` to a fake value so PrismaClient's
    // datasource block resolves at construction time. It is therefore ALWAYS
    // set inside a worker, whether or not the developer set anything.
    //
    // Treating that as "the developer made the reasonable guess" would fire
    // the near-miss advice on literally every run — recreating, in the new
    // code, the exact cries-wolf failure this change exists to remove. The
    // old `TEST_DATABASE_URL is NOT set` line cost two reviewers an
    // independent verification each for precisely that reason.
    //
    // Mutation: delete the `!== PINNED_PLACEHOLDER_URL` clause in `classify`.
    // This test then fails, and so does the banner test below.
    expect(classify({ [APP_URL_ENV]: PINNED_PLACEHOLDER_URL }).state).toBe("absent");
  });

  it("still treats a real URL on the same host as a near-miss", () => {
    // Guards the discount above from being written too broadly — matching on
    // "localhost" or on the port would swallow a developer's genuine local
    // database, which is the single most likely thing to be at
    // localhost:5432 and the one this must warn about.
    // Mutation: compare only the host, or use `.includes("localhost")`.
    expect(classify({ [APP_URL_ENV]: "postgresql://me:pw@localhost:5432/my_real_db" }).state).toBe(
      "near-miss",
    );
  });
});

describe("banner — a partial run must not read like a complete one", () => {
  const text = (env: Record<string, string>) => banner(classify(env), 133, 497).join("\n");

  it("makes the enabled and skipped banners different text", () => {
    // THE property, stated directly. Everything else in this file is a
    // refinement of it: if these two strings are ever equal, a reader cannot
    // tell a run that proved everything from one that proved 73% of it, and
    // the defect is back regardless of how much prose each contains.
    // Mutation: return the same array from both branches of `banner`.
    expect(text(ENABLED)).not.toBe(text(NOTHING_SET));
  });

  it("states positively that the gated files RAN when they did", () => {
    // Criterion 2: the healthy case must be as explicit as the broken one.
    // Silence on success would leave the reader doing the same manual
    // verification either way, and a signal that has to be audited by hand
    // has stopped being a signal.
    // Mutation: return [] for the "enabled" state.
    const enabled = text(ENABLED);
    expect(enabled).toMatch(/ENABLED/);
    expect(enabled).toMatch(/will RUN/);
    expect(enabled).not.toMatch(/SKIP/);
  });

  it("states that they SKIPPED when they did, with the count", () => {
    // Criterion 1. "Some suites were skipped" would satisfy a looser test
    // while telling a reader nothing about whether it was 3 files or 300 —
    // and the size of the hole is the whole question.
    // Mutation: drop the interpolated `gatedCount` from the template.
    const skipped = text(NOTHING_SET);
    expect(skipped).toMatch(/SKIP/);
    expect(skipped).toContain("133");
    expect(skipped).toContain("497");
  });

  it("names the variable that would enable the suites", () => {
    // A count raises the question; the banner has to answer it in place, or
    // it has relocated the manual step rather than removed it. Deferring the
    // diagnosis to a second command still requires the reader to suspect
    // something first, and the reader who trusts a green run does not.
    // Mutation: replace `DB_URL_ENV` with a vague "the database variable".
    expect(text(NOTHING_SET)).toContain(DB_URL_ENV);
  });

  it("answers the reasonable guess instead of ignoring it", () => {
    // Criterion 4, and the reason this module exists rather than a one-line
    // console.log. A developer who set DATABASE_URL did the sensible thing
    // and got a silently vacuous run; they must be told, by name, that it is
    // not the variable the suite reads.
    // Mutation: delete the `near-miss` block from `banner`. The banner still
    // renders and still says "SKIPPED", so only this test catches it.
    const nearMiss = text(NEAR_MISS);
    expect(nearMiss).toContain(APP_URL_ENV);
    expect(nearMiss).toMatch(/does NOT read it/);
  });

  it("gives the near-miss reader different advice from the no-database reader", () => {
    // Someone with a database already running does not need `npm run db:up`;
    // someone with nothing does not need to be told about a variable they
    // have not set. Collapsing the two wastes the one moment the reader is
    // actually paying attention.
    // Mutation: make both branches append the same remedy line.
    expect(text(NEAR_MISS)).not.toBe(text(NOTHING_SET));
    expect(text(NOTHING_SET)).toMatch(/db:up/);
  });

  it("warns that the test suite destroys databases, so the guess stays refused", () => {
    // The reason DATABASE_URL is not simply accepted as a fallback, stated
    // where the person tempted to wire it will read it. These files
    // `CREATE DATABASE`, clone templates and `DROP DATABASE ... WITH (FORCE)`
    // — see tests/helpers/global-setup.ts. Without this sentence the obvious
    // next step is `export TEST_DATABASE_URL=$DATABASE_URL` pointed at
    // something that matters.
    // Mutation: delete the "create, clone or DROP" clause.
    expect(text(NEAR_MISS)).toMatch(/DROP/);
  });

  it("does not show the near-miss advice on an ordinary no-database run", () => {
    // Advice printed unconditionally is advice a reader learns to scroll
    // past, and a banner that cries wolf on every run buys nothing with the
    // one run where it is telling the truth.
    // Mutation: append the near-miss block to every skipped banner.
    expect(text(NOTHING_SET)).not.toMatch(/does NOT read it/);
  });
});
