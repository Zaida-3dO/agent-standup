// src/lib/settings/build-constants.ts — the read-only third tier
// (SCHEMA.md §17.6) and the bootstrap panel (§17.1), both rendered on
// `/settings` per MILESTONES.md #86.
//
// The load-bearing test here is the last one: **no bootstrap value is ever
// carried.** `DATABASE_URL` is a connection string with a password in it,
// and §17.2 is explicit that the bootstrap tier exists precisely because
// some values must not be readable from the application.
import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  HOOK_PROTOCOL,
  renderBootstrapVariables,
  renderBuildConstants,
} from "@/lib/settings/build-constants";

describe("the build constants §17.6 declares", () => {
  it("carries two numbers per hook protocol variant, not one", () => {
    // Collapsing them would make every version bump a breaking one.
    expect(typeof HOOK_PROTOCOL.http.current).toBe("number");
    expect(typeof HOOK_PROTOCOL.http.minSupported).toBe("number");
    expect(typeof HOOK_PROTOCOL.cli.current).toBe("number");
    expect(typeof HOOK_PROTOCOL.cli.minSupported).toBe("number");
  });

  it("never accepts a version newer than it speaks", () => {
    expect(HOOK_PROTOCOL.http.minSupported).toBeLessThanOrEqual(HOOK_PROTOCOL.http.current);
    expect(HOOK_PROTOCOL.cli.minSupported).toBeLessThanOrEqual(HOOK_PROTOCOL.cli.current);
  });

  it("is frozen, so nothing can configure what is by definition not configurable", () => {
    expect(Object.isFrozen(HOOK_PROTOCOL)).toBe(true);
    expect(Object.isFrozen(HOOK_PROTOCOL.http)).toBe(true);
  });

  it("renders the five rows §17.6's table lists", () => {
    const names = renderBuildConstants().map((row) => row.name);
    expect(names).toEqual([
      "HOOK_PROTOCOL.http.current",
      "HOOK_PROTOCOL.http.min_supported",
      "HOOK_PROTOCOL.cli.current",
      "HOOK_PROTOCOL.cli.min_supported",
      "APP_VERSION",
    ]);
  });

  it("gives every row a value and an explanation", () => {
    for (const row of renderBuildConstants()) {
      expect(row.value.length, row.name).toBeGreaterThan(0);
      expect(row.meaning.length, row.name).toBeGreaterThan(0);
    }
  });

  it("shows a visible marker rather than a blank when the version is not set", () => {
    // A panel rendering an empty version reads as broken rather than as
    // "not a released build".
    const version = renderBuildConstants().find((row) => row.name === "APP_VERSION");
    expect(version?.value).toBe(APP_VERSION);
    expect(version?.value).not.toBe("");
  });
});

describe("the bootstrap panel", () => {
  it("lists the variables §17.1 declares, including the two the command line adds", () => {
    const names = renderBootstrapVariables({}).map((row) => row.name);
    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("HOSTNAME");
    expect(names).toContain("PORT");
    expect(names).toContain("NODE_ENV");
    expect(names).toContain("SHADOW_DATABASE_URL");
    expect(names).toContain("STANDUP_URL");
    expect(names).toContain("STANDUP_SESSION_ID");
  });

  it("reports a variable that is set", () => {
    const rows = renderBootstrapVariables({ PORT: "3000" });
    expect(rows.find((row) => row.name === "PORT")?.set).toBe(true);
  });

  it("reports an absent variable as not set", () => {
    const rows = renderBootstrapVariables({});
    expect(rows.find((row) => row.name === "PORT")?.set).toBe(false);
  });

  it("treats an empty string as not set — an empty connection string cannot connect", () => {
    // Reporting it as configured would tell an operator the opposite of what
    // they need to know.
    const rows = renderBootstrapVariables({ DATABASE_URL: "" });
    expect(rows.find((row) => row.name === "DATABASE_URL")?.set).toBe(false);
  });

  it("carries no value anywhere in the rendered rows, for any variable", () => {
    // The test this module exists for. A secret is passed in for every
    // declared name, and the whole serialised answer is searched for it.
    const secret = "s3cr3t-p4ssw0rd-do-not-publish";
    const env: Record<string, string> = {};
    for (const row of renderBootstrapVariables({})) env[row.name] = `postgres://u:${secret}@h/db`;

    const rendered = renderBootstrapVariables(env);
    expect(JSON.stringify(rendered)).not.toContain(secret);
    // And every one is still correctly reported as set, so the absence of
    // the secret is not just the absence of any answer.
    for (const row of rendered) expect(row.set, row.name).toBe(true);
  });

  it("gives every variable an explanation", () => {
    for (const row of renderBootstrapVariables({})) {
      expect(row.meaning.length, row.name).toBeGreaterThan(0);
    }
  });
});
