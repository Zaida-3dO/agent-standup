// Whether the findings recorded on an approving review block the merge it
// would otherwise permit — SCHEMA.md §6a, MILESTONES.md #88794a6c.
//
// ── The rule, stated exactly ────────────────────────────────────────────
//
// Severity gates **only beneath `lgtm_with_nits`**. Under that one verdict, a
// finding graded `medium`, `high` or `critical` blocks precisely as
// `changes_required` would. Under every other approving verdict — `lgtm`,
// `approved`, `lgtm_with_followups` — this returns "not blocking" without
// reading a severity at all.
//
// That asymmetry is the whole design and it is not an oversight, so it is
// worth saying why it is right rather than merely what it is.
//
// `lgtm_with_nits` is the one verdict whose meaning is conditional: it says
// "this is sound, and what remains is cosmetic". The verdict is a claim about
// the severity of what was found, so the findings array is the evidence for
// the claim the verdict is making, and checking it is not second-guessing the
// reviewer — it is holding the verdict to its own stated terms. A MEDIUM
// finding under `lgtm_with_nits` is a self-contradiction: the reviewer has
// said "only nits remain" and then recorded something that is not a nit.
//
// A plain `lgtm` makes no such claim. It says "ship it" unconditionally, and
// a reviewer who records a `critical` finding alongside it has made a
// deliberate, attributable statement that the finding does not block. Reading
// severity there would let a recorded observation silently overrule an
// explicit approval, which inverts where judgement is supposed to sit: the
// verdict carries the weight, and severity only gates beneath
// `lgtm_with_nits`.
//
// `lgtm_with_followups` is likewise left alone, and deliberately: its bargain
// is "these findings are real and will be done separately", so findings that
// are *not* nits are exactly what it is FOR. It already pays for that bargain
// through `merge.requires_linked_followup`. Grading it here would make the
// tier unusable for the case it exists to serve, and would double-charge it.
//
// ── Why the gate reads findings rather than trusting the word ───────────
//
// The verdict is a string a reviewer types; the findings are the record of
// what it actually found. When those two disagree the safe reading is the
// evidence, not the label — otherwise the cheapest way past a blocking
// finding is to type a different word above it, and every tier below
// `changes_required` becomes advisory.
//
// ── Ungraded findings do not block ─────────────────────────────────────
//
// A finding with no `severity` is ungraded, which is a different claim from
// "graded low" (`../../findings.ts`). It does not block: inventing a level
// for it would be the gate grading a finding the reviewer declined to grade,
// and historical reviews recorded before the vocabulary existed are all
// ungraded. `isAtLeastSeverity` already answers `false` for an absent or
// unrecognised value, so this falls out of reusing it rather than being a
// special case here.
//
// ── Why a malformed findings column does not block ─────────────────────
//
// `parseFindings` throws on a malformed document. That is right at the write,
// where the caller can fix it, and wrong at the merge: a row written before
// the validator existed, or by any other writer, would become an item that
// can never merge and whose refusal names a column the merging party did not
// write and cannot correct. So a document that will not parse is treated as
// "no gradeable findings" — the verdict alone decides, exactly as it did
// before this module existed. Refusing to merge is a stronger action than
// this module is entitled to take on the strength of data it cannot read.
import { isAtLeastSeverity, parseFindings, type Finding } from "../../findings";

/**
 * The verdict whose findings are graded, and the only one.
 *
 * A constant rather than an inline literal because the asymmetry above is the
 * load-bearing part of this module: one name, referenced by the check and by
 * every message that has to explain itself, so the rule cannot be described
 * one way and applied another.
 */
export const SEVERITY_GATED_VERDICT = "lgtm_with_nits";

/**
 * The lowest severity that blocks. Everything at or above it gates; `info`
 * and `low` are nits and do not.
 */
export const BLOCKING_SEVERITY_FLOOR = "medium" as const;

/** A blocking finding, and why it blocks — enough for a refusal to quote it. */
export interface BlockingFinding {
  readonly severity: string;
  readonly text: string;
  readonly where?: string;
}

/**
 * The findings on `artifact` that block a merge, in the order recorded.
 *
 * Returns empty for every verdict other than `lgtm_with_nits`, for a document
 * that does not parse, and for findings that are absent, ungraded, or graded
 * below `medium`.
 */
export function blockingFindings(verdict: string | null, findings: unknown): BlockingFinding[] {
  if (verdict !== SEVERITY_GATED_VERDICT) {
    return [];
  }
  if (findings == null) {
    return [];
  }
  let parsed: Finding[];
  try {
    parsed = parseFindings(findings);
  } catch {
    // Unreadable, so ungradeable. See the header: the verdict decides alone.
    return [];
  }
  const blocking: BlockingFinding[] = [];
  for (const finding of parsed) {
    if (isAtLeastSeverity(finding.severity, BLOCKING_SEVERITY_FLOOR)) {
      blocking.push({
        // Narrowed by `isAtLeastSeverity`, which is false for undefined.
        severity: finding.severity as string,
        text: finding.text,
        ...(finding.where === undefined ? {} : { where: finding.where }),
      });
    }
  }
  return blocking;
}

/**
 * One line per blocking finding, for a refusal that has to name what is
 * actually in the way.
 *
 * Quoting them matters more than the count: a caller told "2 findings block"
 * has to go and look them up, and the whole failure this gate addresses is a
 * merging party who never read the review. Truncated, because a refusal is a
 * message and not a report.
 */
export function describeBlockingFindings(blocking: readonly BlockingFinding[]): string {
  const MAX_QUOTED = 5;
  const quoted = blocking
    .slice(0, MAX_QUOTED)
    .map((f) => `  - [${f.severity}] ${f.text}${f.where ? ` (${f.where})` : ""}`)
    .join("\n");
  const remainder = blocking.length - MAX_QUOTED;
  return remainder > 0 ? `${quoted}\n  - …and ${remainder} more` : quoted;
}
