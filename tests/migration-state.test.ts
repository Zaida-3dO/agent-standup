// Migration-drift comparison (`@/lib/migrations/state`) — the pure half of
// DECISIONS.md §13f's "is this package current with the database's
// migration state" question. No filesystem, no database: every branch is
// exercised through the plain data types the two impure readers produce.
import { describe, expect, it } from "vitest";
import {
  compareMigrationState,
  readPackageMigrationHistory,
  type PackageMigrationHistory,
} from "@/lib/migrations/state";

/** A package history that read cleanly, with the given migration names — already sorted, as the real reader sorts them. */
function history(names: readonly string[]): PackageMigrationHistory {
  return { ok: true, migrations: names.map((name) => ({ name })) };
}

describe("compareMigrationState", () => {
  it("reports no drift when the package's newest matches the database's newest", () => {
    const report = compareMigrationState(history(["20260101000000_a", "20260102000000_b"]), [
      { name: "20260101000000_a" },
      { name: "20260102000000_b" },
    ]);
    expect(report.severity).toBe("none");
    expect(report.packageNewest).toBe("20260102000000_b");
    expect(report.databaseNewest).toBe("20260102000000_b");
  });

  it("reports database_ahead when the database applied a migration this package does not have", () => {
    const report = compareMigrationState(history(["20260101000000_a"]), [
      { name: "20260101000000_a" },
      { name: "20260103000000_c" },
    ]);
    expect(report.severity).toBe("database_ahead");
    // The message has to name the migration the package does not recognise,
    // or an operator reading it has nothing to look up.
    expect(report.message).toContain("20260103000000_c");
    expect(report.databaseNewest).toBe("20260103000000_c");
  });

  it("reports package_ahead when this package ships migrations the database has not applied", () => {
    const report = compareMigrationState(history(["20260101000000_a", "20260102000000_b"]), [
      { name: "20260101000000_a" },
    ]);
    expect(report.severity).toBe("package_ahead");
    expect(report.message).toContain("20260102000000_b");
    // Ordinary and actionable — the remedy is named, not just the fact.
    expect(report.message.toLowerCase()).toMatch(/init|migrate deploy/);
  });

  it("reports incompatible when the database's oldest applied migration shares no base with this package", () => {
    // This package's own history starts later than the database's oldest
    // applied migration — the two histories cannot be reconciled by
    // "run more migrations", because this package does not know the one
    // the database's lineage actually starts from.
    const report = compareMigrationState(history(["20260105000000_e"]), [
      { name: "20260101000000_a" },
      { name: "20260105000000_e" },
    ]);
    expect(report.severity).toBe("incompatible");
    expect(report.message).toContain("20260101000000_a");
  });

  it("incompatible takes priority over database_ahead when both conditions hold", () => {
    // A database years ahead, on a migration history this package's own
    // oldest-migration check cannot even recognise the start of, must not
    // be read as merely "ahead" — that undersells exactly the case that
    // should refuse rather than warn.
    const report = compareMigrationState(history(["20260201000000_only"]), [
      { name: "20260101000000_ancient" },
      { name: "20260301000000_future" },
    ]);
    expect(report.severity).toBe("incompatible");
  });

  it("is none, not drift, when nothing has been applied yet", () => {
    // A freshly provisioned database mid-`standup init` — the package
    // having migrations the (empty) ledger lacks is not evidence of
    // anything wrong; it is the ordinary state before the first apply.
    const report = compareMigrationState(history(["20260101000000_a"]), []);
    expect(report.severity).toBe("none");
    expect(report.databaseNewest).toBeNull();
  });

  it("is none, not incompatible or drift, when the package's own history could not be read", () => {
    // The honest third answer — see readPackageMigrationHistory's header.
    // Neither "you are current" nor "you are broken" is a fact this
    // function has when it could not read its own side of the comparison.
    const unreadable: PackageMigrationHistory = { ok: false, reason: "ENOENT" };
    const report = compareMigrationState(unreadable, [{ name: "20260101000000_a" }]);
    expect(report.severity).toBe("none");
    expect(report.message).toContain("ENOENT");
    expect(report.packageNewest).toBeNull();
    expect(report.databaseNewest).toBeNull();
  });

  it("sorts applied migrations before comparing, not trusting the ledger's own row order", () => {
    // Postgres makes no ordering guarantee absent an ORDER BY, and the
    // caller (`describe-tool.ts`) issues none — this function's own job is
    // to find the newest and oldest correctly regardless of row order.
    const report = compareMigrationState(history(["20260101000000_a", "20260103000000_c"]), [
      { name: "20260103000000_c" },
      { name: "20260101000000_a" },
      { name: "20260102000000_b" },
    ]);
    // 20260102000000_b is not in the package's history and sorts in the
    // middle — proving the newest/oldest picks are by name, not by array
    // position, is what a mutant swapping `.at(-1)` for `[0]` would fail.
    expect(report.databaseNewest).toBe("20260103000000_c");
    expect(report.severity).toBe("database_ahead");
  });
});

describe("readPackageMigrationHistory", () => {
  /** A fake `readdirSync`-shaped reader, so no real filesystem is touched. */
  function fakeReaddir(
    entries: readonly { name: string; isDirectory: boolean }[],
  ): (dir: string, options: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[] {
    return () =>
      entries.map((entry) => ({ name: entry.name, isDirectory: () => entry.isDirectory }));
  }

  it("reads directory entries, sorted, and excludes the lock file", () => {
    const result = readPackageMigrationHistory(
      "/anywhere",
      fakeReaddir([
        { name: "20260102000000_b", isDirectory: true },
        { name: "migration_lock.toml", isDirectory: false },
        { name: "20260101000000_a", isDirectory: true },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migrations.map((m) => m.name)).toEqual([
        "20260101000000_a",
        "20260102000000_b",
      ]);
    }
  });

  it("reports ok: false rather than throwing when the directory cannot be read", () => {
    const result = readPackageMigrationHistory("/nonexistent", () => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("/nonexistent");
      expect(result.reason).toContain("ENOENT");
    }
  });
});
