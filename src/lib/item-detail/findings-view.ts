// Reading `Artifact.findings` back for display — the read side of
// `@/lib/findings`, which owns what a finding IS and refuses a malformed one
// at the moment it is written.
//
// ── Why this does not call `parseFindings` ─────────────────────────────
//
// `parseFindings` throws, and it is right to: writing is the moment to
// refuse, because a findings list is written once and read for the lifetime
// of the record, and a coercing WRITER would store a list that looks
// complete and is not. Reading is the opposite situation. The row is already
// stored, this code cannot fix it, and the reader is the person most likely
// to need to see what is actually in there. A view that threw would take out
// the whole Reviews tab — including the well-formed findings sitting beside
// the malformed one — on the strength of a row nobody can now edit.
//
// So this module **degrades, entry by entry**. A well-formed finding renders
// as a finding; a malformed one renders with whatever text can be recovered
// and is marked as unreadable rather than dropped. Dropping it would be the
// one genuinely dangerous option: a review's findings list is the material
// for "is this safe to merge", and silently showing four of five findings
// gives a reader a confident answer built on a list they believe is whole.
//
// ── Why grouped by severity rather than listed in order ────────────────
//
// The column has a severity per finding and a GIN index over it, and the
// question a reader actually arrives with is "is there anything serious in
// here", not "what did the reviewer write third". Severity order answers
// that in the first line of the section; source order buries a `critical`
// under four `info`s and makes the reader do the sorting themselves.
//
// Within a group, source order is preserved — that is the reviewer's own
// sequencing, and there is nothing better to replace it with.
import { FINDING_SEVERITIES, isFindingSeverity, type FindingSeverity } from "@/lib/findings";

/**
 * One finding as the view renders it.
 *
 * `severity` is `null` for BOTH an ungraded finding and an unrecognised
 * grade, which are collapsed deliberately: `@/lib/findings` is explicit that
 * absent means "ungraded" and not "graded low", and a grade this build does
 * not recognise makes exactly as weak a claim. Neither may be sorted among
 * the real levels, so neither gets one.
 */
export interface DisplayFinding {
  readonly text: string;
  readonly severity: FindingSeverity | null;
  readonly where: string | null;
  /**
   * True when the stored entry did not satisfy `Finding` — no usable `text`,
   * or not an object at all. Rendered as a finding that cannot be read
   * rather than omitted; see the header.
   */
  readonly malformed: boolean;
}

/** One severity's findings. Groups with no findings are never emitted. */
export interface FindingGroup {
  /** `null` is the ungraded group — see `DisplayFinding.severity`. */
  readonly severity: FindingSeverity | null;
  readonly findings: readonly DisplayFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The findings stored against an artifact, as the view can render them.
 *
 * `null`, absent, and a non-array all return an empty list — which the
 * component shows as "this review recorded no structured findings", a claim
 * that is true for all three. A non-array is a shape `parseFindings` would
 * never have written, so it can only have arrived from outside the product;
 * there is nothing to recover from it and nothing honest to say about it
 * beyond that there are no findings to show.
 */
export function displayFindings(value: unknown): DisplayFinding[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (!isRecord(entry)) {
      return {
        // A non-object entry keeps its serialised form as its text, so the
        // reader sees what is stored rather than the word "malformed" and
        // no way to find out what was.
        text: typeof entry === "string" ? entry : (JSON.stringify(entry) ?? String(entry)),
        severity: null,
        where: null,
        malformed: typeof entry !== "string",
      };
    }
    const rawText = entry.text;
    const text = typeof rawText === "string" ? rawText : "";
    const severity = isFindingSeverity(entry.severity) ? entry.severity : null;
    const where = typeof entry.where === "string" && entry.where !== "" ? entry.where : null;
    return {
      text: text.trim() === "" ? (JSON.stringify(entry) ?? "") : text,
      severity,
      where,
      malformed: text.trim() === "",
    };
  });
}

/**
 * Findings grouped by severity, **most severe first**, with the ungraded
 * group last.
 *
 * Descending rather than ascending because the group that changes a merge
 * decision should not be below the fold. `FINDING_SEVERITIES` is the ladder,
 * least to most severe, so this walks it backwards — which means adding a
 * level to that array reorders this correctly with no edit here.
 *
 * The ungraded group sits at the bottom rather than being sorted as if it
 * were `info`. It is not the mildest group, it is the group whose severity
 * nobody stated, and putting it under `info` would assert a ranking the data
 * does not carry.
 */
export function groupFindingsBySeverity(
  findings: readonly DisplayFinding[],
): readonly FindingGroup[] {
  const groups: FindingGroup[] = [];
  for (let i = FINDING_SEVERITIES.length - 1; i >= 0; i--) {
    const severity = FINDING_SEVERITIES[i]!;
    const matching = findings.filter((finding) => finding.severity === severity);
    if (matching.length > 0) groups.push({ severity, findings: matching });
  }
  const ungraded = findings.filter((finding) => finding.severity === null);
  if (ungraded.length > 0) groups.push({ severity: null, findings: ungraded });
  return groups;
}

/**
 * The most severe severity present, or `null` when nothing is graded.
 *
 * This is what a review's header line leads with — "3 findings, most severe:
 * high" — so the reader does not have to open the groups to learn whether
 * opening them matters.
 */
export function highestSeverity(findings: readonly DisplayFinding[]): FindingSeverity | null {
  for (let i = FINDING_SEVERITIES.length - 1; i >= 0; i--) {
    const severity = FINDING_SEVERITIES[i]!;
    if (findings.some((finding) => finding.severity === severity)) return severity;
  }
  return null;
}

/** How a severity reads on screen. Capitalised; the stored vocabulary is lower-case. */
export function severityLabel(severity: FindingSeverity | null): string {
  if (severity === null) return "Ungraded";
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}
