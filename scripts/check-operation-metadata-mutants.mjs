#!/usr/bin/env node
/**
 * Fails when a service operation's registry metadata is left open to
 * mutation testing, where it can only ever be reported as a false survivor.
 *
 * ── The mutants this is about, and why they are unkillable ──────────────
 *
 * Every operation declares itself the same way:
 *
 *     export const note = defineOperation({
 *       name: "note",
 *       kind: "write",
 *       summary: "Leaves a timestamped remark on an item.",
 *       …
 *
 * Mutating `name`, `kind` or `summary` to an empty string, or emptying the
 * object literal outright, produces four mutants that **no test can kill** —
 * however thoroughly the metadata is asserted, and it is asserted, by
 * `tests/service-registry.test.ts` across the whole registry.
 *
 * The reason is evaluation order, and it is worth stating precisely because
 * the obvious fix does not work. Stryker activates a mutant at **run time**,
 * by checking `global.activeMutant` where the mutated expression evaluates.
 * An operation's metadata is a module-level object literal: it evaluates
 * **once, at import**, and `registry.ts` reads it into the registry as the
 * module loads — before the first test body runs, and never again. By the
 * time any assertion executes, the value it reads was computed before the
 * mutant existed.
 *
 * **So moving the assertion into a test body does not help**, which is the
 * intuitive fix and is worth ruling out explicitly. Measured directly
 * against one operation: with metadata assertions living in a test body and
 * reading the registry, all four mutants still survived. The report showed
 * them covered by exactly three tests — the three in
 * `tests/cli-init-dispatch.test.ts`, which are the only tests in the tree
 * that call `vi.resetModules()` and re-import the module graph, and are
 * therefore the only ones that re-evaluate the literal *during* a test body.
 * They do not assert this metadata, so even they cannot kill it. Nothing
 * else covers the mutants at all.
 *
 * `ignoreStatic` does not cover them either: Stryker classifies them as
 * coverable-but-uncovered rather than static, so they are reported as
 * survivors rather than ignored. And `excludedMutations` is per mutator
 * *type*, so silencing string-literal mutations here would silence them
 * everywhere — far too blunt for the problem.
 *
 * That leaves the per-declaration disable annotation as the only mechanism
 * that is both correct and narrow. It is correct because these mutants are
 * unkillable by construction, **not** because the metadata is untested — a
 * distinction the comment has to state, or it reads as coverage being waved
 * away.
 *
 * ── Why a check rather than a convention ────────────────────────────────
 *
 * CI mutates **changed files**, so any pull request touching an operation
 * pulls that operation into scope for the first time and meets this. The
 * failure presents as a batch of survivors against metadata that visibly
 * already has tests, and the whole diagnosis gets re-derived from scratch by
 * whoever hits it. Requiring the annotation up front turns that into a
 * failure with the reason attached.
 *
 * ── What a green run means, and what it does not ────────────────────────
 *
 * **A green run means every declaration carries the annotation. It does not
 * mean the metadata is correct, tested, or that the annotation is placed to
 * cover exactly the right lines** — this reads source text, and never runs
 * Stryker or a test.
 *
 * It matches the declaration shape used throughout the operations directory
 * (a `defineOperation({` opening a multi-line literal). An operation that
 * declares itself some other way is invisible here, exactly as a new
 * phrasing is invisible to the external-reference check, and for the same
 * reason: a fixed set of known shapes can only certify those shapes.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where operations live. A constant so the self-test can point elsewhere. */
export const OPERATIONS_DIR = "src/lib/service/operations";

/** The call every operation declares itself with. */
export const DECLARATION = "defineOperation({";

/** The annotation that must precede it, and the one that closes the range. */
export const DISABLE_COMMENT = "// Stryker disable all";
export const RESTORE_COMMENT = "// Stryker restore all";

/**
 * How far above the declaration the annotation may sit.
 *
 * Not "the line immediately above", because the annotation carries a written
 * reason and that reason is the point of it — a multi-line comment block is
 * the shape actually wanted. The window bounds how far the search runs, so
 * an unrelated disable elsewhere in the file cannot be mistaken for this one.
 */
export const LOOKBEHIND_LINES = 30;

/** Every `.ts` file declaring an operation, as repo-relative paths. */
export function operationFiles(root = repoRoot) {
  const absolute = path.join(root, OPERATIONS_DIR);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.posix.join(OPERATIONS_DIR, entry.name))
    .filter((file) => readFileSync(path.join(root, file), "utf8").includes(DECLARATION))
    .sort();
}

/**
 * The declarations in one file's text that are not covered by the
 * annotation, as line numbers.
 *
 * A declaration counts as annotated when **both** hold:
 *
 *   - a disable comment appears within the lookbehind window above it and is
 *     not already closed by a restore between the two — a restore in between
 *     means that range ended before reaching this declaration, so it covers
 *     something else; and
 *   - a restore comment follows, within the same window below.
 *
 * The closing half matters as much as the opening one, and it is the easier
 * of the two to leave out. An unclosed range does not stop at the metadata:
 * it runs on through the `input` schema and the whole handler, silencing
 * mutants that are genuinely killable and genuinely worth killing. That is a
 * real loss of signal wearing the annotation's clothes, and it is exactly
 * what this check exists to prevent — so a range with no visible end is
 * reported rather than trusted.
 */
export function unannotatedDeclarations(text) {
  const lines = text.split(/\r?\n/);
  const found = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(DECLARATION)) continue;

    let opened = false;
    for (let back = index - 1; back >= 0 && index - back <= LOOKBEHIND_LINES; back -= 1) {
      const line = lines[back];
      if (line.includes(RESTORE_COMMENT)) break;
      if (line.includes(DISABLE_COMMENT)) {
        opened = true;
        break;
      }
    }

    // The range must also visibly end. Searching forward stops at the next
    // declaration as well as at the window edge: a restore found beyond one
    // belongs to that declaration, not this one, and reading it as this
    // one's would call an unclosed range closed.
    let closed = false;
    for (
      let ahead = index + 1;
      ahead < lines.length && ahead - index <= LOOKBEHIND_LINES;
      ahead += 1
    ) {
      const line = lines[ahead];
      if (line.includes(DECLARATION)) break;
      if (line.includes(RESTORE_COMMENT)) {
        closed = true;
        break;
      }
    }

    if (!opened || !closed) found.push(index + 1);
  }

  return found;
}

export function analyse(root = repoRoot) {
  const files = operationFiles(root);
  const offenders = [];
  for (const file of files) {
    const lines = unannotatedDeclarations(readFileSync(path.join(root, file), "utf8"));
    if (lines.length > 0) offenders.push({ file, lines });
  }
  return { files, offenders };
}

export function main(root = repoRoot) {
  const { files, offenders } = analyse(root);

  // A check that inspected nothing must not report success — the same
  // posture the database-import allowlist takes for an empty scan.
  if (files.length === 0) {
    console.error(
      `check-operation-metadata-mutants found no ${DECLARATION} declarations under\n` +
        `${OPERATIONS_DIR}. That means this check is not running against anything, which is\n` +
        "worse than not running at all.",
    );
    return 1;
  }

  const summary = `Checked ${files.length} operation file${files.length === 1 ? "" : "s"}.`;

  if (offenders.length === 0) {
    console.log(`${summary} Every declaration's metadata is annotated for mutation testing.`);
    return 0;
  }

  for (const { file, lines } of offenders) {
    for (const line of lines) {
      console.error(
        `${file}:${line}  [unannotated-metadata]  the metadata is open to mutation testing.\n` +
          `    ↳ wrap name/kind/summary between ${DISABLE_COMMENT} and ${RESTORE_COMMENT},\n` +
          "      with a comment saying these mutants are unkillable by construction\n" +
          "      (the literal evaluates at import, before any mutant is active) and NOT\n" +
          "      that the metadata is untested.",
      );
    }
  }

  console.error(
    `\n${summary}\n\n` +
      `${offenders.length} file${offenders.length === 1 ? "" : "s"} would report false survivors the\n` +
      "moment a pull request brings them into the mutation scope, because CI mutates\n" +
      "changed files. Moving the assertions into a test body does NOT fix it — measured,\n" +
      "the mutants survive regardless, because the metadata is read into the registry at\n" +
      "import and never re-evaluated.\n\n" +
      "Note what a green run does NOT prove: this reads source text only. It does not\n" +
      "check that the metadata is correct or tested.",
  );
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
