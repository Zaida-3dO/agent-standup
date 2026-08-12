// A dedicated fixture for the mutation-testing harness's own self-check —
// see `scripts/run-mutation-tests.mjs` (`assertControlSurvives`) and
// `tests/mutation-harness.test.ts`.
//
// The harness needs to prove, on every run, that it is capable of
// reporting a mutant as SURVIVED — otherwise a run that reports 100%
// kills could just as easily be a harness that is incapable of ever
// observing a survivor, which is indistinguishable from "every mutant was
// really killed" without this check. `controlNoOp` below has one branch
// that is provably unreachable under its only allowed input type, so
// mutating that branch's condition changes nothing any test can observe:
// the branch can never execute either way. If a mutant there is ever
// reported Killed, the harness — not this file — is what's broken.
//
// Nothing here is imported by application code; it exists solely for the
// control check.

/**
 * Always returns `value` unchanged. The `typeof value === "undefined"`
 * branch is dead code under the `string` parameter type — TypeScript
 * guarantees no caller can pass `undefined` here, so that branch never
 * executes for any test, any input, ever.
 *
 * The harness's control target is the `return "unreachable"` statement
 * below. Because the branch it lives in can never run, no test can ever
 * observe which string that `return` would have produced — so a mutation
 * to it can never legitimately be reported "Killed" under any test suite
 * that respects the type system. `scripts/run-mutation-tests.mjs`
 * (`assertControlSurvives`, `CONTROL_FIXTURE_DEAD_LINE`) checks the
 * report for exactly that line number; if this statement ever moves,
 * that constant must move with it.
 */
export function controlNoOp(value: string): string {
  if (typeof value === "undefined") {
    // Unreachable: `value` is typed `string`, never `undefined`, at every
    // call site a test can construct.
    return "unreachable";
  }
  return value;
}
