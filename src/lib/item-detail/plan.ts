// The Plan tab's shape: which plan is the live one, which are superseded,
// and what the tab leads with.
//
// ── The problem this solves ────────────────────────────────────────────
//
// The Plan tab renders every plan artifact and every plan review at full
// length, stacked in one column in round order. Nothing on it is more
// prominent than anything else, so a plan agreed three rounds ago and
// replaced twice since occupies the same visual weight as the plan the work
// is actually being done against — and it appears FIRST, because rounds
// ascend. A reader arriving to answer "what is the plan" reads a superseded
// one and has no signal that they should keep scrolling.
//
// A snapshot history is genuinely worth keeping — the point of a plan
// review is that a plan changed in response to it, and that is only legible
// when both versions remain reachable. So the answer is not to drop history,
// it is to rank it: the live plan is the page, the rest are one click away.
//
// ── What "latest" means here ───────────────────────────────────────────
//
// The **last plan artifact in the order the server sent**, which is
// `reviewRound` ascending then `createdAt` ascending. Not the highest round
// alone: two plans can share a round (a plan revised twice before a review
// looked at either), and in that case the later-written one is the current
// one by every reading. Not `createdAt` alone either — a round is the
// stronger ordering signal, and the server has already applied both.
//
// This module never re-sorts. It reads position, so the ordering rule lives
// in exactly one place (the operation's ORDER BY) rather than being restated
// in the client where it can drift.
import type { DetailArtifact } from "./types";

/** The artifact kind the Plan tab treats as a plan snapshot, as opposed to a review of one. */
const PLAN_SNAPSHOT_KIND = "plan";

/**
 * The Plan tab, arranged.
 *
 * `latest` and `superseded` are disjoint and together are every plan
 * snapshot, so nothing is shown twice and nothing is dropped. `reviews`
 * carries the plan reviews, which are the record of what was said ABOUT the
 * plans and belong in their own section rather than interleaved with them —
 * a review's verdict is a different kind of claim from a plan's body, and
 * mixing them was half of why the column read as undifferentiated.
 */
export interface PlanTimeline {
  /** The plan in force, or `null` when no plan has been recorded at all. */
  readonly latest: DetailArtifact | null;
  /**
   * Earlier plans, **most recent first** — the reverse of the order they
   * were written. Someone reaching into the history is almost always
   * looking for the version immediately before the current one ("what
   * changed"), and that is the one this puts at the top.
   */
  readonly superseded: readonly DetailArtifact[];
  /** Plan reviews, in the order the server sent them — oldest first, which is how a conversation reads. */
  readonly reviews: readonly DetailArtifact[];
}

/**
 * Splits the Plan tab's artifacts into the live plan, the superseded ones,
 * and the reviews of them.
 *
 * Anything that is neither a plan nor a plan review cannot reach here —
 * `artifactsForTab` has already filtered to the two kinds — so an unexpected
 * kind falls into `reviews` rather than being dropped. That is the safe
 * direction: an artifact filed under the tab's review section is visible and
 * mildly mis-headed, where a dropped one is invisible, and invisible is the
 * failure this whole tab exists to correct.
 */
export function planTimeline(artifacts: readonly DetailArtifact[]): PlanTimeline {
  const snapshots = artifacts.filter((artifact) => artifact.kind === PLAN_SNAPSHOT_KIND);
  const reviews = artifacts.filter((artifact) => artifact.kind !== PLAN_SNAPSHOT_KIND);
  const latest = snapshots.length === 0 ? null : (snapshots[snapshots.length - 1] ?? null);
  const superseded = snapshots.slice(0, Math.max(0, snapshots.length - 1)).reverse();
  return { latest, superseded, reviews };
}

/**
 * The number of leading characters of a plan body the BLUF is drawn from.
 *
 * A bound rather than the whole body, because this runs over stored text of
 * unbounded length and the BLUF's entire job is to be shorter than the thing
 * it summarises. Generous enough that a real opening paragraph fits inside
 * it; short enough that a body with no paragraph break does not become the
 * summary of itself.
 */
const BLUF_SCAN_CHARS = 2000;

/** The longest BLUF shown, in characters. Past this it is cut on a word boundary and ellipsised. */
const BLUF_MAX_CHARS = 320;

/**
 * The plan's bottom line, up front — the one thing the tab leads with.
 *
 * ── Why this is derived rather than stored ─────────────────────────────
 *
 * There is no BLUF column on an artifact, and inventing one would mean every
 * plan already written has an empty one — the field would be blank on
 * precisely the corpus that exists. So it is derived from the body, which
 * every plan has.
 *
 * ── What it takes ─────────────────────────────────────────────────────
 *
 * The first paragraph of actual prose: headings, code fences, blockquote
 * markers, list bullets and horizontal rules are skipped, because a plan
 * whose body opens with a `# Plan` heading would otherwise have "Plan" as
 * its entire summary. Markdown emphasis and inline code marks are stripped
 * from what remains, since this renders as plain text in a lead position and
 * a stray asterisk pair there reads as a typo rather than as bold.
 *
 * **A list item is taken when there is no prose paragraph at all.** A plan
 * written as nothing but a bulleted list is a real shape, and returning
 * `null` for it would leave the tab's most prominent line empty on a plan
 * that is perfectly readable.
 *
 * Returns `null` when there is nothing to summarise — an empty or
 * whitespace-only body — so the component omits the lead entirely rather
 * than rendering an empty emphasis block.
 */
export function planBluf(body: string | null): string | null {
  if (body === null) return null;
  const head = body.slice(0, BLUF_SCAN_CHARS);
  const lines = head.split(/\r?\n/);

  const prose: string[] = [];
  const listFallback: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    // A fence toggles regardless of its info string, and its contents are
    // never prose — a plan opening with a code block is describing a command
    // or a shape, not stating its bottom line.
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === "") {
      // A blank line ends the paragraph — but only once something has been
      // collected, so leading blank lines do not terminate before it starts.
      if (prose.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^([-*_]\s*){3,}$/.test(line)) continue;
    if (/^>\s?/.test(line)) {
      prose.push(line.replace(/^>\s?/, ""));
      continue;
    }
    const listMatch = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      if (prose.length > 0) break;
      if (listFallback.length === 0) listFallback.push(listMatch[1] ?? "");
      continue;
    }
    prose.push(line);
  }

  const chosen = prose.length > 0 ? prose.join(" ") : listFallback.join(" ");
  const cleaned = stripInlineMarkdown(chosen).trim();
  if (cleaned === "") return null;
  return truncateOnWord(cleaned, BLUF_MAX_CHARS);
}

/**
 * Removes the inline markdown marks that read as noise in plain text.
 *
 * Deliberately small: emphasis, inline code, and the link syntax reduced to
 * its text. This is not a markdown parser and must not grow into one — a
 * BLUF is a lead line, and anything it cannot flatten is better shown as
 * written than mangled by a rule that half-understands it.
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\s+/g, " ");
}

/**
 * Cuts to at most `max` characters on a word boundary, ellipsised.
 *
 * The boundary matters: cutting mid-word produces a fragment that reads as a
 * rendering fault rather than as a summary. When there is no space to cut on
 * — one very long token — it cuts hard, because a summary that is allowed to
 * exceed its bound is not a bound.
 */
function truncateOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
