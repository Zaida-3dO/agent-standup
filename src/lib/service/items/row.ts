// Shared shape for the item operations — the row as `items` returns it, and
// the mapping from a raw Postgres row to it. See docs/plans/SCHEMA.md §1.
//
// Operations run against `TransactionHandle` (`../../context.ts`), which
// exposes only `$queryRawUnsafe`/`$executeRawUnsafe` — no Prisma model API.
// That is deliberate (`context.ts`: "an operation that cannot import the
// database client cannot bypass the transaction"), so every read here maps
// columns by hand rather than trusting a generated client's typing.

/** One `items` row, as every item operation reads and returns it. */
export interface ItemRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: "project" | "task" | "subtask";
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly priority: "P0" | "P1" | "P2" | "P3";
  readonly originType: "person" | "source" | "auto";
  readonly originPersonId: string | null;
  readonly area: string;
  readonly repo: string | null;
  readonly branch: string | null;
  readonly needsVisualReview: boolean;
  readonly driveMode: "autonomous" | "supervised" | "manual";
  readonly mergeAuthority: "pre_approved" | "needs_approval" | "agent_judgement";
  readonly blockedReason: string | null;
  readonly blockedOnType: "person" | "external_process" | "time" | null;
  readonly blockedOnPersonId: string | null;
  readonly unblockAt: string | null;
  readonly pauseReason: string | null;
  readonly resumeCondition: string | null;
  readonly resumeAttempts: number;
  readonly difficulty: unknown;
  readonly sourceRef: string | null;
  readonly notify: unknown;
  readonly estimatedCost: string | null;
  readonly customFields: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one `"Item"` row — driver values, not yet an `ItemRecord`. */
export interface RawItemRow {
  id: string;
  parentId: string | null;
  kind: string;
  title: string;
  body: string;
  state: string;
  priority: string;
  originType: string;
  originPersonId: string | null;
  area: string;
  repo: string | null;
  branch: string | null;
  needsVisualReview: boolean;
  driveMode: string;
  mergeAuthority: string;
  blockedReason: string | null;
  blockedOnType: string | null;
  blockedOnPersonId: string | null;
  unblockAt: Date | string | null;
  pauseReason: string | null;
  resumeCondition: string | null;
  resumeAttempts: number;
  difficulty: unknown;
  sourceRef: string | null;
  notify: unknown;
  estimatedCost: unknown;
  customFields: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Maps one raw driver row to the typed shape every item operation returns.
 *
 * A single function so `create_item`, `get_item`, `update_item` and
 * `list_items` read a row identically — if the mapping were duplicated
 * per-operation, one of the four could drift and the conformance harness
 * (§22) would see a create response shaped differently from a get response
 * for the same row, which is exactly the kind of adapter-invisible drift
 * this whole layer exists to rule out.
 */
export function toItemRecord(row: RawItemRow): ItemRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind as ItemRecord["kind"],
    title: row.title,
    body: row.body,
    state: row.state,
    priority: row.priority as ItemRecord["priority"],
    originType: row.originType as ItemRecord["originType"],
    originPersonId: row.originPersonId,
    area: row.area,
    repo: row.repo,
    branch: row.branch,
    needsVisualReview: row.needsVisualReview,
    driveMode: row.driveMode as ItemRecord["driveMode"],
    mergeAuthority: row.mergeAuthority as ItemRecord["mergeAuthority"],
    blockedReason: row.blockedReason,
    blockedOnType: row.blockedOnType as ItemRecord["blockedOnType"],
    blockedOnPersonId: row.blockedOnPersonId,
    unblockAt: isoOrNull(row.unblockAt),
    pauseReason: row.pauseReason,
    resumeCondition: row.resumeCondition,
    resumeAttempts: row.resumeAttempts,
    difficulty: row.difficulty,
    sourceRef: row.sourceRef,
    notify: row.notify,
    // Prisma's raw driver returns NUMERIC as a string already; `String()`
    // is only a safety net if a future driver upgrade starts returning it
    // some other JS type.
    estimatedCost: row.estimatedCost === null ? null : String(row.estimatedCost),
    customFields: row.customFields,
    createdAt: isoOrNull(row.createdAt) as string,
    updatedAt: isoOrNull(row.updatedAt) as string,
    completedAt: isoOrNull(row.completedAt),
  };
}

export const ITEM_COLUMNS = [
  "id",
  '"parentId"',
  "kind",
  "title",
  "body",
  "state",
  "priority",
  '"originType"',
  '"originPersonId"',
  "area",
  "repo",
  "branch",
  '"needsVisualReview"',
  '"driveMode"',
  '"mergeAuthority"',
  '"blockedReason"',
  '"blockedOnType"',
  '"blockedOnPersonId"',
  '"unblockAt"',
  '"pauseReason"',
  '"resumeCondition"',
  '"resumeAttempts"',
  "difficulty",
  '"sourceRef"',
  "notify",
  '"estimatedCost"',
  '"customFields"',
  '"createdAt"',
  '"updatedAt"',
  '"completedAt"',
].join(", ");
