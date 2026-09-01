// Build status as a recorded fact — the answer to "is this item's pull
// request passing?".
//
// The question is the single most repeated one a crew asks. Measured across
// eighty three thousand harness records from thirteen sessions: two thousand
// and six shell invocations asking a build service for a pull request's
// status, and a further one thousand and twenty three asking about a specific
// run, across nine of those sessions. The board already records that an item
// *has* a pull request — a `pull_request` artifact carrying its URL — and
// could not say whether that pull request was green. So every crew dropped
// out of the board, shelled out, read the answer by eye, and came back, and
// what it learned was never written down, so the next session asked again.
//
// ── Reported in, not fetched out ────────────────────────────────────────
//
// The service does not call the forge. It is handed the answer by whoever
// already has it.
//
// The alternative — the service resolving a `pull_request` artifact's `ref`
// against a forge API on every read — is the shape that looks more capable
// and is worse on all four axes that matter here:
//
//   - **It needs a credential.** A token with read access to every repository
//     any item might name, held by the server, refreshed by someone, and
//     scoped to nothing in particular. Introducing such a secret is a
//     permanent operational obligation, not a one-time cost.
//   - **It needs a forge.** `Repo.host` is nullable and nothing anywhere
//     records which forge a host runs or how that forge spells a checks API.
//     `pull-requests.ts` already declined to compose a PR URL for exactly
//     this reason; resolving one is the same guess with a network call
//     attached.
//   - **It can hang.** `get_item_detail` runs inside one transaction so its
//     payload is a consistent snapshot. An outbound HTTP call inside that
//     transaction holds it open for as long as the far end is slow, which
//     turns the most detailed read in the product into the one that stalls a
//     connection when an unrelated third party is having an outage.
//   - **It cannot answer offline.** A read that only works when the forge is
//     reachable is a read that stops working exactly when a crew most wants
//     to know what it last knew.
//
// A reported status has the opposite profile: it costs one write at the
// moment a caller already has the answer in hand, it cannot hang, it cannot
// fail, it needs no secret, and it works for any forge or none — a local
// script, a self-hosted runner and a hand-typed observation all record the
// same way. What it gives up is currency, and currency is precisely the thing
// that can be *measured and reported* rather than assumed. Which is the next
// section.
//
// ── Staleness is surfaced, never guessed ────────────────────────────────
//
// A reported status is a claim about a moment. The moment matters as much as
// the claim: "passing" learned four seconds ago and "passing" learned
// yesterday against a commit since rewritten are the same word carrying
// opposite amounts of information.
//
// So every read of a build status carries **two** independent staleness
// facts, and neither is inferred from the other:
//
//   - **How old it is** — `ageSeconds`, from the artifact's own `createdAt`.
//     Wall-clock age. Always available.
//   - **Whether the commit it ran against is still the item's tip** —
//     `atTip`. A build that passed against a commit three pushes ago says
//     nothing about the code as it stands now, however recently it was
//     recorded.
//
// The two are genuinely orthogonal, which is why both are reported. A status
// recorded seconds ago against a superseded commit is fresh and irrelevant. A
// status recorded hours ago against a tip nobody has moved since is old and
// perfectly good. Collapsing them into one "is it stale" boolean would have
// to pick a rule and would be wrong in one of those directions.
//
// `atTip` is `null`, not `false`, when the question does not apply — the
// status recorded no commit, or the item has no commit artifact to be a tip.
// Unknown and false are different answers, and reporting an unanswerable
// question as `false` would read as "this build is stale" about a build that
// may be perfectly current.

/**
 * The state a reported build is in.
 *
 * Deliberately four values, and deliberately not any forge's vocabulary.
 * Every build service spells these differently and most add states that only
 * mean something inside their own product; the question a reader of this
 * board asks has four answers and no more:
 *
 *   `passing`  every check that ran, passed. Safe to merge on this evidence.
 *   `failing`  at least one check failed. A real, nameable reason not to merge.
 *   `pending`  the build is still running. Neither answer yet — and the state
 *              a crew is waiting on, which is why it is recorded rather than
 *              left absent.
 *   `error`    the build did not complete: infrastructure failed, it was
 *              cancelled, it timed out. Distinct from `failing` because the
 *              code is not implicated, and a crew that reads `error` should
 *              re-run rather than go looking for a defect it will not find.
 *
 * `pending` earns its place by being the state polling exists to escape. A
 * crew that records `pending` has written down that a build is in flight, so
 * the next reader knows one is running rather than that none was ever
 * started — which is the difference between waiting and starting one.
 */
export const CHECK_RUN_STATUSES = ["passing", "failing", "pending", "error"] as const;

export type CheckRunStatus = (typeof CHECK_RUN_STATUSES)[number];

/** Whether `value` is one of the four states a reported build can carry. */
export function isCheckRunStatus(value: unknown): value is CheckRunStatus {
  return typeof value === "string" && (CHECK_RUN_STATUSES as readonly string[]).includes(value);
}

/**
 * The statuses on which merging is not justified by the build.
 *
 * Exported as a named set rather than written as `status !== "passing"` at
 * each site, because the two ideas are not the same and the difference is
 * load-bearing: `pending` is not a failure, and a reader that treats "not
 * passing" as "failing" reports a build still running as a broken one.
 */
export const NON_PASSING_CHECK_RUN_STATUSES: readonly CheckRunStatus[] = [
  "failing",
  "pending",
  "error",
];

/**
 * Reads the status off a `check_run` artifact's `body`.
 *
 * Returns `null` — not a status — for anything unrecognised, and that is the
 * whole safety property of this function.
 *
 * `pull-requests.ts` faces the same question about its own artifact kind and
 * answers it the other way: an unrecognised body there reads as `open`,
 * because a recorded PR whose status nobody validated is far likelier to be
 * open than closed, and the cost of being wrong is a link. Here the cost of
 * being wrong is a crew merging on a build that did not pass, so there is no
 * default worth taking. **A status that cannot be read is reported as
 * unknown**, and a caller that gets `null` knows it has learned nothing —
 * which is a true and useful thing to learn, and strictly better than a
 * confident guess in either direction.
 *
 * The write path refuses an unrecognised status outright, so `null` can only
 * arrive from a row written around the operation. Matching is exact after
 * trimming, with no case folding and no trailing-clause tolerance: unlike the
 * PR case there is no body of pre-existing prose rows to be lenient toward,
 * this vocabulary existed before the kind did, and leniency here would be
 * inventing tolerance for data that does not exist at the cost of reading
 * `"failing, will retry"` as a pass if the prefix rule were ever widened.
 */
export function checkRunStatusOf(body: string | null | undefined): CheckRunStatus | null {
  if (body == null) return null;
  const trimmed = body.trim();
  return isCheckRunStatus(trimmed) ? trimmed : null;
}

/**
 * How old a reported status is, in whole seconds, as of `now`.
 *
 * Floored at zero. A negative age is not a meaningful thing to report and is
 * reachable in practice — the recorded time comes from the database's clock
 * and `now` from the reading process's, and the two need only disagree by a
 * few milliseconds for a status recorded in the same request to come back
 * "recorded one second in the future". Reporting that as `-1` would make
 * every consumer handle a case that means nothing; reporting it as `0` says
 * the true thing, which is that it was recorded just now.
 *
 * Whole seconds because the number exists for a human or an agent to judge
 * currency by, and sub-second precision on a fact that is at best minutes
 * fresh is noise that invites false confidence in it.
 */
export function checkRunAgeSeconds(recordedAt: Date, now: Date): number {
  const deltaMs = now.getTime() - recordedAt.getTime();
  return deltaMs <= 0 ? 0 : Math.floor(deltaMs / 1000);
}
