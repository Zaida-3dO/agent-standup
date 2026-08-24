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
// second copy would be a second thing to keep correct. `ci-mutation-gate`
// owns them and tests them directly.
import { extractJobBlock, extractStepBlock } from "./ci-mutation-gate.test";

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
