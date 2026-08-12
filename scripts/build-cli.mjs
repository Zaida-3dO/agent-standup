#!/usr/bin/env node
/**
 * Builds the published `standup` binary from `src/bin/standup.ts`.
 *
 * Row #89 (MILESTONES.md) publishes the npm package with this binary on the
 * same version tag that publishes the image. Node cannot run the TypeScript
 * source directly — it uses the `@/` path alias (`tsconfig.json`), which is
 * a TypeScript-only resolution rule with no Node equivalent — so something
 * has to turn it into plain, alias-free JavaScript before it can ship as a
 * package `bin` entry. This is that step.
 *
 * ── Why code splitting, not a single flat bundle ────────────────────────
 *
 * `src/lib/cli/run.ts` deliberately loads `@/lib/service/live` (the
 * composition root that constructs the real Prisma client) with a dynamic
 * `import()`, and only when the `direct` binding is actually selected — see
 * its own header comment: "resolving to `http` never loads the composition
 * root ... which is what keeps a command against a server from needing a
 * database client in the process at all." A bundler that flattens everything
 * into one file has to hoist every `import` a bundled module contains to the
 * top of that one file, because ESM `import` statements are static — so a
 * naive single-file bundle would turn that lazy load back into an eager one,
 * and `standup --help` would start requiring `@prisma/client` to even print
 * its help text. Splitting (`splitting: true`, `outdir` rather than
 * `outfile`) keeps a dynamically-imported module in its own chunk file,
 * loaded by a real `import()` only when that code path actually runs — the
 * same property the source already has, preserved rather than undone by
 * this step. `tests/cli-package-publish.test.ts` asserts this directly by
 * checking the built entry file's own text, not by trusting this comment.
 *
 * `packages: "external"` leaves every `node_modules` dependency
 * (`@prisma/client`, `zod`, …) as a plain `import` specifier in the output
 * rather than inlining it — those are already listed in `dependencies` and
 * installed alongside the package, so bundling them in again would only
 * bloat the artefact and risk a stale copy of something npm already manages.
 *
 * Usage: `node scripts/build-cli.mjs` (wired as `npm run build:cli`, and run
 * automatically before `npm pack`/`npm publish` via the `prepack` script).
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const ENTRY_POINT = "src/bin/standup.ts";
export const OUT_DIR = "dist";

export async function buildCli() {
  await rm(OUT_DIR, { recursive: true, force: true });

  await build({
    entryPoints: [ENTRY_POINT],
    outdir: OUT_DIR,
    outbase: "src",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "external",
    sourcemap: false,
    logLevel: "info",
  });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
