// The boot line that names which build is about to migrate the database.
//
// ── What these tests are guarding against, specifically ─────────────────
//
// Not "a version is printed". That assertion passes when the version
// printed is `0.1.0` — the placeholder in `package.json` that survived
// twelve releases — which is the bug, not the fix. Every test below either
// asserts a LITERAL value it supplied itself, or asserts that a placeholder
// is NOT presented as a release. The distinction between "a real version"
// and "something version-shaped" is the whole subject.
//
// The plausible mistake this file exists to kill is falling back to
// `package.json`'s version when the environment carries nothing. That
// mistake is silent, looks correct in a log, and ends investigations — so
// it is asserted against directly, by value, using the real placeholder.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bootIdentity } from "../scripts/entrypoint.mjs";
import { DEV_VERSION, UNKNOWN_REVISION } from "@/lib/build-info";

const repoRoot = path.resolve(import.meta.dirname, "..");

/** The placeholder that started all of this — read, not hardcoded. */
const packageJsonVersion: string = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
).version;

describe("the boot identity line", () => {
  it("names the version and revision the build baked in", () => {
    const line = bootIdentity({
      APP_VERSION: "0.13.0",
      APP_REVISION: "c4a151f26b851ba0466780cb10f9bc8554fc98ec",
    });

    // Literals, not references to the input: the point is that the value
    // travels from the environment into the log unchanged.
    expect(line).toContain("0.13.0");
    expect(line).toContain("c4a151f26b851ba0466780cb10f9bc8554fc98ec");
  });

  it("does not call a released build a placeholder", () => {
    // The `released` half of the contract, in the affirmative. A real build
    // must not carry the disclaimer, or the disclaimer means nothing.
    const line = bootIdentity({ APP_VERSION: "1.2.3", APP_REVISION: "abc1234" });

    expect(line).not.toContain("placeholder");
    expect(line).not.toContain("no release identity");
  });

  // ── The mutation this file exists to kill ────────────────────────────

  it("NEVER falls back to package.json's version when the build carries none", () => {
    // The plausible wrong implementation: `env.APP_VERSION ?? pkg.version`.
    // It looks right, logs a confident `0.1.0` on every single deploy, and
    // is exactly how four separate investigations were ended early.
    const line = bootIdentity({});

    expect(line).not.toContain(packageJsonVersion);
    // Guard the guard: if package.json is ever bumped off the placeholder
    // this assertion silently stops testing anything, so pin the premise.
    expect(packageJsonVersion).toBe("0.1.0");
  });

  it("reports an unreleased build with the same sentinels service_info uses", () => {
    // Sourced from build-info's own exports rather than restated, so the
    // two readings of "what is running" cannot drift apart.
    const line = bootIdentity({});

    expect(line).toContain(DEV_VERSION);
    expect(line).toContain(UNKNOWN_REVISION);
  });

  it("says in words that an unreleased build's version is not a real one", () => {
    // A sentinel only helps a reader who recognises it. The words are what
    // make the line self-explaining at 3am in a container log.
    const line = bootIdentity({});

    expect(line).toContain("placeholder");
  });

  it("treats an empty string as absent, which is what an unpassed Docker ARG produces", () => {
    // `ARG APP_VERSION=""` with nothing passed leaves the variable PRESENT
    // AND EMPTY in the image, not unset. A `??` check alone reports "" as a
    // real version and the boot line renders a blank where a version goes.
    const line = bootIdentity({ APP_VERSION: "", APP_REVISION: "" });

    expect(line).toContain(DEV_VERSION);
    expect(line).toContain(UNKNOWN_REVISION);
    expect(line).toContain("placeholder");
  });

  it("treats a whitespace-only value as absent too", () => {
    const line = bootIdentity({ APP_VERSION: "   ", APP_REVISION: "\t\n" });

    expect(line).toContain(DEV_VERSION);
    expect(line).toContain("placeholder");
  });

  it("trims a trailing newline off a real value rather than logging it", () => {
    // The normal shape of a value produced by a shell command substitution,
    // so it reaches the build arg more often than not.
    const line = bootIdentity({ APP_VERSION: " 1.2.3 ", APP_REVISION: "abc123\n" });

    expect(line).toContain("agent-standup 1.2.3 ");
    expect(line).toContain("revision abc123)");
    expect(line).not.toContain("abc123\n");
  });

  it("calls a half-identified build unreleased when only the version is baked in", () => {
    // `released` requires BOTH facts. A version with no sha cannot be
    // compared against `git log`, which is the question being asked.
    const line = bootIdentity({ APP_VERSION: "1.2.3" });

    expect(line).toContain("1.2.3");
    expect(line).toContain(UNKNOWN_REVISION);
    expect(line).toContain("placeholder");
  });

  it("calls a half-identified build unreleased when only the revision is baked in", () => {
    const line = bootIdentity({ APP_REVISION: "abc123" });

    expect(line).toContain("abc123");
    expect(line).toContain(DEV_VERSION);
    expect(line).toContain("placeholder");
  });
});
