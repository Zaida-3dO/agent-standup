// The chain that carries the running version from the build into the
// process, asserted end to end.
//
// ── Why this file exists at all ────────────────────────────────────────
//
// `src/lib/build-info.ts` is unit-tested against environments its own test
// supplies, which proves the *reader* works. It cannot prove anything about
// whether the build actually SETS those variables — and that half is where
// the original defect lived: `src/lib/settings/build-constants.ts` read
// `process.env.APP_VERSION` correctly for its whole life, while nothing in
// the Dockerfile or the release workflow ever set it, so the deployed
// settings panel showed `0.0.0-dev` and nobody noticed.
//
// So these assertions read the real Dockerfile and the real workflow off
// disk. Each one names a link in the chain that, if it broke, would leave a
// deployed build unable to say what it is — with every unit test still
// green. That is the exact failure mode this row was raised for.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The real repo root, not a Stryker sandbox copy — see service-registry.test.ts. */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), "utf-8");
}

/** The three variables the process reads to describe itself. */
const BAKED_VARIABLES = ["APP_VERSION", "APP_REVISION", "APP_BUILD_TIME"] as const;

describe("the Dockerfile bakes the build's identity into the image", () => {
  const dockerfile = read("Dockerfile");

  it.each(BAKED_VARIABLES)("declares an ARG and an ENV for %s", (name) => {
    // Both halves are required and they do different jobs: the ARG is what
    // `--build-arg` can reach, and the ENV is what survives into the
    // running container. An ARG alone is visible only during the build, so
    // the process would still see nothing — which is a silent failure,
    // because the image builds fine either way.
    expect(dockerfile).toMatch(new RegExp(`^ARG ${name}=`, "m"));
    // `ENV FOO=$FOO` — the `$` is a literal dollar in the Dockerfile, so it
    // is escaped here rather than read as an end-of-line anchor.
    expect(dockerfile).toContain(`
ENV ${name}=$${name}
`);
  });

  it("declares them after the last COPY, so a new commit does not rebuild the world", () => {
    // The cache argument in the Dockerfile's own comment, made checkable.
    // Every ARG/ENV invalidates the layers below it, so a sha that changes
    // on every commit must sit below everything expensive. If these moved
    // above `npm ci` or `next build`, every release would rebuild from
    // scratch — slow, but silent, which is why it needs a test rather than
    // a comment.
    const lastCopy = dockerfile.lastIndexOf("\nCOPY ");
    const lastRun = dockerfile.lastIndexOf("\nRUN ");
    expect(lastCopy).toBeGreaterThan(-1);
    expect(lastRun).toBeGreaterThan(-1);

    for (const name of BAKED_VARIABLES) {
      const argAt = dockerfile.search(new RegExp(`^ARG ${name}=`, "m"));
      expect(argAt).toBeGreaterThan(lastCopy);
      expect(argAt).toBeGreaterThan(lastRun);
    }
  });
});

describe("the release workflow passes the build's identity to the image", () => {
  const workflow = read(".github/workflows/release.yml");

  it("hands all three variables to the docker build as build-args", () => {
    // Reading the workflow, not a fixture: a build-arg silently dropped
    // here produces an image whose ARGs default to "" — which builds and
    // runs perfectly, and reports `0.0.0-dev` forever.
    expect(workflow).toContain("build-args:");
    for (const name of BAKED_VARIABLES) {
      expect(workflow).toContain(`${name}=\${{ env.${name} }}`);
    }
  });

  it("derives the version from the release tag rather than from package.json", () => {
    // The whole point of AC #2: the tag is the source of truth, and
    // `version-from-tag.mjs` is the one parser that owns turning it into a
    // version. A `${TAG#v}` written inline here would be a second reading
    // that can disagree about a prerelease tag.
    expect(workflow).toContain("scripts/version-from-tag.mjs");
    expect(workflow).toMatch(/APP_VERSION=\$\(node scripts\/version-from-tag\.mjs/);
  });

  it("takes the revision from the checked-out tree, not the triggering ref", () => {
    // `github.sha` is the commit the workflow was TRIGGERED from. On a
    // manual dispatch the `tag` job creates the tag mid-run and the build
    // job checks that tag out explicitly, so the two can be different
    // commits — baking `github.sha` would report a sha the image was not
    // built from, a worse lie than the missing version this replaced.
    expect(workflow).toMatch(/APP_REVISION=\$\(git rev-parse HEAD\)/);
    expect(workflow).not.toMatch(/APP_REVISION=\$\{\{ github\.sha \}\}/);
  });
});

describe("no checked-in constant claims to be the version", () => {
  it("has removed the hardcoded 0.1.0 placeholder", () => {
    // The literal that survived twelve releases. Its docstring claimed the
    // release pipeline wrote it; nothing did. Asserting its absence is
    // what stops it being reintroduced by someone who wants a default.
    const constants = read("src/lib/build-constants.ts");
    expect(constants).not.toMatch(/^export const APP_VERSION\s*=/m);
  });

  it("keeps package.json's version out of the running answer", () => {
    // AC #2, checked rather than asserted in prose. package.json's version
    // field is not consulted by anything that answers "what is running" —
    // the release pipeline sets the published version from the tag
    // (`npm version --no-git-tag-version`, never committed), so the
    // checked-in field is not a source of truth and must not become one.
    const buildInfo = read("src/lib/build-info.ts");
    // Mentioning package.json in the header narrative is fine and useful —
    // what must not happen is READING it. So assert on the import and
    // filesystem surface, not on the word appearing anywhere in the file.
    expect(buildInfo).not.toMatch(/from\s+["'][^"']*package\.json["']/);
    expect(buildInfo).not.toMatch(/require\s*\(/);
    expect(buildInfo).not.toContain("readFileSync");
    expect(buildInfo).not.toContain("node:fs");
  });
});
