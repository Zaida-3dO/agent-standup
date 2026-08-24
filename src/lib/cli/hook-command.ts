// `standup hook` (MILESTONES.md #88) — the hook, reachable as a command
// rather than only as an installed script.
//
// Row #41 already names the shape this completes: "The route is one caller;
// `standup hook` is another." The decision itself lives in the service
// layer and is reached the same way from both; what this command adds is
// the *client* half — read the payload from stdin, spool a telemetry record
// for it, and answer.
//
// ── Why this is a command and not just the script ──────────────────────
//
// Three things the script alone cannot give:
//
//   - **One installed binary.** Row #48 packages "MCP config, hook config,
//     and the command line in one install". A hook configured as
//     `standup hook` is the same executable an installation already has on
//     its path, so there is no second artefact to version, locate or keep
//     executable.
//   - **A flush that is not on the critical path.** `standup hook flush`
//     sends what has accumulated, and can be run by anything — a stop hook,
//     a scheduled task, a person — without a tool call waiting on it.
//   - **Somewhere to look.** `standup hook status` reads the spool and says
//     how much is waiting and how much of it is unreadable, which is the
//     first question anyone asks when telemetry looks thin.
//
// ── The envelope, and the one place this command leaves it ─────────────
//
// `flush` and `status` answer in the ordinary `Envelope`, like every other
// command. **`standup hook run` does not**, and cannot: its caller is an
// agent tool that reads a specific JSON shape on stdout and a specific exit
// code (`../hook/response.ts`), and wrapping that in `{ok, data}` would
// produce a response no hook reader understands. So it returns the rendered
// response for the entry point to write verbatim. That divergence is the
// whole reason this module exists as its own file rather than as three more
// rows in `COMMANDS`, where every entry is an operation call whose result
// becomes an envelope.
//
// Nothing here touches the filesystem or the process. The spool is read and
// written through injected functions, exactly as `../hook/run.ts` takes the
// rules cache — which is what keeps a full disk, an unreadable spool and an
// unreachable server testable as values.

import { runHook, type RunHookOptions } from "@/lib/hook/run";
import { parseHookPayload } from "@/lib/hook/payload";
import { buildRecord, type SpooledToolCall } from "@/lib/hook/spool-record";
import { readReportedPaths, readReportedUsage } from "@/lib/hook/usage";
import {
  serialiseRecord,
  readSpool,
  serialiseSpool,
  trimSpool,
  shouldTrimOnAppend,
  DEFAULT_MAX_RECORDS,
  DEFAULT_TRIM_INTERVAL,
} from "@/lib/hook/spool";
import { flushSpool, type SendBatch } from "@/lib/hook/flush";
import type { RenderedResponse } from "@/lib/hook/response";
import { EXIT, malformed, ok, type Envelope, type ExitCode } from "./envelope";

/** The verbs `standup hook` accepts. */
export const HOOK_VERBS = ["run", "flush", "status"] as const;
export type HookVerb = (typeof HOOK_VERBS)[number];

export function isHookVerb(value: unknown): value is HookVerb {
  return typeof value === "string" && (HOOK_VERBS as readonly string[]).includes(value);
}

/**
 * The spool, as this command reaches it.
 *
 * Three operations, because that is exactly what the two paths need and no
 * more: `run` adds a line, `flush` reads and rewrites, `status` reads.
 * Adding a line is a separate operation from rewriting the whole file for a
 * reason the performance argument in `../hook/spool.ts` turns on: the write
 * path is an append with no read, and an interface offering only a whole-file
 * write would force every tool call to read the file first.
 */
export interface SpoolStore {
  /** Appends one serialised line. */
  readonly append: (line: string) => void;
  /** The spool's whole contents, or `undefined` when there is no file. */
  readonly read: () => string | undefined;
  /** Writes the spool's whole contents, discarding what was there. */
  readonly replace: (text: string) => void;
}

export interface HookCommandOptions {
  readonly verb: HookVerb;
  /** The payload the agent tool wrote. Only `run` uses it. */
  readonly stdin?: string;
  readonly spool: SpoolStore;
  /** Epoch milliseconds. Injected, as everywhere in the hook. */
  readonly now: number;
  /** Everything `runHook` needs. Only `run` uses it. */
  readonly hook?: Omit<RunHookOptions, "stdin" | "now">;
  /** Sends one batch. Only `flush` uses it. */
  readonly send?: SendBatch;
  readonly batchSize?: number;
  readonly maxRecords?: number;
  /** Paces the write-path ceiling. Only `run` uses it. See `SpoolCeilingOptions`. */
  readonly appendCounter?: () => number;
  readonly trimInterval?: number;
}

/**
 * What one `standup hook` invocation produced.
 *
 * Exactly one of `response` and `envelope` is set, which is the type-level
 * statement of the divergence described in the header: `run` answers a hook
 * reader, the others answer a person.
 */
export type HookCommandOutcome =
  | { readonly kind: "hook-response"; readonly response: RenderedResponse }
  | { readonly kind: "envelope"; readonly envelope: Envelope; readonly exitCode: ExitCode };

/**
 * What `spoolEvent` needs to keep the spool bounded.
 *
 * Optional in full: a caller that passes nothing gets exactly the previous
 * behaviour (append, never trim), which keeps this additive for the
 * `standup hook run` path whose ceiling the flush already enforces.
 */
export interface SpoolCeilingOptions {
  /**
   * How many appends this process has made, including the one just made.
   *
   * A function rather than a number because the count has to advance per
   * append, and the entry point that owns the count is the only thing that
   * can say what it is. See `../cli/spool-file.ts` for the persistent
   * counter the hook script uses — a per-process count would never reach
   * the interval, since the hook script is a fresh process per tool call.
   */
  readonly appendCounter?: () => number;
  readonly maxRecords?: number;
  readonly trimInterval?: number;
}

/**
 * Spools one event, if it is worth spooling.
 *
 * **Every failure here is swallowed**, and that is the single most important
 * property in this file. Spooling is measurement; the hook's job is to
 * decide whether a command may run. A full disk, a read-only home directory
 * or a spool file owned by another user must not turn into a denied tool
 * call — the hook would be refusing work for a reason that has nothing to
 * do with whether the work is safe, which is precisely the failure mode
 * `../hook/run.ts` already refuses to accept for the rules cache ("a cache
 * that cannot be written is a slower hook, not a wrong one").
 *
 * Returns the record it wrote, for the caller to report; `undefined` when
 * there was nothing to spool or the write failed. The two are not
 * distinguished, because no caller acts differently on them.
 */
export function spoolEvent(
  raw: string,
  spool: SpoolStore,
  now: number,
  options?: SpoolCeilingOptions,
): SpooledToolCall | undefined {
  const parsed = parseHookPayload(raw);
  if (!parsed.ok) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Unreachable in practice — `parseHookPayload` already parsed it — but
    // this function is called on the critical path and a throw here would
    // be a thrown exception in a hook, so it is handled rather than assumed
    // away.
    return undefined;
  }

  const record = buildRecord({
    event: parsed.event,
    now,
    usage: readReportedUsage(payload),
    paths: readReportedPaths(payload),
  });
  if (record === undefined) return undefined;

  try {
    spool.append(serialiseRecord(record));
    enforceCeiling(spool, options);
  } catch {
    return undefined;
  }
  return record;
}

/**
 * Keeps the spool under its ceiling, occasionally.
 *
 * This is the write path's half of a ceiling that already existed but could
 * only ever be reached from the *flush* path (`../hook/flush.ts`). That was
 * the bug: in a deployment whose hook never flushes, `trimSpool` is real,
 * tested and unreachable, and the file grows without limit while the code
 * plainly contains a limit. A ceiling enforced only by the path that may
 * never run is not a ceiling.
 *
 * It runs once every `trimInterval` appends rather than on every one,
 * because a bare append is the entire performance argument in
 * `../hook/spool.ts`. The cost is a bounded overshoot, documented on
 * `DEFAULT_TRIM_INTERVAL`.
 *
 * **Every failure is swallowed by the caller's `try`, and that is
 * deliberate.** Trimming is housekeeping on a measurement; it must never
 * cost a tool call. Note the ordering: the append happens *before* this, so
 * a trim that throws loses the trim, never the record it was called to make
 * room for.
 */
function enforceCeiling(spool: SpoolStore, options: SpoolCeilingOptions | undefined): void {
  const interval = options?.trimInterval ?? DEFAULT_TRIM_INTERVAL;
  const counter = options?.appendCounter;
  // With no counter there is nothing to pace against. Trimming on every
  // append instead would silently put a whole-file read and rewrite on the
  // critical path of every tool call — the one thing this file's design
  // forbids — so the honest response to a missing counter is to leave the
  // ceiling to the flush path.
  if (counter === undefined) return;
  if (!shouldTrimOnAppend(counter(), interval)) return;

  const text = spool.read();
  const { records } = readSpool(text);
  const trimmed = trimSpool(records, options?.maxRecords ?? DEFAULT_MAX_RECORDS);
  // Rewriting an unchanged file would be a full write of identical bytes,
  // and this runs while an agent is waiting.
  if (trimmed.dropped === 0) return;
  spool.replace(serialiseSpool(trimmed.records));
}

/**
 * Runs one `standup hook` invocation.
 *
 * The order inside `run` is deliberate: **the decision is made first, and
 * the record is spooled second.** Spooling before deciding would put a
 * filesystem write in front of every verdict, so the slowest thing in the
 * hook would sit on the path of the fastest and most common case (an
 * allow-listed command, which §4 optimises to zero network). Deciding first
 * also means a hook that is killed between the two loses a measurement
 * rather than delaying a decision, which is the correct thing to lose.
 */
export async function runHookCommand(options: HookCommandOptions): Promise<HookCommandOutcome> {
  if (options.verb === "run") {
    const stdin = options.stdin ?? "";
    const response = await runHook({
      stdin,
      now: options.now,
      askServer: options.hook?.askServer ?? (async () => undefined),
      ...(options.hook?.enforcement === undefined ? {} : { enforcement: options.hook.enforcement }),
    });

    spoolEvent(stdin, options.spool, options.now, {
      ...(options.appendCounter === undefined ? {} : { appendCounter: options.appendCounter }),
      ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
      ...(options.trimInterval === undefined ? {} : { trimInterval: options.trimInterval }),
    });
    return { kind: "hook-response", response };
  }

  if (options.verb === "status") {
    let text: string | undefined;
    try {
      text = options.spool.read();
    } catch {
      // An unreadable spool is a reportable state, not a failed command:
      // "I could not read it" is the answer someone running `status` is
      // asking for, and an error envelope would say less.
      text = undefined;
    }
    const contents = readSpool(text);
    const envelope = ok({
      pending: contents.records.length,
      unreadableLines: contents.skipped,
    });
    return { kind: "envelope", envelope, exitCode: EXIT.OK };
  }

  // `flush`.
  if (options.send === undefined) {
    // Reachable only from a caller that built this wrong — the binary
    // always supplies one — so it is refused as malformed input rather than
    // silently reporting a flush of zero, which would look like success.
    return {
      kind: "envelope",
      envelope: malformed("standup hook flush needs somewhere to send to", ["send"]),
      exitCode: EXIT.MALFORMED,
    };
  }

  let text: string | undefined;
  try {
    text = options.spool.read();
  } catch {
    text = undefined;
  }

  const result = await flushSpool({
    send: options.send,
    ...(text === undefined ? {} : { spoolText: text }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
  });

  // The spool is rewritten only when the flush changed it. A flush that
  // sent nothing and dropped nothing has nothing to write, and rewriting
  // anyway would take a file that is only ever appended to and replace it
  // wholesale on every failed flush — turning an unreachable server into a
  // repeated full-file rewrite, and widening the window in which a crash
  // could tear one.
  const changed = result.sent > 0 || result.dropped > 0 || result.skipped > 0;
  if (changed) {
    try {
      options.spool.replace(result.remaining);
    } catch {
      // The records were accepted by the server; failing to shorten the
      // spool means they will be sent again (`../hook/flush.ts` — the flush
      // is at-least-once by design). Reporting the flush as failed here
      // would be less true than reporting what actually happened.
    }
  }

  return {
    kind: "envelope",
    envelope: ok({
      sent: result.sent,
      retained: result.retained,
      skipped: result.skipped,
      dropped: result.dropped,
      batches: result.attempted,
      stoppedEarly: result.stoppedEarly,
    }),
    exitCode: EXIT.OK,
  };
}
