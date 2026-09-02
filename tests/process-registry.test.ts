// The process registry and the ownership check, against a real Postgres —
// MILESTONES.md #45.
//
// A real database is required rather than convenient, and for the reason
// `claims.test.ts` gives about its own subject: the properties under test
// are that **Postgres** refuses a second live registration of one process
// id, and that the guard's answer changes with what is actually stored. An
// in-memory model would decide the first by whatever it happened to do.
//
// **What would make this file hollow.** Asserting only that a registration
// round-trips would pass against a guard that never refuses anything. So
// every allow below is paired with a refusal produced by changing **one
// thing** — the registering crew, or nothing at all (an empty registry) —
// and the pair is what carries the assertion.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, isServiceError, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** Two crews on one machine. Every interesting case is about telling them apart. */
const OURS = "root-a";
const THEIRS = "root-b";
const MACHINE = "laptop";

interface KillAnswer {
  decision: "allow" | "deny";
  basis: string;
  reason: string;
  objections?: { kind: string }[];
}

describeIfDb("the process registry and the ownership check", () => {
  const dbName = scratchDatabaseName("process_registry");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "registered_processes"`);
  });

  /** Registers one process, defaulting everything a case does not care about. */
  async function register(overrides: Record<string, unknown> = {}) {
    return (await runtime.call("register_process", {
      machine: MACHINE,
      pid: 4821,
      executable: "node",
      sessionId: "session-a",
      rootSessionId: OURS,
      ...overrides,
    })) as { id: string; pid: number; executable: string; rootSessionId: string };
  }

  /** Asks the guard as `OURS` unless a case says otherwise. */
  async function ask(command: string, overrides: Record<string, unknown> = {}) {
    return (await runtime.call("kill_guard", {
      command,
      machine: MACHINE,
      sessionId: "session-a",
      rootSessionId: OURS,
      ...overrides,
    })) as KillAnswer;
  }

  describe("register_process", () => {
    it("records a process, normalising the executable name", async () => {
      const row = await register({ executable: "Node.EXE" });
      // Normalised on write, so a Windows registration and a POSIX kill
      // command compare equal without either side knowing about the other.
      expect(row.executable).toBe("node");
      expect(row.pid).toBe(4821);
    });

    it("defaults the crew root to the session when there is no crew above it", async () => {
      const row = (await runtime.call("register_process", {
        machine: MACHINE,
        pid: 100,
        executable: "node",
        sessionId: "session-solo",
      })) as { rootSessionId: string };
      expect(row.rootSessionId).toBe("session-solo");
    });

    it("refuses a second live registration of the same process id", async () => {
      await register({ pid: 100 });
      // Without this refusal, any session could take ownership of any
      // process by asserting it — which is the guard's premise, undone by
      // its own registration path.
      await expect(register({ pid: 100, rootSessionId: THEIRS })).rejects.toSatisfy(
        (error: unknown) => isServiceError(error) && error.code === "conflict",
      );
    });

    it("allows the process id again once the earlier registration has ended", async () => {
      await register({ pid: 100 });
      await runtime.call("end_process", {
        machine: MACHINE,
        pid: 100,
        sessionId: "session-a",
        rootSessionId: OURS,
      });
      // Operating systems reuse process ids; a permanent block would make
      // the registry unusable within a day.
      await expect(register({ pid: 100, rootSessionId: THEIRS })).resolves.toBeTruthy();
    });

    it("the same process id on a different machine is a different process", async () => {
      await register({ pid: 100 });
      await expect(register({ pid: 100, machine: "desktop" })).resolves.toBeTruthy();
    });

    it("refuses a process id that is not a positive integer", async () => {
      // `0` and negatives are process GROUPS on POSIX — wider than one
      // process, and not what this registry models.
      for (const pid of [0, -1, 1.5]) {
        await expect(register({ pid })).rejects.toSatisfy(
          (error: unknown) => isServiceError(error) && error.code === "invalid_input",
        );
      }
    });
  });

  describe("end_process", () => {
    it("refuses to close another crew's registration", async () => {
      await register({ pid: 100, rootSessionId: THEIRS });
      // Otherwise closing a row is a way to launder ownership: end theirs,
      // register the pid as yours, kill it.
      await expect(
        runtime.call("end_process", {
          machine: MACHINE,
          pid: 100,
          sessionId: "session-a",
          rootSessionId: OURS,
        }),
      ).rejects.toSatisfy((error: unknown) => isServiceError(error) && error.code === "forbidden");
    });

    it("refuses when there is no live registration", async () => {
      await expect(
        runtime.call("end_process", { machine: MACHINE, pid: 999, sessionId: "session-a" }),
      ).rejects.toSatisfy((error: unknown) => isServiceError(error) && error.code === "not_found");
    });

    it("keeps the row rather than deleting it", async () => {
      await register({ pid: 100 });
      await runtime.call("end_process", {
        machine: MACHINE,
        pid: 100,
        sessionId: "session-a",
        rootSessionId: OURS,
      });
      const all = (await runtime.call("list_processes", { includeEnded: true })) as unknown[];
      expect(all).toHaveLength(1);
      // "Never yours" and "was yours and has exited" are different answers,
      // and a deleted row cannot tell them apart.
      const live = (await runtime.call("list_processes", {})) as unknown[];
      expect(live).toHaveLength(0);
    });
  });

  describe("list_processes", () => {
    it("returns live rows by default and ended ones only when asked", async () => {
      await register({ pid: 100 });
      await register({ pid: 101 });
      await runtime.call("end_process", {
        machine: MACHINE,
        pid: 100,
        sessionId: "session-a",
        rootSessionId: OURS,
      });

      expect((await runtime.call("list_processes", {})) as unknown[]).toHaveLength(1);
      expect(
        (await runtime.call("list_processes", { includeEnded: true })) as unknown[],
      ).toHaveLength(2);
    });

    it("narrows to one crew", async () => {
      await register({ pid: 100, rootSessionId: OURS });
      await register({ pid: 101, rootSessionId: THEIRS });
      const mine = (await runtime.call("list_processes", { rootSessionId: OURS })) as unknown[];
      expect(mine).toHaveLength(1);
    });

    it("narrows to one machine", async () => {
      await register({ pid: 100, machine: MACHINE });
      await register({ pid: 100, machine: "desktop" });
      expect(
        (await runtime.call("list_processes", { machine: "desktop" })) as unknown[],
      ).toHaveLength(1);
    });
  });

  describe("kill_guard — the ownership check over the real registry", () => {
    it("allows a command that ends nothing", async () => {
      const answer = await ask("npm run build");
      expect(answer.decision).toBe("allow");
      expect(answer.basis).toBe("not-a-kill");
    });

    it("allows killing a process this crew registered", async () => {
      await register({ pid: 4821, rootSessionId: OURS });
      const answer = await ask("kill 4821");
      expect(answer.decision).toBe("allow");
      expect(answer.basis).toBe("owned");
    });

    it("refuses the identical command when another crew registered it", async () => {
      // One field different from the case above. The command text, the
      // machine and the asking session are all unchanged.
      await register({ pid: 4821, rootSessionId: THEIRS });
      const answer = await ask("kill 4821");
      expect(answer.decision).toBe("deny");
      expect(answer.basis).toBe("unowned");
      expect(answer.objections?.[0]?.kind).toBe("owned-by-another");
    });

    it("refuses against an empty registry", async () => {
      const answer = await ask("kill 4821");
      expect(answer.decision).toBe("deny");
      expect(answer.objections?.[0]?.kind).toBe("unregistered");
    });

    it("allows a machine-wide kill when every matching process is ours", async () => {
      await register({ pid: 100, executable: "node", rootSessionId: OURS });
      await register({ pid: 101, executable: "node", rootSessionId: OURS });
      const answer = await ask("taskkill /F /IM node.exe");
      expect(answer.decision).toBe("allow");
    });

    it("refuses the identical machine-wide kill when one sibling process would be caught", async () => {
      await register({ pid: 100, executable: "node", rootSessionId: OURS });
      await register({ pid: 101, executable: "node", rootSessionId: THEIRS });
      const answer = await ask("taskkill /F /IM node.exe");
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toContain("another session's crew");
    });

    it("an ended registration does not confer ownership", async () => {
      await register({ pid: 4821, rootSessionId: OURS });
      await runtime.call("end_process", {
        machine: MACHINE,
        pid: 4821,
        sessionId: "session-a",
        rootSessionId: OURS,
      });
      // The pid may now belong to something else entirely, so a stale row
      // must not answer for it.
      const answer = await ask("kill 4821");
      expect(answer.decision).toBe("deny");
    });

    it("a registration on another machine does not confer ownership", async () => {
      await register({ pid: 4821, machine: "desktop", rootSessionId: OURS });
      const answer = await ask("kill 4821", { machine: MACHINE });
      expect(answer.decision).toBe("deny");
    });

    it("refuses a kill it cannot read, even with the process registered", async () => {
      await register({ pid: 4821, executable: "node", rootSessionId: OURS });
      // An unread selector is not an empty one: `-f` matches whole command
      // lines and would reach far past the one registered process.
      const answer = await ask("pkill -f node");
      expect(answer.decision).toBe("deny");
      expect(answer.basis).toBe("unparseable");
    });

    it("a sibling session in the same crew is not a stranger", async () => {
      // The builder registered it; the orchestrator kills it. Same root,
      // different session — the ordinary case, and it must not refuse.
      await register({ pid: 4821, sessionId: "session-builder", rootSessionId: OURS });
      const answer = await ask("kill 4821", { sessionId: "session-orchestrator" });
      expect(answer.decision).toBe("allow");
    });

    it("defaults the crew root to the session, so a solo session owns what it registered", async () => {
      await runtime.call("register_process", {
        machine: MACHINE,
        pid: 4821,
        executable: "node",
        sessionId: "session-solo",
      });
      const answer = (await runtime.call("kill_guard", {
        command: "kill 4821",
        machine: MACHINE,
        sessionId: "session-solo",
      })) as KillAnswer;
      expect(answer.decision).toBe("allow");
    });
  });
});
