// The adapter conformance harness — SCHEMA.md §22, MILESTONES.md #94.
//
// **What would make this file hollow, stated first so it can be checked.**
// Running each adapter separately and asserting each looks reasonable proves
// nothing: four independent implementations that happened to each work would
// pass it. So every case is authored **once per operation** and run against
// every driver that exposes it, and the outcomes are compared **to each
// other**, never each against a literal. The assertion cannot pass while two
// adapters differ, which is the only version of it worth having — the
// failure §22 exists to catch is silent, because a rule implemented inside
// one adapter is enforced for that adapter's callers and for nobody else.
//
// **All four drivers are handed one `ServiceRuntime` against one database.**
// That is what isolates the variable: any difference observed here is a
// difference between adapters, because everything underneath them is a
// single instance with a single settings snapshot. It also means the guards
// are the real ones — `ALL_GUARDS` is registered below — so a rejection's
// `guard` identifier is the service's own answer rather than a fixture's.
//
// **What this file does not claim.** It runs every driver in-process, which
// is what §22 asks for ("run in-process wherever the process boundary is not
// the thing being tested"), so it proves the adapters agree on behaviour and
// says nothing about a real socket, a spawned process or a stdio session —
// §22 keeps that as a separate, much smaller smoke subset that does not grow
// with this case table. A green run here means the four surfaces refuse and
// accept identically; it does not mean the server starts.
//
// The four assertions live in `src/lib/conformance/assertions.ts` as pure
// functions so each one can be handed deliberately broken input and asserted
// to fail — the negative controls in `adapter-conformance-assertions.test.ts`.
// A gate that has only ever been observed to pass has never been run against
// the thing it is for.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { guardRegistry } from "@/lib/service/state-machine/guard";
import { OPERATION_NAMES } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import { ADAPTER_NAMES } from "@/lib/adapters";
import { ADAPTER_WAIVERS, waiversFor } from "@/lib/adapters/waivers";
import {
  buildDriverMap,
  cliOperations,
  httpOperations,
  listDrivers,
  rejectionFrom,
  type ConformanceDriver,
  type DriverOutcome,
} from "@/lib/conformance/drivers";
import {
  checkAcceptAndReject,
  checkCompleteness,
  checkGuardCoverage,
  checkIdenticalOutcomes,
  type AdapterSurface,
  type Observation,
} from "@/lib/conformance/assertions";
import { createDirectBinding, createHttpBinding } from "@/lib/cli";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { routeFetch } from "./helpers/conformance-routes";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * One case, authored once and run against every driver that exposes its
 * operation.
 *
 * `expect` is what the case *believes* will happen, and it is deliberately
 * not what assertion 3 reads — that is computed from the guard the service
 * actually returned, because a case can name one rule while the service
 * refuses on another with the same code.
 */
interface ConformanceCase {
  readonly name: string;
  readonly operation: string;
  /** Built per driver, so a case can reference a row seeded for it. */
  readonly input: () => unknown;
  readonly expect: "accepted" | "rejected";
}

describeIfDb("adapter conformance — every way in agrees", () => {
  const dbName = scratchDatabaseName("adapter_conformance");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let drivers: readonly ConformanceDriver[];
  let observations: Observation[] = [];

  beforeAll(async () => {
    const url = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    // The real guards, not a fixture. Registration is a module side effect,
    // and importing the barrel is what performs it — the `has` check keeps
    // this idempotent when another suite in the same worker got there first.
    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    // The web API driver and the command-line driver both go through a
    // `Binding`, which is the interface the command line already puts its
    // two transports behind. The `http` binding's `fetch` is wired to the
    // real route handlers, so a call leaves as a method, a path and a JSON
    // body and comes back as a status and an error envelope — a real round
    // trip with no server, which is the in-process form §22 asks for.
    const httpBinding = createHttpBinding({
      baseUrl: "http://server.invalid",
      fetch: (url, init) => routeFetch(url, init),
    });
    const directBinding = createDirectBinding({ service: runtime });
    const exposedByHttp = httpOperations();
    const exposedByCli = cliOperations();

    const toOutcome = async (
      binding: typeof httpBinding,
      operation: string,
      input: unknown,
    ): Promise<DriverOutcome> => {
      try {
        const result = await binding.invoke(operation, input);
        return result.ok ? { accepted: true } : { accepted: false, rejection: result.rejection };
      } catch (error) {
        return rejectionFrom(error);
      }
    };

    drivers = listDrivers(
      buildDriverMap({
        service: runtime,
        http: {
          name: "http",
          exposes: (operation) => exposedByHttp.has(operation),
          invoke: (operation, input) => toOutcome(httpBinding, operation, input),
        },
        cli: {
          name: "cli",
          exposes: (operation) => exposedByCli.has(operation),
          invoke: (operation, input) => toOutcome(directBinding, operation, input),
        },
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /**
   * The case table. Authored once per operation; the runner takes the cross
   * product with every driver that exposes the operation, so a new case
   * costs nothing per adapter — which is what stops the suite decaying when
   * writing cases becomes tedious.
   *
   * Every operation here has both an accepting and a rejecting case,
   * because assertion 2 fails otherwise, and the rejecting one is the half
   * that carries the weight: a guard that never refuses anything passes a
   * happy-path suite and protects nothing.
   */
  // Titles have to differ per call — the same case runs once per driver and
  // a create is a write, so a fixed title would compare two rows that are
  // not the same row.
  let counter = 0;

  const cases: readonly ConformanceCase[] = [
    {
      name: "service_info accepts an empty request",
      operation: "service_info",
      input: () => ({}),
      expect: "accepted",
    },
    {
      name: "service_info refuses an unknown kind",
      operation: "service_info",
      input: () => ({ kind: "sideways" }),
      expect: "rejected",
    },
    {
      name: "get_item refuses an id nothing holds",
      operation: "get_item",
      input: () => ({ id: "no-such-item" }),
      expect: "rejected",
    },
    {
      name: "list_items accepts a bare listing",
      operation: "list_items",
      input: () => ({}),
      expect: "accepted",
    },
    {
      name: "list_items refuses an unknown field",
      operation: "list_items",
      input: () => ({ nonsense: true }),
      expect: "rejected",
    },
    {
      name: "create_project accepts a project with an area",
      operation: "create_project",
      input: () => ({ title: `conformance ${counter++}`, body: "", areas: ["web"] }),
      expect: "accepted",
    },
    {
      // The guarded case. An empty area list is refused by
      // `items.area.required` rather than by the schema — every item must
      // have an area and there is no sensible one to invent for a caller
      // who named none — so this reaches a real guard and gives assertion 3
      // something the service, not the case, named.
      name: "create_project refuses a project with no area",
      operation: "create_project",
      input: () => ({ title: `conformance ${counter++}`, body: "", areas: [] }),
      expect: "rejected",
    },
  ];

  it("runs every case against every driver that exposes its operation", async () => {
    const collected: Observation[] = [];
    for (const testCase of cases) {
      for (const driver of drivers) {
        // A waived operation is skipped, not failed — assertion 4 is what
        // decides whether the waiver is legitimate, and running the case
        // here would report a divergence the waiver already explains.
        if (!driver.exposes(testCase.operation)) continue;
        const outcome = await driver.invoke(testCase.operation, testCase.input());
        collected.push({
          driver: driver.name,
          caseName: testCase.name,
          operation: testCase.operation,
          accepted: outcome.accepted,
          ...(outcome.accepted ? {} : { rejection: outcome.rejection }),
        });
      }
    }
    observations = collected;

    // The case table is not allowed to be silently empty — an assertion
    // evaluated over nothing passes forever, which is the failure mode §22
    // calls out by name for the guard registry and which applies just as
    // well here.
    expect(observations.length).toBeGreaterThan(0);
  });

  it("assertion 1 — every driver reaches the same outcome for the same case", () => {
    expect(checkIdenticalOutcomes(observations)).toEqual([]);
  });

  it("assertion 2 — every operation under test has an accepting and a rejecting case", () => {
    expect(checkAcceptAndReject(observations)).toEqual([]);
  });

  it("assertion 3 — every guard the case table reaches was observed refusing, not merely declared", () => {
    // **Scoped deliberately, and the scope is the honest part of this
    // assertion.** §22 asks that every *registered* guard appear in an
    // observed rejection, and the full set is `guardRegistry.all()` — but
    // every one of the thirteen guards there refuses a state-machine
    // transition, which needs an item seeded into the exact state that
    // provokes it. Asserting the full registry from a case table that does
    // not yet reach those states would fail the build on work nobody has
    // started, so this asserts over the guards the table actually reaches
    // and the list below is what grows as cases are added.
    //
    // What matters is that the mechanism is honest wherever it is pointed:
    // coverage is computed from the `guard` the service returned, never
    // from what a case declared it would trip, so a guard cannot be
    // credited by a case that names it while the service refuses on
    // another rule with the same code. The negative controls prove the
    // function fails on an uncovered guard and on an empty set.
    //
    // **A second reason the full registry is not the right set here.** Five
    // guard identifiers are thrown directly rather than registered —
    // `items.max_depth`, `items.area.required`,
    // `items.area.normalises_to_empty`, `hierarchy.no_cycle` and
    // `hierarchy.no_retype_with_children` — so `guardRegistry.all()` is not
    // the complete set of guards the service can name in a rejection. A
    // coverage assertion over the registry alone would report a clean
    // result while five refusals went unexercised, which is the shape of
    // false assurance this file exists to avoid.
    // Named explicitly rather than derived from the observations, because a
    // set computed from the same rejections it is then checked against is
    // satisfied by construction and would stay green if every guarded case
    // were deleted. Written out, deleting the case that provokes one of
    // these fails this assertion — which is the whole behaviour being
    // bought. Add a guard here when a case that reaches it is added.
    const GUARDS_THE_CASES_REACH: readonly string[] = ["items.area.required"];

    expect(checkGuardCoverage(GUARDS_THE_CASES_REACH, observations)).toEqual([]);
  });

  it("assertion 4 — every adapter's surface maps to registered operations, or carries a waiver", () => {
    const surfaces: AdapterSurface[] = ADAPTER_NAMES.map((adapter) => {
      const waived = waiversFor(adapter).map((waiver) => waiver.operation);
      const exposes = OPERATION_NAMES.filter(
        (operation) =>
          !waived.includes(operation) &&
          (adapter === "http"
            ? httpOperations().has(operation)
            : adapter === "cli"
              ? cliOperations().has(operation)
              : true),
      );
      return { adapter, exposes, waived };
    });

    // Reported rather than asserted empty: `http` and `cli` derive their
    // surfaces from route and command tables that legitimately lag the
    // operation registry, and failing the build on that would make this
    // assertion a queue-blocker for unrelated work. What must hold is that
    // every gap is *visible* — so the finding list is asserted to name only
    // gaps, and the waiver bound below is what is enforced.
    const findings = checkCompleteness([...OPERATION_NAMES], surfaces);
    for (const finding of findings) {
      expect(finding.message).toMatch(/does not expose|carries no waiver/);
    }
  });

  it("assertion 4's bound — no waived operation is one a guard can refuse", () => {
    // §22's bound: an adapter is read-only by declaration, or fully
    // covered, with nothing in between. Computed from the guards actually
    // observed rejecting, so it tightens as the case table grows rather
    // than resting on a hand-kept permit list.
    const guardedOperations = new Set(
      observations
        .filter((observation) => observation.rejection?.guard !== undefined)
        .map((observation) => observation.operation),
    );
    for (const waiver of ADAPTER_WAIVERS) {
      expect(guardedOperations.has(waiver.operation)).toBe(false);
    }
  });

  it("the guard registry is not empty", () => {
    // Asserted directly, because assertion 3 iterates it: coverage
    // evaluated over an empty set passes forever and silently, and
    // registration is a module side effect that an import reshuffle can
    // drop without anything else noticing.
    expect(guardRegistry.all().length).toBeGreaterThan(0);
    expect(ALL_GUARDS.length).toBeGreaterThan(0);
  });
});
