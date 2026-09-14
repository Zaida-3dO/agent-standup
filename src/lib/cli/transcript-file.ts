// Reading the session transcript off disk — MILESTONES.md #88, SCHEMA.md §10.
//
// The filesystem half of `@/lib/hook/transcript-usage`. That module is pure
// and takes a file's *contents*; this one is the only place that turns a
// `transcript_path` into those contents, and it lives under `src/lib/cli/`
// for exactly the reason `./spool-file.ts` does: everything under
// `src/lib/hook/**` is asserted free of `node:fs` and `process`
// (`tests/hook-script-boundaries.test.ts`), because that property is what
// makes every refusal in the hook testable as a value in and a value out.
//
// ── The baseline file, and why the delta needs one ─────────────────────
//
// The transcript reports usage CUMULATIVELY — each assistant message adds
// to a running total for the session. The hook is a fresh process per tool
// call, so it cannot remember what it attributed last time; and re-reading
// the transcript from the top on every call would re-report the same turns
// on every call, inflating a session's tokens by roughly the number of tool
// calls in it. That is a far worse failure than reporting nothing, because
// it is a confident wrong number rather than a visible gap.
//
// So the last cumulative reading is persisted beside the spool, and each
// call spools the DIFFERENCE. The baseline is keyed by transcript path, so
// two concurrent sessions on one machine cannot consume each other's
// baseline and blank out each other's usage.
//
// **The baseline is disposable and the spool is not.** Losing it costs at
// most one call's attribution — the next reading re-baselines and carries
// on — which is why it is a plain JSON file with no locking and no
// recovery, and why every failure here is swallowed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  emptyTranscriptUsage,
  readTranscriptUsage,
  usageDelta,
  type TranscriptUsage,
} from "@/lib/hook/transcript-usage";

/**
 * Where the per-transcript baseline lives.
 *
 * Beside the spool rather than in the system temp directory: it is
 * per-user state whose lifetime should match the spool's, and a temp
 * directory that is cleared between reboots would silently re-baseline
 * every session after a restart.
 */
export function baselinePath(spoolFile: string): string {
  return path.join(path.dirname(spoolFile), "transcript-usage.json");
}

/** The whole baseline map, keyed by transcript path. Unreadable reads as empty. */
function readBaselines(file: string): Record<string, TranscriptUsage> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, TranscriptUsage>;
  } catch {
    // Absent is the ordinary state before the first call, and corrupt is
    // indistinguishable from it here on purpose — both mean "no baseline",
    // which re-baselines rather than mis-attributing.
    return {};
  }
}

/**
 * How many baselines are kept.
 *
 * The map is keyed by transcript path and nothing ever removes a key, so
 * without a bound it would grow by one entry per session forever. Kept
 * rather than cleared wholesale because a machine genuinely runs several
 * sessions at once and clearing would blank a live session's baseline.
 * Oldest-out by insertion order, which for this map is least-recently
 * written.
 */
const MAX_BASELINES = 64;

/**
 * Reads the usage this call should be attributed, and advances the baseline.
 *
 * Returns `undefined` when there is nothing to report — no transcript path,
 * an unreadable transcript, or a reading identical to the last one, which
 * is the common case for the many tool calls inside a single assistant
 * turn. `undefined` means "nothing measured", never "zero tokens were used".
 *
 * **Every failure is swallowed.** This runs on the critical path of every
 * tool call, and a telemetry reading that threw would be a thrown exception
 * in a hook. A missing file, a permissions error, a partially-written line:
 * all of them must read as no measurement, never as a denied tool call.
 */
export function readTranscriptDelta(
  transcriptPath: string | undefined,
  spoolFile: string,
): TranscriptUsage | undefined {
  if (transcriptPath === undefined || transcriptPath.trim() === "") return undefined;

  let contents: string;
  try {
    contents = readFileSync(transcriptPath, "utf-8");
  } catch {
    return undefined;
  }

  const current = readTranscriptUsage(contents);
  const file = baselinePath(spoolFile);
  const baselines = readBaselines(file);
  const previous = baselines[transcriptPath] ?? emptyTranscriptUsage();
  const delta = usageDelta(current, previous);

  try {
    // Re-inserting the key moves it to the end of the insertion order, so
    // the eviction below drops the least recently active session rather
    // than an arbitrary one.
    delete baselines[transcriptPath];
    baselines[transcriptPath] = current;
    const keys = Object.keys(baselines);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_BASELINES))) {
      delete baselines[stale];
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(baselines), "utf-8");
  } catch {
    // The reading is still returned. A baseline that could not be written
    // means the next call re-reports this delta — an over-count of one
    // call's usage — which is the lesser of the two failures available:
    // returning nothing here would lose the measurement outright, and the
    // write failing at all is already an unusual state.
  }

  const nothingNew =
    delta.inputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.cacheWriteTokens === 0 &&
    delta.cacheReadTokens === 0;
  // The model is still worth reporting on a zero delta: it is what lets a
  // run be priced at all, and a call that consumed no new tokens was still
  // served by a model.
  if (nothingNew && delta.model === undefined) return undefined;
  return delta;
}
