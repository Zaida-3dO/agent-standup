// Pure(ish) logic for scoping Stryker's `--mutate` argument to files changed
// relative to a base ref, split out of `scripts/run-mutation-tests.mjs` so
// the escaping and filtering rules are unit-testable — see
// `tests/mutation-scope.test.ts` — the same split `scripts/run-mutation-tests.mjs`
// already uses for report verification (`scripts/lib/mutation-report-guards.mjs`).
//
// ── Why a changed file path must be ESCAPED before being handed to Stryker ──
//
// Stryker's `-m/--mutate` value (and the `mutate` array in
// `stryker.config.json` — the exact same code path, see
// `ProjectReader.resolveFileDescriptions` in `@stryker-mutator/core`) is
// NEVER treated as a literal file path. Every entry is compiled into a
// minimatch glob and matched against every file Stryker finds in the
// project. A literal path containing minimatch-magic characters — most
// importantly Next.js's own dynamic-route folder syntax, `[id]`, and route
// groups, `(group)` — is silently reinterpreted as a character class /
// extglob group instead of matching itself: `[id]` parses as "exactly one
// of the characters i or d", which matches nothing on this project's real
// file tree (`src/app/api/items/[id]/route.ts` does not contain a
// single-character `i`-or-`d` path segment). Stryker's `FileMatcher` warns
// "did not result in any files" for a config-level pattern but does NOT
// warn at all for a CLI `--mutate` target pattern (verified empirically —
// see this change's handoff notes) — it just silently mutates nothing for
// that file and moves on. `assertRequestedFilesMutated` in
// `mutation-report-guards.mjs` is the second, load-bearing line of defence
// for exactly this shape: escaping closes brackets specifically;
// reconciliation makes the whole class of silent-skip self-detecting for
// any future special character this file doesn't know about yet.
//
// ── Why the escape is BRACKET self-quoting, never a backslash escape ────
//
// The obvious fix — backslash-escape each magic character, `\[id\]` — does
// NOT survive Stryker's own pattern normalization and must not be used.
// `FileMatcher`'s constructor (in `@stryker-mutator/core`) does
// `this.pattern = normalizeFileName(path.resolve(pattern))`, and
// `normalizeFileName` (from `@stryker-mutator/util`) unconditionally
// turns every `\` into `/` — on every platform this runs on, not only
// Windows. A backslash-escaped pattern is corrupted into something else
// entirely before minimatch ever sees it: verified empirically (both via
// the isolated function and a real `stryker run`) that
// `src/app/api/items/\[id\]/route.ts` normalizes to
// `.../items/[id/]/route.ts`, which matches nothing either. The bracket
// self-quoting technique below (`[` -> `[[]`, `]` -> `[]]`, same for the
// other minimatch-magic characters) uses only `[` and `]`, which
// `path.resolve` treats as ordinary path characters and `normalizeFileName`
// never touches, so it survives that normalization intact — confirmed with
// a real `npx stryker run --mutate "src/app/api/items/[[]id[]]/route.ts"`
// (see this change's handoff notes for the full command output: "Found 1 of
// 239 file(s) to be mutated", "Instrumented 1 source file(s) with 34
// mutant(s)").
//
// This mirrors minimatch's own public `escape(pattern, { windowsPathsNoEscape:
// true })` helper. It is reimplemented here rather than imported so this
// project does not take on a dependency on whichever minimatch major happens
// to be hoisted at the top of `node_modules` — verified in this change that
// TWO different minimatch majors are present simultaneously in this
// project's own tree (v3.1.5, hoisted at the top level for eslint's sake,
// and v10.2.6, nested under `@stryker-mutator/core`, which is the version
// Stryker itself actually resolves and runs — see package-lock.json). The
// bracket self-quoting technique is not new API surface specific to either
// version; it matched identically against both in this change's own
// testing, because it is how minimatch has represented a literal
// glob-magic character since its earliest versions.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GLOB_MAGIC_CHARACTERS = /[?*()[\]]/g;

/**
 * Escapes every minimatch-magic character in a single relative file path so
 * it matches only itself when passed to Stryker's `--mutate`. Forward
 * slashes are left untouched (they are the path separator, not magic to
 * minimatch), so this can be — and is — applied to a whole relative path
 * rather than segment by segment.
 */
export function escapeMutatePattern(relativeFilePath) {
  return relativeFilePath.replace(GLOB_MAGIC_CHARACTERS, "[$&]");
}

/**
 * Builds the value for Stryker's `--mutate <filesToMutate>` CLI flag from a
 * list of changed file paths: each path is escaped (see
 * `escapeMutatePattern`) and the results are comma-joined, because
 * Stryker's own CLI parser (`createSplitter(',')` in `stryker-cli.js`)
 * splits exactly one string on `,` into the array of patterns it actually
 * uses — there is no other way to pass more than one `--mutate` pattern on
 * the command line (repeating the flag does not accumulate; the splitter
 * ignores commander's `previous` argument, so only the LAST `--mutate` on
 * the command line takes effect).
 *
 * That comma-splitting is also why a literal comma in a changed file's path
 * would silently merge two files into one broken glob — the same silent-skip
 * shape this whole module exists to prevent, just triggered by a different
 * character. Rather than let that happen invisibly, this throws loudly and
 * immediately if it would occur (the changed-files reconciliation check in
 * `mutation-report-guards.mjs` would also eventually catch this, but failing
 * here is closer to the cause and doesn't require a full Stryker run first).
 */
export function buildMutateArg(files) {
  const withCommas = files.filter((f) => f.includes(","));
  if (withCommas.length > 0) {
    throw new Error(
      `cannot build a --mutate argument: ${withCommas.length} changed file path(s) contain a ` +
        `literal comma, which Stryker's own CLI parser uses as the ONLY separator between ` +
        `multiple --mutate patterns. Joining them would silently merge two file paths into one ` +
        `broken glob pattern:\n${withCommas.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
  return files.map(escapeMutatePattern).join(",");
}

/**
 * Filters raw `git diff --name-only` output (one path per line, possibly
 * with a trailing newline) down to the mutable TypeScript source files this
 * wrapper cares about: under `src/`, a `.ts`/`.tsx` extension, and still
 * present on disk (a deleted file has nothing left to mutate). Split out
 * from `changedSourceFiles` below purely so these filtering RULES are
 * testable without spawning git — see `tests/mutation-scope.test.ts`.
 */
/**
 * @param {string} diffOutput
 * @param {(filePath: string) => boolean} [fileExistsFn]
 */
export function filterChangedSourceFiles(diffOutput, fileExistsFn = existsSync) {
  return diffOutput
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => f.startsWith("src/"))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => fileExistsFn(f));
}

/**
 * Source files (under `src/`, TypeScript, excluding tests) changed relative
 * to `base`. Returns null (meaning "use the config default") when the diff
 * can't be computed — a --changed-only run on a branch with no source
 * changes returns an empty array (not null), which the caller treats as
 * "nothing to mutate" rather than falling back to the full default scope.
 */
export function changedSourceFiles(base) {
  const fetchResult = spawnSync("git", ["fetch", "origin", "main", "--quiet"], {
    stdio: "inherit",
  });
  if (fetchResult.status !== 0) {
    console.warn(
      `[run-mutation-tests] \`git fetch origin main\` failed (exit ${fetchResult.status}); ` +
        `diffing against the local ref ${base} without refreshing it first.`,
    );
  }

  const diff = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
  });
  if (diff.status !== 0 || diff.error) {
    console.warn(
      `[run-mutation-tests] could not diff against ${base}; falling back to the config's default mutate scope.`,
    );
    return null;
  }

  return filterChangedSourceFiles(diff.stdout);
}
