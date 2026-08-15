// Admin service operations against a real Postgres — SCHEMA.md §19, §23;
// MILESTONES.md #92 ("Administration API and command line for
// installation-owned entities").
//
// Same shape as tests/settings-operations.test.ts: a real database is
// required because the properties under test — a unique-constraint refusal,
// an upsert's create-vs-update branch, jsonb keeping its own null — are
// exactly the things an in-memory model cannot prove.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("admin service operations against Postgres", () => {
  const dbName = scratchDatabaseName("admin_ops");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  // ── repo ────────────────────────────────────────────────────────────
  describe("repos", () => {
    it("create_repo creates a repository with the given fields", async () => {
      const repo = (await runtime.call("create_repo", {
        id: "repo-alpha",
        displayName: "Repo Alpha",
        defaultBranch: "main",
        host: "example.test",
        needsVisualReview: true,
      })) as { id: string; displayName: string; defaultBranch: string; host: string | null };
      expect(repo).toMatchObject({
        id: "repo-alpha",
        displayName: "Repo Alpha",
        defaultBranch: "main",
        host: "example.test",
      });
    });

    it("create_repo refuses a duplicate id with conflict, not a raw constraint error", async () => {
      await runtime.call("create_repo", {
        id: "repo-dup",
        displayName: "First",
        defaultBranch: "main",
      });
      const error = await runtime
        .call("create_repo", { id: "repo-dup", displayName: "Second", defaultBranch: "main" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
      expect((error as { fields: string[] }).fields).toEqual(["id"]);
    });

    it("get_repo reads it back, and refuses an id that does not exist", async () => {
      await runtime.call("create_repo", {
        id: "repo-get",
        displayName: "Get Me",
        defaultBranch: "main",
      });
      const repo = (await runtime.call("get_repo", { id: "repo-get" })) as { displayName: string };
      expect(repo.displayName).toBe("Get Me");

      const error = await runtime.call("get_repo", { id: "no-such-repo" }).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    it("list_repos excludes archived by default and includes them on request", async () => {
      await runtime.call("create_repo", {
        id: "repo-archived",
        displayName: "Archived Repo",
        defaultBranch: "main",
      });
      await runtime.call("update_repo", { id: "repo-archived", archived: true });

      const active = (await runtime.call("list_repos", {})) as { repos: readonly { id: string }[] };
      expect(active.repos.some((r) => r.id === "repo-archived")).toBe(false);

      const all = (await runtime.call("list_repos", { includeArchived: true })) as {
        repos: readonly { id: string }[];
      };
      expect(all.repos.some((r) => r.id === "repo-archived")).toBe(true);
    });

    it("update_repo edits fields, archives, and un-archives", async () => {
      await runtime.call("create_repo", {
        id: "repo-update",
        displayName: "Before",
        defaultBranch: "main",
      });

      const renamed = (await runtime.call("update_repo", {
        id: "repo-update",
        displayName: "After",
      })) as { displayName: string; archivedAt: string | null };
      expect(renamed.displayName).toBe("After");
      expect(renamed.archivedAt).toBeNull();

      const archived = (await runtime.call("update_repo", {
        id: "repo-update",
        archived: true,
      })) as { archivedAt: string | null };
      expect(archived.archivedAt).not.toBeNull();

      const unarchived = (await runtime.call("update_repo", {
        id: "repo-update",
        archived: false,
      })) as { archivedAt: string | null };
      expect(unarchived.archivedAt).toBeNull();
    });

    it("update_repo refuses an id that does not exist", async () => {
      const error = await runtime
        .call("update_repo", { id: "no-such-repo", displayName: "x" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    // MILESTONES.md #124: `defaultBranch` is nullable — unknown is a
    // distinct, representable state, never a guessed constant.
    it("create_repo omits defaultBranch and stores it as null, not a guessed value", async () => {
      const repo = (await runtime.call("create_repo", {
        id: "repo-unknown-branch",
        displayName: "Unknown Branch",
      })) as { defaultBranch: string | null };
      expect(repo.defaultBranch).toBeNull();
    });

    it("create_repo accepts an explicit null defaultBranch the same as omitting it", async () => {
      const repo = (await runtime.call("create_repo", {
        id: "repo-explicit-null-branch",
        displayName: "Explicit Null",
        defaultBranch: null,
      })) as { defaultBranch: string | null };
      expect(repo.defaultBranch).toBeNull();
    });

    it("update_repo can clear defaultBranch back to null", async () => {
      await runtime.call("create_repo", {
        id: "repo-clear-branch",
        displayName: "Clear Me",
        defaultBranch: "main",
      });

      const cleared = (await runtime.call("update_repo", {
        id: "repo-clear-branch",
        defaultBranch: null,
      })) as { defaultBranch: string | null };
      expect(cleared.defaultBranch).toBeNull();
    });
  });

  // ── area ────────────────────────────────────────────────────────────
  describe("areas", () => {
    it("create_area normalises the name into the id", async () => {
      const area = (await runtime.call("create_area", { name: "  Web Site  " })) as {
        id: string;
        displayName: string;
      };
      expect(area.id).toBe("web-site");
      expect(area.displayName).toBe("Web Site");
    });

    it("create_area is find-or-create: a second call with a different spelling does not overwrite the display name", async () => {
      await runtime.call("create_area", { name: "Infra" });
      const second = (await runtime.call("create_area", { name: "infra" })) as {
        id: string;
        displayName: string;
      };
      expect(second.id).toBe("infra");
      // The first writer's spelling survives — ON CONFLICT DO NOTHING.
      expect(second.displayName).toBe("Infra");
    });

    it("get_area refuses an id that does not exist", async () => {
      const error = await runtime.call("get_area", { id: "no-such-area" }).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    it("list_areas excludes archived by default and includes them on request", async () => {
      await runtime.call("create_area", { name: "archived-area" });
      await runtime.call("update_area", { id: "archived-area", archived: true });

      const active = (await runtime.call("list_areas", {})) as { areas: readonly { id: string }[] };
      expect(active.areas.some((a) => a.id === "archived-area")).toBe(false);

      const all = (await runtime.call("list_areas", { includeArchived: true })) as {
        areas: readonly { id: string }[];
      };
      expect(all.areas.some((a) => a.id === "archived-area")).toBe(true);
    });

    it("update_area renames the display name without touching the id", async () => {
      await runtime.call("create_area", { name: "renameme" });
      const renamed = (await runtime.call("update_area", {
        id: "renameme",
        displayName: "Renamed",
      })) as { id: string; displayName: string };
      expect(renamed.id).toBe("renameme");
      expect(renamed.displayName).toBe("Renamed");
    });

    it("update_area refuses an id that does not exist", async () => {
      const error = await runtime
        .call("update_area", { id: "no-such-area", displayName: "x" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });
  });

  // ── machine ─────────────────────────────────────────────────────────
  describe("machines", () => {
    it("get_machine refuses a name that has never been created", async () => {
      const error = await runtime
        .call("get_machine", { name: "no-such-machine" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    it("update_machine creates the row on first PATCH — no prior create step exists", async () => {
      const machine = (await runtime.call("update_machine", {
        name: "desktop",
        sourceGlobs: ["apps/**", "services/**"],
      })) as { name: string; sourceGlobs: readonly string[] | null };
      expect(machine).toEqual({
        name: "desktop",
        lastPollAt: null,
        liveSessions: 0,
        sourceGlobs: ["apps/**", "services/**"],
      });
    });

    it("update_machine with no sourceGlobs on a fresh machine leaves the override null (inherits the setting)", async () => {
      const machine = (await runtime.call("update_machine", { name: "laptop" })) as {
        sourceGlobs: readonly string[] | null;
      };
      expect(machine.sourceGlobs).toBeNull();
    });

    it("update_machine preserves an existing override when sourceGlobs is omitted on a later call", async () => {
      await runtime.call("update_machine", { name: "preserve-me", sourceGlobs: ["a/**"] });
      const untouched = (await runtime.call("update_machine", { name: "preserve-me" })) as {
        sourceGlobs: readonly string[] | null;
      };
      expect(untouched.sourceGlobs).toEqual(["a/**"]);
    });

    it("update_machine distinguishes null (no override) from [] (an explicit empty override)", async () => {
      const cleared = (await runtime.call("update_machine", {
        name: "empty-override",
        sourceGlobs: [],
      })) as { sourceGlobs: readonly string[] | null };
      // [] is a real override — "scans nothing" — not the same as never having set one.
      expect(cleared.sourceGlobs).toEqual([]);

      const backToInherit = (await runtime.call("update_machine", {
        name: "empty-override",
        sourceGlobs: null,
      })) as { sourceGlobs: readonly string[] | null };
      expect(backToInherit.sourceGlobs).toBeNull();
    });

    it("update_machine refuses a sourceGlobs value the registry's own validator rejects", async () => {
      // minting.source_globs is z.array(z.string().min(1)) — an empty
      // string element fails min(1), the same schema the setting itself uses.
      const error = await runtime
        .call("update_machine", { name: "bad-globs", sourceGlobs: [""] })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toEqual(["sourceGlobs"]);
    });

    it("list_machines returns every machine created so far", async () => {
      await runtime.call("update_machine", { name: "list-me" });
      const result = (await runtime.call("list_machines", {})) as {
        machines: readonly { name: string }[];
      };
      expect(result.machines.some((m) => m.name === "list-me")).toBe(true);
    });
  });

  // ── account ─────────────────────────────────────────────────────────
  const validBudgetWindows = {
    primary: {
      enabled: true,
      lengthHours: 24,
      boundaries: {
        selective: { kind: "constant", value: 20 },
        windDown: { kind: "constant", value: 60 },
        stop: { kind: "constant", value: 90 },
      },
    },
  };

  describe("accounts", () => {
    it("update_account creates a new account when vendor, displayName and planType are all given", async () => {
      const account = (await runtime.call("update_account", {
        id: "account-new",
        vendor: "anthropic",
        displayName: "New Account",
        planType: "subscription",
      })) as { id: string; vendor: string; planType: string };
      expect(account).toMatchObject({
        id: "account-new",
        vendor: "anthropic",
        planType: "subscription",
      });
    });

    it("update_account refuses to create a new account missing a required field, naming it", async () => {
      const error = await runtime
        .call("update_account", { id: "account-incomplete", vendor: "anthropic" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect([...(error as { fields: string[] }).fields].sort()).toEqual(
        ["displayName", "planType"].sort(),
      );
    });

    // The highest-value case in this row (task brief): an unregistered
    // vendor must be refused, on BOTH the create and the update path — a
    // vendor is not merely stored, it selects a usage adapter, and a
    // silently-accepted unknown one is a setting nobody can act on.
    it("update_account refuses an unregistered vendor when creating a new account", async () => {
      const error = await runtime
        .call("update_account", {
          id: "account-bad-vendor",
          vendor: "not-a-real-vendor",
          displayName: "Bad Vendor",
          planType: "subscription",
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toEqual(["vendor"]);
    });

    it("update_account refuses an unregistered vendor when editing an existing account", async () => {
      await runtime.call("update_account", {
        id: "account-vendor-switch",
        vendor: "anthropic",
        displayName: "Switch Me",
        planType: "subscription",
      });
      const error = await runtime
        .call("update_account", { id: "account-vendor-switch", vendor: "openai-but-unregistered" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toEqual(["vendor"]);

      // And the account's stored vendor is untouched by the refused write.
      const unchanged = (await runtime.call("get_account", {
        id: "account-vendor-switch",
      })) as { vendor: string };
      expect(unchanged.vendor).toBe("anthropic");
    });

    it("update_account accepts every registered vendor", async () => {
      const account = (await runtime.call("update_account", {
        id: "account-registered-vendor",
        vendor: "anthropic",
        displayName: "Registered",
        planType: "metered",
      })) as { vendor: string };
      expect(account.vendor).toBe("anthropic");
    });

    it("update_account sets a budgetWindows override, validated by the settings registry's own validator", async () => {
      const account = (await runtime.call("update_account", {
        id: "account-budget",
        vendor: "anthropic",
        displayName: "Budget",
        planType: "subscription",
        budgetWindows: validBudgetWindows,
      })) as { budgetWindows: unknown };
      expect(account.budgetWindows).toEqual(validBudgetWindows);
    });

    it("update_account refuses a budgetWindows override whose boundaries cross", async () => {
      const crossing = {
        primary: {
          enabled: true,
          lengthHours: 24,
          boundaries: {
            // selective ABOVE windDown — an incoherent, ordering-violating window.
            selective: { kind: "constant", value: 90 },
            windDown: { kind: "constant", value: 10 },
            stop: { kind: "constant", value: 95 },
          },
        },
      };
      const error = await runtime
        .call("update_account", {
          id: "account-crossing",
          vendor: "anthropic",
          displayName: "Crossing",
          planType: "subscription",
          budgetWindows: crossing,
        })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
      expect((error as { fields: string[] }).fields).toEqual(["budgetWindows"]);
    });

    it("update_account clears an existing budgetWindows override with null", async () => {
      await runtime.call("update_account", {
        id: "account-clear-budget",
        vendor: "anthropic",
        displayName: "Clear Me",
        planType: "subscription",
        budgetWindows: validBudgetWindows,
      });
      const cleared = (await runtime.call("update_account", {
        id: "account-clear-budget",
        budgetWindows: null,
      })) as { budgetWindows: unknown };
      expect(cleared.budgetWindows).toBeNull();
    });

    it("update_account leaves budgetWindows untouched when the field is omitted", async () => {
      await runtime.call("update_account", {
        id: "account-untouched-budget",
        vendor: "anthropic",
        displayName: "Untouched",
        planType: "subscription",
        budgetWindows: validBudgetWindows,
      });
      const untouched = (await runtime.call("update_account", {
        id: "account-untouched-budget",
        displayName: "Still Untouched",
      })) as { budgetWindows: unknown; displayName: string };
      expect(untouched.displayName).toBe("Still Untouched");
      expect(untouched.budgetWindows).toEqual(validBudgetWindows);
    });

    it("get_account refuses an id that does not exist", async () => {
      const error = await runtime
        .call("get_account", { id: "no-such-account" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
    });

    it("list_accounts returns every account created so far", async () => {
      await runtime.call("update_account", {
        id: "account-list-me",
        vendor: "anthropic",
        displayName: "List Me",
        planType: "subscription",
      });
      const result = (await runtime.call("list_accounts", {})) as {
        accounts: readonly { id: string }[];
      };
      expect(result.accounts.some((a) => a.id === "account-list-me")).toBe(true);
    });
  });
});
