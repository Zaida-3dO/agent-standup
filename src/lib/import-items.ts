// Importer — items (MILESTONES.md #10, SCHEMA.md §1, §23, DECISIONS.md
// §13c/§13g/§11 "Import, and going live").
//
// The source is a **directory-per-task file store**: one directory per task,
// each holding a single `task.json` describing it. This module defines the
// shape it reads (`SourceTask`) rather than assuming a particular prior
// system's layout — the importer's job is "take a directory of one JSON file
// per task and land it in `items`", and that shape is deliberately the
// smallest one a file-based backlog needs: an id, a title, a body, a status
// string in whatever vocabulary the source used, and the free-text repo/area
// labels the source happened to spell that work under.
//
// The import never writes to its source (DECISIONS.md §13c) — every
// function here only reads the directory tree and writes to `items`.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ItemState, MergeAuthority, OriginType, PrismaClient, Priority } from "@prisma/client";
import { ensureArea } from "./areas";

/** One task directory's `task.json`, exactly as the source store writes it. */
export interface SourceTask {
  /** The source's own identifier for this task — unique within the store. */
  id: string;
  title: string;
  body: string;
  /** Free-text status in the SOURCE vocabulary — see `STATUS_REMAP` for the mapping into `ItemState`. */
  status: string;
  /**
   * Free-text repository label as the source spelled it. Optional — not
   * every task in a generic backlog is a code change (SCHEMA.md §1, `area`
   * vs `repo`). Resolved through `repoAliases`, never auto-created
   * (repos.ts — deliberate-create only).
   */
  repo?: string;
  /** Free-text area label as the source spelled it. Always required on `items`; resolved via `ensureArea`. */
  area: string;
  /**
   * The task's history log, oldest first — optional because not every
   * source store keeps one, and its absence is not an error. Read and
   * imported by `import-events.ts` (MILESTONES.md #11), never by this
   * module: `readSourceTasks` here treats it as opaque passthrough so the
   * two importers agree on one `task.json` shape without either owning the
   * other's column. See `import-events.ts` for `SourceHistoryEntry`.
   */
  history?: SourceHistoryEntry[];
  /**
   * `items.priority`, when the source records one. Optional because a
   * backlog that has no notion of priority is a perfectly ordinary source;
   * omitted leaves the column's own default (`P2`) in place rather than
   * inventing a value.
   */
  priority?: Priority;
  /** `items.branch` — the deliverable's integration branch (SCHEMA.md §1). Omitted leaves it null. */
  branch?: string;
  /** `items.needs_visual_review` — the merge gate's visual flag (SCHEMA.md §1). Omitted leaves it false. */
  needsVisualReview?: boolean;
  /**
   * `items.source_ref` — `path@content_hash` (SCHEMA.md §1), the version of
   * the source file this item was read from. A **relative** path: an
   * absolute one would record the importing machine's directory layout in
   * every row.
   */
  sourceRef?: string;
  /**
   * `items.created_at` — when the source says the work was created, not
   * when it was imported. Optional; omitted leaves the column's own
   * `now()` default.
   *
   * Worth a slot rather than a note in the escape hatch, because a
   * timestamp is the field an imported backlog is most often READ by:
   * without it every row in a decade-old backlog is stamped within the same
   * second of the import and the ordering that made the history meaningful
   * is gone from the column that sorts it.
   */
  createdAt?: string;
  /** `items.updated_at`. Optional; omitted stamps the import moment. */
  updatedAt?: string;
  /**
   * `items.origin_type` — who or what created the work. Optional; omitted
   * defaults to `source`, which is what an import without an opinion is.
   * `person` additionally requires `originPersonId`, per SCHEMA.md §1.
   */
  originType?: OriginType;
  /** `items.origin_person` — required when `originType` is `person`, ignored otherwise. */
  originPersonId?: string;
  /**
   * `items.merge_authority`. Optional; omitted defaults to
   * `needs_approval`. A slot rather than a constant because an
   * installation that pre-authorises its merges would otherwise have every
   * imported row contradict its own standing policy on arrival.
   */
  mergeAuthority?: MergeAuthority;
  /**
   * Extra source fields to preserve verbatim in `items.custom_fields`
   * alongside `legacy_id` — the "arbitrary key/value bag, opaque to the
   * core" escape hatch SCHEMA.md §1 defines, whose stated purpose is exactly
   * this: keeping a source field that has no typed column of its own rather
   * than dropping it. `legacy_id` always wins over a same-named key here,
   * because idempotency keys on it (see `importItems`).
   *
   * SCHEMA.md's second rule on the bag applies to whatever a caller puts
   * here: **if a key recurs, promote it to a column.** This is for the
   * genuinely source-specific, not a parking space for fields that deserve
   * a schema.
   */
  customFields?: Record<string, unknown>;
}

/**
 * One entry in a task's history log, exactly as the source store writes it.
 * Declared here (not in `import-events.ts`) so `SourceTask` can reference it
 * without a circular import between the two importer modules — the events
 * importer re-exports this name for callers that only need the events side.
 */
export interface SourceHistoryEntry {
  /** The source's own identifier for this history entry — unique within the task. */
  id: string;
  /**
   * Free-text actor label as the source spelled it — a person's or agent's
   * handle in the SOURCE vocabulary. Never null in the source: an
   * unattributed entry is a data problem for `actorAliases` to refuse, not
   * a case this type models as optional (`import-events.ts`).
   */
  actor: string;
  /** ISO 8601 timestamp string, as the source wrote it. */
  at: string;
  /** Free-text one-line note — what happened, in the source's own words. */
  note: string;
}

/**
 * Maps a source status string onto the `items.state` vocabulary
 * (SCHEMA.md §1.1). The source store this importer reads used a **five-value**
 * status set that collapses several of `items`' eleven states — most
 * notably, the source has no separate "blocked" signal, so its one waiting
 * state remaps to `paused` (the closer of the two: nobody re-checks an
 * external actor for it, DECISIONS.md §2 "`blocked` is narrow"). A source
 * status this map doesn't recognise is a data problem to raise, not a
 * silent default — see `mapSourceStatus`.
 */
export const STATUS_REMAP: Record<string, ItemState> = {
  todo: "on_deck",
  "in-progress": "executing",
  review: "in_review",
  waiting: "paused",
  done: "merged",
};

export class UnknownSourceStatusError extends Error {
  constructor(status: string, taskId: string) {
    super(`unrecognised source status ${JSON.stringify(status)} on task ${JSON.stringify(taskId)}`);
    this.name = "UnknownSourceStatusError";
  }
}

/**
 * Resolves a source status onto an `items.state`.
 *
 * **A caller-supplied `statusAliases` wins over this application's own
 * table**, and that ordering is the whole design. Every source has its own
 * state machine; this application ships ITS states and nobody else's, and
 * the translation between the two belongs to whoever knows both — the
 * caller. That is exactly how `repoAliases` and `actorAliases` already
 * work, and there is no reason status should be the one vocabulary an
 * outside caller has to edit application source to extend.
 *
 * A status in neither map is refused. An unrecognised status is a mapping
 * gap to fix, not a default to fall back on: guessing files somebody's work
 * under a state they never chose, silently.
 */
export function mapSourceStatus(
  status: string,
  taskId: string,
  statusAliases: Record<string, ItemState> = {},
): ItemState {
  const mapped = statusAliases[status] ?? STATUS_REMAP[status];
  if (!mapped) {
    throw new UnknownSourceStatusError(status, taskId);
  }
  return mapped;
}

export class UnknownRepoAliasError extends Error {
  constructor(alias: string, taskId: string) {
    super(
      `source repo ${JSON.stringify(alias)} on task ${JSON.stringify(taskId)} has no entry in ` +
        "repoAliases — repos are deliberate-create only (repos.ts) so the importer cannot mint one",
    );
    this.name = "UnknownRepoAliasError";
  }
}

/**
 * Reads every `task.json` under `sourceDir` (one per immediate
 * subdirectory) and returns them as `SourceTask`s. A subdirectory missing
 * `task.json`, or one whose contents don't parse as JSON, is skipped rather
 * than aborting the whole read — a directory-per-task store can accumulate
 * stray subdirectories (a `.git`, an editor's swap folder) that were never
 * meant to be a task.
 */
export async function readSourceTasks(sourceDir: string): Promise<SourceTask[]> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const tasks: SourceTask[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskFile = path.join(sourceDir, entry.name, "task.json");
    let raw: string;
    try {
      raw = await readFile(taskFile, "utf-8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as SourceTask;
      tasks.push(parsed);
    } catch {
      continue;
    }
  }

  return tasks;
}

export interface ImportItemsOptions {
  /**
   * Maps a source repo label (as read from `SourceTask.repo`, verbatim) to
   * the id of an existing `Repo` row. **This is where aliases of one
   * repository collapse onto one id** — e.g. both `"web-app"` and `"webapp"`
   * mapping to `"web"` — so the importer never inserts a repo alias as a
   * distinct value. A source repo label with no entry here is refused
   * (`UnknownRepoAliasError`) rather than silently imported as free text or
   * used to mint a new `Repo` row, because repos are deliberate-create only
   * (repos.ts) and an unrecognised repo is a mapping gap to fix, not license
   * to invent one.
   */
  repoAliases: Record<string, string>;
  /**
   * Maps a source status label onto an `items.state`, consulted BEFORE this
   * application's own `STATUS_REMAP`. Caller-owned for the same reason
   * `repoAliases` is: a source's status vocabulary is the source's, and
   * baking one into the application makes every other source a source-code
   * change. See `mapSourceStatus`.
   */
  statusAliases?: Record<string, ItemState>;
}

export interface ImportItemsResult {
  imported: number;
  skippedExisting: number;
}

/**
 * Imports `tasks` into `items`. Idempotent on `custom_fields.legacy_id`
 * (SCHEMA.md §1 `custom_fields` — "Migration seeds `legacy_id` here, which
 * is why `id` can be opaque"; DECISIONS.md "an imported identifier lives in
 * `custom_fields.legacy_id`") — a task whose source id has already been
 * imported is skipped, not re-inserted or updated, so re-running the
 * importer against a store that has since had items claimed, transitioned
 * or annotated in the app never clobbers that work. The item's own `id` is
 * **generated** by the app (a `crypto.randomUUID()`-shaped opaque id, per
 * SCHEMA.md §1 "New items get whatever the app generates") rather than
 * reusing the source id directly as the primary key — the source id is
 * preserved verbatim, but as data (`custom_fields.legacy_id`), which is what
 * idempotency checks against; it is not repurposed as this table's own
 * primary key, which numbers this installation's rows, not the source
 * store's.
 *
 * `area` is resolved through `ensureArea` — auto-create-with-normalisation,
 * per areas.ts. `repo` is resolved through `options.repoAliases` only; there
 * is no fallback that creates a `Repo` row.
 *
 * `origin_type` is set to `source` (SCHEMA.md §1 `origin_type`) and
 * `merge_authority` to `needs_approval` — the same default a fresh item gets
 * from the settings registry's `items.default_merge_authority` (SCHEMA.md
 * §17.2), reproduced literally here because the importer runs as a script,
 * outside the service layer that would otherwise resolve a settings
 * snapshot for it.
 */
export async function importItems(
  client: Pick<
    PrismaClient,
    "item" | "area" | "$executeRaw" | "$queryRaw" | "$executeRawUnsafe" | "$queryRawUnsafe"
  >,
  tasks: SourceTask[],
  options: ImportItemsOptions,
): Promise<ImportItemsResult> {
  let imported = 0;
  let skippedExisting = 0;

  for (const task of tasks) {
    const existing = await client.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: task.id } },
      select: { id: true },
    });
    if (existing) {
      skippedExisting++;
      continue;
    }

    const state = mapSourceStatus(task.status, task.id, options.statusAliases);

    let repoId: string | null = null;
    if (task.repo) {
      const resolved = options.repoAliases[task.repo];
      if (!resolved) {
        throw new UnknownRepoAliasError(task.repo, task.id);
      }
      repoId = resolved;
    }

    const area = await ensureArea(client, task.area);
    const id = crypto.randomUUID();

    await client.item.create({
      data: {
        id,
        kind: "task",
        title: task.title,
        body: task.body,
        state,
        originType: task.originType ?? "source",
        ...(task.originPersonId !== undefined ? { originPersonId: task.originPersonId } : {}),
        area: area.id,
        repo: repoId,
        mergeAuthority: task.mergeAuthority ?? "needs_approval",
        ...(task.createdAt !== undefined ? { createdAt: new Date(task.createdAt) } : {}),
        ...(task.updatedAt !== undefined ? { updatedAt: new Date(task.updatedAt) } : {}),
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        ...(task.branch !== undefined ? { branch: task.branch } : {}),
        ...(task.needsVisualReview !== undefined
          ? { needsVisualReview: task.needsVisualReview }
          : {}),
        ...(task.sourceRef !== undefined ? { sourceRef: task.sourceRef } : {}),
        // `legacy_id` is spread LAST so a source-supplied `customFields`
        // carrying its own `legacy_id` cannot displace the one idempotency
        // keys on — a displaced key would make the second run of an import
        // re-insert every row it had already written.
        customFields: { ...(task.customFields ?? {}), legacy_id: task.id },
      },
    });

    // The insert above writes `Item.area` directly — it has to, the column
    // is NOT NULL and no `ItemArea` row can reference an item id that
    // doesn't exist yet. This is the second write `setItemAreas`
    // (`./service/items/item-areas.ts`) warns about: without it, every
    // imported item gets zero `ItemArea` rows and is invisible to
    // `areaFilterCondition`, which deliberately reads only that table. Raw
    // SQL rather than importing `setItemAreas` itself: this module is a
    // narrow Prisma-client-shaped importer that also runs as a standalone
    // script (see the module header), and `setItemAreas` takes a full
    // `ServiceContext` it has no way to construct one of here — the
    // statement below is exactly what that function's own body runs for a
    // fresh item's single area, kept in the same transaction the caller
    // already opened (`transactionBackedClient`, when run through the
    // service operation) or the client's own connection (when run as a
    // script).
    await client.$executeRawUnsafe(
      `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      id,
      area.id,
    );

    imported++;
  }

  return { imported, skippedExisting };
}
