#!/usr/bin/env node
/**
 * Writes the Claude Code plugin directory (MILESTONES.md #48).
 *
 * One install carries the MCP configuration, the hook wiring and the
 * `standup` command line, so a machine ends up fully wired rather than
 * three-quarters wired with a step nobody wrote down (DECISIONS.md §10).
 *
 * ── This script decides nothing ─────────────────────────────────────────
 *
 * Every value it writes comes from `src/lib/plugin/manifest.ts`; the whole
 * of this file is "turn those values into files". That split is deliberate:
 * the contents are the part worth asserting, and a decision that only exists
 * inside a function which also creates directories can only be tested by
 * creating directories.
 * `tests/plugin-package.test.ts` reads the built output; every claim about
 * *what should be in it* is asserted against the module, with no filesystem.
 *
 * ── Nothing is copied into the plugin ───────────────────────────────────
 *
 * The plugin declares `agent-standup` as a dependency and resolves both the
 * binary and the hook script through the package manager. It does not carry
 * a copy of either, because a copy is a second version of the artefact that
 * decides whether a tool call is allowed, and two versions drift with
 * nothing comparing them. This script therefore writes configuration files
 * and nothing else — if it ever grows a `copyFile`, that is the bug the row
 * exists to prevent.
 *
 * Usage: `node scripts/build-plugin.mjs` (wired as `npm run build:plugin`).
 */
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const PLUGIN_DIR = "dist/plugin";

/** The modules whose exported values are the plugin's contents. */
export const CONTENT_ENTRY_POINTS = Object.freeze([
  "src/lib/plugin/manifest.ts",
  "src/lib/plugin/skill.ts",
]);

/**
 * Compiles the content modules and imports them.
 *
 * They live under `src/` because the command line imports them too, and
 * `src/` is TypeScript using the `@/` path alias, which is a
 * TypeScript-only resolution rule Node has no equivalent for. So something
 * has to compile them before their values can be read. The alternative —
 * writing the same values out again in JavaScript here — is exactly the
 * drift this row exists to prevent, one copy for the command line and one
 * for the build.
 *
 * A temporary output directory rather than `dist/`: this build is not the
 * published artefact, and writing into `dist/` would put files in the
 * package that nothing installs, as well as racing whichever other build is
 * writing there.
 */
async function loadContentModules(workDir) {
  await build({
    entryPoints: [...CONTENT_ENTRY_POINTS],
    outdir: workDir,
    outbase: "src",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "external",
    logLevel: "silent",
  });

  const load = async (name) => {
    const built = path.resolve(workDir, "lib/plugin", name);
    // A cache-busting query, because this function runs more than once in a
    // single test process and Node's ESM loader caches by URL — without it
    // a second call would silently return the first build's values.
    return import(`file://${built.replace(/\\/g, "/")}?t=${Date.now()}${Math.random()}`);
  };

  return { manifest: await load("manifest.js"), skill: await load("skill.js") };
}

/**
 * @param {{ version: string, pluginDir?: string }} options
 */
export async function buildPlugin({ version, pluginDir = PLUGIN_DIR }) {
  // A clean start, so a file dropped from a later revision of this build
  // cannot survive in the output and be read as still shipping.
  await rm(pluginDir, { recursive: true, force: true });

  const workDir = path.join(pluginDir, ".build");
  const { manifest, skill } = await loadContentModules(workDir);
  const { pluginManifest, hooksConfig, mcpConfig } = manifest;
  const { skillDocument, SKILL_NAME } = skill;

  await mkdir(path.join(pluginDir, "hooks"), { recursive: true });
  await mkdir(path.join(pluginDir, "skills", SKILL_NAME), { recursive: true });

  const files = {
    // `.claude-plugin/plugin.json` is where the loader looks for the
    // manifest; the other two sit at the plugin root by the same
    // convention.
    ".claude-plugin/plugin.json": pluginManifest({ version }),
    "hooks/hooks.json": hooksConfig(),
    ".mcp.json": mcpConfig(),
  };

  await mkdir(path.join(pluginDir, ".claude-plugin"), { recursive: true });

  for (const [relative, contents] of Object.entries(files)) {
    await writeFile(
      path.join(pluginDir, relative),
      `${JSON.stringify(contents, null, 2)}\n`,
      "utf8",
    );
  }

  // The skill is markdown, not JSON, so it is written apart from the loop
  // above rather than by teaching that loop a second serialisation.
  const skillPath = path.join("skills", SKILL_NAME, "SKILL.md");
  await writeFile(path.join(pluginDir, skillPath), skillDocument(), "utf8");

  // The compiled content modules were a means of reading values, not part
  // of what ships. Leaving them behind would put JavaScript inside the
  // plugin directory — indistinguishable, to anyone auditing the output,
  // from having vendored a copy of the binary on purpose, which is the one
  // shape this row exists to keep out.
  await rm(workDir, { recursive: true, force: true });

  return { pluginDir, files: [...Object.keys(files), skillPath] };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  buildPlugin({ version: pkg.version })
    .then(({ pluginDir, files }) => {
      console.log(`Wrote ${files.length} plugin files to ${pluginDir}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
