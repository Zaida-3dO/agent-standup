// Item titles — the convention, and the check that states it. MILESTONES.md #131.
//
// A title is the one field a person reads before deciding whether an item is
// theirs. It is what the board renders, what a progress report puts one per
// row (#136), and what a notification carries. So the audience for a title is
// a person scanning a list, and the rule follows from that audience: **a
// title says what the work is, in words the reader already knows.** The
// mechanism — the module, the function, the identifier the change happens to
// touch — belongs in `body`, which is unbounded and read by whoever picks the
// work up.
//
// ── Why this advises rather than refuses ────────────────────────────────
//
// Every other input rule here refuses: an over-length headline, a missing
// `originPersonId`, an unrecognised key. This one cannot, and the reason is
// not timidity about a new rule.
//
// Refusing needs a predicate that is right about *every* string. "Reads well
// to a person" has no such predicate — the signals below are correlations,
// and each has honest counter-examples. `Inbox` is a one-word title and a
// perfectly good one. A title naming a real product surface may contain the
// characters an identifier does. A refusal that fires on those blocks a mint
// the caller cannot fix except by writing a worse title, and the caller has
// no way to see which of several signals objected.
//
// The asymmetry is what settles it. A wrong refusal costs a caller a mint it
// cannot complete; a wrong nudge costs a sentence in a response nobody has to
// act on. Where a rule is a matter of judgement rather than validity, the
// cheap error is the one to prefer — so this returns findings and the create
// path attaches them, exactly as `buildSliceNotice` attaches a routing line
// to a successful read rather than failing it.
//
// ── Why these signals and not a general "is this technical" judgement ───
//
// Each one below is a *shape*, matched structurally, and each is here because
// it appeared in real imported titles. None is a list of real values, per the
// repository's own rule against writing one down. `summaries/validate.ts`
// argued the same case for the same reason and its enumerated
// `ALL_CAPS_PREFIXES` beat the blanket regex it replaced: a broad pattern
// fires on legitimate prose, and a caller cannot tell why.

/**
 * A single thing about a title that will read badly on a board.
 *
 * Shaped like `SummaryValidationIssue` — a field, a rule id, a message — so a
 * caller that already renders one can render the other, and so the rule id is
 * matchable without parsing prose.
 */
export interface TitleFinding {
  readonly field: string;
  readonly rule: string;
  readonly message: string;
}

/**
 * A bare cross-reference: `#102`, `PR-14`, `§6a`.
 *
 * The single strongest signal, and the one the row quotes directly — a title
 * opening `agent-standup #102 - …` tells a reader nothing except that a
 * number exists somewhere they cannot see. Anchored to a boundary so an
 * ordinary `#` inside a word is left alone.
 *
 * Deliberately the same shape `summaries/validate.ts` matches for the same
 * reason: a completion summary and a title have the same audience.
 */
const CROSS_REFERENCE = /(^|[\s(([])(#\d+|PR-\d+|§\d+(\.\d+)?[a-z]?)\b/;

/**
 * A token that is a lowercase-initial product name rather than code.
 *
 * A whole family of real product names opens lower-case and then capitalises,
 * and structurally that is indistinguishable from `camelCase` — which is why
 * these are recognised by shape and set aside, rather than left to be flagged.
 * Two shapes cover it: one to three lower-case letters followed by an all-caps
 * run, and a single lower-case letter followed by one capitalised word.
 *
 * This names *shapes*, never the actual brands. The repository's rule against
 * writing real values into a matcher applies to product names as much as to
 * anything else, and a list of them would need extending forever.
 *
 * The bound is what keeps it honest: a real identifier carries at least two
 * lower-case letters before its capital and more after it, so `appendEvent`,
 * `toItemRecord`, `getUserById`, `normalizeEmDash`, `isoOrString` and `myWork`
 * match neither shape. Checked against those exact names.
 */
const LOWERCASE_INITIAL_BRAND = /^(?:[a-z]{1,3}[A-Z]+|[a-z][A-Z][a-z]+)$/;

/**
 * A code identifier: `camelCase`, `snake_case`, `dotted.path`, `fn()`.
 *
 * Each alternative requires evidence that survives being read aloud — an
 * interior capital after a lower-case run, an underscore between word
 * characters, a dot between two lower-case runs, or a call's parentheses. A
 * plain capitalised word ("Inbox", "Postgres") matches none of them, which is
 * the property that keeps this off ordinary prose.
 *
 * Two alternatives are bounded at **two** lower-case characters rather than
 * one, and the difference is load-bearing. `[a-z]+[A-Z]` fires on every
 * lowercase-initial product name, and `[a-z]+\.[a-z]+` fires on ordinary
 * abbreviations such as a sentence's "e.g." or a time's "a.m." — neither of
 * which is code. Requiring two either side clears both without losing a real
 * identifier, since one short enough to fall in the gap would be too short to
 * read as an identifier anyway.
 */
const CODE_IDENTIFIER = /\b(\w+[a-z0-9]\w*_\w+|[a-z]{2,}[A-Z]\w*|[a-z]{2,}\.[a-z]{2,}\w*|\w+\(\))/;

/**
 * `title` with any lowercase-initial product name removed, for the identifier
 * check alone.
 *
 * Dropping the token is simpler than teaching one pattern to carve an
 * exception out of another, and it is deliberately scoped: the words are
 * removed from what `CODE_IDENTIFIER` reads, never from the title itself,
 * which reaches the caller untouched.
 */
function withoutBrandTokens(title: string): string {
  return title
    .split(/\s+/)
    .filter((token) => !LOWERCASE_INITIAL_BRAND.test(token.replace(/[^\w]/g, "")))
    .join(" ");
}

/**
 * A file path or a file with an extension: `src/lib/thing.ts`, `run.mjs`.
 *
 * A path in a title is the clearest case of the mechanism displacing the
 * work: it names where a change lands, never what the change achieves.
 */
const FILE_PATH =
  /(\b[\w.-]+\/[\w./-]+|\b[\w-]+\.(ts|tsx|js|mjs|cjs|json|sql|md|yml|yaml|prisma))\b/;

/**
 * The shortest title that can carry a subject and a verb.
 *
 * Two words, which is generous on purpose — the bar is "did the author write
 * a phrase or paste a token", and `Inbox` is the one-word title the system
 * itself creates and must never be nudged about. The count is over
 * whitespace-separated runs containing a letter or digit, so punctuation
 * alone never counts as a word.
 */
export const TITLE_MIN_WORDS = 2;

/** Words in `value` — whitespace-separated runs carrying at least one letter or digit. */
function wordCount(value: string): number {
  return value.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * Every way `title` departs from the convention, or an empty list.
 *
 * Pure and total: no database, no settings, no locale. Returns *all* findings
 * rather than the first, so a caller sees the whole picture in one response —
 * the same reason `validateSummaryShape` gathers instead of throwing.
 *
 * An empty list is a real answer ("nothing to say about this title"), not a
 * missing one.
 */
export function findTitleFindings(title: string, field = "title"): TitleFinding[] {
  const findings: TitleFinding[] = [];

  if (CROSS_REFERENCE.test(title)) {
    findings.push({
      field,
      rule: "cross_reference",
      message:
        "The title carries a bare issue, PR or section number, which means nothing to someone reading the board. Say what the work achieves and keep the reference in the body.",
    });
  }
  if (CODE_IDENTIFIER.test(withoutBrandTokens(title))) {
    findings.push({
      field,
      rule: "code_identifier",
      message:
        "The title names a code identifier. Titles are read by people deciding whether this work is theirs — describe what changes for them, and put the identifier in the body.",
    });
  }
  if (FILE_PATH.test(title)) {
    findings.push({
      field,
      rule: "file_path",
      message:
        "The title names a file or path, which says where the change lands rather than what it accomplishes. Move it to the body.",
    });
  }
  if (wordCount(title) < TITLE_MIN_WORDS) {
    findings.push({
      field,
      rule: "too_short",
      message: `The title is a single word, which cannot say what the work is. Write at least ${TITLE_MIN_WORDS} words describing the outcome.`,
    });
  }

  return findings;
}

/**
 * The findings as one sentence to hand back on a successful create, or `null`
 * when there is nothing to say.
 *
 * `null` rather than an empty string so a caller tests presence rather than
 * length, matching `buildSliceNotice`, whose null-when-nothing-withheld shape
 * this deliberately mirrors — both are advice attached to a response that
 * succeeded.
 */
export function titleAdviceFor(title: string, field = "title"): string | null {
  const findings = findTitleFindings(title, field);
  if (findings.length === 0) return null;

  const detail = findings.map((finding) => finding.message).join(" ");
  return `A note on the title: ${detail}`;
}

/**
 * The convention, in the words a caller needs to satisfy it.
 *
 * Exported so the operations' `contract.rules` state it and this module
 * enforces it from one string — a rule whose prose lives beside its check
 * cannot drift from it, which is the property `complete_item`'s contract
 * protects by interpolating its caps rather than retyping them.
 */
export const TITLE_CONVENTION_RULE =
  "`title` is written for a person scanning a board: say what the work achieves, in words a reader outside this codebase would understand. Identifiers, file paths, and issue or PR numbers belong in `body`. A title that reads as a work order is accepted and answered with a note, never refused — the judgement is the author's.";
