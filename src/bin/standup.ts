#!/usr/bin/env node
// The `standup` binary. The only module in this build that touches
// `process` — everything it does is read four things off it and hand them
// to `main`, which returns the exit code.
//
// `slice(2)` drops the node binary and this script's own path, so `argv`
// below is what a person typed and nothing else. Row #89 publishes this as
// the package's `bin`; nothing about the entry point changes when it does.
import { main } from "@/lib/cli/main";
import { readConfigFile } from "@/lib/cli/config-file";
import { createHttpFlush } from "@/lib/hook/flush-http";
import { fileSpool, spoolPath } from "@/lib/cli/spool-file";

// The local configuration file `standup init` writes (row #80) — read once,
// synchronously, at process start. Every command after this one sees it as
// the lowest tier of "flag, then environment, then the configuration file"
// (SCHEMA.md §20); a file that doesn't exist or can't be parsed reads back
// as `{}`, never a crash (see `readConfigFile`).
const file = readConfigFile();

// The edges `standup hook` needs (MILESTONES.md #88). Built here rather
// than inside the command for the reason the whole adapter is shaped this
// way: this is the only module that may touch the filesystem, the clock and
// the network, so the spool and the sender are constructed at the one
// boundary that is allowed to know they are real.
//
// `hook run` is served by the dedicated hook entry point rather than by
// this binary — it needs stdin, and reading stdin unconditionally here
// would make every `standup` command wait for input that never comes. So
// no `stdin` is supplied: the verbs reachable through this binary are
// `flush` and `status`, and `run` refuses for want of a payload, which is
// the honest answer when it was invoked without one.
const baseUrl = process.env.STANDUP_URL?.trim();
const exitCode = await main(process.argv.slice(2), {
  env: process.env,
  file,
  hook: {
    spool: fileSpool(spoolPath(process.env)),
    now: Date.now(),
    ...(baseUrl === undefined || baseUrl === ""
      ? {}
      : { send: createHttpFlush({ baseUrl, fetch: globalThis.fetch as never }) }),
  },
  streams: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
});

process.exitCode = exitCode;
