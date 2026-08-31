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
 * Two values, not a copy of any forge's state vocabulary. The report asks
 * exactly one question of a PR — "should this render as a link?" — and every
 * forge state answers it one way or the other. `merged` is deliberately
 * absent: a merged PR's item reaches `merged` on its own, and a link to a
 * merged PR is still a live link, so recording the merge adds a third value
 * that no reader here would branch on differently from `open`.
 */
export const PULL_REQUEST_STATUSES = ["open", "closed"] as const;

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
  // Anchored at the start: the body must *lead* with the word, so a review
  // note that merely mentions "closed" partway through — "keeping this open
  // until the sibling PR is closed" — is not read as a closure. A trailing
  // clause is allowed only after a boundary that is not a letter, so
  // `closedown` does not match.
  return /^closed\b/i.test(body.trim()) ? "closed" : DEFAULT_PULL_REQUEST_STATUS;
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
