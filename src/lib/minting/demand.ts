// "Triggered by demand" — the first third of MILESTONES.md #63.
//
// **Minting is pull, not schedule.** The row is explicit that a scan is
// *triggered by demand*, and `minting.backlog_low_threshold` (SCHEMA.md
// §17.7: *"On-deck count below this triggers a mint request"*) is the
// signal. Scanning on a timer instead would mint work nobody asked for and
// would keep minting it while a full backlog went stale — the queue would
// grow without anything consuming it.
//
// Everything here is a pure function of a count and a settings value, with
// no database and no filesystem, because "should we scan?" is a decision
// and "what is on deck?" is a query. Keeping them apart is what lets the
// decision be tested exhaustively at its boundary, which is where a
// threshold comparison is always wrong if it is wrong at all.
import { SOURCE_REF_SEPARATOR } from "./source-ref";

/** Why a scan was or was not triggered — returned rather than logged. */
export type MintDemand =
  | { readonly scan: true; readonly reason: "backlog-low"; readonly onDeck: number }
  | { readonly scan: false; readonly reason: "backlog-sufficient"; readonly onDeck: number }
  | { readonly scan: false; readonly reason: "no-sources" }
  | { readonly scan: false; readonly reason: "already-scanning" };

/**
 * Whether the backlog is low enough to want more work.
 *
 * **Strictly below, matching §17.7's wording** — *"On-deck count **below**
 * this triggers a mint request"*. At exactly the threshold the backlog is
 * still considered sufficient. The distinction is one item and it is the
 * only place this comparison is written down, so it is asserted at the
 * boundary rather than around it.
 */
export function backlogIsLow(onDeck: number, threshold: number): boolean {
  return onDeck < threshold;
}

/**
 * The whole trigger decision.
 *
 * Ordering is deliberate, and each refusal comes before the ones that would
 * be more expensive to establish:
 *
 *   1. **No sources configured** — nothing to scan, whatever the backlog.
 *      This is the ordinary state of a fresh install (`minting.source_globs`
 *      defaults to `[]`), so it must be a quiet no-op and never an error.
 *   2. **A scan already in flight** — §13's *"concurrency is the dispatch
 *      record: a 'go mint from this file' instruction that hasn't been
 *      claimed or timed out means the server doesn't issue another"*. The
 *      caller establishes this; this function only respects it.
 *   3. **Backlog sufficient** — the common case once running.
 *
 * The unclaimed-dispatch check is a *lease*, not the dedup mechanism. It
 * stops redundant work being dispatched; `mintOnce` is what stops a
 * duplicate item existing if two scans run anyway. Conflating the two is
 * the mistake that makes people believe a lease is sufficient — it is not,
 * because a lease expires and a crashed scanner's dispatch times out while
 * its already-issued insert may still land.
 */
export function assessMintDemand(input: {
  readonly onDeck: number;
  readonly threshold: number;
  readonly sourceGlobs: readonly string[];
  readonly scanInFlight: boolean;
}): MintDemand {
  if (input.sourceGlobs.length === 0) return { scan: false, reason: "no-sources" };
  if (input.scanInFlight) return { scan: false, reason: "already-scanning" };
  return backlogIsLow(input.onDeck, input.threshold)
    ? { scan: true, reason: "backlog-low", onDeck: input.onDeck }
    : { scan: false, reason: "backlog-sufficient", onDeck: input.onDeck };
}

/**
 * The globs a machine actually scans.
 *
 * `machines.source_globs` overrides `minting.source_globs` wholesale rather
 * than merging with it — SCHEMA.md §17.7 and its precedence table
 * (*"filesystem globs are a property of a machine, and machines have
 * different layouts"*). Merging would be the wrong shape: a machine that
 * sets its own globs is saying *"my layout is not the default one"*, and
 * silently keeping the default entries alongside would have it scan paths
 * that do not exist there and, worse, could have two machines scan one
 * shared path and race over it.
 *
 * **Null and empty are different.** Null means *"inherit"* (the column's
 * documented meaning) and empty means *"this machine scans nothing"* — an
 * explicit, legitimate choice for a machine that runs sessions but holds no
 * sources. Collapsing them with `?? []` or a truthiness check would make
 * that choice unexpressable and would silently hand it the default globs.
 */
export function effectiveSourceGlobs(
  machineGlobs: readonly string[] | null | undefined,
  settingGlobs: readonly string[],
): readonly string[] {
  return machineGlobs === null || machineGlobs === undefined ? settingGlobs : machineGlobs;
}

/** One source a scan found, as the poll reports it. */
export interface PendingSource {
  /** Path relative to the scan root, already normalised. */
  readonly path: string;
  /** Hash of the file's current content. */
  readonly contentHash: string;
}

/**
 * The sources that are new to us, given what has already been minted.
 *
 * **This is a filter, not the dedup.** It exists so a scan can report *"3
 * of 200 files are new"* without attempting 200 inserts, and so the
 * launcher's poll payload (SCHEMA.md §19: *"pending source hashes"*) can be
 * answered cheaply. The guarantee that a source mints once is
 * `mintOnce`'s and the constraint's; if this function were deleted the
 * system would still be correct.
 *
 * Both arguments are plain data, so a caller may pass hashes it read from a
 * poll body without touching a filesystem.
 */
export function pendingSources(
  found: readonly PendingSource[],
  mintedRefs: ReadonlySet<string>,
): readonly PendingSource[] {
  return found.filter(
    (source) => !mintedRefs.has(`${source.path}${SOURCE_REF_SEPARATOR}${source.contentHash}`),
  );
}
