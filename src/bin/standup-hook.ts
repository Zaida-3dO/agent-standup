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
// of rules that no longer live in this script.

import { runHook } from "@/lib/hook/run";
import { createHttpAsk } from "@/lib/hook/ask-http";
import { HOOK_EXIT } from "@/lib/hook/response";
import { spoolEvent } from "@/lib/cli/hook-command";
import { fileSpool, spoolPath } from "@/lib/cli/spool-file";
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

  spoolEvent(stdin, fileSpool(spoolPath(env)), now);

  return rendered.exitCode;
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
