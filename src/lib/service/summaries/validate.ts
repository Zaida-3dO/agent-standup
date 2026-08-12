// Summaries — static validators. SCHEMA.md §5, §5a; MILESTONES.md #21.
//
// Everything here is pure and synchronous except the similarity check, which
// needs the item's prior `events` rows to compare against (SCHEMA.md §5,
// static validator 2: "No entry >=85% similar to any events row for this
// item"). The shape/caps/jargon validators need nothing from the database,
// so they are kept separable from the guard that wires them into a
// transition (`guard.ts`, same directory) — a caller with just a candidate
// summary and no open transaction can still run them.
//
// **Reject, never truncate** (SCHEMA.md §5, static validator 1). Every
// violation this module finds is returned as a `SummaryValidationIssue`; the
// caller (the guard) turns that into a `GuardRejectedError`. Nothing in this
// file ever shortens a string to make it fit — the caller either gets the
// value it submitted, unmodified, or a rejection naming which field and rule
// failed.

/** One `shipped` outcome, or one `not_done` follow-up-reason target — kept a plain string cap. */
export const SHIPPED_MIN = 1;
export const SHIPPED_MAX = 5;
export const SHIPPED_CHAR_CAP = 120; // SCHEMA.md §5: "1-5 entries, <=120 chars each."

export const NOT_DONE_MIN = 0;
export const NOT_DONE_MAX = 5; // SCHEMA.md §5: "0-5 typed entries."
// SCHEMA.md §5a does not state a per-field character cap for `not_done`'s
// `text`/`reason` strings — the row only bounds entry *count* (0-5).
// DECISIONS.md's "Closing summaries" note says only "typed fields with hard
// caps" in the aggregate, and does not restate one either. Per the task
// brief, a cap was lost from this field somewhere in an earlier audit of the
// source doc; it is not recoverable from either document as they stand. This
// is my own placeholder, not a spec'd value — generous enough not to bite a
// real deferral note, applied so "reject, never truncate" has something
// concrete to enforce on this field too. Flagged in the PR/handoff; a future
// row should replace it the moment the real cap is confirmed or restored.
export const NOT_DONE_TEXT_CHAR_CAP = 240;
export const NOT_DONE_REASONS = ["follow-up", "needs-approval", "descoped"] as const;
export type NotDoneReason = (typeof NOT_DONE_REASONS)[number];

export const WHAT_TO_TEST_MIN = 1;
export const WHAT_TO_TEST_MAX = 3; // SCHEMA.md §5: "Required iff user_facing. 1-3 entries."
// No char cap stated in SCHEMA for `what_to_test[].text`. Same posture as
// `not_done` above: my own placeholder, not a spec'd value.
export const WHAT_TO_TEST_TEXT_CHAR_CAP = 240;

export const WATCH_FOR_MAX = 3; // SCHEMA.md §5: "0-3."
// No char cap stated for `watch_for` entries either. Own placeholder.
export const WATCH_FOR_CHAR_CAP = 240;

// No char cap stated for `how_verified` (a single string, not an array).
// Own placeholder — generous, since it is meant to hold "what was run and
// observed live," which can legitimately run longer than a one-line outcome.
export const HOW_VERIFIED_CHAR_CAP = 600;

/** The similarity threshold SCHEMA.md §5 states outright: ">=85% similar" is a rejection. */
export const SIMILARITY_REJECT_AT = 0.85;

/**
 * The jargon denylist (SCHEMA.md §5, static validator 3): "the vocabulary of
 * the system rather than of the work" — internal command names, raw field
 * identifiers, review shorthand, bare cross-references, script filenames,
 * ALL-CAPS prefixes. Each entry is matched case-sensitively against the
 * *token* boundaries described alongside it below (`findJargonHits`) —
 * plain strings here, no regex authoring at the call site, so every entry
 * reads as a term rather than a pattern.
 *
 * Kept deliberately plain: every entry below names this project's own
 * internal vocabulary as it exists right now — an enum value, a review
 * shorthand convention, an identifier-assignment syntax, a script-file
 * extension this project actually uses. None of it points outside this
 * repository or refers to anything this repository is not.
 */
export const JARGON_TERMS: readonly string[] = [
  // Raw field identifiers / assignment syntax.
  "owner=",
  "review_round",
  "blocked_reason",
  "blocked_on_type",
  "merge_authority",
  "drive_mode",
  // Review shorthand.
  "LGTM",
  "fail-open",
  "fail-closed",
  // Script filenames — the extension this project's own scripts use
  // (`scripts/*.mjs`), not a fixed real filename.
  ".mjs",
];

/** A bare `#123`, `PR-123`, or `§12`-style cross-reference — matched structurally, not as a fixed string. */
const CROSS_REFERENCE = /(^|[\s(])(#\d+|PR-\d+|§\d+(\.\d+)?[a-z]?)\b/;

/**
 * The ALL-CAPS-prefix conventions this denylist actually means to catch —
 * an enumerated list (review round 1, MEDIUM), not a blanket
 * `\b[A-Z]{2,}[:_]/` pattern.
 *
 * The blanket regex fired on any two-or-more uppercase letters followed by
 * `:` or `_` — which also matches legitimate technical prefixes that happen
 * to be all-caps abbreviations: `DB:`, `URL:`, `SQL:`, `NB:`, `OK:`. Those
 * are plausible, ordinary `how_verified` prose ("DB: migrations applied
 * cleanly"); rejecting them blocks a legitimate completion for a reason the
 * author cannot see. The rule SCHEMA.md §5 actually describes is "ALL-CAPS
 * prefixes" in the sense of annotation shorthand a writer drops into a
 * comment or commit message — not every acronym that happens to be
 * upper-case. Enumerating the real set is precise and asks for nothing this
 * matcher cannot already do; it costs maintenance (a new prefix convention
 * needs a line added here), which is the trade the option to keep the
 * blanket regex plus an allowlist would avoid — but that alternative means
 * guessing at the complement of an infinite set of legitimate technical
 * prefixes, which is the wrong side of that trade to be guessing on.
 */
export const ALL_CAPS_PREFIXES: readonly string[] = [
  "TODO",
  "FIXME",
  "WIP",
  "HACK",
  "XXX",
  "NOTE",
  "BUG",
];

/** Matches one of `ALL_CAPS_PREFIXES` at a word boundary, immediately followed by `:` or `_`. */
const ALL_CAPS_PREFIX = new RegExp(`\\b(${ALL_CAPS_PREFIXES.join("|")})[:_]`);

export interface SummaryValidationIssue {
  readonly field: string;
  readonly rule: string;
  readonly message: string;
}

export interface NotDoneEntry {
  readonly text: string;
  readonly reason: string;
  readonly item_id?: string;
}

export interface WhatToTestEntry {
  readonly text: string;
  readonly link?: string;
}

/** The candidate shape a caller submits for validation — SCHEMA.md §5's authored fields only; `final_state` is derived and never validated here. */
export interface SummaryCandidate {
  readonly shipped: readonly string[];
  readonly not_done: readonly NotDoneEntry[];
  readonly user_facing: boolean;
  readonly what_to_test?: readonly WhatToTestEntry[] | null;
  readonly how_verified?: string | null;
  readonly watch_for: readonly string[];
}

function pushIfTooLong(
  issues: SummaryValidationIssue[],
  field: string,
  index: number | undefined,
  value: string,
  cap: number,
): void {
  if (value.length > cap) {
    const label = index === undefined ? field : `${field}[${index}]`;
    issues.push({
      field,
      rule: "max_length",
      message: `${label} is ${value.length} characters, over the ${cap}-character cap. Shorten it and resubmit — it will not be truncated for you.`,
    });
  }
}

/**
 * Validates shape, counts and per-field caps (SCHEMA.md §5's static
 * validator 1) plus the `user_facing` branch it forces (§5, `what_to_test` /
 * `how_verified` rule) and the jargon denylist on human-facing fields
 * (static validator 3) and the `how_verified`-not-CI-only rule (static
 * validator 4).
 *
 * Deliberately does **not** run the similarity check (static validator 2) —
 * that needs the item's event history, which only the guard (with a
 * transaction handle) can fetch. Kept as a separate function
 * (`findSimilarityIssues`, below) so a caller with no database access can
 * still run every check this function covers.
 *
 * Returns every issue found rather than stopping at the first — a caller
 * fixing a rejected summary wants the whole list in one round, not one
 * violation at a time.
 */
export function validateSummaryShape(candidate: SummaryCandidate): SummaryValidationIssue[] {
  const issues: SummaryValidationIssue[] = [];

  // --- shipped: 1-5 entries, <=120 chars each ---
  if (candidate.shipped.length < SHIPPED_MIN || candidate.shipped.length > SHIPPED_MAX) {
    issues.push({
      field: "shipped",
      rule: "count",
      message: `shipped must have ${SHIPPED_MIN}-${SHIPPED_MAX} entries; got ${candidate.shipped.length}.`,
    });
  }
  candidate.shipped.forEach((entry, i) => {
    pushIfTooLong(issues, "shipped", i, entry, SHIPPED_CHAR_CAP);
    issues.push(...findJargonHits("shipped", i, entry));
  });

  // --- not_done: 0-5 typed entries, each with a recognised reason ---
  if (candidate.not_done.length > NOT_DONE_MAX) {
    issues.push({
      field: "not_done",
      rule: "count",
      message: `not_done must have at most ${NOT_DONE_MAX} entries; got ${candidate.not_done.length}.`,
    });
  }
  candidate.not_done.forEach((entry, i) => {
    pushIfTooLong(issues, "not_done", i, entry.text, NOT_DONE_TEXT_CHAR_CAP);
    issues.push(...findJargonHits("not_done", i, entry.text));
    if (!NOT_DONE_REASONS.includes(entry.reason as NotDoneReason)) {
      issues.push({
        field: "not_done",
        rule: "reason",
        message: `not_done[${i}].reason must be one of ${NOT_DONE_REASONS.join(", ")}; got ${JSON.stringify(entry.reason)}.`,
      });
    }
  });

  // --- user_facing forces the what_to_test / how_verified branch (SCHEMA.md §5) ---
  if (candidate.user_facing) {
    const steps = candidate.what_to_test ?? [];
    if (steps.length < WHAT_TO_TEST_MIN || steps.length > WHAT_TO_TEST_MAX) {
      issues.push({
        field: "what_to_test",
        rule: "count",
        message: `what_to_test is required when user_facing is true, with ${WHAT_TO_TEST_MIN}-${WHAT_TO_TEST_MAX} entries; got ${steps.length}.`,
      });
    }
    steps.forEach((step, i) => {
      pushIfTooLong(issues, "what_to_test", i, step.text, WHAT_TO_TEST_TEXT_CHAR_CAP);
      issues.push(...findJargonHits("what_to_test", i, step.text));
    });
    if (candidate.how_verified !== null && candidate.how_verified !== undefined) {
      issues.push({
        field: "how_verified",
        rule: "not_applicable",
        message:
          "how_verified must be omitted when user_facing is true — use what_to_test instead.",
      });
    }
  } else {
    if (!candidate.how_verified || candidate.how_verified.trim().length === 0) {
      issues.push({
        field: "how_verified",
        rule: "required",
        message: "how_verified is required when user_facing is false.",
      });
    } else {
      pushIfTooLong(
        issues,
        "how_verified",
        undefined,
        candidate.how_verified,
        HOW_VERIFIED_CHAR_CAP,
      );
      issues.push(...findJargonHits("how_verified", undefined, candidate.how_verified));
      if (isCiReferenceOnly(candidate.how_verified)) {
        issues.push({
          field: "how_verified",
          rule: "ci_only",
          message:
            "how_verified may not consist solely of a CI/test-run reference — say what was run and observed live.",
        });
      }
    }
    if (candidate.what_to_test !== null && candidate.what_to_test !== undefined) {
      issues.push({
        field: "what_to_test",
        rule: "not_applicable",
        message:
          "what_to_test must be omitted when user_facing is false — use how_verified instead.",
      });
    }
  }

  // --- watch_for: 0-3 ---
  if (candidate.watch_for.length > WATCH_FOR_MAX) {
    issues.push({
      field: "watch_for",
      rule: "count",
      message: `watch_for must have at most ${WATCH_FOR_MAX} entries; got ${candidate.watch_for.length}.`,
    });
  }
  candidate.watch_for.forEach((entry, i) => {
    pushIfTooLong(issues, "watch_for", i, entry, WATCH_FOR_CHAR_CAP);
    issues.push(...findJargonHits("watch_for", i, entry));
  });

  return issues;
}

/**
 * `how_verified` "may not consist *solely* of a CI/test reference" (SCHEMA.md
 * §5, static validator 4). Matched as: after stripping a single CI/test-run
 * phrase and surrounding punctuation, nothing but whitespace remains — so
 * "ran the suite, all green" (extra words) passes, and "tests pass" or "CI
 * green" (nothing else) is refused.
 */
const CI_ONLY_PHRASES =
  /\b(ci|tests?|test suite|the suite|build)\s+(pass(ed|es)?|green|ok|succeeded)\b/gi;

function isCiReferenceOnly(text: string): boolean {
  const stripped = text.replace(CI_ONLY_PHRASES, "").replace(/[.,;:!\s]+/g, "");
  return stripped.length === 0;
}

/**
 * Finds jargon-denylist hits in `text` for one field/index.
 *
 * Exported (not just used internally) so the guard and its tests can probe
 * this in isolation from the count/cap rules above.
 *
 * Matching is **substring**, not exact-token, for the plain-string entries
 * in `JARGON_TERMS` — deliberately, because several of those terms
 * (`owner=`, `.mjs`, `blocked_reason`) are not standalone words to begin
 * with and a word-boundary match would silently stop matching them mid-
 * identifier. It is still case-sensitive per entry (`LGTM` should not fire
 * on the ordinary word "algorithm"), which is what a case-insensitive scan
 * would get wrong — see the false-positive test in the accompanying suite.
 */
export function findJargonHits(
  field: string,
  index: number | undefined,
  text: string,
): SummaryValidationIssue[] {
  const issues: SummaryValidationIssue[] = [];
  const label = index === undefined ? field : `${field}[${index}]`;

  for (const term of JARGON_TERMS) {
    if (text.includes(term)) {
      issues.push({
        field,
        rule: "jargon",
        message: `${label} contains the denylisted term ${JSON.stringify(term)} — use plain language instead.`,
      });
    }
  }
  if (CROSS_REFERENCE.test(text)) {
    issues.push({
      field,
      rule: "jargon",
      message: `${label} contains a bare cross-reference (an issue/PR/section number) — describe the thing itself instead.`,
    });
  }
  if (ALL_CAPS_PREFIX.test(text)) {
    issues.push({
      field,
      rule: "jargon",
      message: `${label} contains an ALL-CAPS prefix (e.g. "TODO:") — write it as plain prose.`,
    });
  }
  return issues;
}

// --- Similarity check (SCHEMA.md §5, static validator 2) ---

/** Lower-cases and splits on non-word runs, dropping empties — the token set two strings are compared over. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Jaccard similarity of two strings' token sets: |intersection| / |union|,
 * in [0, 1]. Two empty strings are defined as similarity 0 (nothing to
 * compare, not "identical") so an empty summary field can never itself
 * trigger a rejection via this path — count/cap rules already refuse an
 * empty required field on their own terms.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * My design call for "similarity", stated explicitly per the task brief
 * (row #91's precedent for stating an algorithm choice in the open):
 *
 * **Algorithm: Jaccard similarity over lower-cased word-token sets.**
 * Rejected alternatives and why:
 *   - Levenshtein edit distance (the algorithm `near-duplicates.ts` uses
 *     for row #91) is a character-level metric built for short strings
 *     where a *typo* is the thing being caught (near-duplicate area ids).
 *     A summary field is a full sentence or more; edit distance over full
 *     prose is expensive (this module's own `O(m*n)` cost, repeated per
 *     candidate-field x history-row pair) and answers the wrong question —
 *     two sentences describing the same fact in different word order have a
 *     *large* edit distance despite being exactly the "log-paste" case
 *     SCHEMA.md §5 names as the thing to catch.
 *   - Token-set Jaccard treats a string as "which words appear", ignoring
 *     order and repetition — cheap to compute, and it is exactly what
 *     "boilerplate" and "log-paste" mean: the same substantive words
 *     reappearing verbatim or near-verbatim from an event's payload/body
 *     into a summary field.
 * **Threshold: >=0.85, taken directly from SCHEMA.md §5's own number**
 * ("No entry >=85% similar to any events row for this item") — not an
 * independent choice, just applied to the algorithm above.
 *
 * Compares one candidate field string against one event's comparable text
 * (see `guard.ts` for what "comparable text" means for an `events` row —
 * this function only knows about two strings).
 */
export function isTooSimilar(candidate: string, historical: string): boolean {
  return jaccardSimilarity(candidate, historical) >= SIMILARITY_REJECT_AT;
}
