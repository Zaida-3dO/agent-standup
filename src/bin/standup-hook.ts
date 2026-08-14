#!/usr/bin/env node
// The hook script — MILESTONES.md #42. **This is the "one file" that gets
// wired to both `PostToolUse` and `Stop`** (DECISIONS.md §4); it branches on
// the event type read from stdin rather than being installed twice.
//
// Same posture as `standup.ts`: this is the only module in the hook build
// that touches `process`, the filesystem or the network. It reads stdin,
// resolves where the server and the cache live, calls `runHook`, and writes
// what comes back. Everything that decides anything is under
// `@/lib/hook/**` and is exercised without a process.
//
// **Nothing here can throw its way to a silent allow.** The whole body is
// wrapped, and the fallback for an unexpected failure is a deny written to
// both channels — because a hook that dies before printing produces an empty
// stdout and (depending on the tool) an exit code the tool reads as "no
// objection". A guard's worst failure mode is being absent while appearing
// present.

import { runHook } from "@/lib/hook/run";
import { createHttpAsk } from "@/lib/hook/ask-http";
import { createKillGuardAsk } from "@/lib/hook/ask-kill-guard";
import { HOOK_EXIT } from "@/lib/hook/response";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Reads stdin to the end. Empty string if there is nothing on it. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Where the cached rule lists live.
 *
 * `STANDUP_HOOK_CACHE` wins so an installation can put it somewhere
 * specific; otherwise it sits beside the user's other per-user state. It is
 * a cache in the strict sense — deleting it costs one extra request, never
 * correctness — which is why no effort is spent on making the location
 * survive a home-directory move.
 */
function cachePath(env: NodeJS.ProcessEnv): string {
  const configured = env.STANDUP_HOOK_CACHE;
  if (configured !== undefined && configured.trim() !== "") return configured.trim();
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return path.join(home, ".standup", "hook-rules.json");
}

function readCacheFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

function writeCacheFile(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
}

async function main(): Promise<number> {
  const env = process.env;
  const baseUrl = env.STANDUP_URL?.trim();

  // With no server configured there is nothing to ask. That is not a deny of
  // everything: the cached lists still classify locally, and a command that
  // needs a verdict is denied by `decide` on the ordinary "could not get an
  // answer" path — with a reason naming it — rather than by a special case
  // here that would have to be kept in step with that one.
  const askServer =
    baseUrl === undefined || baseUrl === ""
      ? async () => undefined
      : createHttpAsk({ baseUrl, fetch: globalThis.fetch as never });

  // The ownership check (MILESTONES.md #45). It needs a machine name, and
  // there is no honest default for one: a process id is only meaningful per
  // host, so guessing the host would make the guard compare the caller's
  // pids against another machine's registrations. With no machine resolved
  // the guard is simply not installed, which `decide` treats as "no
  // ownership check configured" rather than as a refusal of every kill.
  const machine = env.STANDUP_MACHINE?.trim();
  const rootSessionId = env.STANDUP_ROOT_SESSION_ID?.trim();
  const askKillGuard =
    baseUrl === undefined || baseUrl === "" || machine === undefined || machine === ""
      ? undefined
      : createKillGuardAsk({
          baseUrl,
          fetch: globalThis.fetch as never,
          machine,
          ...(rootSessionId === undefined || rootSessionId === "" ? {} : { rootSessionId }),
        });

  const file = cachePath(env);
  const rendered = await runHook({
    stdin: await readStdin(),
    cacheText: readCacheFile(file),
    writeCache: (text) => writeCacheFile(file, text),
    askServer,
    ...(askKillGuard === undefined ? {} : { askKillGuard }),
    now: Date.now(),
  });

  if (rendered.stdout !== "") process.stdout.write(rendered.stdout);
  if (rendered.stderr !== "") process.stderr.write(rendered.stderr);
  return rendered.exitCode;
}

try {
  process.exitCode = await main();
} catch (cause) {
  // The last resort, and it denies. The cause's *class* is named and its
  // message is not, for the reason `cli/main.ts` states: an unexpected
  // failure's text is written for a log and routinely contains a path, a
  // host or a connection string, and a person reading a terminal must not be
  // shown a credential.
  const reason =
    `the hook failed unexpectedly (${cause instanceof Error ? cause.name : "unknown error"}) ` +
    `and denies rather than allowing a command it never examined`;
  process.stdout.write(
    `${JSON.stringify({
      decision: "deny",
      reason,
      source: "no-rules",
      hookSpecificOutput: {
        hookEventName: "Unknown",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.stderr.write(`${reason}\n`);
  process.exitCode = HOOK_EXIT.DENY;
}
