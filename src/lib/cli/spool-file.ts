// The telemetry spool as an actual file — MILESTONES.md #88.
//
// This is the one module that turns the injected `SpoolStore` into
// filesystem calls, and it is shared by both entry points: the hook script
// (`src/bin/standup-hook.ts`, which appends after every tool call) and the
// `standup` binary (`src/bin/standup.ts`, which flushes and reports). They
// must agree on **where the spool is** — a flush that read a different path
// from the one the hook writes would report an empty spool forever while
// telemetry piled up somewhere else — so the resolution lives here once
// rather than being written out in each entry point.
//
// It sits under `src/lib/cli/` rather than `src/lib/hook/` for a structural
// reason, not a filing one: everything under `src/lib/hook/**` is asserted
// to be free of `node:fs` and `process` (`tests/hook-script-boundaries.test.ts`),
// because that property is what makes every refusal in the hook testable as
// a value in and a value out. A filesystem module belongs on the other side
// of that line.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SpoolStore } from "./hook-command";

/**
 * Where the telemetry spool lives.
 *
 * Beside the hook's rules cache and resolved the same way, because they are
 * the same kind of thing: per-user local state that an installation may
 * want to relocate. `STANDUP_SPOOL` overrides it for the same reason
 * `STANDUP_HOOK_CACHE` overrides that one.
 *
 * Unlike the cache, though, **this file is not disposable.** Deleting the
 * cache costs one extra request; deleting the spool loses measurements that
 * cannot be recreated, since §10's history is measured rather than derived.
 * That is worth knowing before choosing to put it somewhere temporary.
 */
export function spoolPath(env: NodeJS.ProcessEnv): string {
  const configured = env.STANDUP_SPOOL;
  if (configured !== undefined && configured.trim() !== "") return configured.trim();
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return path.join(home, ".standup", "telemetry.jsonl");
}

/**
 * The spool, backed by a file.
 *
 * `append` is `appendFileSync` and nothing else — the whole performance
 * argument in `@/lib/hook/spool` is that the write path, which runs on the
 * critical path of every tool call, is one append with no read, no parse
 * and no rewrite. This is where that has to actually be true.
 *
 * **None of these swallow their own failures.** `spoolEvent` does, once, at
 * the point where the consequence is decided — that a failed measurement is
 * never a failed hook. Catching here as well would mean two places deciding
 * the same thing, and the second one to be edited would be the one that got
 * it wrong.
 */
export function fileSpool(file: string): SpoolStore {
  return {
    append: (line) => {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, line, "utf-8");
    },
    read: () => {
      try {
        return readFileSync(file, "utf-8");
      } catch {
        // A spool that is not there yet is an empty spool, which is the
        // ordinary state before the first tool call. Distinguishing it from
        // an unreadable one would buy nothing: both mean "nothing to send".
        return undefined;
      }
    },
    replace: (text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, "utf-8");
    },
  };
}
