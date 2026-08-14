// Reading the usage an agent tool reported on the hook payload —
// MILESTONES.md #88, SCHEMA.md §10 (token counts) and §11 ("the hook
// reports model and effort on every call").
//
// This is separate from `./payload.ts` on purpose, and the reason is worth
// stating because the two obviously could have been one function.
//
// `parseHookPayload` answers a question a *guard* asks: what is being run,
// in whose session, and can I read the question at all? Every one of its
// failure modes is a refusal, because a payload it cannot read might have
// carried `rm -rf /`. Usage answers a question a *meter* asks, and its
// failure modes are the opposite: a token count this build cannot read must
// never refuse anything. Folding them together would put a field that is
// allowed to be absent, malformed or unrecognised inside the function whose
// contract is "anything I cannot read denies" — and the first time someone
// tightened that contract, an agent tool that renamed `input_tokens` would
// start denying every tool call on the machine.
//
// So: two functions, two contracts. This one never fails. It returns
// whatever it recognised and silently ignores the rest, which is the correct
// posture for measurement and the wrong one for a guard.
//
// **Spellings are listed, never scanned for.** Same rule as `./payload.ts`:
// a scan for "any numeric property whose name contains tokens" would
// eventually pick up an unrelated field and meter against it. A field this
// module does not recognise is simply not measured, which loses a
// measurement — recoverable, and far cheaper than a wrong one.

import type { ReportedUsage } from "./spool-record";

/** Reads one property off an unknown value without asserting its whole shape. */
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The first of `keys` present on `source`, whatever its type. */
function first(source: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = property(source, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * Where usage is looked for, in order.
 *
 * Agent tools nest it differently — some put it at the top level, some
 * under a `usage` object, some under the tool's own response. All three are
 * tried and the first that yields a recognised field wins; the order is
 * fixed so the same payload always meters the same way.
 */
const USAGE_CONTAINERS = ["usage", "token_usage", "tokenUsage"] as const;

const INPUT_KEYS = ["input_tokens", "inputTokens"] as const;
const OUTPUT_KEYS = ["output_tokens", "outputTokens"] as const;
const CACHE_WRITE_KEYS = [
  "cache_creation_input_tokens",
  "cache_write_tokens",
  "cacheWriteTokens",
] as const;
const CACHE_READ_KEYS = [
  "cache_read_input_tokens",
  "cache_read_tokens",
  "cacheReadTokens",
] as const;
const MODEL_KEYS = ["model", "model_id", "modelId"] as const;
const EFFORT_KEYS = ["effort", "reasoning_effort", "reasoningEffort"] as const;
const USAGE_5H_KEYS = ["usage_5h", "usage5h"] as const;
const USAGE_WEEKLY_KEYS = ["usage_weekly", "usageWeekly"] as const;

/**
 * Reads the usage off a raw hook payload.
 *
 * Always succeeds. An entirely unrecognised payload yields an object with
 * no fields set, which `buildRecord` turns into zero counts and no model —
 * a record that says "this tool call happened and nothing was reported
 * about it", which is true and useful, rather than no record at all.
 *
 * The top level and the nested containers are both consulted, with the
 * nested one winning where both carry a field: a tool that reports both is
 * far more likely to have a stale top-level copy than a stale nested one,
 * because the nested object is the shape the vendor APIs actually emit.
 */
export function readReportedUsage(raw: unknown): ReportedUsage {
  const containers: unknown[] = [];
  for (const key of USAGE_CONTAINERS) {
    const nested = property(raw, key);
    if (nested !== undefined && nested !== null) containers.push(nested);
  }
  containers.push(raw);

  const pick = (keys: readonly string[]): unknown => {
    for (const container of containers) {
      const value = first(container, keys);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const numeric = (keys: readonly string[]): number | undefined => {
    const value = pick(keys);
    return typeof value === "number" ? value : undefined;
  };

  const text = (keys: readonly string[]): string | undefined => {
    const value = pick(keys);
    return typeof value === "string" ? value : undefined;
  };

  const inputTokens = numeric(INPUT_KEYS);
  const outputTokens = numeric(OUTPUT_KEYS);
  const cacheWriteTokens = numeric(CACHE_WRITE_KEYS);
  const cacheReadTokens = numeric(CACHE_READ_KEYS);
  const model = text(MODEL_KEYS);
  const effort = text(EFFORT_KEYS);
  const usage5h = numeric(USAGE_5H_KEYS);
  const usageWeekly = numeric(USAGE_WEEKLY_KEYS);

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(usage5h === undefined ? {} : { usage5h }),
    ...(usageWeekly === undefined ? {} : { usageWeekly }),
  };
}

/**
 * The paths a tool call touched, as the payload reports them.
 *
 * A single path field (a Write's `file_path`) reads as a one-element list,
 * because the consumer measures spread and a spread of one is a real
 * measurement. `capPaths` does the capping; this only locates them.
 */
const PATH_LIST_KEYS = ["paths", "file_paths", "filePaths"] as const;
const PATH_SINGLE_KEYS = ["file_path", "filePath", "path", "notebook_path"] as const;

export function readReportedPaths(raw: unknown): readonly string[] | undefined {
  const toolInput = property(raw, "tool_input") ?? property(raw, "toolInput");
  for (const source of [toolInput, raw]) {
    const list = first(source, PATH_LIST_KEYS);
    if (Array.isArray(list)) return list.filter((one): one is string => typeof one === "string");
    const single = first(source, PATH_SINGLE_KEYS);
    if (typeof single === "string" && single.length > 0) return [single];
  }
  return undefined;
}
