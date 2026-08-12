import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Plain JS, deliberately: `.github/workflows/release.yml` runs this as
// `node scripts/version-from-tag.mjs <tag>` with no build step, so the tag
// that decides what gets published is parsed before anything is compiled.
import { versionFromTag } from "../scripts/version-from-tag.mjs";

const scriptPath = path.resolve(import.meta.dirname, "../scripts/version-from-tag.mjs");

/** Runs the script as the release workflow runs it — a real process. */
function runCli(args: string[]) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("versionFromTag", () => {
  it("strips the leading v from a plain release tag", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
  });

  it("keeps a prerelease suffix", () => {
    expect(versionFromTag("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
  });

  it("accepts a zero version", () => {
    expect(versionFromTag("v0.1.0")).toBe("0.1.0");
  });

  it("refuses a tag with no leading v", () => {
    expect(versionFromTag("1.2.3")).toBeNull();
  });

  it("refuses a partial version", () => {
    expect(versionFromTag("v1.2")).toBeNull();
  });

  it("refuses a non-numeric component", () => {
    expect(versionFromTag("v1.2.x")).toBeNull();
  });

  it("refuses build metadata", () => {
    expect(versionFromTag("v1.2.3+build5")).toBeNull();
  });

  it("refuses a leading zero in a numeric component", () => {
    // Semver forbids leading zeros (v1.02.3 is not the same claim as
    // v1.2.3) — this is what stops the regex from being read as "any
    // digits" and quietly accepting something docker/metadata-action's
    // own semver matcher would not.
    expect(versionFromTag("v1.02.3")).toBeNull();
  });

  it("refuses an unrelated string", () => {
    expect(versionFromTag("latest")).toBeNull();
  });

  it("refuses a non-string input", () => {
    expect(versionFromTag(undefined as unknown as string)).toBeNull();
  });
});

describe("version-from-tag.mjs CLI (the gate release.yml runs)", () => {
  it("prints the version and exits 0 for a valid tag", () => {
    const result = runCli(["v2.4.6"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2.4.6");
  });

  it("fails loudly on a seeded bad tag rather than publishing a guess", () => {
    // This is the self-test CLAUDE.md requires of every gating script: proof
    // it actually fails on a violation, not only that it passes clean input.
    const result = runCli(["not-a-real-tag"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/not a valid release tag/);
  });

  it("fails with no arguments rather than silently succeeding", () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
  });
});
