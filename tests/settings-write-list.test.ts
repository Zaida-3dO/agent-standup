// The list of settings-writing operations, checked against what actually
// writes settings.
//
// Kept in its own file, deliberately: it imports `service/live.ts`, whose
// module-level singleton binds `DATABASE_URL` at import time. Importing it
// from a file whose `beforeAll` repoints that variable at a scratch database
// would bind the client to the placeholder URL instead, and every DB-backed
// test in that file would then fail to authenticate. A source check needs no
// database and so has no business sharing a file with tests that do.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_WRITE_OPERATIONS } from "@/lib/service/live";

// A source check, so it runs with or without a database.
//
// The invalidating runtime keys off a list of operation names, and a list is
// the kind of thing that goes stale silently: a fourth settings writer added
// later would bump the revision, leave the snapshot held, and nothing would
// complain. "Changed the settings" and "moved the revision" are the same
// event, so the list is checkable against the modules that call
// `bumpRevision` rather than merely remembered.
describe("the settings-write list stays in step with what actually writes settings", () => {
  const OPERATIONS_DIR = path.resolve(import.meta.dirname, "../src/lib/service/operations");

  it("names exactly the operations that bump the settings revision", () => {
    const bumpers = readdirSync(OPERATIONS_DIR)
      .filter((file) => file.endsWith(".ts") && file !== "settings-shared.ts")
      .map((file) => ({ file, text: readFileSync(path.join(OPERATIONS_DIR, file), "utf8") }))
      .filter((entry) => entry.text.includes("bumpRevision"))
      .map((entry) => /name:\s*"([^"]+)"/.exec(entry.text)?.[1])
      .filter((name): name is string => name !== undefined);

    // Not vacuous: a glob that matched nothing would make the comparison
    // below trivially true against an empty set.
    expect(bumpers.length).toBeGreaterThan(0);
    expect([...bumpers].sort()).toEqual([...SETTINGS_WRITE_OPERATIONS].sort());
  });
});
