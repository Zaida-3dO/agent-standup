// `resolveInitSource` (SCHEMA.md §20, MILESTONES.md #80) — pure decision
// logic, no I/O. Every branch of "find, accept or provision a database" is
// asserted here in isolation from the database-touching code that acts on
// its output (`scripts/lib/run-init.mjs`, covered separately).
import { describe, expect, it } from "vitest";
import { DEFAULT_APP_ROLE, DEFAULT_DATABASE_NAME, resolveInitSource } from "@/lib/cli/init/resolve";

describe("resolveInitSource — accept takes priority over everything else", () => {
  it("accepts a --database-url flag directly, never attempting to provision", () => {
    const source = resolveInitSource({
      flags: { databaseUrl: "postgres://someone:pw@host/db" },
    });
    expect(source).toEqual({ kind: "accept", databaseUrl: "postgres://someone:pw@host/db" });
  });

  it("accepts DATABASE_URL from the environment when no flag is given", () => {
    const source = resolveInitSource({ env: { DATABASE_URL: "postgres://env/db" } });
    expect(source).toEqual({ kind: "accept", databaseUrl: "postgres://env/db" });
  });

  it("accepts a databaseUrl already written to the local configuration file", () => {
    // This is what makes re-running `standup init` idempotent without
    // regenerating an application role's password: the second run's "file"
    // tier already has what the first run wrote (config-file.ts).
    const source = resolveInitSource({ file: { databaseUrl: "postgres://file/db" } });
    expect(source).toEqual({ kind: "accept", databaseUrl: "postgres://file/db" });
  });

  it("prefers the flag over the environment over the file — same order as everywhere else in §20", () => {
    const source = resolveInitSource({
      flags: { databaseUrl: "postgres://flag/db" },
      env: { DATABASE_URL: "postgres://env/db" },
      file: { databaseUrl: "postgres://file/db" },
    });
    expect(source).toEqual({ kind: "accept", databaseUrl: "postgres://flag/db" });
  });

  it("treats a blank --database-url as absent, consistent with firstDefined elsewhere", () => {
    const source = resolveInitSource({
      flags: { databaseUrl: "   " },
      env: { STANDUP_PROVISION_URL: "postgres://admin/postgres" },
    });
    expect(source.kind).toBe("provision");
  });

  it("a --provision-url alongside an accepted string is ignored — accept always wins", () => {
    // The row's own text: accept is the fallback for when provisioning
    // isn't possible, which only makes sense if it's tried first, not as a
    // last resort after a provisioning attempt has already run.
    const source = resolveInitSource({
      flags: { databaseUrl: "postgres://flag/db", provisionUrl: "postgres://admin/postgres" },
    });
    expect(source.kind).toBe("accept");
  });
});

describe("resolveInitSource — provision, when an explicit provisioning connection is given", () => {
  it("resolves to provision with the default database name and app role", () => {
    const source = resolveInitSource({
      flags: { provisionUrl: "postgres://admin:pw@host/postgres" },
    });
    expect(source).toEqual({
      kind: "provision",
      provisionUrl: "postgres://admin:pw@host/postgres",
      databaseName: DEFAULT_DATABASE_NAME,
      appRole: DEFAULT_APP_ROLE,
    });
  });

  it("honours --database-name, --app-role and --app-password overrides", () => {
    const source = resolveInitSource({
      flags: {
        provisionUrl: "postgres://admin/postgres",
        databaseName: "custom_db",
        appRole: "custom_role",
        appPassword: "a-fixed-password",
      },
    });
    expect(source).toEqual({
      kind: "provision",
      provisionUrl: "postgres://admin/postgres",
      databaseName: "custom_db",
      appRole: "custom_role",
      appPassword: "a-fixed-password",
    });
  });

  it("reads STANDUP_PROVISION_URL from the environment when no flag is given", () => {
    const source = resolveInitSource({
      env: { STANDUP_PROVISION_URL: "postgres://admin/postgres" },
    });
    expect(source.kind).toBe("provision");
  });

  it("never carries an appPassword key when none was supplied — auto-generation is run-init.mjs's job", () => {
    const source = resolveInitSource({ flags: { provisionUrl: "postgres://admin/postgres" } });
    expect(source.kind).toBe("provision");
    if (source.kind !== "provision") throw new Error("unreachable");
    expect("appPassword" in source).toBe(false);
  });
});

describe("resolveInitSource — auto, when nothing was supplied", () => {
  it("resolves to auto with the default database name and app role", () => {
    const source = resolveInitSource({});
    expect(source).toEqual({
      kind: "auto",
      databaseName: DEFAULT_DATABASE_NAME,
      appRole: DEFAULT_APP_ROLE,
    });
  });

  it("still honours --database-name and --app-role overrides for the auto path", () => {
    const source = resolveInitSource({
      flags: { databaseName: "custom_db", appRole: "custom_role" },
    });
    expect(source).toEqual({ kind: "auto", databaseName: "custom_db", appRole: "custom_role" });
  });

  it("no inputs at all still resolves — never throws — leaving the container-runtime attempt to run-init.mjs", () => {
    expect(() => resolveInitSource()).not.toThrow();
  });
});
