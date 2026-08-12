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

// The local configuration file `standup init` writes (row #80) — read once,
// synchronously, at process start. Every command after this one sees it as
// the lowest tier of "flag, then environment, then the configuration file"
// (SCHEMA.md §20); a file that doesn't exist or can't be parsed reads back
// as `{}`, never a crash (see `readConfigFile`).
const exitCode = await main(process.argv.slice(2), {
  env: process.env,
  file: readConfigFile(),
  streams: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
});

process.exitCode = exitCode;
