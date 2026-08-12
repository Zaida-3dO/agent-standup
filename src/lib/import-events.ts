// Importer — events (MILESTONES.md #11, SCHEMA.md §3, DECISIONS.md §13c).
//
// Reads the `history` log `import-items.ts` (#10) already defined on
// `SourceTask` — one `SourceHistoryEntry` per thing the source recorded
// happening to a task — and lands it in `events`, one row per entry, via
// `appendEvent` (`events.ts`, #20). This module never writes to `events`
// directly with a raw query of its own; #20's helper is the only writer.
//
// **Collapsed-summary rule (DECISIONS.md §13c):** finished work is the bulk
// of the volume of an established backlog and the least useful part of it —
// importing full event streams for it mostly imports noise nobody will
// query. So a task whose *current* `items.state` is terminal (`merged`,
// `research_done`, `wont_do`, `cancelled`) gets its history collapsed into
// ONE `note` event instead of one row per entry; in-flight and blocked tasks
// import their full history, one row per entry. The import never writes to
// its source (same decision), so if the detail behind a collapsed summary
// turns out to be wanted later, it can be backfilled — nothing here deletes
// or mutates the source `history` array.
//
// The import never writes to its source — every function here only reads
// `SourceTask.history` and writes to `events`.
import type { PrismaClient } from "@prisma/client";
import type { TransactionHandle } from "./service/context";
import { appendEvent, type EventActor } from "./events";
import type { SourceHistoryEntry, SourceTask } from "./import-items";

export type { SourceHistoryEntry } from "./import-items";

/** `items.state` values that collapse history to one summary row (DECISIONS.md §13c). */
const TERMINAL_STATES = new Set(["merged", "research_done", "wont_do", "cancelled"]);

export class UnknownActorAliasError extends Error {
  constructor(alias: string, taskId: string, historyEntryId: string) {
    super(
      `source actor ${JSON.stringify(alias)} on task ${JSON.stringify(taskId)}, history entry ` +
        `${JSON.stringify(historyEntryId)} has no entry in actorAliases — an unmapped actor is a ` +
        "mapping gap to fix, not license to guess who it was (import-events.ts)",
    );
    this.name = "UnknownActorAliasError";
  }
}

/**
 * Maps a source actor label (as read from `SourceHistoryEntry.actor`,
 * verbatim) onto the `EventActor` an `events` row is attributed to.
 *
 * **Exact-string match only, deliberately** — the same "values that must be
 * exact are a data problem, not a type problem" reasoning `repoAliases`
 * follows (DECISIONS.md §13g), applied to actors instead of repositories.
 * There is no case-folding, trimming or fuzzy matching here: a source
 * spelling not present as a key is refused (`UnknownActorAliasError`), never
 * guessed at, because guessing wrong attributes a real person's or agent's
 * history entry to the wrong row silently. **This is narrower than it
 * sounds** — `"User A"`, `"user-a "` and `"USER-A"` are each a DIFFERENT key
 * from `"user-a"` under this map, so a source store that varies casing or
 * whitespace across entries (the same entity, spelled inconsistently) needs
 * every spelling listed, not just the canonical one. That is the accepted
 * limit, matching `repoAliases`' own posture: the map is a translation
 * table the caller controls, not a normalisation function this module
 * invents on its behalf.
 */
export interface ActorAliasTarget {
  readonly actorType: "person" | "agent";
  readonly actorId: string;
}

export interface ImportEventsOptions {
  /**
   * Maps a source actor label to the `people`/`agents` row it resolves to.
   * A source actor label with no entry here is refused
   * (`UnknownActorAliasError`) rather than imported as free text or used to
   * mint a new `Person`/`Agent` row — neither table is auto-created by an
   * importer (people.ts has no such path; agents are a fixed name roster,
   * SCHEMA.md §9).
   */
  readonly actorAliases: Record<string, ActorAliasTarget>;
}

export interface ImportEventsResult {
  imported: number;
  skippedExisting: number;
}

function resolveActor(
  alias: string,
  taskId: string,
  historyEntryId: string,
  actorAliases: Record<string, ActorAliasTarget>,
): EventActor {
  const resolved = actorAliases[alias];
  if (!resolved) {
    throw new UnknownActorAliasError(alias, taskId, historyEntryId);
  }
  return { actorType: resolved.actorType, actorId: resolved.actorId };
}

/**
 * A history entry already imported for `itemId`, keyed by the source's own
 * history-entry id. `events.payload` is a discriminated union typed per
 * `type` (SCHEMA.md §3) — there is no free-text `custom_fields` bag on this
 * table the way `items` has one, so idempotency cannot key off a field the
 * way `import-items.ts` keys off `custom_fields.legacy_id`. Instead every
 * row this importer writes carries the source history-entry id as
 * `payload.legacy_id` — legal because `note`'s documented payload shape is
 * "none, prose is in `body`", so this module owns the whole of `note`'s
 * payload object and can add a field to it without colliding with any other
 * writer's expectations of what a `note` payload contains.
 */
async function findExistingLegacyIds(db: TransactionHandle, itemId: string): Promise<Set<string>> {
  const rows = await db.$queryRawUnsafe<{ legacyId: string }[]>(
    `SELECT "payload"->>'legacy_id' AS "legacyId"
     FROM "Event"
     WHERE "itemId" = $1 AND "type" = 'note' AND "payload" ? 'legacy_id'`,
    itemId,
  );
  return new Set(rows.map((r) => r.legacyId).filter((id): id is string => id !== null));
}

/**
 * Imports one task's `history` log into `events`.
 *
 * `itemId` is the **generated** `items.id` this history belongs to (the id
 * `importItems` minted, per `custom_fields.legacy_id` — `import-items.ts`),
 * not the source task id; `currentState` is that item's current
 * `items.state`, used only to decide full-vs-collapsed per DECISIONS.md
 * §13c. Both are supplied by the caller rather than looked up here, so this
 * module never has to reach into `items` itself — it takes exactly the two
 * facts it needs and nothing more.
 *
 * **Idempotent, re-run-safe:** every row this function writes is looked up
 * first by `payload.legacy_id` (see `findExistingLegacyIds`), and a history
 * entry (or, for a terminal item, the single collapsed summary) already
 * present is skipped rather than re-inserted. Running the same import twice
 * against the same populated database therefore produces the same row
 * count both times.
 */
export async function importEventsForTask(
  db: TransactionHandle,
  args: {
    readonly itemId: string;
    readonly taskId: string;
    readonly currentState: string;
    readonly history: readonly SourceHistoryEntry[];
  },
  options: ImportEventsOptions,
): Promise<ImportEventsResult> {
  const { itemId, taskId, currentState, history } = args;

  if (history.length === 0) {
    return { imported: 0, skippedExisting: 0 };
  }

  const existing = await findExistingLegacyIds(db, itemId);

  if (TERMINAL_STATES.has(currentState)) {
    return importCollapsedSummary(db, { itemId, taskId, history, existing }, options);
  }

  return importFullHistory(db, { itemId, taskId, history, existing }, options);
}

/**
 * In-flight/blocked path: one `events` row per history entry, attributed to
 * the entry's own mapped actor. `entry.at` is preserved verbatim in
 * `payload.source_at` for anyone who needs the original moment, but does
 * NOT become the row's `ts` — see the "known limit" note on
 * `importCollapsedSummary`, which applies equally here: `appendEvent` (#20)
 * always stamps `ts` as `now()`, so every row this function writes is
 * timestamped at import time, not at the historical moment it describes.
 */
async function importFullHistory(
  db: TransactionHandle,
  args: {
    readonly itemId: string;
    readonly taskId: string;
    readonly history: readonly SourceHistoryEntry[];
    readonly existing: Set<string>;
  },
  options: ImportEventsOptions,
): Promise<ImportEventsResult> {
  const { itemId, taskId, history, existing } = args;
  let imported = 0;
  let skippedExisting = 0;

  for (const entry of history) {
    if (existing.has(entry.id)) {
      skippedExisting++;
      continue;
    }

    const actor = resolveActor(entry.actor, taskId, entry.id, options.actorAliases);

    await appendEvent(db, {
      itemId,
      actor,
      type: "note",
      payload: { legacy_id: entry.id, source_at: entry.at },
      body: entry.note,
    });
    imported++;
  }

  return { imported, skippedExisting };
}

/**
 * Terminal path (DECISIONS.md §13c): the whole history log collapses into
 * ONE `note` event rather than one row per entry. Attributed to the LAST
 * entry's mapped actor — the closing act on a finished task is the most
 * defensible single attribution when several actors touched it.
 *
 * **Known limit, stated plainly:** `ts` on the written row is `now()` (the
 * import moment), not the last entry's `at` — `appendEvent` (#20)
 * deliberately leaves `ts` to Postgres's own column default and takes no
 * override, for reasons that are exactly right for a live mutation and a
 * real gap for a historical import. The entry's original `at` is not lost —
 * it is preserved verbatim in `payload.source_at` — but a reader sorting
 * `events` by `ts` will see every collapsed summary clustered at import time
 * rather than spread across the task's real history. Untested and unfixed
 * here; a follow-up either extends `appendEvent` with an optional `ts`
 * override (touches #20's module, outside this row's territory) or accepts
 * the gap.
 *
 * Every entry still gets its actor resolved (not just the last one) —
 * collapsing the ROW COUNT must never mean skipping the refusal an unmapped
 * actor deserves partway through a task's history; a source-data problem
 * three entries back is exactly as real as one in the last entry.
 */
async function importCollapsedSummary(
  db: TransactionHandle,
  args: {
    readonly itemId: string;
    readonly taskId: string;
    readonly history: readonly SourceHistoryEntry[];
    readonly existing: Set<string>;
  },
  options: ImportEventsOptions,
): Promise<ImportEventsResult> {
  const { itemId, taskId, history, existing } = args;

  // The collapsed row is keyed on the FIRST entry's source id — stable
  // across re-runs regardless of how many entries the source history holds,
  // unlike a synthetic key derived from the array's length or last id.
  const summaryLegacyId = history[0]!.id;
  if (existing.has(summaryLegacyId)) {
    return { imported: 0, skippedExisting: 1 };
  }

  // Resolve every entry's actor before writing anything — an unmapped actor
  // anywhere in the history is a data problem to raise, not one to silently
  // drop because it happened to fall outside the entry this summary quotes.
  for (const entry of history) {
    resolveActor(entry.actor, taskId, entry.id, options.actorAliases);
  }

  const last = history[history.length - 1]!;
  const lastActor = resolveActor(last.actor, taskId, last.id, options.actorAliases);

  const body =
    history.length === 1
      ? last.note
      : `Imported history (${history.length} entries, collapsed on import — DECISIONS.md §13c). ` +
        `Last: ${last.note}`;

  await appendEvent(db, {
    itemId,
    actor: lastActor,
    type: "note",
    payload: { legacy_id: summaryLegacyId, source_at: last.at, entry_count: history.length },
    body,
  });

  return { imported: 1, skippedExisting: 0 };
}

/**
 * Imports the `history` log of every task in `tasks` into `events`.
 *
 * This is the top-level entry point a caller (a script, or a test) hands
 * `readSourceTasks`' output to directly — `SourceTask.history`, optional
 * on that type because not every source store keeps one — is read from
 * each task and the `items` row it landed on is found by the SAME
 * `custom_fields.legacy_id` lookup `import-items.ts` uses (this is why
 * `importItems`, #10, must already have run against the same database: a
 * task with no matching `items` row is skipped, not an error, because a
 * caller importing events without first importing items is a sequencing
 * mistake this function reports rather than crashes on).
 *
 * `client` needs both the Prisma model API (to look up `items` by
 * `legacy_id` and read its current `state`) and the raw-query surface
 * `appendEvent`/`findExistingLegacyIds` use — a `PrismaClient` satisfies
 * both structurally, the same split `import-items.ts`'s `importItems`
 * takes for the same reason: this runs as a script, outside the service
 * layer that would otherwise hand it a `TransactionHandle` already scoped
 * to one transaction.
 */
export interface ImportEventsSummary {
  readonly imported: number;
  readonly skippedExisting: number;
  /** Tasks in `tasks` with a `history` array whose `items` row could not be found (no matching `legacy_id`). */
  readonly tasksWithoutMatchingItem: string[];
}

export async function importEvents(
  client: Pick<PrismaClient, "item" | "$queryRawUnsafe" | "$executeRawUnsafe">,
  tasks: readonly SourceTask[],
  options: ImportEventsOptions,
): Promise<ImportEventsSummary> {
  let imported = 0;
  let skippedExisting = 0;
  const tasksWithoutMatchingItem: string[] = [];

  for (const task of tasks) {
    const history = task.history ?? [];
    if (history.length === 0) continue;

    const item = await client.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: task.id } },
      select: { id: true, state: true },
    });

    if (!item) {
      tasksWithoutMatchingItem.push(task.id);
      continue;
    }

    const result = await importEventsForTask(
      client,
      { itemId: item.id, taskId: task.id, currentState: item.state, history },
      options,
    );
    imported += result.imported;
    skippedExisting += result.skippedExisting;
  }

  return { imported, skippedExisting, tasksWithoutMatchingItem };
}
