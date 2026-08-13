// A review's findings, and the severity vocabulary they are graded on —
// SCHEMA.md §6a, stored in `Artifact.findings`.
//
// **Storage only.** This module defines what a finding IS and refuses one
// that is malformed. It deliberately does not count, aggregate, threshold or
// report on findings, and nothing in the merge gate reads a severity: no
// verdict-independent severity rule exists in this system and this is not the
// change that invents one. Reporting (`Run.blocking_findings`, review-round
// and rework analysis) is later work; what it needs from here is that the
// severity was recorded at the time, honestly and in one vocabulary, because
// that is the part that cannot be reconstructed afterwards.
//
// Why validate in code rather than in the column: Postgres cannot apply an
// enum type to a value nested inside a jsonb document, so the alternative is
// a check constraint hand-writing the same list in SQL — a second copy of
// the vocabulary, free to drift from this one, in a place no test reads.

/**
 * The severity ladder, ordered least to most severe. Order is load-bearing:
 * `severityRank` is the array index, so "at least this severe" is a numeric
 * comparison rather than a set of hand-maintained membership lists, and
 * inserting a level later is one edit here rather than an edit everywhere the
 * ladder is compared.
 */
export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** One finding from one review. `severity` is optional — see `Finding`'s note. */
export interface Finding {
  /** What was found. The one genuinely required field: a finding with no text is not a finding. */
  readonly text: string;
  /**
   * How severe. Optional on purpose, and NOT defaulted: a historical review
   * that never graded its findings did not grade them, and inventing a level
   * for it would put a number nobody chose into the one field the whole
   * column exists to preserve. Absent reads as "ungraded", which is a
   * different claim from "graded low".
   */
  readonly severity?: FindingSeverity;
  /** Optional free-form location — a file, a line, a route. Never parsed. */
  readonly where?: string;
}

const SEVERITY_INDEX = new Map<string, number>(FINDING_SEVERITIES.map((s, i) => [s, i]));

/** Whether `value` is one of the severity labels. */
export function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && SEVERITY_INDEX.has(value);
}

/**
 * The severity's position on the ladder, or `null` for anything that is not
 * a severity. `null` rather than `-1`: a caller comparing ranks would read
 * `-1` as "less severe than info" and silently order an unrecognised value
 * below a real one, where `null` forces the caller to decide what an
 * unrecognised value means.
 */
export function severityRank(value: unknown): number | null {
  if (!isFindingSeverity(value)) return null;
  return SEVERITY_INDEX.get(value) ?? null;
}

/** Whether `value` is at least as severe as `floor`. Unrecognised severities are never "at least". */
export function isAtLeastSeverity(value: unknown, floor: FindingSeverity): boolean {
  const rank = severityRank(value);
  const floorRank = severityRank(floor);
  if (rank === null || floorRank === null) return false;
  return rank >= floorRank;
}

export class InvalidFindingError extends Error {
  constructor(index: number, reason: string) {
    super(`findings[${index}]: ${reason}`);
    this.name = "InvalidFindingError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and narrows an untrusted value into the findings list, or throws.
 *
 * Refuses rather than repairs, and refuses per entry with the offending
 * index named. A findings list is written once and read for the lifetime of
 * the record; a coercing parser that dropped the two malformed entries out of
 * fifty would produce a list that looks complete and is not, and no later
 * reader could tell.
 */
export function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) {
    throw new InvalidFindingError(0, "findings must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidFindingError(index, "must be an object");
    }
    const text = entry.text;
    if (typeof text !== "string" || text.trim() === "") {
      throw new InvalidFindingError(index, "text is required and must be a non-empty string");
    }
    const severity = entry.severity;
    if (severity !== undefined && !isFindingSeverity(severity)) {
      throw new InvalidFindingError(
        index,
        `severity ${JSON.stringify(severity)} is not one of ${FINDING_SEVERITIES.join(", ")}`,
      );
    }
    const where = entry.where;
    if (where !== undefined && typeof where !== "string") {
      throw new InvalidFindingError(index, "where must be a string when present");
    }
    const finding: Finding = {
      text,
      ...(severity === undefined ? {} : { severity }),
      ...(where === undefined ? {} : { where }),
    };
    return finding;
  });
}
