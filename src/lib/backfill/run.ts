// Backfill — the sequence.
//
// `import-items.ts`, `import-events.ts` and `import-assignments-artifacts.ts`
// each own one table. What none of them owns is the ORDER, and the order is
// not free: events, assignments and artifacts all resolve the item they
// belong to through `custom_fields.legacy_id`, so items must land first or
// every later importer finds nothing to attach to and silently attaches
// nothing. This module is that sequence and nothing else — it adds no
// insert logic of its own, so the three importers stay the only writers to
// their own tables.
import type { PrismaClient } from "@prisma/client";
import { importAssignmentsAndArtifacts } from "../import-assignments-artifacts";
import type { SourceClaim, SourceReview } from "../import-assignments-artifacts";
import { importEvents } from "../import-events";
import type { ActorAliasTarget } from "../import-events";
import { importItems } from "../import-items";
import type { SourceTask } from "../import-items";
import type { BackfillPayload, BackfillTask } from "./contract";

/** Everything the sequence touches. Narrowed to the union of what the three importers each need. */
export type BackfillClient = Pick<
  PrismaClient,
  "item" | "area" | "$executeRaw" | "$queryRaw" | "$executeRawUnsafe" | "$queryRawUnsafe"
>;

export interface BackfillCounts {
  readonly tasks: number;
  readonly itemsImported: number;
  readonly itemsSkipped: number;
  readonly eventsImported: number;
  readonly eventsSkipped: number;
  readonly claimsImported: number;
  readonly claimsSkipped: number;
  /** Claims a uniqueness rule refused — a genuine conflict in the source history, surfaced not swallowed. */
  readonly claimsConflicted: number;
  readonly artifactsImported: number;
  readonly artifactsSkipped: number;
  /** Tasks whose history could not be attached because no item row matched — always empty in a clean run. */
  readonly tasksWithoutMatchingItem: readonly string[];
}

/**
 * Turns one contract task into the shape the importers consume.
 *
 * The two shapes are close by design — the contract was written from what
 * the importers already accept — so this is a field-for-field widening with
 * one substantive step: `area` falls back to the payload's `defaultArea`,
 * because `items.area` is mandatory and a per-task area is not.
 */
export function toSourceTask(
  task: BackfillTask,
  defaultArea: string,
): SourceTask & { claims?: SourceClaim[]; reviews?: SourceReview[] } {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    area: task.area ?? defaultArea,
    ...(task.repo !== undefined ? { repo: task.repo } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.branch !== undefined ? { branch: task.branch } : {}),
    ...(task.needsVisualReview !== undefined ? { needsVisualReview: task.needsVisualReview } : {}),
    ...(task.sourceRef !== undefined ? { sourceRef: task.sourceRef } : {}),
    ...(task.customFields !== undefined ? { customFields: task.customFields } : {}),
    ...(task.history !== undefined ? { history: task.history } : {}),
    ...(task.claims !== undefined ? { claims: task.claims as SourceClaim[] } : {}),
    ...(task.reviews !== undefined ? { reviews: task.reviews as SourceReview[] } : {}),
  };
}

/**
 * Runs the three importers in dependency order and returns the combined
 * counts.
 *
 * **Idempotent, because each importer already is** — items key on
 * `custom_fields.legacy_id`, events on the history entry's own id,
 * assignments on `(item, session, claimed-at)` and artifacts on
 * `(item, kind, round, author, created-at)`. Running this twice against the
 * same database inserts nothing the second time; the counts are what make
 * that checkable rather than asserted.
 */
export async function backfillTasks(
  client: BackfillClient,
  payload: BackfillPayload,
): Promise<BackfillCounts> {
  const tasks = payload.tasks.map((task) => toSourceTask(task, payload.defaultArea));

  const items = await importItems(client, tasks, { repoAliases: payload.repoAliases ?? {} });

  const actorAliases = (payload.actorAliases ?? {}) as Record<string, ActorAliasTarget>;
  const events = await importEvents(client, tasks, { actorAliases });

  const assignmentsArtifacts = await importAssignmentsAndArtifacts(client, tasks);

  return {
    tasks: tasks.length,
    itemsImported: items.imported,
    itemsSkipped: items.skippedExisting,
    eventsImported: events.imported,
    eventsSkipped: events.skippedExisting,
    claimsImported: assignmentsArtifacts.claimsImported,
    claimsSkipped: assignmentsArtifacts.claimsSkippedExisting,
    claimsConflicted: assignmentsArtifacts.claimsConflicted,
    artifactsImported: assignmentsArtifacts.reviewsImported,
    artifactsSkipped: assignmentsArtifacts.reviewsSkippedExisting,
    tasksWithoutMatchingItem: events.tasksWithoutMatchingItem,
  };
}
