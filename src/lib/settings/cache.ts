// The revision-based cache. See docs/plans/SCHEMA.md §17.3.
//
// A long-lived process holds one resolved snapshot and re-reads the
// one-row revision counter at most once every few seconds. If the counter
// moved, the snapshot is rebuilt. The guarantee is therefore explicit and
// small:
//
//   a settings change is visible immediately in the process that made it,
//   and within the revalidation interval in every other process.
//
// A counter and not `max(updated_at)`, because clearing an override deletes
// a row and a delete can lower a maximum — a change that moves state
// backwards would be invisible to anything watching a high-water mark.
import { resolveSettings, type SettingsSnapshot, type StoredOverride } from "./resolve";

/** How the cache reaches the database. Two reads, deliberately separate. */
export interface SettingsSource {
  /**
   * The current revision. The cheap read — one primary-key lookup — done on
   * every revalidation whether or not anything changed.
   */
  readRevision(): Promise<bigint>;
  /**
   * Every override row, with the revision they were read at.
   *
   * Both in one call, and the revision returned by *this* read is the one
   * the snapshot is stamped with — not the one that prompted the rebuild.
   * A write landing between the two reads would otherwise stamp the
   * snapshot with a revision newer than the rows it holds, and the next
   * revalidation would compare equal and never correct it: a permanently
   * stale snapshot that believes it is current. Reading both inside one
   * transaction is what makes the pair consistent; this interface requires
   * it of an implementation rather than hoping for it.
   */
  readOverrides(): Promise<{ overrides: StoredOverride[]; revision: bigint }>;
}

export interface SettingsCacheOptions {
  source: SettingsSource;
  /**
   * Milliseconds before the revision is re-read. Within this window a read
   * is served from memory without touching the database.
   */
  revalidateAfterMs?: number;
  /** Injectable clock, so the interval is testable without waiting. */
  now?: () => number;
}

export const DEFAULT_REVALIDATE_AFTER_MS = 3_000;

/**
 * Holds one snapshot and rebuilds it when the revision moves.
 *
 * Not a module-level singleton: a singleton is the version that cannot be
 * tested twice in one process and cannot be given a different source. The
 * application composes one of these where it wants one.
 */
export class SettingsCache {
  readonly #source: SettingsSource;
  readonly #revalidateAfterMs: number;
  readonly #now: () => number;

  #snapshot: SettingsSnapshot | null = null;
  #checkedAt = 0;
  /**
   * The in-flight load, if any. Concurrent callers await the same promise
   * rather than each issuing their own pair of reads — a cold start under
   * concurrency is otherwise N identical round trips, and, worse, N
   * snapshots of which the last to land wins regardless of which is newest.
   */
  #inFlight: Promise<SettingsSnapshot> | null = null;

  constructor({
    source,
    revalidateAfterMs = DEFAULT_REVALIDATE_AFTER_MS,
    now = Date.now,
  }: SettingsCacheOptions) {
    this.#source = source;
    this.#revalidateAfterMs = revalidateAfterMs;
    this.#now = now;
  }

  /**
   * The current snapshot, rebuilt if the revision has moved since the last
   * check and the revalidation interval has elapsed.
   */
  async get(): Promise<SettingsSnapshot> {
    if (this.#inFlight) return this.#inFlight;

    const cached = this.#snapshot;
    if (cached && this.#now() - this.#checkedAt < this.#revalidateAfterMs) {
      return cached;
    }

    if (cached) {
      const revision = await this.#source.readRevision();
      this.#checkedAt = this.#now();
      if (revision === cached.revision) return cached;
    }

    return this.#load();
  }

  /**
   * Discards the held snapshot, so the next read rebuilds unconditionally.
   *
   * This is the "immediate in the process that made the change" half of the
   * guarantee: a process that has just written a setting calls this rather
   * than waiting out its own revalidation interval to observe its own
   * write. Without it the writing process is the one process that reads a
   * value it knows to be stale.
   */
  invalidate(): void {
    this.#snapshot = null;
    this.#checkedAt = 0;
  }

  /** The held snapshot without any database read. Null before the first load. */
  peek(): SettingsSnapshot | null {
    return this.#snapshot;
  }

  #load(): Promise<SettingsSnapshot> {
    const load = (async () => {
      try {
        const { overrides, revision } = await this.#source.readOverrides();
        const snapshot = resolveSettings({ overrides, revision });
        this.#snapshot = snapshot;
        this.#checkedAt = this.#now();
        return snapshot;
      } finally {
        // Cleared in `finally` rather than after the assignment: a source
        // that rejects would otherwise leave a rejected promise latched
        // here, and every later call would replay that one failure instead
        // of retrying.
        this.#inFlight = null;
      }
    })();
    this.#inFlight = load;
    return load;
  }
}
