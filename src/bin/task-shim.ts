#!/usr/bin/env node
// The `task` binary — MILESTONES.md #39's compatibility shim. Kept for one
// release (DECISIONS.md §11) and removed at #40; see `src/lib/task-shim/`
// for the surface it keeps unchanged while it exists.
//
// Same shape as `standup.ts`: the only module that touches `process`,
// everything else takes its I/O as arguments.
import { run } from "@/lib/task-shim";

const exitCode = await run(process.argv.slice(2), {
  env: process.env,
  streams: {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
});

process.exitCode = exitCode;
