#!/usr/bin/env node
// The hook script — MILESTONES.md #125. **This is the "one file" that gets
// wired to `PreToolUse`, `PostToolUse` and `Stop`** (DECISIONS.md §4); it
// branches on the event type read from stdin rather than being installed
// three times.
//
// Same posture as `standup.ts`: this is the only module in the hook build
// that touches `process`, the filesystem or the network. It reads stdin,
// resolves where the server lives, calls `runHook`, and writes what comes
// back. Everything that decides anything is server-side.
//
// **Nothing here can throw its way to a refusal.** The whole body is
// wrapped, and the fallback for an unexpected failure is an *allow* — see
// DECISIONS.md §16. A hook that crashes has enforced nothing; refusing the
// call on its way out would refuse a command it never examined, on behalf
// of rules that live server-side and were never consulted.

import { runHook } from "@/lib/hook/run";
import { createHttpAsk } from "@/lib/hook/ask-http";
import { HOOK_EXIT } from "@/lib/hook/response";
import { spoolEvent } from "@/lib/cli/hook-command";
import { fileSpool, fileAppendCounter, spoolPath } from "@/lib/cli/spool-file";
import { flushSpool } from "@/lib/hook/flush";
import { createHttpFlush } from "@/lib/hook/flush-http";
import { parseHookPayload } from "@/lib/hook/payload";
// The version this script declares it speaks (SCHEMA.md §21). It lives in
// its own module rather than here because this file's body runs on import —
// it reads stdin to the end — so a constant exported from it could not be
// read by the assertion that checks it against the server's.
import { HOOK_PROTOCOL_VERSION } from "@/lib/hook/protocol";

/** Reads stdin to the end. Empty string if there is nothing on it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<number> {
  const env = process.env;

  // `--protocol-version` is the one thing this script answers without
  // reading stdin. An installer (row #48) needs the number to put in a
  // registration, and the alternative — parsing it out of the built bundle,
  // or hard-coding it in the installer — is a second place the version
  // lives and therefore a second place it can be stale.
  if (process.argv.includes("--protocol-version")) {
    process.stdout.write(`${HOOK_PROTOCOL_VERSION}\n`);
    return HOOK_EXIT.ALLOW;
  }

  const baseUrl = env.STANDUP_URL?.trim();

  // With no server configured there is nothing to ask, and nothing to ask
  // means nothing to enforce. That resolves through `decide`'s ordinary "no
  // answer" path — which allows, with a reason naming it — rather than
  // through a special case here that would have to be kept in step with it.
  const askServer =
    baseUrl === undefined || baseUrl === ""
      ? async () => undefined
      : createHttpAsk({ baseUrl, fetch: globalThis.fetch as never });

  const stdin = await readStdin();
  const now = Date.now();
  const rendered = await runHook({ stdin, askServer, now });

  // The verdict is written before the record is spooled, and the record is
  // spooled before the process exits — MILESTONES.md #88. Deciding first
  // keeps the filesystem off the front of the fastest and most common path,
  // and a hook killed between the two loses a measurement rather than
  // delaying a decision.
  //
  // `spoolEvent` swallows every failure it can have, so nothing about
  // telemetry can turn into a delayed tool call. That is deliberate and is
  // the reason there is no `try` around this line: adding one here would
  // suggest it can throw, and the next person to read it would wonder what
  // happens to the verdict when it does.
  if (rendered.stdout !== "") process.stdout.write(rendered.stdout);
  if (rendered.stderr !== "") process.stderr.write(rendered.stderr);

  const spool = fileSpool(spoolPath(env));
  spoolEvent(stdin, spool, now, { appendCounter: fileAppendCounter(spoolPath(env)) });

  // ── The drain (MILESTONES.md #88's "batched flush") ───────────────────
  //
  // Until this existed the `http` variant had **no flush path at all**:
  // `flush-http.ts` was built and tested, but its only caller was the
  // `standup hook flush` CLI verb, which nothing in a hook-only
  // installation invokes. Telemetry was therefore collected diligently,
  // written forever and read by nobody — 28 MB in ten days on the machine
  // that found it.
  //
  // It hangs off `Stop` rather than off a daemon, a scheduler or a
  // per-call send, because `Stop` is already an event this script is
  // installed for and already parses. That satisfies #88's requirement
  // that the flush be *batched and off the critical path* by construction
  // rather than by promise: a `Stop` fires once at the end of an agent's
  // turn, after the last tool call has returned, so nothing is waiting on
  // the tool-call path for it. Sending per `PostToolUse` would be the
  // per-call connection §13f exists to forbid.
  if (isStop(stdin)) await drain(spool, baseUrl, env);

  return rendered.exitCode;
}

/** Whether this payload is the end-of-turn event the drain hangs off. */
function isStop(stdin: string): boolean {
  const parsed = parseHookPayload(stdin);
  return parsed.ok && parsed.event.eventType === "Stop";
}

/**
 * Sends what has spooled, and never lets that matter to the hook.
 *
 * **This function cannot fail.** Every failure mode of a flush — an
 * unreachable server, a refused shape, a timeout, an unwritable spool — is
 * swallowed here, because the alternative is a hook that delays or breaks a
 * session over telemetry. That is the trade stated plainly: *lost telemetry
 * is much cheaper than a hung session.* `flushSpool` already never throws
 * and `createHttpFlush` already collapses every failure to `false`; the
 * `try` is the belt to their braces, covering the filesystem calls around
 * them that have no such guarantee.
 *
 * The spool is rewritten only when the flush changed it, and only with what
 * the server did **not** acknowledge — `flushSpool` is at-least-once by
 * design, so a record is dropped from the file only after something took
 * it. A failed flush leaves the file exactly as it was, to be retried on
 * the next `Stop`.
 */
async function drain(
  spool: ReturnType<typeof fileSpool>,
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // With no server there is nothing to drain to. The write-path ceiling in
  // `spoolEvent` is what bounds the file in that case, which is why the
  // cap is not conditional on the drain being configured.
  if (baseUrl === undefined || baseUrl === "") return;

  try {
    const text = spool.read();
    if (text === undefined || text.length === 0) return;

    const result = await flushSpool({
      spoolText: text,
      send: createHttpFlush({
        baseUrl,
        fetch: globalThis.fetch as never,
        // The ingest authenticates unconditionally, so a tokenless flush is
        // a permanent `401` and the spool would fill to its ceiling in
        // silence. Read from the environment for the same reason the URL
        // is: this script is configured by the thing that installs it.
        ...(env.STANDUP_TOKEN === undefined || env.STANDUP_TOKEN.trim() === ""
          ? {}
          : { token: env.STANDUP_TOKEN.trim() }),
        ...(flushTimeoutMs(env) === undefined ? {} : { timeoutMs: flushTimeoutMs(env) as number }),
      }),
    });

    // Nothing acknowledged and nothing dropped means the file is unchanged,
    // and rewriting it would be a full write of identical bytes.
    if (result.sent === 0 && result.dropped === 0 && result.skipped === 0) return;
    spool.replace(result.remaining);
  } catch {
    // Deliberately silent. A message on stderr here would be written into
    // the transcript of every turn whose server is down, which is noise
    // about a subsystem the session does not depend on. `standup hook
    // status` is where someone asks how much is waiting.
  }
}

/** An override for the flush timeout, for an installation that needs a shorter one. */
function flushTimeoutMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.STANDUP_FLUSH_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  // A non-numeric or negative override is ignored rather than being allowed
  // to become `NaN`, which `AbortSignal.timeout` would reject and which
  // would turn a typo in an env var into a flush that never runs.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

try {
  process.exitCode = await main();
} catch (cause) {
  // The last resort, and it **allows** (DECISIONS.md §16). The cause's
  // *class* is named and its message is not, for the reason `cli/main.ts`
  // states: an unexpected failure's text is written for a log and routinely
  // contains a path, a host or a connection string, and a person reading a
  // terminal must not be shown a credential.
  //
  // The note goes to stderr only. stdout stays empty because that is what
  // an allow looks like on this protocol, and printing a JSON object there
  // would have to name a decision — which is precisely the thing this
  // branch has failed to reach.
  process.stderr.write(
    `the hook failed unexpectedly (${cause instanceof Error ? cause.name : "unknown error"}) ` +
      `and allows rather than refusing a command it never examined\n`,
  );
  process.exitCode = HOOK_EXIT.ALLOW;
}
