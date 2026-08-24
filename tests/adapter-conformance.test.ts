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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stubAuthEnvironment } from "./helpers/authenticated-requests";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import { guardRegistry } from "@/lib/service/state-machine/guard";
import { OPERATION_NAMES } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import { ADAPTER_NAMES } from "@/lib/adapters";
import { ADAPTER_WAIVERS, waiversFor } from "@/lib/adapters/waivers";
import {
  buildDriverMap,
  cliArgvDriver,
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
 * The runtime the route handlers reach, behind a mutable holder.
 *
 * A route imports the composition root at module scope, and the real one
 * opens a connection from `DATABASE_URL` — which in a test run is either
 * absent or points somewhere this suite has not migrated. Without this the
 * `http` driver reports `internal` for every case while the other three
 * answer correctly, which reads as an adapter divergence and is really the
 * harness talking to a different service.
 *
 * The holder is needed because `vi.mock` is hoisted above `beforeAll`,
 * where the runtime is built: the factory closes over the holder and reads
 * it per call, so it sees the instance assigned later.
 */
const serviceHolder: { current: ServiceRuntime | undefined } = { current: undefined };

vi.mock("@/lib/service/live", () => ({
  service: {
    call: (name: string, input: unknown, options?: unknown) => {
      const runtime = serviceHolder.current;
      if (runtime === undefined) throw new Error("the conformance runtime was not built yet");
      return runtime.call(name, input, options as never);
    },
  },
}));

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
  /**
   * The same call, as words a person types.
   *
   * Supplied only where the command line's own translation layer is part of
   * what the case is comparing — a flag that has to become a number, a
   * positional that has to become a typed JSON scalar. With it, the `cli`
   * driver runs `runCommand` and `parseArgs`/`buildInput` are inside the
   * comparison; without it, the case reaches the binding directly, exactly
   * as before.
   */
  readonly argv?: (input: Record<string, unknown>) => readonly string[];
}

describeIfDb("adapter conformance — every way in agrees", () => {
  const dbName = scratchDatabaseName("adapter_conformance");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let drivers: readonly ConformanceDriver[];
  let observations: Observation[] = [];

  // The web API driver presents a bearer token, so the environment has to
  // carry one — see `helpers/conformance-routes.ts` for why an HTTP driver
  // sending no credential would agree with nothing.
  beforeAll(stubAuthEnvironment);

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
    // What the mocked composition root hands the route handlers, so all
    // four drivers are demonstrably on one service instance.
    serviceHolder.current = runtime;

    // Seeded through the service rather than through Prisma, so the row is
    // shaped by the same code path a caller would have used.
    const seeded = await runtime.call("create_project", {
      title: "conformance fixture",
      body: "",
      areas: ["web"],
      originType: "auto",
    });
    seededItemId = seeded.id;
    expect(seededItemId).not.toBe("");

    // A task under it, because the guarded cases transition and a project's
    // state is derived from its children — `evaluate()` refuses a
    // transition against a project outright, which is a different refusal
    // than the guard the case is trying to reach.
    const seededTask = await runtime.call("create_task", {
      title: "conformance task",
      body: "",
      areas: ["web"],
      originType: "auto",
      projectId: seededItemId,
    });
    seededTaskId = seededTask.id;
    expect(seededTaskId).not.toBe("");

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
        // Driven from `argv` wherever the running case supplies one, so
        // the command line's own input building is inside the comparison
        // rather than beneath it. `currentArgv` is set by the runner
        // immediately before each invocation: the driver interface is
        // deliberately `(operation, input)` for every adapter, so the one
        // adapter that needs a second spelling of the same case reads it
        // from here rather than widening the interface for all four.
        cli: cliArgvDriver({
          binding: directBinding,
          argvFor: (input) => currentArgv?.(input),
          invoke: (operation, input) => toOutcome(directBinding, operation, input),
        }),
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

  // One row every driver reads, so `get_item`'s accepting case is the same
  // read four times rather than four reads of four different rows — the
  // latter would compare outcomes that were never the same question.
  let seededItemId = "";

  // A task, for the cases that transition — a project's state derives from
  // its children and cannot be moved directly.
  let seededTaskId = "";

  // The argv spelling of the case under invocation, or `undefined`
  // for a case that has none. Set by the runner around each driver call
  // rather than passed through `invoke`, so that all four drivers keep the
  // identical `(operation, input)` signature — the property that makes the
  // map typed by `AdapterName` and the completeness assertion possible.
  let currentArgv: ConformanceCase["argv"];

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
      name: "get_item accepts an id that exists",
      operation: "get_item",
      input: () => ({ id: seededItemId }),
      expect: "accepted",
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
      // A value outside the `priority` enum rather than an unknown field.
      // An unknown field is not a divergence over HTTP but an
      // unrepresentable input: `list_items` is a GET whose route reads
      // named query parameters, so a field the route does not name never
      // reaches the service and the call succeeds — correctly. A bad value
      // in a field every adapter carries is the input that actually
      // compares the four rejections.
      name: "list_items refuses a priority outside the enum",
      operation: "list_items",
      input: () => ({ priority: "P9" }),
      expect: "rejected",
    },
    {
      // **The `--limit` bug, as a case.** `limit` is declared `z.number()`,
      // and a command-line flag is always a string — so before
      // `numericFlag` existed the command line sent `"3"`, the schema
      // refused it as `invalid_input`, and the identical operation was fine
      // over HTTP, MCP and the service layer. It survived because every
      // adapter was exercised against `list_items` separately and none was
      // compared to another on an input carrying a number.
      //
      // The `argv` spelling is what makes this case load-bearing: without
      // it the `cli` driver is handed `{ limit: 3 }` already typed, which
      // is the one input that cannot reproduce the bug.
      name: "list_items accepts a numeric limit",
      operation: "list_items",
      input: () => ({ limit: 3 }),
      argv: (input) => ["item", "list", "--limit", String(input.limit)],
      expect: "accepted",
    },
    {
      // The refusing half of the same flag, so the conversion is pinned in
      // both directions. A non-numeric `--limit` must be refused by every
      // adapter — and refused as `invalid_input`, not accepted as a string
      // and not silently coerced to `0` (`Number("")` is `0`, which is why
      // `numericFlag` trims and checks for emptiness first).
      name: "list_items refuses a limit that is not a number",
      operation: "list_items",
      input: () => ({ limit: "abc" }),
      argv: () => ["item", "list", "--limit", "abc"],
      expect: "rejected",
    },
    {
      // **The `put_setting` boolean bug, as a case.** `model_picker.enabled`
      // is declared `z.boolean()`. Over HTTP a JSON body carries `true` as
      // a boolean and it was accepted; the command line had no typing step,
      // so `standup config set … true` sent the string `"true"` and was
      // refused. The operation was tested at the CLI layer and at the
      // service layer and never once across adapters, which is why it
      // survived five releases.
      //
      // `model_picker.enabled` deliberately, not `budget.enabled`: the
      // latter is declared `sensitive`, so the command line's confirmation
      // gate refuses it without `--confirm` and the case would compare a
      // CLI-only safety refusal against three acceptances — a real
      // divergence, but not this one, and it would mask the bug under test.
      name: "put_setting accepts a boolean for a boolean setting",
      operation: "put_setting",
      input: () => ({ key: "model_picker.enabled", value: true }),
      argv: (input) => ["config", "set", String(input.key), "true"],
      expect: "accepted",
    },
    {
      // The refusing half: a string is not a boolean, and every adapter
      // must say so. This is the case that fails if a future "helpful"
      // adapter-side coercion starts turning `"yes"` into `true` for its
      // own callers only.
      name: "put_setting refuses a string for a boolean setting",
      operation: "put_setting",
      input: () => ({ key: "model_picker.enabled", value: "yes" }),
      // Quoted so `parseSettingValue`'s JSON parse yields the *string*
      // "yes" rather than falling back to the raw word — the input every
      // other adapter is sending, which is what makes this a comparison
      // rather than four adapters being asked different questions.
      argv: (input) => ["config", "set", String(input.key), '"yes"'],
      expect: "rejected",
    },
    {
      name: "create_project accepts a project with an area",
      operation: "create_project",
      input: () => ({
        title: `conformance ${counter++}`,
        body: "",
        areas: ["web"],
        originType: "auto",
      }),
      expect: "accepted",
    },
    {
      // Refused by the schema, not by `items.area.required` — the array is
      // declared non-empty, so the guard behind it never runs. Kept as a
      // rejecting case for `create_project` rather than as a guarded one;
      // the guarded cases are the transitions below.
      name: "create_project refuses a project with no area",
      operation: "create_project",
      input: () => ({
        title: `conformance ${counter++}`,
        body: "",
        areas: [],
        originType: "auto",
      }),
      expect: "rejected",
    },
    {
      // The two guarded cases. These are what make assertion 3 a claim
      // rather than a shape: both refuse with `guard_rejected` and a guard
      // identifier the *service* chose, so coverage is computed from what
      // actually fired.
      //
      // **Not a dry run, deliberately.** `dry_run=true` evaluates and
      // *reports* rather than raising (§16), so a rehearsal of a refused
      // move is a successful call carrying a rejection in its payload —
      // which would leave the `guard` column empty and assertion 3 vacuous,
      // the exact failure this case exists to close. A real move raises,
      // and a refused move writes nothing, so running it once per driver
      // against the same row is safe: each driver sees the same starting
      // state because the refusal left it unchanged.
      name: "transition_item refuses blocked with no reason",
      operation: "transition_item",
      input: () => ({ id: seededTaskId, to: "blocked" }),
      expect: "rejected",
    },
    {
      name: "transition_item refuses a merge with no commit",
      operation: "transition_item",
      input: () => ({ id: seededTaskId, to: "merged" }),
      expect: "rejected",
    },
    {
      // The accepting half, as a rehearsal — this one *would* succeed, and
      // a real move would change the state the two refusing cases above are
      // asserted against on the next driver's turn.
      name: "transition_item accepts a move the guards allow",
      operation: "transition_item",
      input: () => ({ id: seededTaskId, to: "executing", dryRun: true }),
      expect: "accepted",
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
        currentArgv = testCase.argv;
        const outcome = await driver.invoke(testCase.operation, testCase.input());
        currentArgv = undefined;
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
    //
    // **One candidate was tried and is genuinely unreachable**, recorded so
    // it is not attempted again: `items.area.required` sits behind a schema
    // that requires a non-empty `areas` array of non-empty strings, so both
    // `[]` and `["   "]` are refused as `invalid_input` with the guard never
    // running. It is defence in depth for callers inside the service layer,
    // which is a sound place for it and not something an adapter can
    // provoke. Both inputs were tried against a real database rather than
    // assumed.
    const GUARDS_THE_CASES_REACH: readonly string[] = [
      "state-machine.blocked_required_fields",
      "merge.requires_commit",
    ];

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
