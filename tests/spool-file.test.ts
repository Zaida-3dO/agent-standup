// The telemetry spool as an actual file — `src/lib/cli/spool-file.ts`.
//
// This module is the one place the spool stops being a value and becomes
// filesystem calls, so it is the one place its properties cannot be proven
// by passing strings around. It had no test file until row 636f640b, which
// is how `fileAppendCounter` could be added: a stub returning a constant
// `0` passed the entire 5,000-test suite, because nothing anywhere asserted
// that the counter *advances*.
//
// That matters more than it looks. The counter is what paces the write-path
// ceiling, and the hook is a **fresh process per tool call** — so a counter
// that does not advance across processes is a ceiling that never fires, in
// exactly the deployment the ceiling exists for. It would look wired and do
// nothing, which is the failure mode row 636f640b was filed about in the
// first place.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileAppendCounter, fileSpool, spoolPath } from "@/lib/cli/spool-file";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "standup-spool-file-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function scratchFile(name: string): string {
  return path.join(scratch, name);
}

/** A `ProcessEnv` from a plain object, so a case states only what it sets. */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("spoolPath resolves where the spool lives", () => {
  it("prefers an explicit STANDUP_SPOOL", () => {
    expect(spoolPath(env({ STANDUP_SPOOL: "/tmp/custom.jsonl", HOME: "/home/x" }))).toBe(
      "/tmp/custom.jsonl",
    );
  });

  it("ignores a blank override rather than treating it as a path", () => {
    // A blank env var is how a shell spells "unset" by accident, and
    // honouring it would resolve the spool to the process's cwd.
    expect(spoolPath(env({ STANDUP_SPOOL: "   ", HOME: "/home/x" }))).toBe(
      path.join("/home/x", ".standup", "telemetry.jsonl"),
    );
  });

  it("falls back to the home directory", () => {
    expect(spoolPath(env({ HOME: "/home/x" }))).toBe(
      path.join("/home/x", ".standup", "telemetry.jsonl"),
    );
  });
});

describe("fileSpool reads and writes the spool", () => {
  it("appends without disturbing what is already there", () => {
    const file = scratchFile("append.jsonl");
    const spool = fileSpool(file);
    spool.append("one\n");
    spool.append("two\n");
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("creates the directory it is pointed at", () => {
    const file = path.join(scratch, "nested", "deeper", "spool.jsonl");
    fileSpool(file).append("line\n");
    expect(readFileSync(file, "utf8")).toBe("line\n");
  });

  it("reads a missing spool as undefined rather than throwing", () => {
    // The ordinary state before the first tool call. A throw here would
    // reach the hook.
    expect(fileSpool(scratchFile("absent.jsonl")).read()).toBe(undefined);
  });

  it("replace discards what was there", () => {
    const file = scratchFile("replace.jsonl");
    const spool = fileSpool(file);
    spool.append("old\n");
    spool.replace("new\n");
    expect(readFileSync(file, "utf8")).toBe("new\n");
  });
});

describe("fileAppendCounter paces the write-path ceiling", () => {
  it("answers 0 for a spool that does not exist", () => {
    // Never triggers a trim, which is right: there is nothing to trim, and
    // a number that happened to hit the interval would schedule a read and
    // rewrite of a file that is not there.
    expect(fileAppendCounter(scratchFile("no-such.jsonl"))()).toBe(0);
  });

  it("advances as the spool grows", () => {
    // **The assertion that kills a constant-returning counter.** A stub
    // returning 0 (or any fixed value) passes every other test in this
    // repo; it fails here, because this is the only place the counter's
    // one job — advancing with the file — is actually stated.
    const file = scratchFile("counter.jsonl");
    writeFileSync(file, "");
    const counter = fileAppendCounter(file);
    const empty = counter();

    // Written as bytes rather than as records because the counter is a
    // proxy for appends derived from size; 60_000 bytes is comfortably
    // more than one record's worth however the divisor is tuned.
    writeFileSync(file, "x".repeat(60_000));
    const grown = counter();

    expect(empty).toBe(0);
    expect(grown).toBeGreaterThan(empty);
  });

  it("reports the same count to a different process reading the same file", () => {
    // The property the whole design turns on: the hook is a fresh process
    // per tool call, so the count must live in the file rather than in
    // memory. Two independently-constructed counters stand in for two
    // processes.
    const file = scratchFile("cross-process.jsonl");
    writeFileSync(file, "y".repeat(30_000));
    expect(fileAppendCounter(file)()).toBe(fileAppendCounter(file)());
    expect(fileAppendCounter(file)()).toBeGreaterThan(0);
  });
});
