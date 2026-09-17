// Pull requests as recorded facts — MILESTONES.md #136.
//
// `progress_report` promises a clickable link to the open PR where there is
// one, and the branch name where there is not. The whole difficulty is the
// "where there is not": a report that renders a link to a PR that was never
// opened, or that has since been closed, is worse than one that renders the
// branch, because a reader who clicks a dead link learns not to trust the
// links that work either.
//
// ── Why a PR is recorded rather than composed ───────────────────────────
//
// The tempting alternative is to compose the URL from `Item.repo` and
// `Item.branch`, both of which the report already holds. It costs no schema
// change and no write. It is also wrong in a way that cannot be patched:
//
//   - **The branch is present in all three cases.** An item whose PR is
//     open, an item whose PR was closed unmerged, and an item on which
//     nobody ever opened a PR are indistinguishable by branch alone. A
//     composed URL would render identically for all three and be a live link
//     in only one.
//   - **It would have to guess a forge.** `Repo.host` is nullable
//     (schema.prisma records why: unknown is a distinct state from a guess),
//     and there is no field anywhere saying which forge a host runs or how
//     that forge spells a pull-request URL. Composing means hard-coding one
//     vendor's path scheme and hoping.
//
// So a PR is a `pull_request` artifact: recorded once, by whoever opened it,
// carrying the real URL. The cost is one write at the moment a crew opens a
// PR — which is the moment the URL is in hand and free to record — and in
// exchange the report never renders a link it was not handed.
//
// ── Why closure is a status on a new row, not an edit ───────────────────
//
// `artifacts` is append-only: nothing in the product updates an artifact
// after it is written, and the merge gate's whole "at tip" reasoning depends
// on that. So a PR that closes is not an edit to the row that opened it — it
// is a **newer `pull_request` row for the same item** whose status says
// `closed`. The report reads the newest row per item and links only when it
// says `open`.
//
// That keeps two things true at once: the history of every PR an item ever
// had survives (a re-proposed piece of work has two open rows and a closed
// one between them, in order), and "is there a live PR right now" is a
// single-row read rather than a fold.

/**
 * The state a recorded pull request is in.
 *
 * ── Why four values, over the two-value argument this reverses ─────────
 *
 * This comment argued for exactly two. The argument is sound for the reader
 * it considers, and is worth stating before it is overturned:
 *
 * > Two values, not a copy of any forge's state vocabulary. The report asks
 * > exactly one question of a PR — "should this render as a link?" — and
 * > every forge state answers it one way or the other. `merged` is
 * > deliberately absent: a merged PR's item reaches `merged` on its own, and
 * > a link to a merged PR is still a live link, so recording the merge adds
 * > a third value that no reader here would branch on differently from
 * > `open`.
 *
 * **The error is the premise that the report is the only reader.** That was
 * true when this module had one caller, and the vocabulary was correctly
 * sized to it. It stopped being true, and the cost landed on a question the
 * link-rendering purpose never asks: *did this work land?*
 *
 * `merged` and `closed` are not two spellings of "not open" — they are
 * **opposite outcomes**. One says the work shipped; the other says it was
 * abandoned. Collapsed into one value they store identically, so the board
 * cannot tell them apart at all, and anything reading a PR's status as an
 * *outcome* rather than as link-or-no-link gets a wrong answer with no way
 * to detect it. A gate built on a two-value vocabulary would pass an
 * abandoned PR as readily as a merged one, the exact inversion of its purpose
 * (`../service/guards/merge.ts`, `merge_authority: "pr"`). This was reported
 * independently, twice, by callers who had no contact with each other —
 * which is the signal that it is the model that is wrong here, not one
 * caller's expectation of it.
 *
 * Note what does **not** change: `merged` still renders as a live link, so
 * the report's own behaviour is untouched. The two-value argument proves
 * that `merged` is uninteresting *to the report*, and it is. It does not
 * follow that the fact is uninteresting to record — the report simply was
 * never the thing that needed it.
 *
 * `draft` is the same mistake at the other end of a PR's life. A parked
 * draft and a PR sitting in front of reviewers are both `open`, and a board
 * reader deciding where attention is owed needs them apart: one is waiting
 * on its author, the other on a reviewer. Collapsing them makes a column of
 * open PRs unreadable for the one purpose anybody scans it for.
 *
 * **This is still not a copy of a forge's vocabulary**, and that bound is
 * the thing being kept. Each value earns its place by a question a reader
 * of *this* board asks: is there something to click (`open`, `draft`,
 * `merged`), did the work land (`merged` vs `closed`), and is it waiting on
 * its author or on a reviewer (`draft` vs `open`). Forge states with no such
 * question behind them — locked, queued, auto-merge-enabled — stay out.
 *
 * A status change is recorded the way a closure is: a **new `pull_request`
 * row** superseding the one before it, never an edit. See the
 * module header — `artifacts` is append-only and the merge gate's "at tip"
 * reasoning depends on it. So a draft going up for review is a fresh row
 * saying `open`, and the draft period survives in the history rather than
 * being overwritten. No schema change: `body` already carries the status as
 * text.
 */
export const PULL_REQUEST_STATUSES = ["open", "closed", "merged", "draft"] as const;

export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number];

/**
 * The status a `pull_request` artifact is taken to have when it records none.
 *
 * `open`, because recording a PR is something a caller does at the moment it
 * opens one — that is when the URL exists to be recorded at all. Defaulting
 * to `closed` would make the ordinary call the one that has to say something
 * extra, and a caller that forgot would silently lose the link the artifact
 * was written to provide.
 */
export const DEFAULT_PULL_REQUEST_STATUS: PullRequestStatus = "open";

/** Whether `value` is one of the two statuses a recorded PR can carry. */
export function isPullRequestStatus(value: unknown): value is PullRequestStatus {
  return typeof value === "string" && (PULL_REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Reads the status off a `pull_request` artifact's `body`.
 *
 * Unrecognised prose reads as `open` rather than throwing, and that is a
 * deliberate asymmetry with the write path: `record_artifact` refuses an
 * unrecognised status outright, so the only rows that reach here with one are
 * rows that predate this vocabulary or were written around the operation. For
 * those, the recorded URL is the only fact available, and the item that has a
 * PR row at all is far likelier to have a live PR than a closed one — this is
 * the same posture `DEFAULT_PULL_REQUEST_STATUS` takes, applied to a row
 * nobody validated.
 *
 * ── Why the match is not `body.trim() === "closed"` ────────────────────
 *
 * It was, and that made the tolerance one-sided in the one direction that
 * costs something. The rows this function exists to be lenient about are
 * precisely the unvalidated ones, and an unvalidated row saying `"Closed"`,
 * `"CLOSED"`, `"closed."` or `"closed — superseded by #340"` fell through
 * the exact-equality test and was reported **open**. The result is the one
 * failure this module's header says the whole design exists to prevent: the
 * report renders a live markdown link to a dead pull request, and "a reader
 * who clicks a dead link learns not to trust the links that work either".
 *
 * So the closed side is matched case-insensitively and allows trailing
 * punctuation or an explanatory clause after the word.
 *
 * ── `merged` and `draft` are matched the same way, and it is still safe ──
 *
 * Both are matched by the identical leading-word rule, and neither widens
 * what counts as `open`. The safety property above is about not turning a
 * dead PR into a live link, and these two cannot: `draft` and `merged` are
 * *more* specific than the `open` they fall back from, so the worst outcome
 * of a missed match is the status this function already returned.
 *
 * `merged` in particular narrows rather than widens. A legacy row whose body
 * leads with "merged" is read as merged instead of open — which is the
 * honest reading of what it says, and the one a gate needs. A row that does
 * not say it stays `open`, exactly as before, so no unvalidated row is
 * promoted to an outcome nobody recorded. That direction matters for the
 * merge authority that reads this: falling back to `open` leaves a gate
 * refusing, and a gate that refuses on absent evidence is the failure mode
 * to have.
 *
 * **The leniency is deliberately one-directional, and that asymmetry is the
 * safety property.** Nothing here widens what counts as `open`: an
 * unrecognised body still falls through to `open`, so the only behaviour
 * that changed is a row that plainly says it is closed now being read that
 * way. Widening the *open* side would be the dangerous direction — it would
 * let a body that merely mentions the word turn a genuinely closed PR back
 * into a live link, which is the failure this is fixing, reintroduced from
 * the other end. `record_artifact` remains exactly as strict as it was: it
 * accepts only the two exact words, so none of these spellings can be
 * written through the product from now on. This tolerance is for the
 * history, not a relaxation of the contract.
 */
export function pullRequestStatusOf(body: string | null | undefined): PullRequestStatus {
  if (body == null) return DEFAULT_PULL_REQUEST_STATUS;
  const trimmed = body.trim();
  // Anchored at the start: the body must *lead* with the word, so a review
  // note that merely mentions "closed" partway through — "keeping this open
  // until the sibling PR is closed" — is not read as a closure. A trailing
  // clause is allowed only after a boundary that is not a letter, so
  // `closedown` does not match.
  if (/^closed\b/i.test(trimmed)) return "closed";
  // `merged` before `draft` is not a precedence decision — a body can only
  // lead with one word — but the order does encode which fact costs more to
  // get wrong. Both use the same anchored, case-insensitive, word-boundary
  // rule as `closed`, so `mergedown` and `draftsman` match neither.
  if (/^merged\b/i.test(trimmed)) return "merged";
  if (/^draft\b/i.test(trimmed)) return "draft";
  return DEFAULT_PULL_REQUEST_STATUS;
}

/**
 * Whether `url` is one the report is willing to render as a link.
 *
 * A deliberately narrow check: `http` and `https` only. The report emits
 * markdown, and a markdown link whose target is a `javascript:` or `data:`
 * URL is an injection into whatever renders the report — an MCP client's
 * chat pane, the web UI — from a string that arrived over the API. Anything
 * that is not plainly a web address is not linked; the row falls back to its
 * branch, which is the same thing it does when there is no PR at all.
 *
 * This is also the last line of the "never a dead link" promise. The write
 * path refuses a `pull_request` with no `ref`, and this refuses one whose
 * `ref` is not a URL — so between them, a link only ever reaches a reader
 * when someone recorded a real web address for it.
 */
export function isLinkableUrl(url: string | null | undefined): boolean {
  if (url == null) return false;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    // Not a URL at all — a path, a PR number, a sentence. `ref` is a generic
    // column shared with screenshots, so this is a realistic value, not a
    // defensive impossibility.
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // A markdown renderer ends a link at the first `)`, so a URL carrying one
  // — or any whitespace — lets an authenticated caller close our link early
  // and append their own: `https://ok/1) [CLICK ME](https://evil)` renders as
  // two links, the second entirely theirs. The protocol check above cannot
  // see that, because such a string is a perfectly valid URL. Refuse the
  // characters rather than escape them: every real forge PR URL is free of
  // both, so nothing legitimate is lost, and a refusal at the write is one
  // place to reason about instead of every render site.
  return !/[()\s]/.test(url.trim());
}
