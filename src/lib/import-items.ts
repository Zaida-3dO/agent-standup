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
import type { ItemState, PrismaClient } from "@prisma/client";
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

export function mapSourceStatus(status: string, taskId: string): ItemState {
  const mapped = STATUS_REMAP[status];
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
}

export interface ImportItemsResult {
  imported: number;
  skippedExisting: number;
}

/**
 * Imports `tasks` into `items`. Idempotent on `custom_fields.sourceId`
 * (SCHEMA.md §1 `custom_fields`, DECISIONS.md §11 "the source identifier
 * preserved") — a task whose source id has already been imported is
 * skipped, not re-inserted or updated, so re-running the importer against a
 * store that has since had items claimed, transitioned or annotated in the
 * app never clobbers that work. The item's own `id` is **generated** by the
 * app (a `crypto.randomUUID()`-shaped opaque id, per SCHEMA.md §1 "New items
 * get whatever the app generates") rather than reusing the source id
 * directly as the primary key — the source id is preserved verbatim, but as
 * data (`custom_fields.sourceId`), which is what idempotency checks against;
 * it is not repurposed as this table's own primary key, which numbers this
 * installation's rows, not the source store's.
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
  client: Pick<PrismaClient, "item" | "area">,
  tasks: SourceTask[],
  options: ImportItemsOptions,
): Promise<ImportItemsResult> {
  let imported = 0;
  let skippedExisting = 0;

  for (const task of tasks) {
    const existing = await client.item.findFirst({
      where: { customFields: { path: ["sourceId"], equals: task.id } },
      select: { id: true },
    });
    if (existing) {
      skippedExisting++;
      continue;
    }

    const state = mapSourceStatus(task.status, task.id);

    let repoId: string | null = null;
    if (task.repo) {
      const resolved = options.repoAliases[task.repo];
      if (!resolved) {
        throw new UnknownRepoAliasError(task.repo, task.id);
      }
      repoId = resolved;
    }

    const area = await ensureArea(client, task.area);

    await client.item.create({
      data: {
        id: crypto.randomUUID(),
        kind: "task",
        title: task.title,
        body: task.body,
        state,
        originType: "source",
        area: area.id,
        repo: repoId,
        mergeAuthority: "needs_approval",
        customFields: { sourceId: task.id },
      },
    });
    imported++;
  }

  return { imported, skippedExisting };
}
