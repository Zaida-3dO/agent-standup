// A review's findings, and the severity vocabulary they are graded on —
// SCHEMA.md §6a, stored in `Artifact.findings`.
//
// **Definition and validation — not policy.** This module defines what a
// finding IS and refuses one that is malformed. It deliberately does not
// count, aggregate or threshold findings, and **nothing in the merge gate
// reads a severity**: the guards key on `Artifact.verdict` alone
// (`service/guards/merge.ts`), so no verdict-independent severity rule
// exists in this system and this is not the change that invents one. A
// MEDIUM finding does not mechanically block anything here; the reviewer's
// verdict is what carries that weight.
//
// **Findings ARE displayed**, which the earlier "storage only" wording got
// wrong. `src/lib/item-detail/findings-view.ts` parses them and
// `src/components/item-detail/FindingsList.tsx` renders them grouped by
// severity, ordering the groups by `FINDING_SEVERITIES` itself. Note that
// `severityRank` and `isAtLeastSeverity` are a separate matter: they have
// **no callers at all** outside this module's own tests, because nothing
// asks the "at least this severe" question they answer. Aggregate
// reporting (`Run.blockingFindings`,
// which has no writer at all, plus review-round and rework analysis) is
// still later work; what it needs from here is that the severity was
// recorded at the time, honestly and in one vocabulary, because that is the
// part that cannot be reconstructed afterwards.
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

/** The element shape, stated once, for every message that has to name it. */
export const FINDING_SHAPE_DESCRIPTION =
  `an array of objects, each {text: string (required, non-empty), ` +
  `severity?: ${FINDING_SEVERITIES.join("|")}, where?: string} — ` +
  `for example [{"text": "N+1 query in the board loader", "severity": "medium", "where": "src/lib/board.ts:88"}]`;

/**
 * A findings list that could not be stored, naming what was wrong.
 *
 * `index` is the offending entry, or `null` when the fault is with the list
 * as a whole rather than any entry in it, and the distinction is the whole
 * reason the parameter is nullable.
 *
 * **An index must never be fabricated for a whole-list fault.** Rendering
 * one — `findings[0]: findings must be an array` — states something the
 * validator did not do: indexing into element 0 implies the value WAS an
 * array and that its first element was the problem. A caller who believes
 * the message goes looking for a nesting level nothing ever wanted, and the
 * field's real shape appears nowhere in the text to correct them. So a
 * whole-list fault is prefixed `findings:` with no index at all.
 *
 * The companion rule: a message that rejects a shape names the shape that
 * WOULD be accepted. A validator that only says "no" makes the caller guess,
 * and `findings` is a nested structure with several plausible spellings.
 */
export class InvalidFindingError extends Error {
  /** The entry at fault, or `null` when the whole value is. */
  readonly index: number | null;

  constructor(index: number | null, reason: string) {
    super(index === null ? `findings: ${reason}` : `findings[${index}]: ${reason}`);
    this.name = "InvalidFindingError";
    this.index = index;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What arrived, in one phrase, for a message that has to say so.
 *
 * A JSON string gets its own wording because it is the most likely
 * near-miss: a caller who serialised a correct array before sending it is
 * one `JSON.parse` from being right, and "a JSON-encoded string" tells them
 * that where "a string" does not.
 */
export function describeReceived(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      return "a JSON-encoded string (send the array itself, not a string containing it)";
    }
    return "a string";
  }
  const kind = typeof value;
  return `${kind === "object" ? "an" : "a"} ${kind}`;
}

/**
 * The whole-list refusal, as one sentence, for every door that has to say it.
 *
 * **Two doors refuse this field and they must not disagree.** `parseFindings`
 * below owns the verdict for the import path, but a call arriving over MCP or
 * HTTP is shape-checked by Zod in `ServiceRuntime` *before* the handler body
 * runs — so a caller who sends a JSON-encoded string never reaches
 * `parseFindings` at all and used to get Zod's generic "Expected array,
 * received string" instead of the wording written for exactly that near-miss.
 * The message a caller reads should not depend on which door they knocked on,
 * so the schema node borrows this function rather than restating it.
 *
 * The JSON-string branch is the one that earns this. A caller who serialised
 * a correct array is one `JSON.parse` from success, and telling them so is
 * the difference between a fixed call and a filed bug — this field has
 * already cost one of the latter.
 */
export function findingsShapeRefusal(value: unknown): string {
  return `must be ${FINDING_SHAPE_DESCRIPTION}. Received ${describeReceived(value)}`;
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
    // `null` index, and the expected shape named outright. This is the
    // message a caller guessing at the field actually hits — including the
    // one who sent a JSON *string* of a correct array, a near-miss worth
    // naming precisely because it is one `JSON.parse` from being right.
    throw new InvalidFindingError(null, findingsShapeRefusal(value));
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidFindingError(
        index,
        `must be an object {text, severity?, where?}, not ${describeReceived(entry)}. ` +
          `The list as a whole is ${FINDING_SHAPE_DESCRIPTION}`,
      );
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
