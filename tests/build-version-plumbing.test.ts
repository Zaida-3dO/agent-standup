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
import { DEV_VERSION, UNKNOWN_REVISION } from "@/lib/build-info";

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
    //
    // Scoped to the `runner` stage, and matching its *last* declaration of
    // each name rather than the first. `ARG` is per-stage, so a name can be
    // declared in more than one stage — and one of them is: the stage that
    // builds the hook scripts declares `APP_REVISION` too, because the
    // bundler needs the commit at build time and an ARG from another stage
    // is not in scope there. A search for the first match anywhere in the
    // file would find that one and assert the wrong stage's placement, which
    // says nothing about the runtime layers this test is about. The build
    // stage's own placement is covered separately below.
    const runnerAt = dockerfile.search(/^FROM node:24-alpine AS runner$/m);
    expect(runnerAt).toBeGreaterThan(-1);

    const lastCopy = dockerfile.lastIndexOf("\nCOPY ");
    const lastRun = dockerfile.lastIndexOf("\nRUN ");
    expect(lastCopy).toBeGreaterThan(-1);
    expect(lastRun).toBeGreaterThan(-1);

    for (const name of BAKED_VARIABLES) {
      const argAt = dockerfile.lastIndexOf(`\nARG ${name}=`);
      expect(argAt).toBeGreaterThan(runnerAt);
      expect(argAt).toBeGreaterThan(lastCopy);
      expect(argAt).toBeGreaterThan(lastRun);
    }
  });

  it("keeps the build stage's own APP_REVISION below its expensive steps", () => {
    // The same caching argument, for the second place the sha now enters the
    // build. The stage that bundles the hook scripts needs the commit at
    // build time — the bundler compiles it into the artifact — so it declares
    // its own `APP_REVISION`. Declared too early it would sit above
    // `npm ci` and `next build` and make every commit rebuild both, which
    // builds correctly and is therefore silent.
    const stage = dockerfile
      .split(/^FROM /m)
      .find((s) => s.startsWith("node:24-alpine AS build\n"));
    expect(stage).toBeDefined();
    if (stage === undefined) return;

    const argAt = stage.search(/^ARG APP_REVISION=/m);
    expect(argAt).toBeGreaterThan(-1);
    // Below the `next build` line, which is the expensive one in this stage.
    expect(argAt).toBeGreaterThan(stage.indexOf("npm run build"));
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

  it("tells the release build to fail rather than ship an unstamped bundle", () => {
    // The half that cannot be asserted from the Dockerfile. The strictness
    // is an ARG defaulting to off, so that CI's dry-run build of the same
    // file — which passes no build args and is releasing nothing — keeps
    // passing. That makes this workflow the only thing that ever turns it
    // on, and a build-arg silently dropped here would restore the exact
    // failure the flag exists to prevent: a release whose hook bundle is
    // stamped "unstamped", which disables every freshness check downstream
    // while the build reports success.
    //
    // Mutation that breaks it: deleting the `REQUIRE_BUILD_STAMP=1` line
    // from the `build-args` block. Nothing else in the suite notices.
    expect(workflow).toContain("REQUIRE_BUILD_STAMP=1");
  });

  it("derives the version from the release tag rather than from package.json", () => {
    // The whole point of AC #2: the tag is the source of truth, and
    // `version-from-tag.mjs` is the one parser that owns turning it into a
    // version. A `${TAG#v}` written inline here would be a second reading
    // that can disagree about a prerelease tag.
    expect(workflow).toContain("scripts/version-from-tag.mjs");
    // The version written into the environment must be the one that script
    // produced, so assert the assignment chain rather than just that the
    // script is mentioned somewhere in the file.
    expect(workflow).toMatch(/version="\$\(node scripts\/version-from-tag\.mjs "\$RELEASE_TAG"\)"/);
    expect(workflow).toContain('echo "APP_VERSION=$version"');
  });

  it("takes the revision from the checked-out tree, not the triggering ref", () => {
    // `github.sha` is the commit the workflow was TRIGGERED from. On a
    // manual dispatch the `tag` job creates the tag mid-run and the build
    // job checks that tag out explicitly, so the two can be different
    // commits — baking `github.sha` would report a sha the image was not
    // built from, a worse lie than the missing version this replaced.
    expect(workflow).toMatch(/revision="\$\(git rev-parse HEAD\)"/);
    expect(workflow).toContain('echo "APP_REVISION=$revision"');
    // The mutation that matters: `github.sha` must not be what gets baked.
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

// The boot line is a SECOND reader of the same two variables, in a file
// that cannot import the first one — `scripts/entrypoint.mjs` is plain
// JavaScript run by Node before anything is built. That is the same
// constraint `backfillWarning` lives under, and it gets the same remedy:
// the duplication is pinned by test rather than by comment, so the two
// readings cannot drift apart without something going red.
describe("the boot identity line reads the same source of truth", () => {
  it("reads the baked-in variables and not package.json", () => {
    const entrypoint = read("scripts/entrypoint.mjs");

    // It must consult the build args...
    expect(entrypoint).toContain("env.APP_VERSION");
    expect(entrypoint).toContain("env.APP_REVISION");
    // ...and must never read the placeholder file. The mistake here is
    // silent: a `?? pkg.version` fallback logs a confident `0.1.0` forever.
    expect(entrypoint).not.toMatch(/from\s+["'][^"']*package\.json["']/);
    expect(entrypoint).not.toMatch(/readFileSync\s*\(/);
  });

  it("uses the same sentinels build-info exports, so the two agree", () => {
    // If either side changes its wording for "not a real release", a
    // reader comparing a boot log against a service_info answer would see
    // two different vocabularies for one fact.
    const entrypoint = read("scripts/entrypoint.mjs");

    expect(entrypoint).toContain(DEV_VERSION);
    expect(entrypoint).toContain(UNKNOWN_REVISION);
  });

  it("prints the identity before migrations are applied, not after", () => {
    // The ordering IS the feature: a boot that dies inside `migrate
    // deploy` must still have said which build was doing the migrating.
    const entrypoint = read("scripts/entrypoint.mjs");

    const identityAt = entrypoint.indexOf("log.info(bootIdentity(env))");
    const migrateAt = entrypoint.indexOf("await runMigrations(");

    expect(identityAt).toBeGreaterThan(-1);
    expect(migrateAt).toBeGreaterThan(-1);
    expect(identityAt).toBeLessThan(migrateAt);
  });
});
