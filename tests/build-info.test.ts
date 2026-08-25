// What code is running — the read that answers "what is deployed".
//
// Every assertion below supplies its own environment and asserts a
// LITERAL expected value. That shape is deliberate: a test that read the
// expectation back out of the same constant the code reads would pass
// whether or not the plumbing worked, which is the exact failure this
// module exists to fix — `APP_VERSION` sat at `0.1.0` through twelve
// releases with tests green the whole time.
import { describe, expect, it } from "vitest";
import { DEV_VERSION, UNKNOWN_REVISION, readBuildInfo, currentBuildInfo } from "@/lib/build-info";

describe("reading what build is running", () => {
  it("reports the version and revision the build baked in", () => {
    const info = readBuildInfo({
      APP_VERSION: "0.12.0",
      APP_REVISION: "d49c993aa1b2c3d4e5f60718293a4b5c6d7e8f90",
      APP_BUILD_TIME: "2026-08-25T04:00:00Z",
    });

    // Literals, not references to the input object: the point is that the
    // value travels from the environment to the answer unchanged.
    expect(info.version).toBe("0.12.0");
    expect(info.revision).toBe("d49c993aa1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(info.buildTime).toBe("2026-08-25T04:00:00Z");
    expect(info.released).toBe(true);
  });

  it("does not invent a version for a build nobody released", () => {
    const info = readBuildInfo({});

    expect(info.version).toBe("0.0.0-dev");
    expect(info.revision).toBe("unknown");
    expect(info.buildTime).toBeNull();
    expect(info.released).toBe(false);
  });

  it("reads an empty string as absent, which is what an unpassed Docker ARG produces", () => {
    // The regression that matters most here. `ARG APP_VERSION=""` with
    // nothing passed makes the variable *present and empty* in the image,
    // not unset — so a `?? ` check alone reports "" as a real version and
    // the panel renders a blank where a version should be.
    const info = readBuildInfo({ APP_VERSION: "", APP_REVISION: "", APP_BUILD_TIME: "" });

    expect(info.version).toBe("0.0.0-dev");
    expect(info.revision).toBe("unknown");
    expect(info.buildTime).toBeNull();
    expect(info.released).toBe(false);
  });

  it("reads a whitespace-only value as absent too", () => {
    const info = readBuildInfo({ APP_VERSION: "   ", APP_REVISION: "\t\n" });

    expect(info.version).toBe("0.0.0-dev");
    expect(info.revision).toBe("unknown");
    expect(info.released).toBe(false);
  });

  it("trims surrounding whitespace off a real value rather than carrying it", () => {
    // A trailing newline is the normal shape of a value produced by a
    // shell substitution, so it reaches the build arg more often than not.
    const info = readBuildInfo({ APP_VERSION: " 1.2.3 ", APP_REVISION: "abc123\n" });

    expect(info.version).toBe("1.2.3");
    expect(info.revision).toBe("abc123");
  });

  it("is not released when only the version was baked in", () => {
    // `released` is the single boolean a caller uses instead of knowing
    // which sentinel means absence, so it must require BOTH facts.
    const info = readBuildInfo({ APP_VERSION: "1.2.3" });

    expect(info.version).toBe("1.2.3");
    expect(info.revision).toBe("unknown");
    expect(info.released).toBe(false);
  });

  it("is not released when only the revision was baked in", () => {
    const info = readBuildInfo({ APP_REVISION: "abc123" });

    expect(info.version).toBe("0.0.0-dev");
    expect(info.revision).toBe("abc123");
    expect(info.released).toBe(false);
  });

  it("keeps a build time even when the build is not a release", () => {
    // buildTime is independent of `released` — reporting when an
    // unreleased image was built is still useful, and dropping it would
    // lose the only temporal fact a dev build has.
    const info = readBuildInfo({ APP_BUILD_TIME: "2026-01-02T03:04:05Z" });

    expect(info.buildTime).toBe("2026-01-02T03:04:05Z");
    expect(info.released).toBe(false);
  });

  it("exports fallbacks that cannot be mistaken for a real release", () => {
    // The failure that started this: `0.1.0` is a plausible version, so
    // nobody could tell a placeholder from a release. A fallback has to be
    // unmistakable, so assert its actual shape rather than just that it
    // exists.
    expect(DEV_VERSION).toBe("0.0.0-dev");
    expect(UNKNOWN_REVISION).toBe("unknown");
    // Not a bare semver: the suffix is what makes it unmistakable.
    expect(DEV_VERSION).not.toMatch(/^\d+\.\d+\.\d+$/);
    // Not sha-shaped: a caller comparing against `git log` must be able to
    // tell "not recorded" from a real answer.
    expect(UNKNOWN_REVISION).not.toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("reads the running process's own environment", () => {
    const original = process.env.APP_REVISION;
    try {
      process.env.APP_REVISION = "sha-from-the-real-process-env";
      // Proves currentBuildInfo() reads process.env at CALL time. If it
      // captured its value at module load, this would still report
      // whatever the process started with.
      expect(currentBuildInfo().revision).toBe("sha-from-the-real-process-env");
    } finally {
      if (original === undefined) delete process.env.APP_REVISION;
      else process.env.APP_REVISION = original;
    }
  });
});
