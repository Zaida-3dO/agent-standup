// The four conformance assertions, as pure functions over observed results.
// See docs/plans/SCHEMA.md §22, MILESTONES.md #94.
//
// These are functions rather than `it()` bodies for one reason, and it is
// the reason §22 asks for a negative control per claim: an assertion
// written inline can only ever be run against the real tree, where it is
// expected to pass. A function taking the driver map, the case table and
// the observed results as arguments can also be handed a deliberately
// broken one — a guard with no case, a driver returning a different code —
// and asserted to *report* the failure. An assertion that has only ever
// been observed to pass has never been run against the thing it exists to
// catch.
//
// So each function returns its findings rather than throwing. The caller
// decides what a finding means: the conformance suite fails on a non-empty
// list, and the negative controls assert the list is non-empty for input
// that ought to fail. Throwing would make the second of those impossible
// to write without catching, which is the shape that hides a typo in the
// assertion itself.
import type { Rejection } from "../service/errors";

/**
 * What one driver did with one case.
 *
 * `accepted` carries no value: §22 compares *outcomes*, and two adapters
 * legitimately shape a success differently — HTTP stringifies a `bigint`
 * that the direct binding returns as a `bigint`. Comparing acceptance as a
 * boolean is the honest claim; comparing payloads would fail on encoding
 * rather than on behaviour.
 */
export interface Observation {
  readonly driver: string;
  readonly caseName: string;
  readonly operation: string;
  readonly accepted: boolean;
  /** Present exactly when `accepted` is false. */
  readonly rejection?: Rejection;
}

/** One disagreement, named so a failure message says which claim broke. */
export interface Finding {
  readonly assertion:
    "identical-outcomes" | "accept-and-reject" | "guard-coverage" | "completeness";
  readonly message: string;
}

/**
 * A rejection reduced to a string, for comparison and for a readable
 * failure message.
 *
 * `fields` is sorted because two adapters may collect the same offending
 * fields in a different order — the set is the claim, the order is not.
 * `guard` is spelled `-` when absent rather than omitted, so a rejection
 * carrying no guard and one carrying a guard named `undefined` do not
 * render identically.
 */
export function renderRejection(rejection: Rejection | undefined): string {
  if (rejection === undefined) return "accepted";
  const fields = [...rejection.fields].sort().join(",");
  return `${rejection.code}[${fields}]${rejection.guard ?? "-"}`;
}

/**
 * Assertion 1 — identical outcomes.
 *
 * The same acceptance, or the same rejection code, fields and guard, from
 * every driver that ran the case. Message text is deliberately not
 * compared: a terminal and an API should word things differently, and the
 * service goes out of its way to make them (`shapeRefusalMessage` picks a
 * surface from the caller's transport), so asserting text would fail on
 * correct behaviour.
 *
 * A case observed by a single driver is not a disagreement — it is what
 * every waived operation looks like — so one observation passes.
 */
export function checkIdenticalOutcomes(observations: readonly Observation[]): Finding[] {
  const byCase = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = observation.caseName;
    const bucket = byCase.get(key);
    if (bucket === undefined) byCase.set(key, [observation]);
    else bucket.push(observation);
  }

  const findings: Finding[] = [];
  for (const [caseName, group] of [...byCase.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const rendered = new Map<string, string[]>();
    for (const observation of group) {
      const key = renderRejection(observation.accepted ? undefined : observation.rejection);
      const drivers = rendered.get(key);
      if (drivers === undefined) rendered.set(key, [observation.driver]);
      else drivers.push(observation.driver);
    }
    if (rendered.size <= 1) continue;
    const detail = [...rendered.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([outcome, drivers]) => `${outcome} from ${[...drivers].sort().join(", ")}`)
      .join(" / ");
    findings.push({
      assertion: "identical-outcomes",
      message: `${caseName}: drivers disagreed — ${detail}`,
    });
  }
  return findings;
}

/**
 * Assertion 2 — every operation under test has an accepting case and a
 * rejecting case.
 *
 * A guard that never refuses anything passes a happy-path suite and
 * protects nothing, so the rejecting half is the load-bearing one. This
 * checks the operations the case table claims to cover rather than every
 * registered operation: which operations are in scope is the case table's
 * decision, and asserting over all 62 here would restate assertion 4 while
 * failing for a different reason.
 */
export function checkAcceptAndReject(observations: readonly Observation[]): Finding[] {
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  for (const observation of observations) {
    (observation.accepted ? accepted : rejected).add(observation.operation);
  }

  const findings: Finding[] = [];
  for (const operation of [...new Set([...accepted, ...rejected])].sort()) {
    if (!accepted.has(operation)) {
      findings.push({
        assertion: "accept-and-reject",
        message: `${operation}: no accepting case — a suite of refusals proves the operation is reachable by nothing`,
      });
    }
    if (!rejected.has(operation)) {
      findings.push({
        assertion: "accept-and-reject",
        message: `${operation}: no rejecting case — a guard that never refuses anything protects nothing`,
      });
    }
  }
  return findings;
}

/**
 * Assertion 3 — every guard in `expected` appears in at least one
 * *observed* rejection.
 *
 * Computed from the `guard` identifier the service returned, never from
 * what a case declared it would trip. That distinction is the whole point:
 * a case can name one rule while the service refuses on another with the
 * same code, and a suite that trusted the declaration would record
 * coverage it does not have. So a new guard fails the build until a case
 * actually provokes it.
 *
 * `expected` is passed in rather than read from `guardRegistry` here, so
 * this function has no import-time side effects and so the negative
 * control can hand it a set of one.
 */
export function checkGuardCoverage(
  expected: readonly string[],
  observations: readonly Observation[],
): Finding[] {
  const observed = new Set<string>();
  for (const observation of observations) {
    const guard = observation.rejection?.guard;
    if (guard !== undefined) observed.add(guard);
  }

  // An assertion evaluated over an empty set passes forever and silently.
  // §22 asks for this as a direct claim rather than as a property of the
  // loop below, because the loop is exactly what stops reporting when the
  // registry stops being populated — which is a plausible failure, since
  // registration is a module side effect that an import reshuffle can drop.
  if (expected.length === 0) {
    return [
      {
        assertion: "guard-coverage",
        message:
          "the expected-guard set is empty — coverage over an empty set passes forever and proves nothing",
      },
    ];
  }

  return [...expected]
    .filter((guard) => !observed.has(guard))
    .sort()
    .map((guard) => ({
      assertion: "guard-coverage" as const,
      message: `${guard}: registered but never observed refusing anything — it needs a case that provokes it`,
    }));
}

/** What one adapter exposes, and what it deliberately does not. */
export interface AdapterSurface {
  readonly adapter: string;
  /** Operation names this adapter exposes, however it derives them. */
  readonly exposes: readonly string[];
  /** Operation names it deliberately does not, each carrying a written reason. */
  readonly waived: readonly string[];
}

/**
 * Assertion 4 — adapter completeness.
 *
 * Every operation an adapter exposes maps to a registered service
 * operation, and every registered operation it does not expose carries a
 * written waiver. An unwaived divergence fails in both directions, and the
 * directions catch different mistakes: an unmapped name is an adapter
 * reaching for something the service does not have, while an unwaived
 * absence is a surface quietly missing an operation nobody noticed.
 *
 * A waiver naming an operation the adapter exposes anyway is also a
 * finding. It is not harmless — it is a reason on record for a decision
 * that was reversed, and left alone it is the sentence a reader trusts
 * while the code does the opposite.
 */
export function checkCompleteness(
  registered: readonly string[],
  surfaces: readonly AdapterSurface[],
): Finding[] {
  const known = new Set(registered);
  const findings: Finding[] = [];

  for (const surface of [...surfaces].sort((a, b) => a.adapter.localeCompare(b.adapter))) {
    const exposed = new Set(surface.exposes);
    const waived = new Set(surface.waived);

    for (const operation of [...exposed].sort()) {
      if (!known.has(operation)) {
        findings.push({
          assertion: "completeness",
          message: `${surface.adapter} exposes ${operation}, which is not a registered service operation`,
        });
      }
      if (waived.has(operation)) {
        findings.push({
          assertion: "completeness",
          message: `${surface.adapter} waives ${operation} and exposes it anyway — the waiver's reason is on record for a decision that was reversed`,
        });
      }
    }

    for (const operation of [...known].sort()) {
      if (!exposed.has(operation) && !waived.has(operation)) {
        findings.push({
          assertion: "completeness",
          message: `${surface.adapter} does not expose ${operation} and carries no waiver for it`,
        });
      }
    }
  }
  return findings;
}
