#!/usr/bin/env node
/**
 * Prints the command line's user-visible grammar as stable, sorted text.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * The compaction this was written for folds eight hand-written command
 * modules into one table and a shared builder factory, and generates the
 * `http` binding's route map instead of hand-writing it. Every one of those
 * changes is maintainer-side by intent: **nothing a person types is meant to
 * change.** That intent is easy to state and easy to violate by accident —
 * a verb dropped from a table, an alias that silently stopped resolving, a
 * summary rewritten while "just" moving it.
 *
 * A diff cannot answer the question, because the whole point of the change
 * is that the diff is enormous. So the grammar is *captured* instead: run
 * this on the base commit, run it again on the branch, and compare the two
 * files. Identical output is a direct statement that the surface a person
 * touches did not move.
 *
 * ── What is captured, and why exactly this ──────────────────────────────
 *
 * Four things, because these are what a person can type or read:
 *
 *   - **`command`** — every `<noun> <verb>` pair, with the service
 *     operation it calls. The operation is included because a verb that
 *     kept its spelling but started calling a different operation is a
 *     behavioural change wearing an identical name, which is precisely the
 *     failure a name-only comparison would miss.
 *   - **`alias`** — every alias and the `<noun> <verb>` it resolves to.
 *   - **`noun`** / **`verbs`** — what `nouns()` and `verbsFor()` report,
 *     which is what `--help` renders and therefore what a person reads.
 *   - **`summary`** — each command's one-line help text, hashed rather than
 *     printed in full. Hashed because the summaries are long and would
 *     dominate the file, and because the only question being asked of them
 *     is "did this change", which a hash answers exactly.
 *
 * Sorted, so the output is a function of the grammar alone and not of
 * declaration order — a fold that reorders entries without changing any of
 * them should produce a byte-identical file, and does.
 *
 * ── What this does NOT claim ────────────────────────────────────────────
 *
 * It compares the *grammar*, not the behaviour behind it. Identical output
 * means the same commands exist, resolve the same way and call the same
 * operations; it does not mean each one still builds the same input from
 * the same words. `tests/cli-grammar-identity.test.ts` pins this file's
 * content against a committed baseline, and the builder-level behaviour is
 * the job of the per-command suites, which this does not replace.
 *
 * Usage:
 *   node scripts/cli-grammar-snapshot.mjs            # print to stdout
 */
import { createHash } from "node:crypto";

/**
 * Loads the command table through the TypeScript source.
 *
 * Imported dynamically from the built-by-vitest path is not available to a
 * plain `node` run, so this script is run through `tsx`/`vitest` when it
 * needs the real table. `renderGrammar` below is exported so the test can
 * call it with the table it already imports, which is the path that
 * actually runs in CI.
 */

/** A short, stable digest — enough to detect a change, short enough to read. */
function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * Renders the grammar as sorted lines.
 *
 * Takes the table rather than importing it so this is callable from a test
 * (which has the TypeScript module graph available) and from a script.
 */
export function renderGrammar({ commands, aliases, nouns, verbsFor }) {
  const lines = [];

  for (const spec of commands) {
    lines.push(`command\t${spec.noun}\t${spec.verb}\t${spec.operation}`);
    lines.push(`summary\t${spec.noun}\t${spec.verb}\t${digest(spec.summary)}`);
  }

  for (const [alias, target] of Object.entries(aliases)) {
    lines.push(`alias\t${alias}\t${target[0]}\t${target[1]}`);
  }

  for (const noun of nouns()) {
    lines.push(`noun\t${noun}`);
    lines.push(`verbs\t${noun}\t${[...verbsFor(noun)].join(" ")}`);
  }

  // Sorted so the file is a function of the grammar, not of declaration
  // order. A fold that reorders entries produces identical bytes.
  return `${lines.sort().join("\n")}\n`;
}
