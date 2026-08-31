// `loop_list` and `loop_get` — the read half of open loops.
//
// ── The asymmetry these close ───────────────────────────────────────────
//
// Loops could be *written* one at a time (`loop_add`, `loop_close`) and only
// ever *read* all at once, as a side effect of a whole-context read. There
// was no filter, no page and no single-loop selector on any read:
// `orientation` takes `itemId`/`since`/`limit` (and that `limit` bounds
// checkpoints, not loops); `get_item_detail` takes `id`/`historyLimit`.
// Measured on a 40-loop item, `orientation` returned 321,056 characters and
// `get_item_detail` 742,960 — both over the response ceiling — while turning
// `historyLimit` down far enough to pass the guard returned a response with
// no loops in it at all. So on precisely the long-lived item whose loops
// matter most, there was no setting of any parameter that returned them.
//
// It also cost something concrete. `loop_add` takes a caller-supplied
// `loopId` that cannot be reused once taken, even after the loop is closed
// — so with no way to list the ids already in use, a caller on a large item
// mints blind. A session did exactly that, minted a duplicate loop, and
// re-derived a finding an existing loop already recorded.
//
// ── Why these are projections, not a new table ──────────────────────────
//
// A loop is a pair of events correlated by `payload.loopId` (SCHEMA.md §3a),
// folded by `deriveLoops` in `src/lib/open-loops.ts`. Nothing here changes
// that: both operations read the same slice of `Event` the write path
// already reads and fold it with the same function `orientation` calls. No
// schema change, no second source of truth, and no possibility of this read
// disagreeing with that one about whether a loop is open.
//
// ── Why the page is applied after the fold ──────────────────────────────
//
// `LIMIT` in SQL cannot page this. The rows are *events*, and one loop is
// made of between one and several of them, so a SQL page of N rows is not a
// page of N loops — it would cut a loop's close away from its open and
// report a closed loop as open, which is the one error the fold's whole
// order-independent construction exists to prevent. The fold therefore needs
// the item's complete loop-event slice to be correct, and the page is taken
// from its output. That is bounded in practice by loops-per-item (tens),
// not by ledger size (unbounded), and it is only the loop event types, which
// no other traffic writes.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  countsAsWork,
  deriveLoops,
  type DerivedLoop,
  type LoopKind,
  type LoopStatus,
} from "@/lib/open-loops";
import { loopEventsFor, requireItemExists } from "./loop-shared";
import { resolveItemId } from "../items/resolve-id";

/**
 * How much of a loop's text the slim shape carries.
 *
 * A loop's text is prose a session wrote to remind itself of something, and
 * it can run to paragraphs. The list read exists so a caller can *find* the
 * loop it wants — recognise it and take its `loopId` — which the opening
 * words do; carrying the whole text would rebuild the payload problem this
 * operation was added to solve. `loop_get` returns one in full.
 */
export const LOOP_TEXT_PREVIEW_CHARS = 200;

/**
 * The default and maximum page.
 *
 * `MAX_LOOP_LIMIT` matches the ceiling every other paginated read here uses,
 * so a caller who wants a big page gets the same number everywhere. The
 * default is the same 50 `list_items` uses — a slim loop is a comparable
 * size to a slim item, and an item with more than fifty *open* loops is
 * already telling the reader something.
 */
export const DEFAULT_LOOP_LIMIT = 50;
export const MAX_LOOP_LIMIT = 200;

/** Cuts `text` to the preview length, marking it when it was cut. */
export function previewText(text: string): { preview: string; truncated: boolean } {
  if (text.length <= LOOP_TEXT_PREVIEW_CHARS) return { preview: text, truncated: false };
  // Reported rather than left to be inferred from the length: a partial
  // result a caller cannot identify as partial is worse than none — the same
  // rule the response-size guard and `orientation`'s truncation flags apply.
  return { preview: text.slice(0, LOOP_TEXT_PREVIEW_CHARS), truncated: true };
}

/** One loop as the list read reports it — enough to recognise it and to act on it. */
export interface LoopSummary {
  readonly loopId: string;
  /** What this loop is tracking. `work` for every loop written before the field existed. */
  readonly kind: LoopKind;
  readonly status: LoopStatus;
  readonly openedAt: string;
  readonly editedAt: string | null;
  readonly closedAt: string | null;
  /** The first ~200 characters of the current text. `textTruncated` says when there is more. */
  readonly text: string;
  readonly textTruncated: boolean;
}

export interface LoopListOutput {
  readonly loops: readonly LoopSummary[];
  /** The `loopId` of the last row in this page, to pass back as `cursor`. Absent when this page is the last. */
  readonly nextCursor: string | null;
  /** How many loops matched the filter in total, before the page was cut. */
  readonly total: number;
  /**
   * How many non-work loops (`kind: note`) were held back by the default.
   * Zero when `includeNonWork` was set, or when the item has none.
   */
  readonly nonWorkExcluded: number;
}

const listInput = z
  .object({
    itemId: z.string().min(1),
    /**
     * Include loops that have been closed. Off by default.
     *
     * **Spelled `includeClosed` rather than `includeTerminal`**, which is
     * `list_items`' word for the same idea. The convention being followed is
     * "finished work is excluded by default, and an `include…` flag asks for
     * it back"; the noun differs because the vocabulary differs. `terminal`
     * names a set of four item *states* (`merged`, `research_done`,
     * `wont_do`, `cancelled`) and a loop has none of them — it is closed or
     * it is not. Reusing the word would imply a shared vocabulary that does
     * not exist, and `search` sets the precedent for varying the name when
     * the meaning varies: it deliberately spells its own version `openOnly`
     * "so that no caller reads the same field name here and on `list_items`
     * and assumes the same behaviour".
     *
     * This is also a real bound and not only a nicety. On the 40-loop item
     * that prompted this work, most loops are closed, so excluding them by
     * default cuts the response substantially before pagination does
     * anything at all.
     */
    includeClosed: z.boolean().default(false),
    /**
     * Include loops that were deleted. Off by default, and **not implied by
     * `includeClosed`** — deletion is a different claim from closure (see
     * `deriveLoops`), so a caller asking to see resolved loose ends is not
     * thereby asking to see rows somebody said should never have existed.
     * Present at all because the events are never destroyed and an audit
     * needs a way to reach them without reading the raw ledger.
     */
    includeDeleted: z.boolean().default(false),
    /**
     * Include loops that are not tracking work — `kind: note`. Off by
     * default, which is the whole point of the kind existing.
     *
     * **This is the counting fix.** An open-loop count is what a person uses
     * to judge whether an item is nearly done, so a tracker padded with
     * references, indexes and status markers misreports progress — quietly,
     * and in the optimistic direction only for the people reading counts.
     * Excluding notes by default makes the default answer mean "work
     * outstanding" again, and `total` counts the same set that is listed.
     *
     * **`blocked_on_person` is NOT excluded by this flag**, deliberately.
     * A loop waiting on a human is the most pending thing an item can carry;
     * hiding it would misreport in the opposite direction. Only `note` is
     * not-work — see `countsAsWork`.
     *
     * Named for what it admits rather than `includeNotes` because the set it
     * governs is "everything that does not count as work", which is a rule
     * (`countsAsWork`) rather than a list of labels — a caller that opts in
     * keeps getting everything if a further non-work kind is ever added.
     */
    includeNonWork: z.boolean().default(false),
    /**
     * `z.coerce.number()` rather than `z.number()`, so the string a command
     * line necessarily produces converts in the one place every adapter
     * shares — the reasoning `commands-artifacts.ts` records for `round`.
     * (`list_items.limit` is a plain `z.number()` and so cannot be set from
     * the CLI at all; that is a pre-existing gap, noted rather than changed
     * here, since altering an established schema is not this row's work.)
     */
    limit: z.coerce.number().int().min(1).max(MAX_LOOP_LIMIT).default(DEFAULT_LOOP_LIMIT),
    /** A `loopId` from a previous page's `nextCursor`. Rows after it, in the same order, are returned. */
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type LoopListInput = z.infer<typeof listInput>;

function toSummary(loop: DerivedLoop): LoopSummary {
  const { preview, truncated } = previewText(loop.text);
  return {
    loopId: loop.loopId,
    kind: loop.kind,
    status: loop.status,
    openedAt: loop.openedAt,
    editedAt: loop.editedAt,
    closedAt: loop.closedAt,
    text: preview,
    textTruncated: truncated,
  };
}

/** The loops of an item, filtered by the caller's status opt-ins. Order is oldest-open first. */
export function selectLoops(
  loops: readonly DerivedLoop[],
  options: { includeClosed: boolean; includeDeleted: boolean; includeNonWork?: boolean },
): DerivedLoop[] {
  return loops.filter((loop) => {
    if (loop.status === "deleted") return options.includeDeleted;
    if (loop.status === "closed") return options.includeClosed;
    // Applied after the status rules, so a note that has been closed or
    // deleted is governed by the flag the caller actually reached for.
    if (!countsAsWork(loop.kind) && options.includeNonWork !== true) return false;
    return true;
  });
}

/**
 * How many of `loops` the non-work rule would hold back, among those the
 * status filters would otherwise have returned.
 *
 * Reported rather than silently dropped. A count that shrank with no
 * explanation is the same failure as a truncated response a caller cannot
 * identify as truncated — the reader has no way to tell "this item has three
 * loose ends" from "this item has three loose ends and two notes you are not
 * being shown". Naming the number is what keeps the default honest in both
 * directions.
 */
export function countNonWorkExcluded(
  loops: readonly DerivedLoop[],
  options: { includeClosed: boolean; includeDeleted: boolean },
): number {
  return selectLoops(loops, { ...options, includeNonWork: true }).filter(
    (loop) => !countsAsWork(loop.kind),
  ).length;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const loopList = defineOperation({
  name: "loop_list",
  kind: "read",
  summary:
    "Lists an item's loops without reading its whole context — loopId, kind, status, when it opened and the first 200 characters of its text. Open loops that are tracking work only by default; pass includeClosed for resolved ones and includeNonWork for notes. `total` counts the same set that is listed, and nonWorkExcluded says how many notes were held back. Read one in full with loop_get.",
  // Stryker restore all
  input: listInput,
  async handler(ctx: ServiceContext, input: LoopListInput): Promise<LoopListOutput> {
    // A full UUID passes straight through untouched; a short id becomes
    // the one item it identifies, or refuses when it names more than
    // one. Rebinding `input` rather than threading a separate variable
    // is what makes this safe: every read of the id below this line —
    // including the ones inside the guards and the event rows — sees the
    // canonical id, so a short id cannot survive into a stored value.
    input = {
      ...input,
      itemId: await resolveItemId(ctx.db, input.itemId, "itemId"),
    };

    // The item is checked before its loops are read, so "no such item" and
    // "that item has no loops" are different answers. They are the two most
    // confusable outcomes of this call — an empty list for a mistyped id
    // reads as "there are none", which is exactly the false negative that
    // made a session mint a duplicate loop in the first place.
    await requireItemExists(ctx, input.itemId, "itemId");

    const all = deriveLoops(await loopEventsFor(ctx, input.itemId));
    const selected = selectLoops(all, input);

    // Paged on `loopId` after the fold — see the module header for why a SQL
    // `LIMIT` cannot do this. The cursor names the last row returned, and
    // the next page starts after it; an unrecognised cursor yields an empty
    // page rather than silently restarting from the beginning, because
    // re-serving page one to a caller that asked for page two is a loop
    // that never terminates.
    let start = 0;
    if (input.cursor !== undefined) {
      const at = selected.findIndex((loop) => loop.loopId === input.cursor);
      start = at === -1 ? selected.length : at + 1;
    }
    const page = selected.slice(start, start + input.limit);
    const hasMore = start + page.length < selected.length;

    return {
      loops: page.map(toSummary),
      nextCursor: hasMore ? (page[page.length - 1]?.loopId ?? null) : null,
      total: selected.length,
      nonWorkExcluded: input.includeNonWork ? 0 : countNonWorkExcluded(all, input),
    };
  },
});

/** One loop in full — the whole text, and every timestamp its lifecycle produced. */
export interface LoopGetOutput {
  readonly loopId: string;
  readonly itemId: string;
  readonly status: LoopStatus;
  /** What this loop is tracking. `work` for every loop written before the field existed. */
  readonly kind: LoopKind;
  /** The current text in full — the newest edit's, or the opening event's where never edited. */
  readonly text: string;
  readonly openedAt: string;
  readonly editedAt: string | null;
  readonly closedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedReason: string | null;
  /** The event id of the `open_loop`, stringified for the JSON boundary. */
  readonly eventId: string;
}

const getInput = z
  .object({
    itemId: z.string().min(1),
    loopId: z.string().trim().min(1),
  })
  .strict();

export type LoopGetInput = z.infer<typeof getInput>;

// Stryker disable all : see the note on `loopList` above.
export const loopGet = defineOperation({
  name: "loop_get",
  kind: "read",
  summary: "Reads one loop on an item in full, by its loopId — the whole text and its lifecycle.",
  // Stryker restore all
  input: getInput,
  async handler(ctx: ServiceContext, input: LoopGetInput): Promise<LoopGetOutput> {
    // A full UUID passes straight through untouched; a short id becomes
    // the one item it identifies, or refuses when it names more than
    // one. Rebinding `input` rather than threading a separate variable
    // is what makes this safe: every read of the id below this line —
    // including the ones inside the guards and the event rows — sees the
    // canonical id, so a short id cannot survive into a stored value.
    input = {
      ...input,
      itemId: await resolveItemId(ctx.db, input.itemId, "itemId"),
    };

    await requireItemExists(ctx, input.itemId, "itemId");

    const loops = deriveLoops(await loopEventsFor(ctx, input.itemId));
    const loop = loops.find((candidate) => candidate.loopId === input.loopId);
    if (loop === undefined) {
      throw new NotFoundError(`No loop ${input.loopId} on item ${input.itemId}.`, {
        fields: ["loopId"],
      });
    }

    // A deleted loop resolves here rather than 404ing, and that is the same
    // choice `delete_item` makes for an archived item: no ordinary *list*
    // serves it, but a direct read by id still lands somewhere real, so a
    // reference held by a note, a checkpoint or a person's memory resolves
    // to "this existed and was retracted" instead of to a hole. The status
    // field says which it is.
    return {
      loopId: loop.loopId,
      itemId: input.itemId,
      status: loop.status,
      kind: loop.kind,
      text: loop.text,
      openedAt: loop.openedAt,
      editedAt: loop.editedAt,
      closedAt: loop.closedAt,
      deletedAt: loop.deletedAt,
      deletedReason: loop.deletedReason,
      eventId: loop.eventId,
    };
  },
});
