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
import { buildHookScripts } from "./build-hook-scripts.mjs";
import { buildPlugin } from "./build-plugin.mjs";

export { PLUGIN_DIR, buildPlugin } from "./build-plugin.mjs";

export {
  HOOK_SCRIPTS_DIR,
  HOOK_SCRIPT_ENTRY_POINTS,
  buildHookScripts,
} from "./build-hook-scripts.mjs";

export const ENTRY_POINT = "src/bin/standup.ts";

/**
 * The hook script (MILESTONES.md #42), built alongside the command line.
 *
 * A second entry point rather than a second build: the two share most of a
 * dependency graph, and `splitting: true` already puts anything common into
 * one chunk both load — so building them together produces a smaller
 * artefact than building them apart, and guarantees they cannot be compiled
 * against different versions of the code they share.
 *
 * **It is deliberately not added to `package.json`'s `bin`.** A hook is not
 * a command a person runs; it is a path an agent tool is configured to
 * execute, and row #48 is what writes that configuration. Putting it on the
 * PATH as `standup-hook` would invite it to be run by hand, where it reads
 * an empty stdin and — correctly, per its own fail-closed rule — denies,
 * which looks exactly like a broken install.
 */
export const HOOK_ENTRY_POINT = "src/bin/standup-hook.ts";
export const OUT_DIR = "dist";

export async function buildCli() {
  await rm(OUT_DIR, { recursive: true, force: true });

  await build({
    entryPoints: [ENTRY_POINT, HOOK_ENTRY_POINT],
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

  // `buildHookScripts` writes under `dist/hook-scripts/`, inside the tree
  // this function just deleted and recreated above — run it after, never
  // concurrently with, the `rm` above, or the two race over the same
  // directory. `GET /hook/script` (`src/app/api/hook/script/route.ts`) reads
  // this output, so every caller of `buildCli` (the npm `prepack` script,
  // `tests/helpers/global-setup.ts`, the Docker build) produces it too,
  // rather than needing a second command remembered in each place.
  await buildHookScripts();

  // The plugin directory (MILESTONES.md #48) is written from the values in
  // the bundle this function just produced, so it runs last and cannot be
  // hoisted above the build it reads. It writes configuration only — the
  // binary and the hook script it points at are resolved from the installed
  // package at run time, never copied in beside it.
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await buildPlugin({ version: pkg.version });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  buildCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
