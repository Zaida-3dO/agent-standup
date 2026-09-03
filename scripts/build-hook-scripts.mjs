#!/usr/bin/env node
/**
 * Builds the standalone, servable copy of each hook variant's script —
 * MILESTONES.md #125(b): `GET /hook/script?variant=<variant>` has to hand a
 * caller one file it can write straight to disk and wire up, not a directory
 * tree.
 *
 * ── Why this is a second build, not a reuse of `dist/bin/standup-hook.js` ─
 *
 * `build-cli.mjs`'s own build uses `splitting: true` so the published
 * `standup` binary can defer loading the database client until the `direct`
 * binding is actually selected (see that file's header). Splitting is
 * exactly wrong here: it produces an entry file that `import`s hashed chunk
 * files sitting *beside* it, and the whole point of this route is that a
 * caller fetches **one URL** and gets something it can drop in place. A
 * split entry point served alone is missing the chunks it needs to run.
 *
 * So each variant gets its own `outfile` (not `outdir`), `bundle: true`,
 * `splitting: false` (the esbuild default, named for clarity) — a flat,
 * self-contained file. The published npm package still gets the split build
 * for the reason `build-cli.mjs` documents; this build exists only to be
 * served.
 *
 * ── Why keyed by variant, not by entry point ───────────────────────────
 *
 * `HOOK_SCRIPT_ENTRY_POINTS` is a map from `HookVariant` (`build-constants.ts`)
 * to the source file that implements it. Only `http` has one —
 * `src/bin/standup-hook.ts` reaches the server over `POST /api/hook`
 * (`src/lib/hook/ask-http.ts`), which is the HTTP hook protocol
 * (`src/lib/hook/protocol.ts`'s `SHIPPED_HOOK_VARIANT`). `cli` is a real,
 * versioned slot in the schema (SCHEMA.md §21's `hook_variant` column) with
 * no script built for it yet, and the route this build feeds has to answer
 * that case honestly (not found, not "unknown variant") rather than by this
 * script silently producing nothing for it. Adding the `cli` hook is then
 * one entry in this map, not a second build script.
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** `HookVariant -> source entry point`, for every variant that has a script built. */
export const HOOK_SCRIPT_ENTRY_POINTS = Object.freeze({
  http: "src/bin/standup-hook.ts",
});

export const HOOK_SCRIPTS_DIR = "dist/hook-scripts";

/**
 * The identifier this build stamps into the artifact when git cannot name a
 * commit. Kept in step with `UNSTAMPED` in `src/lib/hook/build-stamp.ts`,
 * which `tests/hook-build-stamp.test.ts` asserts — the two are deliberately
 * separate files (one is bundled into the artifact, one drives the bundler)
 * so the value is repeated exactly once and the repetition is checked.
 */
export const UNSTAMPED = "unstamped";

/**
 * The commit to stamp into the artifact.
 *
 * ── Why a dirty tree is not the checked-out commit ──────────────────────
 *
 * A build made from a modified working tree is not the commit `HEAD` names —
 * it is that commit plus edits nobody else can resolve. Stamping the bare
 * SHA would make such a build claim provenance it does not have, and a
 * checker comparing stamps would call it current when it is not reproducible
 * from anything. So a dirty build is suffixed `-dirty`: it still names the
 * commit it started from (which is the useful part when reading a stale
 * artifact) while never comparing equal to a clean build of that commit.
 *
 * ── Why a failure here is not a build failure ───────────────────────────
 *
 * Building outside a git checkout — from an unpacked tarball, or in a
 * container that copied sources without `.git` — is legitimate, and refusing
 * to build there would break packaging to gain nothing. Such a build stamps
 * {@link UNSTAMPED}, which is an honest "provenance unknown" and is exactly
 * what the checker treats as unverifiable rather than as current. The one
 * outcome ruled out is a build that *looks* stamped while carrying a
 * fabricated or guessed commit.
 */
export function resolveBuildCommit() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commit === "") return UNSTAMPED;

    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    return status === "" ? commit : `${commit}-dirty`;
  } catch {
    return UNSTAMPED;
  }
}

/** Builds every entry in `HOOK_SCRIPT_ENTRY_POINTS` as a standalone, servable file. */
export async function buildHookScripts() {
  await rm(HOOK_SCRIPTS_DIR, { recursive: true, force: true });

  // Substituted into `src/lib/hook/build-stamp.ts`'s `HOOK_BUILD_COMMIT` so
  // the artifact can state which source it was built from — the thing whose
  // absence let a hook eight days older than the feature it exercised run
  // every session in silence. `JSON.stringify` because `define` substitutes
  // *source text* for an identifier, so the value has to arrive as a quoted
  // literal and not as a bare identifier.
  const buildCommit = resolveBuildCommit();

  await Promise.all(
    Object.entries(HOOK_SCRIPT_ENTRY_POINTS).map(([variant, entryPoint]) =>
      build({
        entryPoints: [entryPoint],
        outfile: path.join(HOOK_SCRIPTS_DIR, `${variant}.js`),
        bundle: true,
        splitting: false,
        format: "esm",
        platform: "node",
        target: "node24",
        packages: "external",
        sourcemap: false,
        logLevel: "info",
        define: { __STANDUP_HOOK_BUILD_COMMIT__: JSON.stringify(buildCommit) },
      }),
    ),
  );

  return { buildCommit };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildHookScripts().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
