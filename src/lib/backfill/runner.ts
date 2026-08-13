// Backfill — the operator's runner (docs/plans/BACKFILL.md).
//
// `./run.ts` is the sequence; the service operation wraps it for callers
// arriving over HTTP or the command line. This module is the third door:
// running a backfill *from a shell, against a database named on the command
// line*, and — the part the other two do not do — **checking afterwards
// that what landed matches what was sent**.
//
// That verification is the reason this exists separately. A bulk load of
// somebody's entire backlog is exactly the operation whose failure mode is
// "it said it worked". So the runner re-reads the database and compares:
// row counts per table, a field-by-field spot check on a spread sample,
// and — with `--twice` — a second full run that must insert nothing.
//
// **Nothing here is hard-coded to a location.** The payload file and the
// database URL both arrive as an argument or an environment variable and
// are refused if absent: a tool with a built-in path works on exactly one
// machine.
//
// Takes its database client by injection (a type-only import), like every
// other module outside the service layer — only the composition root
// constructs one.
import type { PrismaClient } from "@prisma/client";
import { createRepo, RepoAlreadyExistsError } from "../repos";
import type { ActorAliasTarget } from "../import-events";
import type { SourceTask } from "../import-items";
import {
  spotCheckItems,
  verifyAssignmentArtifactRowCounts,
  verifyEventRowCounts,
  verifyFindingsRetention,
  verifyHistoryRetention,
  verifyItemRowCounts,
} from "../import-verify";
import type {
  AssignmentArtifactCountReport,
  EventRowCountReport,
  FindingsRetentionReport,
  HistoryRetentionReport,
  RowCountReport,
  SpotCheckReport,
} from "../import-verify";
import { backfillPayloadSchema, type BackfillPayload } from "./contract";
import { backfillTasks, toSourceTask, type BackfillClient, type BackfillCounts } from "./run";

export interface RunnerOptions {
  readonly payloadFile: string;
  readonly databaseUrl: string;
  /** Mint a `Repo` row for any repo label the payload uses and its `repoAliases` does not map. */
  readonly createMissingRepos: boolean;
  /** Derive an actor alias for every history actor the payload's own `actorAliases` does not cover. */
  readonly deriveActors: boolean;
  readonly sampleSize: number;
  /** Run the whole backfill twice and report whether the second run was a no-op. */
  readonly twice: boolean;
}

export class MissingRunnerOptionError extends Error {
  constructor(what: string, flag: string, envVar: string) {
    super(
      `${what} was not supplied — pass ${flag} or set ${envVar}. There is deliberately no ` +
        "default: a tool with a built-in path only works on the machine it was written on.",
    );
    this.name = "MissingRunnerOptionError";
  }
}

export class UnknownRunnerFlagError extends Error {
  constructor(flag: string) {
    super(`unrecognised option ${JSON.stringify(flag)}`);
    this.name = "UnknownRunnerFlagError";
  }
}

const DEFAULT_SAMPLE_SIZE = 20;

/**
 * Resolves runner options from arguments and the environment, the argument
 * winning where both are present.
 *
 * Pure — it reads nothing from disk and constructs nothing — so every
 * refusal is testable without a database, and an unrecognised flag is
 * refused here rather than quietly ignored on the way into a long run.
 */
export function resolveRunnerOptions(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): RunnerOptions {
  let payloadFile: string | undefined;
  let databaseUrl: string | undefined;
  let sampleSize: string | undefined;
  let createMissingRepos = false;
  let strictActors = false;
  let twice = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new UnknownRunnerFlagError(`${flag} (missing value)`);
      i++;
      return value;
    };
    switch (flag) {
      case "--payload":
        payloadFile = takeValue();
        break;
      case "--database-url":
        databaseUrl = takeValue();
        break;
      case "--sample-size":
        sampleSize = takeValue();
        break;
      case "--create-missing-repos":
        createMissingRepos = true;
        break;
      case "--strict-actors":
        strictActors = true;
        break;
      case "--twice":
        twice = true;
        break;
      default:
        throw new UnknownRunnerFlagError(flag);
    }
  }

  const resolvedPayload = payloadFile ?? env.BACKFILL_PAYLOAD;
  if (!resolvedPayload) {
    throw new MissingRunnerOptionError("the payload file", "--payload", "BACKFILL_PAYLOAD");
  }
  const resolvedUrl = databaseUrl ?? env.DATABASE_URL;
  if (!resolvedUrl) {
    throw new MissingRunnerOptionError("the database URL", "--database-url", "DATABASE_URL");
  }

  const parsedSampleSize = Number(sampleSize ?? env.BACKFILL_SAMPLE_SIZE ?? DEFAULT_SAMPLE_SIZE);

  return {
    payloadFile: resolvedPayload,
    databaseUrl: resolvedUrl,
    createMissingRepos: createMissingRepos || env.BACKFILL_CREATE_MISSING_REPOS === "true",
    deriveActors: !(strictActors || env.BACKFILL_STRICT_ACTORS === "true"),
    sampleSize: Number.isFinite(parsedSampleSize) ? parsedSampleSize : DEFAULT_SAMPLE_SIZE,
    twice,
  };
}

/**
 * Normalises a repo label into a `repos.id`. Its own function rather than
 * the area normaliser it resembles: areas and repos have opposite create
 * postures (DECISIONS.md §13g), and sharing one normaliser would invite
 * sharing the auto-create that goes with the area half.
 */
export function normalizeRepoKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every distinct repo label the payload's tasks name, sorted. */
export function repoLabelsIn(payload: BackfillPayload): string[] {
  const labels = new Set<string>();
  for (const task of payload.tasks) if (task.repo) labels.add(task.repo);
  return [...labels].sort();
}

/** Every distinct history actor the payload's tasks name, sorted. */
export function actorsIn(payload: BackfillPayload): string[] {
  const actors = new Set<string>();
  for (const task of payload.tasks) {
    for (const entry of task.history ?? []) actors.add(entry.actor);
  }
  return [...actors].sort();
}

export interface RepoResolution {
  readonly repoAliases: Record<string, string>;
  readonly created: string[];
  /** Labels left unmapped — the importer refuses the tasks that name them, by design. */
  readonly unmapped: string[];
}

/**
 * Resolves each repo label onto a `repos.id`.
 *
 * Repos are deliberate-create only (repos.ts): a wrong repo aims the merge
 * gate at the wrong repository, so an importer may never mint one as a side
 * effect. Minting one here therefore requires the operator to have asked —
 * the flag IS the deliberation — and without it an unmapped label stays
 * unmapped and the task that names it is refused.
 */
export class DanglingRepoAliasError extends Error {
  constructor(dangling: readonly { label: string; target: string }[]) {
    const list = dangling
      .map(({ label, target }) => `${JSON.stringify(label)} -> ${JSON.stringify(target)}`)
      .join(", ");
    super(
      `repoAliases points at ${dangling.length} repo id(s) that do not exist: ${list}. ` +
        "An alias translates a source's spelling onto a repo that is already in `repos`; it does " +
        "not create one. " +
        "Either create them first (`standup repo create --id <target> ...`), correct the alias " +
        "targets, or drop the alias entries and re-run with --create-missing-repos so the " +
        "source labels are minted directly.",
    );
    this.name = "DanglingRepoAliasError";
  }
}

/**
 * Resolves each repo label onto a `repos.id`.
 *
 * Two distinct cases, and conflating them was a real defect: a label the
 * payload maps through `repoAliases`, and a label it does not.
 *
 * **A mapped label still has to point at something.** An alias is a
 * translation onto a repo that is already in `repos`, never a request to
 * create one, so its
 * target is checked here rather than assumed. Skipping that check does not
 * make the problem go away — it defers it to the foreign key on the first
 * item insert, which fails with a bare `Item_repo_fkey` violation naming
 * neither the task, the label, nor the target, and aborts the whole run.
 * Every other refusal in this importer names the offending value; this one
 * now does too.
 *
 * **An unmapped label** is minted only when the caller asked
 * (`createMissingRepos`) — repos are deliberate-create only (repos.ts),
 * because a wrong repo aims the merge gate at the wrong repository, so the
 * flag IS the deliberation. Without it the label stays unmapped and the
 * task naming it is refused by `importItems`.
 *
 * `createMissingRepos` deliberately does NOT mint an alias's target. The
 * flag says "mint the labels my payload uses"; an alias says "my label
 * `web-app` means the repo you already have as `web`". Minting `web` on the strength
 * of that would invent the very row the caller was asserting already
 * existed, and would hide a typo'd target rather than report it.
 */
export async function resolveRepoAliases(
  client: Pick<PrismaClient, "repo">,
  labels: readonly string[],
  options: { readonly repoAliases: Record<string, string>; readonly createMissingRepos: boolean },
): Promise<RepoResolution> {
  const repoAliases: Record<string, string> = { ...options.repoAliases };
  const created: string[] = [];
  const unmapped: string[] = [];
  const dangling: { label: string; target: string }[] = [];

  for (const label of labels) {
    const aliasTarget = repoAliases[label];
    if (aliasTarget) {
      const existing = await client.repo.findUnique({ where: { id: aliasTarget } });
      if (!existing) dangling.push({ label, target: aliasTarget });
      continue;
    }
    if (!options.createMissingRepos) {
      unmapped.push(label);
      continue;
    }
    const id = normalizeRepoKey(label);
    if (id === "") {
      unmapped.push(label);
      continue;
    }
    try {
      await createRepo(client, { id, displayName: label, defaultBranch: "main" });
      created.push(id);
    } catch (error) {
      // Already there from an earlier run — a re-runnable import expects
      // that as the steady state. Anything else is a real problem.
      if (!(error instanceof RepoAlreadyExistsError)) throw error;
    }
    repoAliases[label] = id;
  }

  // Raised after the whole sweep, so one run reports EVERY dangling target
  // rather than making the operator fix them one failed import at a time.
  if (dangling.length > 0) throw new DanglingRepoAliasError(dangling);

  return { repoAliases, created, unmapped };
}

/**
 * Fills in an alias for every actor the payload did not map.
 *
 * The events importer refuses an unmapped actor, deliberately — guessing
 * attributes somebody's history to the wrong row silently. But a payload
 * whose history spans hundreds of workers cannot be hand-mapped before the
 * first run, so this derives the only two entries that need no judgement:
 *
 * - the literal `system` becomes the `system` actor type with a null id,
 *   because the source attributed those rows to nobody and `events` models
 *   that directly rather than needing a stand-in identity;
 * - every other actor becomes an `agent` keyed on its own label, verbatim.
 *
 * A payload-supplied entry always wins, which is how a real person is
 * distinguished from a worker: **the derivation names nobody**, so anything
 * that should be a `person` has to be stated in the payload.
 *
 * Turning derivation off restores the importer's refusal — the right
 * setting once a payload's aliases are authoritative, and the only way to
 * discover that it has grown an actor nobody mapped.
 */
export function deriveActorAliases(
  actors: readonly string[],
  explicit: Record<string, ActorAliasTarget>,
  derive: boolean,
): Record<string, ActorAliasTarget> {
  if (!derive) return { ...explicit };
  const derived: Record<string, ActorAliasTarget> = {};
  for (const actor of actors) {
    derived[actor] =
      actor === "system"
        ? { actorType: "system", actorId: null }
        : { actorType: "agent", actorId: actor };
  }
  return { ...derived, ...explicit };
}

export interface BackfillVerification {
  readonly items: RowCountReport;
  readonly events: EventRowCountReport;
  readonly assignmentsArtifacts: AssignmentArtifactCountReport;
  readonly spotCheck: SpotCheckReport;
  /** Read back from the database — the one check here capable of contradicting the importer. */
  readonly historyRetention: HistoryRetentionReport;
  /** Read back from the database — findings and, separately, their grading. */
  readonly findingsRetention: FindingsRetentionReport;
}

export interface BackfillRunReport {
  readonly counts: BackfillCounts;
  readonly repos: RepoResolution;
  readonly actorCount: number;
  readonly verification: BackfillVerification;
}

/** The client surface a run needs — the union of what the sequence and the verifier each narrow to. */
export type RunnerClient = BackfillClient & Pick<PrismaClient, "repo">;

/**
 * Validates a payload against the contract, or throws with the offending
 * paths named. Exported so a caller can fail before opening a database
 * connection at all.
 */
export function parsePayload(raw: unknown): BackfillPayload {
  const parsed = backfillPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`payload does not match backfill contract version 1 — ${where}`);
  }
  return parsed.data;
}

/**
 * Backfills a payload and verifies what landed.
 *
 * Verification runs against the SAME task list that was sent, mapped
 * through `toSourceTask` exactly as the sequence mapped it, so the
 * "expected" side of every comparison is what the caller asked for rather
 * than a restatement of what the importer decided to do.
 */
export async function runBackfill(
  client: RunnerClient,
  payload: BackfillPayload,
  options: Pick<RunnerOptions, "createMissingRepos" | "deriveActors" | "sampleSize">,
): Promise<BackfillRunReport> {
  const repos = await resolveRepoAliases(client, repoLabelsIn(payload), {
    repoAliases: payload.repoAliases ?? {},
    createMissingRepos: options.createMissingRepos,
  });

  const actors = actorsIn(payload);
  const actorAliases = deriveActorAliases(
    actors,
    (payload.actorAliases ?? {}) as Record<string, ActorAliasTarget>,
    options.deriveActors,
  );

  const effective: BackfillPayload = { ...payload, repoAliases: repos.repoAliases, actorAliases };
  const counts = await backfillTasks(client, effective);

  const tasks: SourceTask[] = effective.tasks.map((task) =>
    toSourceTask(task, effective.defaultArea),
  );

  return {
    counts,
    repos,
    actorCount: actors.length,
    verification: {
      items: await verifyItemRowCounts(client, tasks),
      events: await verifyEventRowCounts(client, tasks),
      assignmentsArtifacts: await verifyAssignmentArtifactRowCounts(client, tasks),
      historyRetention: await verifyHistoryRetention(client, tasks),
      findingsRetention: await verifyFindingsRetention(client, tasks, counts.findingsIn),
      spotCheck: await spotCheckItems(client, tasks, {
        repoAliases: repos.repoAliases,
        statusAliases: payload.statusAliases,
        sampleSize: options.sampleSize,
      }),
    },
  };
}

export interface IdempotencyCheck {
  readonly first: BackfillRunReport;
  readonly second: BackfillRunReport;
  /** True iff the second run inserted nothing at all — the property a re-runnable load must hold. */
  readonly idempotent: boolean;
  /** Which counters were non-zero on the second run. Empty when `idempotent`. */
  readonly reinserted: string[];
}

/**
 * Runs the whole backfill twice against the same database and reports
 * whether the second run was a complete no-op.
 *
 * Checked by counting INSERTS on the second pass rather than by comparing
 * table totals: a run that both inserted and deleted the same number of
 * rows would pass a totals comparison and fail this one, which is the right
 * way round.
 */
export async function runBackfillTwice(
  client: RunnerClient,
  payload: BackfillPayload,
  options: Pick<RunnerOptions, "createMissingRepos" | "deriveActors" | "sampleSize">,
): Promise<IdempotencyCheck> {
  const first = await runBackfill(client, payload, options);
  const second = await runBackfill(client, payload, options);

  const counters: [string, number][] = [
    ["items", second.counts.itemsImported],
    ["events", second.counts.eventsImported],
    ["assignments", second.counts.claimsImported],
    ["artifacts", second.counts.artifactsImported],
  ];
  const reinserted = counters.filter(([, count]) => count !== 0).map(([name]) => name);

  return { first, second, idempotent: reinserted.length === 0, reinserted };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Renders a run report as plain text. */
export function formatRunReport(report: BackfillRunReport): string {
  const { counts, verification } = report;
  const lines: string[] = [];

  lines.push("Backfilled");
  lines.push(`  tasks in payload : ${counts.tasks}`);
  lines.push(
    `  items            : ${counts.itemsImported} new, ${counts.itemsSkipped} already present`,
  );
  lines.push(
    `  events           : ${counts.eventsImported} new, ${counts.eventsSkipped} already present`,
  );
  lines.push(
    `  assignments      : ${counts.claimsImported} new, ${counts.claimsSkipped} already present, ` +
      `${counts.claimsConflicted} refused by a uniqueness rule`,
  );
  lines.push(
    `  artifacts        : ${counts.artifactsImported} new, ${counts.artifactsSkipped} already present`,
  );
  lines.push(`  distinct actors  : ${report.actorCount}`);
  if (report.repos.created.length > 0) {
    lines.push(`  repos created    : ${report.repos.created.join(", ")}`);
  }
  if (report.repos.unmapped.length > 0) {
    lines.push(`  repo labels with no mapping: ${report.repos.unmapped.join(", ")}`);
  }

  // The history reconciliation, stated as an accounting that must SUM.
  //
  // A row count on its own cannot see a loss upstream of itself: it
  // compares what the importer wrote against what the importer intended to
  // write. So this starts from the entries the PAYLOAD contained and
  // accounts for every one of them, with each difference carrying a named
  // reason and a count.
  const own = counts.historyEntriesIn - counts.historyEntriesCollapsed;
  const retention = verification.historyRetention;
  lines.push("");
  lines.push("History reconciliation");
  lines.push(`  source entries in payload                    : ${counts.historyEntriesIn}`);
  lines.push(`  imported as their own event                  : ${own}`);
  lines.push(
    `  folded into a terminal task's single event   : ${counts.historyEntriesCollapsed}` +
      "  (text retained in the event body and payload)",
  );
  lines.push(
    `  ---- accounted for                           : ${own + counts.historyEntriesCollapsed}` +
      `${own + counts.historyEntriesCollapsed === counts.historyEntriesIn ? "  (sums)" : "  *** DOES NOT SUM ***"}`,
  );
  lines.push(
    `  events written                               : ${counts.eventsImported + counts.eventsSkipped}` +
      `  (${counts.eventsImported} new, ${counts.eventsSkipped} already present)`,
  );
  lines.push(
    `  entries whose text is NOT in the database    : ${retention.entriesMissing}` +
      `${retention.matches ? "  (verified by reading every entry back)" : "  *** HISTORY LOST ***"}`,
  );
  for (const id of retention.missing.slice(0, 10)) {
    lines.push(`    missing: ${id}`);
  }
  if (retention.tasksWithoutMatchingItem.length > 0) {
    lines.push(
      `  tasks whose history could not attach         : ${retention.tasksWithoutMatchingItem.length}`,
    );
  }
  if (counts.tasksWithoutMatchingItem.length > 0) {
    lines.push(`  tasks whose history could not attach: ${counts.tasksWithoutMatchingItem.length}`);
  }

  const findings = verification.findingsRetention;
  lines.push("");
  lines.push("Findings reconciliation");
  lines.push(`  findings in payload                          : ${counts.findingsIn}`);
  lines.push(`  written with the artifacts this run inserted : ${counts.findingsWritten}`);
  lines.push(
    `  already on an artifact skipped as present    : ${counts.findingsOnSkippedArtifacts}`,
  );
  lines.push(
    `  ---- accounted for                           : ${counts.findingsWritten + counts.findingsOnSkippedArtifacts}` +
      `${
        counts.findingsWritten + counts.findingsOnSkippedArtifacts === counts.findingsIn
          ? "  (sums)"
          : "  *** DOES NOT SUM ***"
      }`,
  );
  lines.push(
    `  ungraded in the source, kept ungraded        : ${counts.findingsWithoutSeverity}` +
      "  (never defaulted to a severity)",
  );
  lines.push(
    `  findings read back from the database         : ${findings.findingsInDb}` +
      `  (${findings.gradedInDb} graded, ${findings.ungradedInDb} ungraded)`,
  );

  lines.push("");
  lines.push("Verification");
  lines.push(
    `  item row counts   : ${verification.items.matches ? "MATCH" : "MISMATCH"} ` +
      `(${verification.items.importedItemCount} of ${verification.items.sourceTaskCount})`,
  );
  if (verification.items.missingFromDb.length > 0) {
    lines.push(`    missing from database: ${verification.items.missingFromDb.length}`);
  }
  lines.push(
    `  event row counts  : ${verification.events.matches ? "MATCH" : "MISMATCH"} ` +
      `(${verification.events.actualTotal} actual vs ${verification.events.expectedTotal} expected)`,
  );
  lines.push(
    `  claim/review rows : ${verification.assignmentsArtifacts.matches ? "MATCH" : "MISMATCH"} ` +
      `(${verification.assignmentsArtifacts.actualClaims}/${verification.assignmentsArtifacts.expectedClaims} claims, ` +
      `${verification.assignmentsArtifacts.actualReviews}/${verification.assignmentsArtifacts.expectedReviews} artifacts)`,
  );
  lines.push(
    `  spot check        : ${verification.spotCheck.allMatch ? "ALL MATCH" : "MISMATCH"} ` +
      `(${verification.spotCheck.sampled} tasks sampled)`,
  );
  lines.push(
    `  history retention : ${verification.historyRetention.matches ? "COMPLETE" : "INCOMPLETE"} ` +
      `(${verification.historyRetention.entriesRetained} of ${verification.historyRetention.entriesIn} entries found)`,
  );
  lines.push(
    `  findings retention: ${findings.matches ? "COMPLETE" : "INCOMPLETE"} ` +
      `(${findings.findingsInDb} of ${findings.findingsIn} findings in the database)`,
  );
  for (const result of verification.spotCheck.results) {
    if (result.matches) continue;
    const bad = result.fields.filter((f) => !f.matches).map((f) => f.field);
    lines.push(`    ${result.taskId}: ${result.found ? bad.join(", ") : "no matching item row"}`);
  }

  return lines.join("\n");
}

/** Renders the two-run result — the second run's insert counts are the whole claim. */
export function formatIdempotencyCheck(check: IdempotencyCheck): string {
  const lines = [formatRunReport(check.first), "", "Second run (idempotency)"];
  lines.push(`  items      : ${check.second.counts.itemsImported} new`);
  lines.push(`  events     : ${check.second.counts.eventsImported} new`);
  lines.push(`  assignments: ${check.second.counts.claimsImported} new`);
  lines.push(`  artifacts  : ${check.second.counts.artifactsImported} new`);
  lines.push(
    check.idempotent
      ? "  IDEMPOTENT — the second run inserted nothing."
      : `  NOT IDEMPOTENT — re-inserted by: ${check.reinserted.join(", ")}`,
  );
  return lines.join("\n");
}
