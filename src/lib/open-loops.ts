// Open loops — SCHEMA.md §3a. The loose ends a session is carrying that are
// not themselves work items: "the retry path is untested", "we never checked
// what happens on a cold boot".
//
// **A loop is a pair of events, not an item and not a table.** It has no
// state machine, no assignee, no review and no merge — the four things that
// make something an item here — so modelling it as one would put every loop
// on the board and into every count that ranges over items. It has exactly
// two moments (it opened; it closed) and a line of text, which is the shape
// `events` already is.
//
// This also fixes a real hole rather than adding a nicety: the only existing
// source of open loops is `Summary.notDone`, and `Summary` is one-to-one with
// an item and written only at completion. Before this, an item still
// `executing` could not carry an open loop at all — the state in which it is
// most likely to have one.
//
// The fold below is pure. It is the part that decides whether a loop is open,
// so it is testable without a database, and orientation calls it rather than
// asking Postgres to express the pairing in SQL.

// `OPEN_LOOP_EVENT_TYPES` (just `open_loop` + `open_loop_closed`) was removed
// once the lifecycle gained edit and delete: it named two of the four event
// types a loop is made of, and sat one autocomplete away from
// `LOOP_EVENT_TYPES` below, which names all four. Every query that reaches
// for a loop's events wants all four — narrowing to the opening pair silently
// drops edits and deletions from the fold, which is the exact bug the
// lifecycle work had to fix twice. `LOOP_EVENT_TYPES` is the only such list.

/**
 * One open loop, as `orientation` reports it.
 *
 * `loopId` is the correlation key the two events share — supplied by whoever
 * opens the loop, not derived from the text. Deriving it from the text would
 * make "close the loop" depend on quoting the loop's wording back exactly,
 * and would silently merge two genuinely different loops that happened to be
 * phrased identically.
 */
export interface OpenLoop {
  readonly loopId: string;
  readonly text: string;
  /** ISO timestamp of the `open_loop` event. */
  readonly openedAt: string;
  /** The event id of the `open_loop`, stringified — `bigint` cannot cross a JSON boundary. */
  readonly eventId: string;
}

/** The subset of an event row this fold reads. Deliberately structural, so any row shape fits. */
export interface LoopEventLike {
  readonly id: bigint | number | string;
  readonly ts: Date | string;
  readonly type: string;
  readonly payload: unknown;
}

export class InvalidOpenLoopPayloadError extends Error {
  constructor(reason: string) {
    super(`open-loop payload: ${reason}`);
    this.name = "InvalidOpenLoopPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the payload of an `open_loop` event: `{ loopId, text }`, both
 * non-empty strings. Throws rather than returning a default — a loop whose
 * id is missing can never be closed, so accepting one would write a
 * permanently-open loop into the ledger.
 */
export function parseOpenLoopPayload(payload: unknown): { loopId: string; text: string } {
  if (!isRecord(payload)) {
    throw new InvalidOpenLoopPayloadError("must be an object");
  }
  const loopId = payload.loopId;
  const text = payload.text;
  if (typeof loopId !== "string" || loopId.trim() === "") {
    throw new InvalidOpenLoopPayloadError("loopId is required and must be a non-empty string");
  }
  if (typeof text !== "string" || text.trim() === "") {
    throw new InvalidOpenLoopPayloadError("text is required and must be a non-empty string");
  }
  return { loopId, text };
}

/**
 * Validates the payload of an `open_loop_closed` event: `{ loopId }`. The
 * text is not repeated — the open event already carries it, and a second
 * copy is a second thing that can disagree.
 */
export function parseOpenLoopClosedPayload(payload: unknown): { loopId: string } {
  if (!isRecord(payload)) {
    throw new InvalidOpenLoopPayloadError("must be an object");
  }
  const loopId = payload.loopId;
  if (typeof loopId !== "string" || loopId.trim() === "") {
    throw new InvalidOpenLoopPayloadError("loopId is required and must be a non-empty string");
  }
  return { loopId };
}

function toIso(ts: Date | string): string {
  return ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString();
}

/**
 * Folds a stream of events into the loops that are still open: every
 * `open_loop` whose `loopId` has no `open_loop_closed`.
 *
 * Order-independent by construction — the closes are collected first, then
 * the opens are filtered against them — so a ledger read that returns a close
 * before its open (possible: `events.id` is allocated before commit, so
 * sequence order is not commit order, SCHEMA.md §3) still resolves the loop
 * as closed. A single-pass fold that only cancelled a loop it had already
 * seen opened would report a closed loop as open in exactly that case.
 *
 * A close naming a `loopId` that was never opened is ignored rather than
 * raised: this reads a slice of the ledger, and the open may simply be older
 * than the slice. Reporting a loop the caller cannot see as an error would
 * make "catch me up" fail on a perfectly ordinary window.
 *
 * Malformed payloads are skipped, not thrown on — deliberately the opposite
 * posture from the two parsers above. Those guard the WRITE path, where a
 * refusal costs one caller a clear error. This is the READ path: it is what a
 * session calls to orient itself, and one bad row written by anything at any
 * point in history would otherwise make orientation permanently unusable for
 * that item.
 *
 * **A deleted loop is not open, and an edited loop reports its current
 * wording.** Both follow from this being expressed in terms of `deriveLoops`
 * (below) rather than folding the stream a second time here. That matters
 * more than the duplication it saves: this function is what `orientation`,
 * `progress_report`, `loop_close` and the item-detail view all call, so a
 * loop deleted through `loop_delete` has to disappear from every one of them
 * or "delete" would only mean "hidden from the list read". Two independent
 * folds over the same events is precisely how the two would come to disagree
 * about what a loop is.
 */
export function deriveOpenLoops(events: readonly LoopEventLike[]): OpenLoop[] {
  return deriveLoops(events)
    .filter((loop) => loop.status === "open")
    .map((loop) => ({
      loopId: loop.loopId,
      text: loop.text,
      openedAt: loop.openedAt,
      eventId: loop.eventId,
    }));
}

// ── The full lifecycle: edit and delete ─────────────────────────────────
//
// A loop is a pair of events in an append-only ledger, so correcting one
// cannot mean mutating or removing a row. It means appending a further event
// the fold understands — the posture `delete_item` already takes ("it is
// called delete and it never deletes"): the caller states an intent, the
// store records it as a fact, and the read path stops serving what the
// intent retracted. Nothing is destroyed, so every attribution, every
// `assignmentId` and every history read still resolves.
//
// **Why `deleted` is not simply another kind of `closed`.** They answer
// different questions and a reader has to tell them apart. A closed loop was
// a real loose end that got resolved: it belongs in the record, and
// `includeClosed` shows it. A deleted loop should never have existed — a
// duplicate, or a mistake — and listing it as closed would make the record
// narrate a resolution nobody reached. That is the distinction `delete_item`
// draws between `cancelled` (a decision someone made) and archived (a row
// that should not exist), one level down.
//
// **An edit keeps `openedAt`, deliberately.** `openedAt` means "when this
// became an open question", which is what a resuming session is asking;
// refining the wording does not restart the question. So an edit supplies
// the text the loop now carries and records `editedAt` beside it, leaving
// the original moment intact.

/** Every event type a loop's lifecycle is made of. Mirrors `EventType` in schema.prisma. */
export const LOOP_EVENT_TYPES = [
  "open_loop",
  "open_loop_closed",
  "open_loop_edited",
  "open_loop_deleted",
] as const;

/** Where a loop stands. A `deleted` loop is withheld from every ordinary read. */
export type LoopStatus = "open" | "closed" | "deleted";

/**
 * One loop with its whole lifecycle resolved — the shape `loop_list` and
 * `loop_get` report. A superset of `OpenLoop`.
 */
export interface DerivedLoop {
  readonly loopId: string;
  /** The current text: the newest edit's, or the opening event's where never edited. */
  readonly text: string;
  readonly status: LoopStatus;
  /** ISO timestamp of the `open_loop` event — never moved by an edit. */
  readonly openedAt: string;
  /** ISO timestamp of the newest `open_loop_edited`, or null when never edited. */
  readonly editedAt: string | null;
  /** ISO timestamp of the `open_loop_closed`, or null while open. */
  readonly closedAt: string | null;
  /** ISO timestamp of the `open_loop_deleted`, or null when not deleted. */
  readonly deletedAt: string | null;
  /** Why it was deleted, where the deleting event recorded one. */
  readonly deletedReason: string | null;
  /** The event id of the `open_loop`, stringified — `bigint` cannot cross a JSON boundary. */
  readonly eventId: string;
}

/**
 * Validates the payload of an `open_loop_edited` event: `{ loopId, text }`.
 *
 * The same shape as the opening payload and validated just as strictly, for
 * the same reason: an edit whose id is missing can never be matched to the
 * loop it corrects, so accepting one would write a row that silently does
 * nothing at all.
 */
export function parseOpenLoopEditedPayload(payload: unknown): { loopId: string; text: string } {
  return parseOpenLoopPayload(payload);
}

/**
 * Validates the payload of an `open_loop_deleted` event: `{ loopId }`, with
 * an optional `reason`.
 *
 * The reason is optional *here* and required by the `loop_delete` operation.
 * This parser's job is to read rows that already exist, including any
 * written before a rule tightened; refusing a historical row over a field
 * the write path guards would make the fold fail on data it is only trying
 * to describe. Same split in posture the existing parsers make between
 * guarding the write and tolerating the read.
 */
export function parseOpenLoopDeletedPayload(payload: unknown): {
  loopId: string;
  reason: string | null;
} {
  if (!isRecord(payload)) {
    throw new InvalidOpenLoopPayloadError("must be an object");
  }
  const loopId = payload.loopId;
  if (typeof loopId !== "string" || loopId.trim() === "") {
    throw new InvalidOpenLoopPayloadError("loopId is required and must be a non-empty string");
  }
  const reason = payload.reason;
  return { loopId, reason: typeof reason === "string" && reason.trim() !== "" ? reason : null };
}

/** Reads a well-formed `loopId` out of an event payload, or null when there is not one. */
function loopIdOf(event: LoopEventLike): string | null {
  if (!isRecord(event.payload)) return null;
  const loopId = event.payload.loopId;
  return typeof loopId === "string" && loopId.trim() !== "" ? loopId : null;
}

/**
 * Folds a stream of events into every loop it describes, whatever state each
 * one reached — open, closed or deleted.
 *
 * **Order-independent by the construction `deriveOpenLoops` already uses**,
 * and for its reason: `Event.id` is allocated before commit, so sequence
 * order is not commit order (SCHEMA.md §3) and a close, an edit or a delete
 * genuinely can be read before the open it refers to. Each terminal fact is
 * collected into a map keyed by `loopId` in a first pass, and the opens are
 * resolved against those maps in a second. A single-pass fold would report
 * the wrong status in exactly the case the ledger permits.
 *
 * **Edits resolve to the newest by event id**, not to the last one
 * encountered, so two edits read out of order still leave the later wording
 * in place. `Event.id` is the only total order available here; `ts` cannot
 * serve, because two events written by one call share the one transaction
 * and therefore the timestamp.
 *
 * Malformed payloads are skipped rather than thrown on, matching
 * `deriveOpenLoops`: this is the read path, and one bad row written at any
 * point in history would otherwise make an item's loops permanently
 * unreadable.
 */
export function deriveLoops(events: readonly LoopEventLike[]): DerivedLoop[] {
  const closedAt = new Map<string, string>();
  const deleted = new Map<string, { ts: string; reason: string | null }>();
  /** loopId -> the newest edit seen, by event id. */
  const edits = new Map<string, { id: bigint; text: string; ts: string }>();

  for (const event of events) {
    const loopId = loopIdOf(event);
    if (loopId === null) continue;
    if (event.type === "open_loop_closed") {
      // First close wins: a loop closed twice closed when it first closed.
      if (!closedAt.has(loopId)) closedAt.set(loopId, toIso(event.ts));
    } else if (event.type === "open_loop_deleted") {
      if (!deleted.has(loopId)) {
        const payload = event.payload as Record<string, unknown>;
        const reason = payload.reason;
        deleted.set(loopId, {
          ts: toIso(event.ts),
          reason: typeof reason === "string" && reason.trim() !== "" ? reason : null,
        });
      }
    } else if (event.type === "open_loop_edited") {
      const payload = event.payload as Record<string, unknown>;
      const text = payload.text;
      if (typeof text !== "string" || text.trim() === "") continue;
      const id = BigInt(event.id);
      const previous = edits.get(loopId);
      if (previous === undefined || id > previous.id) {
        edits.set(loopId, { id, text, ts: toIso(event.ts) });
      }
    }
  }

  const loops: DerivedLoop[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== "open_loop") continue;
    if (!isRecord(event.payload)) continue;
    const loopId = loopIdOf(event);
    if (loopId === null) continue;
    const text = event.payload.text;
    if (typeof text !== "string" || text.trim() === "") continue;
    // The same loop opened twice is one loop, keeping the first — the rule
    // `deriveOpenLoops` already applies, restated so the two folds cannot
    // disagree about what a repeated open means.
    if (seen.has(loopId)) continue;
    seen.add(loopId);

    const gone = deleted.get(loopId) ?? null;
    const closed = closedAt.get(loopId) ?? null;
    const edit = edits.get(loopId);
    // Deletion outranks closure. A loop that should never have existed is
    // not also "resolved", and reporting it closed would put a resolution in
    // the record that nobody reached.
    const status: LoopStatus = gone !== null ? "deleted" : closed !== null ? "closed" : "open";

    loops.push({
      loopId,
      text: edit?.text ?? text,
      status,
      openedAt: toIso(event.ts),
      editedAt: edit?.ts ?? null,
      closedAt: closed,
      deletedAt: gone?.ts ?? null,
      deletedReason: gone?.reason ?? null,
      eventId: String(event.id),
    });
  }
  return loops;
}
