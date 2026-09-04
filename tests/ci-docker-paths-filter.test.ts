// The `docker-build` job in `.github/workflows/ci.yml` only runs when the
// `changes` job's `docker` `dorny/paths-filter` output is `true` — otherwise
// `docker-build-gate` reports "Pass — Docker files not changed" without ever
// building the image. That filter used to list only Dockerfile-adjacent
// paths (`Dockerfile`, `.dockerignore`, `docker-compose*.yml`), so a PR that
// changed nothing but `package.json` (e.g. adding an npm lifecycle script)
// could break `npm ci` inside the image while the required Docker check
// reported without ever running. This test proves the `docker` filter's
// coverage of `package.json`/`package-lock.json` stays real, not just
// documented in a comment that can silently go stale.
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
// Reused rather than re-implemented: these walk the YAML structurally, and a
// second copy would be a second thing to keep correct.
import { extractJobBlock, extractStepBlock } from "./helpers/ci-workflow-blocks";

/**
 * The real, git-tracked repo root — not `import.meta.dirname`, which under
 * Stryker's mutation-testing sandbox resolves inside the instrumented copy
 * of the tree rather than the real checkout. Same pattern used throughout
 * `tests/*.test.ts` (see `tests/adapter-registry.test.ts`).
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/**
 * Returns the raw list entries (e.g. `'Dockerfile'`) under a top-level
 * `dorny/paths-filter` filter key, scoped strictly between that key's line
 * and the next filter key at the same or lower indentation (or the end of
 * the filters block). A whole-file substring search would also match an
 * unrelated filter block that happens to mention the same path — this walks
 * the YAML structurally enough to avoid that false positive.
 */
function leadingSpaces(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? (match[1]?.length ?? 0) : 0;
}

export function extractFilterEntries(yamlText: string, filterKey: string): string[] {
  const lines = yamlText.split("\n");
  const keyLineIndex = lines.findIndex((line) => new RegExp(`^\\s*${filterKey}:\\s*$`).test(line));
  if (keyLineIndex === -1) {
    return [];
  }
  const keyLine = lines[keyLineIndex] ?? "";
  const keyIndent = leadingSpaces(keyLine);
  const entries: string[] = [];
  for (const line of lines.slice(keyLineIndex + 1)) {
    if (line.trim() === "") continue;
    // A sibling or parent key (same or shallower indent than `filterKey:`)
    // ends this block.
    if (leadingSpaces(line) <= keyIndent) break;
    const match = /^\s*-\s*'([^']*)'\s*$/.exec(line);
    if (match) entries.push(match[1] ?? "");
  }
  return entries;
}

describe("extractFilterEntries — scoping (proves this isn't a whole-file substring search)", () => {
  const synthetic = `
filters: |
  workflows:
    - '.github/workflows/**'
  docker:
    - 'Dockerfile'
    - 'package.json'
  source:
    - 'package.json'
    - 'src/**/*.ts'
`;

  it("reads only the named block's entries", () => {
    expect(extractFilterEntries(synthetic, "docker")).toEqual(["Dockerfile", "package.json"]);
  });

  it("does not leak entries from a sibling block sharing a value", () => {
    // `source` also lists 'package.json' — if this leaked across blocks,
    // asking for 'workflows' would wrongly report seeing it too.
    expect(extractFilterEntries(synthetic, "workflows")).toEqual([".github/workflows/**"]);
  });

  it("returns an empty list for a filter key that isn't present", () => {
    expect(extractFilterEntries(synthetic, "does-not-exist")).toEqual([]);
  });
});

describe("ci.yml docker paths-filter — package.json/package-lock.json coverage", () => {
  const ciYamlPath = () => path.join(repoRoot(), ".github", "workflows", "ci.yml");
  const dockerFilterEntries = () =>
    extractFilterEntries(readFileSync(ciYamlPath(), "utf8"), "docker");

  it("covers package.json — a lifecycle script change (e.g. `prepare`) can break `npm ci` inside the image", () => {
    expect(dockerFilterEntries()).toContain("package.json");
  });

  it("covers package-lock.json — a dependency bump can break `npm ci` inside the image the same way", () => {
    expect(dockerFilterEntries()).toContain("package-lock.json");
  });

  // The regression this whole file exists to catch: prove the assertions
  // above are not vacuously true. Feeding the extractor a copy of the real
  // filter block with those two lines stripped out (the exact shape of the
  // regression that let v0.2.0 ship a broken image undetected) must make
  // both checks fail — if it didn't, "contains package.json" would be
  // trivially true regardless of what the file actually says.
  it("would fail if that coverage were removed from the file", () => {
    const withoutNpmCoverage = readFileSync(ciYamlPath(), "utf8").replace(
      /(docker:\n(?:.*\n)*?)(\s*-\s*'package\.json'\n\s*-\s*'package-lock\.json'\n)/,
      "$1",
    );
    const entries = extractFilterEntries(withoutNpmCoverage, "docker");
    expect(entries).not.toContain("package.json");
    expect(entries).not.toContain("package-lock.json");
  });

  it("still covers the original Dockerfile-adjacent paths (this fix must not narrow existing coverage)", () => {
    const entries = dockerFilterEntries();
    expect(entries).toEqual(
      expect.arrayContaining([
        "Dockerfile",
        ".dockerignore",
        "docker-compose.yml",
        "docker-compose.prod.yml",
      ]),
    );
  });
});

// ── The gate's "did not build" pass has to be legible as such ───────────
//
// `docker-build-gate` passes in ~4s on a pull request touching no Docker
// files, and in the check list that is indistinguishable from a run that
// really built the image. Its conclusion cannot express the difference —
// a workflow job reports only `success`/`failure`, and GitHub Actions
// cannot emit a `neutral` conclusion — so the job summary carries it.
//
// **The check's NAME is deliberately unchanged here**, unlike
// `mutation-testing-gate`: `Docker build (required)` is a required status
// check context in branch protection on `main`
// (`docs/merge-queue-runbook.md`), and protection matches on the name.
// Renaming it in the workflow alone would leave protection waiting forever
// on a context no run posts, blocking every pull request. That makes the
// rename an admin settings change, not a code change.
describe("the docker gate's no-op pass states that nothing was built", () => {
  const GATE = extractJobBlock(
    readFileSync(path.join(repoRoot(), ".github", "workflows", "ci.yml"), "utf8"),
    "docker-build-gate",
  );

  it("finds the gate job and does not run vacuously", () => {
    expect(GATE).not.toBe("");
  });

  // Fails if `>> "$GITHUB_STEP_SUMMARY"` is dropped from the skip branch,
  // restoring a green tick that says nothing about what it checked.
  it("writes a job summary on the branch that skips the build", () => {
    const step = extractStepBlock(GATE, "needs.changes.outputs.docker == 'false'");
    expect(step, "no step is guarded by the docker == 'false' condition").not.toBe("");
    expect(step).toContain("GITHUB_STEP_SUMMARY");
    // States the absence, rather than merely existing. Fails if the wording
    // is softened into something that reads as a successful build.
    expect(step.toLowerCase()).toContain("no image was built");
  });

  // The name is load-bearing for branch protection. Fails if someone
  // "fixes" it to match the mutation gate's rename without also editing the
  // repository settings — which would block every pull request.
  it("keeps the exact required-context name branch protection matches on", () => {
    expect(GATE).toContain("name: Docker build (required)");
  });
});

// ── The rule, enforced from the Dockerfile rather than from a list ──────
//
// The two omissions this block was written for — `scripts/**` and
// `prisma/**` — were not subtle. `scripts` is COPYed into the image three
// times, one of its files IS the image's start command
// (`CMD ["node", "scripts/entrypoint.mjs"]`), and another is RUN during the
// build. `prisma` is COPYed three times and `prisma generate` runs against
// it. Both were missing from the filter for as long as the filter existed,
// so a pull request changing the container's boot sequence got a green
// `Docker build (required)` in about four seconds without building anything.
//
// Adding two lines fixes the two known gaps. What keeps them fixed is
// deriving the requirement from the Dockerfile: these tests read its own
// COPY and RUN
// lines and demand the filter cover each build-context path they name. A
// future `COPY config ./config` therefore fails CI until the filter catches
// up, instead of silently reopening the hole — which is the same failure
// mode, one directory over.
describe("ci.yml docker paths-filter — covers everything the image is built from", () => {
  const dockerfile = () => readFileSync(path.join(repoRoot(), "Dockerfile"), "utf8");
  const dockerFilterEntries = () =>
    extractFilterEntries(
      readFileSync(path.join(repoRoot(), ".github", "workflows", "ci.yml"), "utf8"),
      "docker",
    );

  /**
   * The repo-relative paths a Dockerfile reads out of the **build context**.
   *
   * `COPY --from=<stage>` is excluded deliberately and is not an oversight:
   * it reads from an earlier build stage, not from the checkout, so a
   * `COPY --from=build /app/scripts ./scripts` says nothing about which
   * repository file a pull request may have touched. Including them would
   * make this check demand filter entries for `/app/.next/standalone`,
   * which no pull request can change directly — a requirement that is both
   * unsatisfiable and meaningless.
   *
   * `COPY . .` is likewise excluded: it names no path to require, and a
   * check that read it as "require everything" would demand the filter list
   * the whole repository and stop distinguishing anything.
   */
  function contextPathsCopied(text: string): string[] {
    const paths: string[] = [];
    for (const line of text.split("\n")) {
      const copy = /^COPY\s+(.*)$/.exec(line.trim());
      if (copy) {
        const args = copy[1] ?? "";
        if (args.includes("--from=")) continue;
        // Everything but the final destination argument is a source.
        const parts = args.split(/\s+/).filter((part) => part !== "" && !part.startsWith("--"));
        for (const source of parts.slice(0, -1)) {
          if (source === "." || source === "./") continue;
          paths.push(source);
        }
      }
      // `RUN node scripts/foo.mjs` executes a context file during the build,
      // which breaks the image just as surely as copying it does.
      const run = /^RUN\s+.*?\bnode\s+([\w./-]+)/.exec(line.trim());
      if (run?.[1]) paths.push(run[1]);
    }
    return paths;
  }

  /** The `CMD`'s script, which is what the container actually starts. */
  function startCommandPath(text: string): string | undefined {
    const cmd = /^CMD\s+\[([^\]]*)\]/m.exec(text);
    if (!cmd) return undefined;
    const args = [...(cmd[1] ?? "").matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
    return args.find((arg) => /[\w-]+\.(mjs|js|cjs|ts)$/.test(arg));
  }

  /** Whether any filter entry would match this path — exact, or a `dir/**` prefix. */
  function covered(entries: readonly string[], candidate: string): boolean {
    const normalised = candidate.replace(/^\.\//, "").replace(/\*$/, "");
    return entries.some((entry) => {
      if (entry === normalised) return true;
      const globbed = /^(.*?)\/\*\*$/.exec(entry);
      if (globbed?.[1]) return normalised === globbed[1] || normalised.startsWith(`${globbed[1]}/`);
      // `package-lock.json*` in the Dockerfile against `package-lock.json`
      // in the filter, and the reverse.
      return entry.replace(/\*$/, "") === normalised;
    });
  }

  it("reads real COPY sources out of the Dockerfile (not an empty sweep)", () => {
    const found = contextPathsCopied(dockerfile());
    // Fails if the parser stops recognising `COPY`, which would make every
    // assertion below vacuously true.
    expect(found).toContain("scripts");
    expect(found).toContain("prisma");
    expect(found).toContain("package.json");
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it("excludes `--from=` stage copies, which name no build-context path", () => {
    const found = contextPathsCopied(dockerfile());
    // These are real `COPY --from=build` sources in the Dockerfile. If the
    // parser stopped excluding stage copies it would demand filter entries
    // for build outputs no pull request can touch.
    expect(found).not.toContain("/app/.next/standalone");
    expect(found).not.toContain("/app/node_modules");
  });

  it("covers every build-context path the Dockerfile copies or runs", () => {
    const entries = dockerFilterEntries();
    const uncovered = [...new Set(contextPathsCopied(dockerfile()))].filter(
      (candidate) => !covered(entries, candidate),
    );
    expect(
      uncovered,
      `the Dockerfile reads these from the build context, but the \`docker\` paths-filter does ` +
        `not list them — a change to one would leave "Docker build (required)" passing without ` +
        `building an image:\n  ${uncovered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("covers the directory holding the image's start command", () => {
    const start = startCommandPath(dockerfile());
    expect(start, "no CMD script found in the Dockerfile").toBeDefined();
    // The literal defect: CMD is `scripts/entrypoint.mjs` and `scripts/**`
    // was absent from the filter.
    expect(covered(dockerFilterEntries(), start!)).toBe(true);
  });

  // ── The seeded violations ───────────────────────────────────────────────
  //
  // Everything above reports zero against the fixed tree, which is also what
  // a detector that lost its way reports. These re-create the exact hole that
  // shipped and require the check to catch it.

  it("FAILS when `scripts/**` is taken back out of the filter — the defect as it shipped", () => {
    const withoutScripts = readFileSync(
      path.join(repoRoot(), ".github", "workflows", "ci.yml"),
      "utf8",
    ).replace(/^[ \t]*-[ \t]*'scripts\/\*\*'\n/m, "");
    const entries = extractFilterEntries(withoutScripts, "docker");
    // The seeding really removed it — without this the rest passes vacuously.
    expect(entries).not.toContain("scripts/**");
    expect(entries).toContain("Dockerfile");
    // A change to `scripts/entrypoint.mjs` — the container's start command —
    // is now ungated, and both checks above must say so.
    const uncovered = [...new Set(contextPathsCopied(dockerfile()))].filter(
      (candidate) => !covered(entries, candidate),
    );
    expect(uncovered).toContain("scripts");
    expect(covered(entries, startCommandPath(dockerfile())!)).toBe(false);
  });

  it("FAILS when `prisma/**` is taken back out of the filter", () => {
    const withoutPrisma = readFileSync(
      path.join(repoRoot(), ".github", "workflows", "ci.yml"),
      "utf8",
    ).replace(/^[ \t]*-[ \t]*'prisma\/\*\*'\n/m, "");
    const entries = extractFilterEntries(withoutPrisma, "docker");
    expect(entries).not.toContain("prisma/**");
    expect(entries).toContain("Dockerfile");
    const uncovered = [...new Set(contextPathsCopied(dockerfile()))].filter(
      (candidate) => !covered(entries, candidate),
    );
    expect(uncovered).toContain("prisma");
  });

  it("FAILS on a newly added COPY the filter does not yet list", () => {
    // The forward-looking half: a Dockerfile that starts copying a new
    // directory must fail until the filter catches up. Seeded into the
    // Dockerfile text rather than the filter, so it pins the direction the
    // real regression will come from.
    const seeded = `${dockerfile()}\nCOPY config ./config\n`;
    const uncovered = [...new Set(contextPathsCopied(seeded))].filter(
      (candidate) => !covered(dockerFilterEntries(), candidate),
    );
    expect(uncovered).toEqual(["config"]);
  });

  it("does not flag a path the filter covers only via a `dir/**` glob", () => {
    // Isolates the glob-matching half of `covered`. `scripts` is copied as a
    // bare directory name and listed as `scripts/**`; if globs stopped
    // matching, the passing test above would fail for the wrong reason and
    // this pins which behaviour is responsible.
    expect(covered(["scripts/**"], "scripts")).toBe(true);
    expect(covered(["scripts/**"], "scripts/entrypoint.mjs")).toBe(true);
    // And does not over-match a sibling directory sharing a prefix.
    expect(covered(["scripts/**"], "scripts-extra")).toBe(false);
  });
});
