// The backfill window announces itself at application startup
// (MILESTONES.md #97, "the levels below `error`").
//
// `backfillStartupWarning` has returned a formatted line since it was
// written and had no caller — it was built to return rather than print "so
// the caller decides where it goes", and then no caller decided. This is the
// test for that caller.
//
// The behaviour that matters is the *silence*, not the line: "silence when
// disabled is what gives the line its meaning", and a warning that printed
// on every boot regardless would be scrolled past — which is the failure
// mode it exists to catch.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { announceBackfillWindow } from "@/instrumentation";
import { BACKFILL_ENV_VAR } from "@/lib/backfill/enabled";
import { captureLogs, oneRecord, type CapturedLogs } from "./helpers/capture-logs";

let logs: CapturedLogs;
let originalLevel: string | undefined;

/** The exact text the module writes, so a test asserts on the real line. */
const WARNING_PREFIX = "WARNING: backfill is ENABLED";

beforeEach(() => {
  originalLevel = process.env.LOG_LEVEL;
  logs = captureLogs();
});

afterEach(() => {
  logs.restore();
  if (originalLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLevel;
});

/** The one record whose `msg` starts with the warning text, if there is one. */
function warningRecord(records: readonly Record<string, unknown>[]) {
  const matches = records.filter(
    (record) => typeof record.msg === "string" && record.msg.startsWith(WARNING_PREFIX),
  );
  if (matches.length > 1) throw new Error(`Expected at most one warning, found ${matches.length}.`);
  return matches[0];
}

describe("announceBackfillWindow", () => {
  test("WRITES the warning when the window is open", async () => {
    await announceBackfillWindow({ [BACKFILL_ENV_VAR]: "true" });

    const record = warningRecord(logs.stderr());
    expect(record).toBeDefined();
    expect(record?.msg).toContain("bypasses the state machine");
    expect(record?.msg).toContain(BACKFILL_ENV_VAR);
  });

  test("writes at WARN, so it is on at the default threshold", async () => {
    // A write surface that bypasses the state machine being reachable is
    // not something anyone should have to raise the log level to see.
    process.env.LOG_LEVEL = "info";

    await announceBackfillWindow({ [BACKFILL_ENV_VAR]: "true" });

    expect(warningRecord(logs.stderr())?.level).toBe("warn");
  });

  test("is SILENT when the window is closed — which is what gives the line meaning", async () => {
    await announceBackfillWindow({});

    expect(warningRecord(logs.stderr())).toBeUndefined();
    expect(logs.stderr()).toEqual([]);
  });

  test("is silent for every value that is not the exact affirmative", async () => {
    // The gate fails closed, and this caller must not soften it: a warning
    // for `TRUE` or `1` would say the window is open when it is shut, which
    // is a worse signal than none.
    for (const value of ["TRUE", "True", "1", "yes", "on", "false", " true", "true "]) {
      logs.restore();
      logs = captureLogs();

      await announceBackfillWindow({ [BACKFILL_ENV_VAR]: value });

      expect(
        warningRecord(logs.stderr()),
        `announced for ${JSON.stringify(value)}`,
      ).toBeUndefined();
    }
  });

  test("writes to stderr and never to stdout", async () => {
    await announceBackfillWindow({ [BACKFILL_ENV_VAR]: "true" });

    expect(logs.stderr().length).toBe(1);
    expect(logs.stdout()).toEqual([]);
  });

  test("the line is real JSON, like every other line", async () => {
    // A startup warning is the line most likely to be written by an
    // ad-hoc `console.warn`, which would be the one unparseable line in an
    // otherwise machine-readable stream.
    await announceBackfillWindow({ [BACKFILL_ENV_VAR]: "true" });

    const record = oneRecord(logs.stderr(), warningRecord(logs.stderr())?.msg as string);
    expect(record?.at).toBeTypeOf("string");
    expect(record?.level).toBe("warn");
  });
});
