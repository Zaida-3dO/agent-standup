// The cached rule lists — MILESTONES.md #42 ("cached rules"), DECISIONS.md
// §4: "The server supplies a cached pattern list; no match → allow locally,
// zero network."
//
// That sentence is the whole performance argument for the hook, and it is
// worth being precise about what it does and does not license. It says a
// command matching *neither* cached list costs no network round trip. It
// does **not** say the local cache is the authority: an ask-list match still
// goes to the server, because the ask-list is where judgement lives (#44's
// merge gate, #45's kill guard, #46's nudges all sit behind it). The cache
// exists to keep the overwhelmingly common case — an ordinary tool call
// matching nothing — off the wire.
//
// ── The part that is easy to get wrong ─────────────────────────────────
//
// A cache that cannot be read is not an empty cache. With empty lists,
// *every* command matches neither list. Under `decideHook` that is the
// "unsure" case and denies — which is the correct posture for a guarded
// command but would refuse every tool call on a machine whose cache file is
// merely missing, which is a broken installation rather than a guarded one.
// So the two are distinguished here:
//
//   - **Fresh** — read, parsed, within its TTL. Classify locally.
//   - **Stale** — read and parsed, past its TTL. Still usable; a rule list
//     that is an hour old is a far better input than no rule list, and §4's
//     versioning posture is that staleness is advisory, not fatal.
//   - **Unavailable** — missing, unreadable, or not the expected shape.
//     There are no rules to classify against, so nothing can be decided
//     locally, and the caller must ask the server. If it cannot, that is a
//     deny (`./decide.ts`), because "I have no rules and cannot reach the
//     authority" is the definition of unsure.
//
// Nothing here touches the filesystem itself: reading is injected. That is
// what lets the staleness and corruption paths be tested as
// one-string-in-one-state-out, with no temporary directory and no clock.

import { hookPatternListSchema } from "@/lib/settings/hook-pattern";

/** How long a cached rule set is considered fresh, in milliseconds. */
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** The rule lists, as cached. Same two keys as the settings registry. */
export interface HookRules {
  readonly allowPatterns: readonly string[];
  readonly askPatterns: readonly string[];
}

/** What was cached, and when. The serialised shape of the cache file. */
export interface CachedRules extends HookRules {
  /** Epoch milliseconds at which these lists were fetched. */
  readonly fetchedAt: number;
}

export type CacheState =
  | { readonly status: "fresh"; readonly rules: HookRules }
  | { readonly status: "stale"; readonly rules: HookRules; readonly ageMs: number }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ReadCacheOptions {
  /** The cache file's text, or `undefined` when there is no file to read. */
  readonly text: string | undefined;
  /** Epoch milliseconds. Injected so freshness is testable without a clock. */
  readonly now: number;
  readonly ttlMs?: number;
}

/**
 * Interprets the cache file's text.
 *
 * Every failure mode collapses to `unavailable` with a reason rather than
 * throwing: this runs on every tool call, and a hook that crashes is a hook
 * whose output the agent tool cannot read — which, depending on the tool, is
 * indistinguishable from an allow. Refusing loudly through the normal
 * decision path is strictly better than exiting on an exception.
 *
 * The pattern lists are validated with the **same schema the settings write
 * path uses** (`hookPatternListSchema`), not a looser local check. A cache
 * containing a pattern that cannot compile as a `RegExp` would silently
 * skip that pattern at match time — the entry a person added to guard
 * something would simply not guard it — so it is rejected here, where the
 * consequence is one server fetch, rather than absorbed on the hot path.
 */
export function readCache({
  text,
  now,
  ttlMs = DEFAULT_CACHE_TTL_MS,
}: ReadCacheOptions): CacheState {
  if (text === undefined) {
    return { status: "unavailable", reason: "no cached rules on this machine" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "unavailable", reason: "the cached rules file was not valid JSON" };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "unavailable", reason: "the cached rules file was not a JSON object" };
  }

  const record = raw as Record<string, unknown>;
  const allow = hookPatternListSchema.safeParse(record.allowPatterns);
  const ask = hookPatternListSchema.safeParse(record.askPatterns);
  if (!allow.success || !ask.success) {
    return {
      status: "unavailable",
      reason: "the cached rules file did not hold two pattern lists",
    };
  }

  const fetchedAt = record.fetchedAt;
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) {
    return { status: "unavailable", reason: "the cached rules file carried no fetch time" };
  }

  const rules: HookRules = { allowPatterns: allow.data, askPatterns: ask.data };
  const ageMs = now - fetchedAt;

  // A cache stamped in the future is stale, not fresh. Clock skew (or a
  // file copied from another machine) must not be able to mint a rule set
  // that never expires — the failure would be silent and permanent, and the
  // cost of being wrong is one fetch.
  if (ageMs < 0 || ageMs >= ttlMs) {
    return { status: "stale", rules, ageMs };
  }

  return { status: "fresh", rules };
}

/** The text to write for a freshly fetched rule set. */
export function serialiseCache(rules: HookRules, fetchedAt: number): string {
  const cached: CachedRules = {
    allowPatterns: rules.allowPatterns,
    askPatterns: rules.askPatterns,
    fetchedAt,
  };
  return JSON.stringify(cached);
}

/**
 * The rule lists carried on a server response, or `undefined` if it carried
 * none.
 *
 * Validated with the same schema as the file, for the same reason: rules
 * arriving over the wire are no more trustworthy than rules read off disk,
 * and a build that trusted one but not the other would have a hole exactly
 * the width of whichever it trusted.
 */
export function readRulesFromResponse(value: unknown): HookRules | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const allow = hookPatternListSchema.safeParse(record.allowPatterns);
  const ask = hookPatternListSchema.safeParse(record.askPatterns);
  if (!allow.success || !ask.success) return undefined;
  return { allowPatterns: allow.data, askPatterns: ask.data };
}
