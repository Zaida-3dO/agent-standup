// The machine a call is recorded against — proved beats declared, and a
// session states it once. MILESTONES.md #111/#134/#133, DECISIONS.md's
// "one is proved and one is declared".
//
// Two claims are under test and they pull in opposite directions, which is
// why both are here:
//
//   - `register_session` must prefer what the transport *proved* over what
//     the body *declared*, so a caller holding `laptop`'s token cannot
//     store a session claiming `desktop`.
//   - `claim` must stop demanding a machine it was already told, falling
//     back to the session's own registration — while still refusing, by
//     name, when there is genuinely nothing to inherit.
//
// The pure resolution is tested without a database because its three cases
// are pure, and the case that matters most — "nothing proved" — is the one
// hardest to reach through a real authenticated transport, since the only
// binding that produces it is the in-process one.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { resolveMachine } from "@/lib/service/machine-identity";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describe("resolveMachine — proved, declared, and the difference between them", () => {
  // The `direct` binding: no token, nothing proved, and the declaration
  // stands exactly as it did before this existed. Fails if the
  // `proved === undefined` early return is dropped — an in-process call
  // would then resolve to `undefined` and store a broken machine, or throw.
  it("takes the caller's word when the transport proved nothing", () => {
    expect(resolveMachine({}, "laptop")).toEqual({
      machine: "laptop",
      source: "declared",
      overrode: null,
    });
  });

  // The ordinary authenticated path. Fails if `source` is hardcoded to
  // "declared", which would make an authenticated registration
  // indistinguishable from an unauthenticated one in the response.
  it("reports a machine as proved when the token agrees with the body", () => {
    expect(resolveMachine({ machine: "laptop" }, "laptop")).toEqual({
      machine: "laptop",
      source: "proved",
      overrode: null,
    });
  });

  // The attack this row exists to close: a caller authenticating as one
  // machine and claiming another. Fails if the contradiction branch returns
  // `declared` instead of `proved` — the impersonation would be stored.
  it("prefers the proved machine over a contradicting declaration", () => {
    const resolved = resolveMachine({ machine: "laptop" }, "desktop");
    expect(resolved.machine).toBe("laptop");
    expect(resolved.source).toBe("proved");
  });

  // Fails if `overrode` is hardcoded to `null`, which would make the
  // override silent — a launcher sending a stale hostname would have no way
  // to discover the value it sent was discarded.
  it("names the declaration it discarded", () => {
    expect(resolveMachine({ machine: "laptop" }, "desktop").overrode).toBe("desktop");
  });

  // Distinguishes "agreed" from "overrode", which is what makes `overrode`
  // readable as a signal at all. Fails if the agreement branch is removed
  // and every proved call reports an override of its own declaration.
  it("reports no override when there was nothing to override", () => {
    expect(resolveMachine({ machine: "laptop" }, "laptop").overrode).toBeNull();
  });
});

describeIfDb("the machine a session registers with, and the claim that inherits it", () => {
  const dbName = scratchDatabaseName("machine_identity");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
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

  interface Registration {
    machine: string;
    machineSource: string;
    machineOverrode: string | null;
  }

  interface Rejection {
    code: string;
    fields?: string[];
    message: string;
  }

  /** Registers through the operation, with an optional proved machine on the caller. */
  async function register(
    sessionId: string,
    declaredMachine: string,
    provedMachine?: string,
  ): Promise<Registration> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(
      "register_session",
      { sessionId, machine: declaredMachine },
      {
        caller: {
          transport: "http",
          sessionId,
          ...(provedMachine === undefined ? {} : { machine: provedMachine }),
        },
      },
    )) as Registration;
  }

  async function storedMachine(sessionId: string): Promise<string | undefined> {
    const rows = await prisma.$queryRawUnsafe<{ machine: string }[]>(
      `SELECT "machine" FROM "Session" WHERE "id" = $1`,
      sessionId,
    );
    return rows[0]?.machine;
  }

  async function createItem(title: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = (await (runtime.call as any)(
      "create_project",
      { title, body: "The brief.", area: "machines", originType: "auto" },
      { caller: {} },
    )) as { id: string };
    return item.id;
  }

  // The gap the row named: the proved value was plumbed to the boundary and
  // dropped. Fails if `register_session` goes back to writing
  // `input.machine` — the body's claim would be stored over the token's.
  it("stores the machine the token proved, not the one the body claimed", async () => {
    const registration = await register("session-impersonating", "desktop", "laptop");

    expect(registration.machine).toBe("laptop");
    expect(registration.machineSource).toBe("proved");
    expect(registration.machineOverrode).toBe("desktop");
    expect(await storedMachine("session-impersonating")).toBe("laptop");
  });

  // The `direct` binding must keep working with nothing proved — an
  // explicit acceptance criterion of the row. Fails if the resolution
  // starts requiring a proved machine, which would break the command line
  // at the one call every session must make first.
  it("keeps registering a session on a transport that proves nothing", async () => {
    const registration = await register("session-direct", "workstation");

    expect(registration.machine).toBe("workstation");
    expect(registration.machineSource).toBe("declared");
    expect(registration.machineOverrode).toBeNull();
    expect(await storedMachine("session-direct")).toBe("workstation");
  });

  // The point of #111 for `claim`: a constant stated once at registration
  // is not restated per call. Fails if `machine` becomes required again, or
  // if the `Session` lookup stops being consulted.
  it("lets a registered session claim without restating its machine", async () => {
    await register("session-claimer", "build-box");
    const itemId = await createItem("Item to claim");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assignment = (await (runtime.call as any)(
      "claim",
      {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "agent-a",
        sessionId: "session-claimer",
      },
      { caller: { sessionId: "session-claimer" } },
    )) as { machine: string };

    expect(assignment.machine).toBe("build-box");
  });

  // An explicit value must still win, so a claim can record a machine other
  // than the session's own. Fails if the fallback is applied
  // unconditionally — i.e. if the `input.machine !== undefined` guard is
  // inverted or removed.
  it("honours a machine the claim names over the session's", async () => {
    await register("session-override", "build-box");
    const itemId = await createItem("Item claimed elsewhere");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assignment = (await (runtime.call as any)(
      "claim",
      {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "agent-b",
        sessionId: "session-override",
        machine: "remote-runner",
      },
      { caller: { sessionId: "session-override" } },
    )) as { machine: string };

    expect(assignment.machine).toBe("remote-runner");
  });

  // `Assignment.machine` is non-null and there is nothing honest to invent.
  // Fails if the refusal is replaced by a placeholder default, which would
  // put a claim in the fleet view listed as running somewhere it is not.
  it("refuses a machineless claim from a session that never registered", async () => {
    const itemId = await createItem("Item claimed by a stranger");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = (await (runtime.call as any)(
      "claim",
      {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "agent-c",
        sessionId: "session-unregistered",
      },
      { caller: { sessionId: "session-unregistered" } },
    ).catch((e: unknown) => e)) as Rejection;

    expect(error.code).toBe("invalid_input");
    expect(error.fields).toContain("machine");
    // The refusal has to name both routes out, since either genuinely fixes
    // it. Fails if the message degrades to a bare "machine is required".
    expect(error.message).toContain("register_session");
  });
});
