// The one-off cleanup that shrinks oversized `field_change` events
// (`scripts/shrink-field-change-events.mjs`).
//
// It is a gate-like script — it rewrites rows of the audit ledger — so the
// tests that matter most are the refusals: it must not write without
// `--apply`, and must not accept `--apply` without `--backup-confirmed`, and
// must say so before any connection is opened.
//
// **What a green run of this file does, and does not, mean.** It means the
// refusals fire, the dry run issues no write (and asks Postgres for a
// read-only transaction), the apply path writes the summary the live writer
// produces, and the script's copy of the summary rules agrees with
// `src/lib/event-summary.ts` on the inputs below. It does not mean the SQL is
// right against a real Postgres: the script is driven through a fake client
// here, so the `SELECT`/`UPDATE` text itself is only checked for the shape
// that matters (a keyset page, a guarded update), not executed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as live from "@/lib/event-summary";
import * as script from "../scripts/shrink-field-change-events.mjs";

const scriptPath = path.resolve(import.meta.dirname, "../scripts/shrink-field-change-events.mjs");

interface Call {
  sql: string;
  params?: unknown[];
}

interface StoredRow {
  id: string;
  itemId: string | null;
  title: string | null;
  payload: unknown;
}

const bigPayload = (field = "customFields") => ({
  field,
  from: { progress: "a".repeat(30000), note: "same" },
  to: { progress: "b".repeat(30000), note: "same" },
});

const bigRow = (id: number, itemId = "item-a", title = "Alpha"): StoredRow => ({
  id: String(id),
  itemId,
  title,
  payload: bigPayload(),
});

/** A stand-in for a `pg` client: serves keyset pages, records every statement. */
function fakeClient(rows: StoredRow[], options: { updateRowCount?: number } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql: sql.trim(), params });
      const text = sql.trim();
      if (text.startsWith("SELECT")) {
        const last = BigInt(params?.[1] as string);
        const limit = params?.[2] as number;
        const page = rows.filter((row) => BigInt(row.id) > last).slice(0, limit);
        return { rows: page, rowCount: page.length };
      }
      if (text.startsWith("UPDATE")) return { rows: [], rowCount: options.updateRowCount ?? 1 };
      return { rows: [], rowCount: 0 };
    },
    async end() {
      calls.push({ sql: "END" });
    },
  };
}

async function runWith(argv: string[], rows: StoredRow[], env: Record<string, string> = {}) {
  const client = fakeClient(rows);
  const lines: string[] = [];
  let connectedWith: string | null = null;
  const code = await script.run({
    argv,
    env: { DATABASE_URL: "postgres://user-a@db.invalid/standup", ...env },
    connect: async (url: string) => {
      connectedWith = url;
      return client;
    },
    log: (line: string) => lines.push(line),
  });
  return { code, lines, calls: client.calls, connectedWith };
}

const statements = (calls: Call[]) => calls.map((call) => call.sql.split(/\s+/)[0]);
const updates = (calls: Call[]) => calls.filter((call) => call.sql.startsWith("UPDATE"));

describe("parseArgs: the refusals", () => {
  it("is a dry run with no flags", () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, backupConfirmed: false });
  });

  it("refuses --apply without --backup-confirmed, and says why", () => {
    expect(() => script.parseArgs(["--apply"])).toThrow(/--apply needs --backup-confirmed/);
    expect(() => script.parseArgs(["--apply"])).toThrow(script.UsageError);
  });

  it("refuses --backup-confirmed on its own, because it would mean nothing", () => {
    expect(() => script.parseArgs(["--backup-confirmed"])).toThrow(/only means something/);
  });

  it("accepts both flags together, in either order", () => {
    expect(script.parseArgs(["--apply", "--backup-confirmed"])).toMatchObject({ apply: true });
    expect(script.parseArgs(["--backup-confirmed", "--apply"])).toMatchObject({ apply: true });
  });

  it("refuses an argument it does not know, so a typo cannot pass for a dry run", () => {
    expect(() => script.parseArgs(["--appply"])).toThrow(/Unknown argument --appply/);
    expect(() => script.parseArgs(["--apply", "--backup-confirmed", "--force"])).toThrow(
      /Unknown argument --force/,
    );
  });
});

describe("run: refusals happen before any connection", () => {
  it("--apply without --backup-confirmed exits 2 and never connects", async () => {
    const result = await runWith(["--apply"], [bigRow(1)]);
    expect(result.code).toBe(2);
    expect(result.connectedWith).toBeNull();
    expect(result.calls).toEqual([]);
    expect(result.lines.join("\n")).toMatch(/Refusing to write/);
    expect(result.lines.join("\n")).toMatch(/Nothing was changed/);
  });

  it("a missing DATABASE_URL exits 2, names the variable and never connects", async () => {
    const result = await runWith([], [bigRow(1)], { DATABASE_URL: "" });
    expect(result.code).toBe(2);
    expect(result.connectedWith).toBeNull();
    expect(result.lines.join("\n")).toMatch(/DATABASE_URL/);
  });

  it("reports a connection failure plainly and exits 1 without writing", async () => {
    const lines: string[] = [];
    const code = await script.run({
      argv: ["--apply", "--backup-confirmed"],
      env: { DATABASE_URL: "postgres://user-a@db.invalid/standup" },
      connect: async () => {
        throw new Error("connection refused");
      },
      log: (line: string) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/Could not connect: connection refused/);
  });

  it("reads the database from the environment, never from the arguments", () => {
    expect(() => script.parseArgs(["postgres://user-a@db.invalid/standup"])).toThrow(
      /Unknown argument/,
    );
  });
});

describe("the script as a process", () => {
  // An address nothing listens on: if the script tried to connect, it would
  // fail with a connection error rather than the refusal asserted here.
  const unreachable = "postgres://user-a@127.0.0.1:1/standup";

  function runProcess(args: string[], env: Record<string, string | undefined>) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const key of Object.keys(childEnv)) {
      if (childEnv[key] === undefined) delete childEnv[key];
    }
    try {
      const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
        env: childEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20000,
      });
      return { status: 0, stdout };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        stdout: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
      };
    }
  }

  it("exits non-zero on --apply alone, before it tries the database", () => {
    const result = runProcess(["--apply"], { DATABASE_URL: unreachable });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/--apply needs --backup-confirmed/);
    expect(result.stdout).not.toMatch(/ECONNREFUSED|Failed/);
  });

  it("exits non-zero on --apply alone even with no database configured", () => {
    const result = runProcess(["--apply"], { DATABASE_URL: undefined });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/--apply needs --backup-confirmed/);
  });

  it("exits non-zero on a dry run with no DATABASE_URL", () => {
    const result = runProcess([], { DATABASE_URL: undefined });
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/Set DATABASE_URL/);
  });

  it("prints usage for --help without needing a database", () => {
    const result = runProcess(["--help"], { DATABASE_URL: undefined });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--apply --backup-confirmed/);
  });
});

describe("run: the dry run", () => {
  const rows = [
    bigRow(1, "item-a", "Alpha"),
    bigRow(2, "item-a", "Alpha"),
    bigRow(3, "item-b", "Beta"),
  ];

  it("opens a read-only transaction and rolls it back, so the database refuses any write", async () => {
    const { code, calls } = await runWith([], rows);
    expect(code).toBe(0);
    expect(calls[0]?.sql).toBe("BEGIN READ ONLY");
    expect(statements(calls)).toContain("ROLLBACK");
    expect(statements(calls)).not.toContain("COMMIT");
  });

  it("issues no UPDATE", async () => {
    const { calls } = await runWith([], rows);
    expect(updates(calls)).toEqual([]);
  });

  it("reports the count, each item id and title, and the bytes before and after", async () => {
    const { lines } = await runWith([], rows);
    const text = lines.join("\n");
    expect(text).toMatch(/Would shrink 3 field_change event\(s\) on 2 item\(s\)/);
    expect(text).toMatch(/item-a\s+Alpha\s+2 event\(s\)/);
    expect(text).toMatch(/item-b\s+Beta\s+1 event\(s\)/);
    expect(text).toMatch(/KB -> [\d.]+ KB/);
    expect(text).toMatch(/Dry run: nothing was written/);
  });

  it("reports a smaller size after than before", async () => {
    const plan = script.planShrinks(rows);
    const totals = script.summariseDryRun(plan);
    expect(totals.before).toBeGreaterThan(100000);
    expect(totals.after).toBeLessThan(totals.before / 50);
  });

  it("says so plainly when there is nothing to shrink", async () => {
    const { code, lines } = await runWith([], []);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/Would shrink 0 field_change event\(s\) on 0 item\(s\)/);
  });
});

describe("run: --apply --backup-confirmed", () => {
  const rows = [bigRow(7, "item-a", "Alpha"), bigRow(9, "item-b", "Beta")];

  it("writes one guarded UPDATE per event, inside one transaction", async () => {
    const { code, calls } = await runWith(["--apply", "--backup-confirmed"], rows);
    expect(code).toBe(0);
    expect(calls[0]?.sql).toBe("BEGIN");
    expect(updates(calls)).toHaveLength(2);
    expect(statements(calls).filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(statements(calls)).not.toContain("ROLLBACK");
    expect(updates(calls)[0]?.params?.[1]).toBe("7");
    expect(updates(calls)[1]?.params?.[1]).toBe("9");
    // Only an event that is not already a summary may be rewritten.
    expect(updates(calls)[0]?.sql).toMatch(/'summarised'\) IS NULL/);
    expect(updates(calls)[0]?.sql).toMatch(/"type" = 'field_change'/);
  });

  it("writes the same summary the live writer produces, and drops the stored values", async () => {
    const { calls } = await runWith(["--apply", "--backup-confirmed"], rows);
    const written = JSON.parse(updates(calls)[0]?.params?.[0] as string) as Record<string, unknown>;
    const original = bigPayload() as { from: unknown; to: unknown };
    expect(written).toEqual(live.fieldChangePayload("customFields", original.from, original.to));
    expect(written).not.toHaveProperty("from");
    expect(written).not.toHaveProperty("to");
    expect(JSON.stringify(written).length).toBeLessThan(1000);
  });

  it("reports what it did", async () => {
    const { lines } = await runWith(["--apply", "--backup-confirmed"], rows);
    expect(lines.join("\n")).toMatch(/Shrunk 2 field_change event\(s\) on 2 item\(s\)/);
    expect(lines.join("\n")).not.toMatch(/Dry run/);
  });

  it("rolls everything back and exits 1 when an event cannot be updated", async () => {
    const client = fakeClient(rows, { updateRowCount: 0 });
    const lines: string[] = [];
    const code = await script.run({
      argv: ["--apply", "--backup-confirmed"],
      env: { DATABASE_URL: "postgres://user-a@db.invalid/standup" },
      connect: async () => client,
      log: (line: string) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(statements(client.calls)).toContain("ROLLBACK");
    expect(statements(client.calls)).not.toContain("COMMIT");
    expect(lines.join("\n")).toMatch(/nothing was changed/i);
  });

  it("closes the connection on every path", async () => {
    for (const argv of [[], ["--apply", "--backup-confirmed"]]) {
      const { calls } = await runWith(argv, rows);
      expect(calls[calls.length - 1]?.sql).toBe("END");
    }
  });

  it("walks every page of a result longer than one page", async () => {
    const many = Array.from({ length: 205 }, (_, i) => bigRow(i + 1, `item-${i % 3}`));
    const { calls, lines } = await runWith(["--apply", "--backup-confirmed"], many);
    expect(updates(calls)).toHaveLength(205);
    expect(lines.join("\n")).toMatch(/Shrunk 205 field_change event/);
    const pages = calls.filter((call) => call.sql.startsWith("SELECT"));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    // Each page resumes after the last id of the one before.
    expect(pages[1]?.params?.[1]).toBe("100");
  });
});

describe("planShrinks: which events are rewritten", () => {
  const plan = (payload: unknown) =>
    script.planShrinks([{ id: "1", itemId: "item-a", title: "Alpha", payload }]);

  it("leaves a small field_change alone", () => {
    expect(plan({ field: "priority", from: "P2", to: "P0" })).toEqual([]);
  });

  it("leaves an event that is already a summary alone — running twice changes nothing", () => {
    const [first] = plan(bigPayload());
    expect(first).toBeDefined();
    expect(plan(first?.payload)).toEqual([]);
  });

  it("leaves a payload that is not an object, or has no values to shrink, alone", () => {
    expect(plan(null)).toEqual([]);
    expect(plan("text")).toEqual([]);
    expect(plan([1, 2])).toEqual([]);
    expect(plan({ field: "x" })).toEqual([]);
  });

  it("shrinks when only one side is large", () => {
    expect(plan({ field: "body", from: "short", to: "x".repeat(5000) })).toHaveLength(1);
    expect(plan({ field: "body", from: "x".repeat(5000), to: null })).toHaveLength(1);
  });

  it("keeps the 2,000-character boundary the live writer uses", () => {
    const atLimit = "a".repeat(script.FIELD_CHANGE_INLINE_LIMIT - 2);
    expect(plan({ field: "body", from: "x", to: atLimit })).toEqual([]);
    expect(plan({ field: "body", from: "x", to: `${atLimit}a` })).toHaveLength(1);
  });

  it("keeps unrelated payload keys and the field name", () => {
    const [shrink] = plan({ ...bigPayload("body"), reason: "kept" });
    expect(shrink?.payload).toMatchObject({ field: "body", reason: "kept", summarised: true });
  });

  it("copes with a payload that lost its field name", () => {
    const [shrink] = plan({ from: "x", to: "y".repeat(5000) });
    expect(shrink?.payload).toMatchObject({ field: "(unknown field)", summarised: true });
  });

  it("records bytes before and after for each event", () => {
    const [shrink] = plan(bigPayload());
    expect(shrink?.before).toBe(JSON.stringify(bigPayload()).length);
    expect(shrink?.after).toBe(JSON.stringify(shrink?.payload).length);
    expect(shrink?.after).toBeLessThan(shrink?.before ?? 0);
  });

  it("groups events without an item under one label", () => {
    const shrinks = script.planShrinks([
      { id: "1", itemId: null, title: null, payload: bigPayload() },
      { id: "2", itemId: null, title: null, payload: bigPayload() },
    ]);
    const report = script.summariseDryRun(shrinks);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ itemId: "(no item)", events: 2 });
  });
});

describe("the script's summary rules agree with the live writer", () => {
  const big = (n: number, c = "x") => c.repeat(n);
  const cases: [string, unknown, unknown][] = [
    [
      "customFields",
      { progress: big(30000, "a"), note: "same" },
      { progress: big(30000, "b"), note: "same" },
    ],
    ["customFields", null, { a: big(2600), b: 1 }],
    ["customFields", { a: big(2600), gone: 1 }, { a: big(2600), fresh: [1, 2] }],
    [
      "customFields",
      { v: { a: 1, b: 2 }, pad: big(2500) },
      { v: { b: 2, a: 1 }, pad: big(2500), x: 1 },
    ],
    ["body", "short", big(4000)],
    ["body", big(4000), null],
    ["areas", null, [big(2500)]],
    ["customFields", [1, 2], { a: big(2500) }],
    [
      "customFields",
      { pad: big(2500) },
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
    ],
    ["customFields", { pad: big(2500) }, { pad: big(2500), [big(300, "k")]: 1 }],
  ];

  it.each(cases.map((c, i) => [i, ...c] as const))("case %i: %s", (_i, field, from, to) => {
    expect(script.summariseFieldChange(field, from, to)).toEqual(
      live.summariseFieldChange(field, from, to),
    );
    expect(script.isOversizedChange(from, to)).toBe(live.isOversizedChange(from, to));
  });

  it("shares hashing, sizing and canonical form", () => {
    for (const value of [null, "text", 12, [3, 1], { b: 1, a: { d: 1, c: 2 } }]) {
      expect(script.shortHash(value)).toBe(live.shortHash(value));
      expect(script.serialisedSize(value)).toBe(live.serialisedSize(value));
      expect(script.canonicalJson(value)).toBe(live.canonicalJson(value));
    }
  });

  it("shares every limit", () => {
    expect(script.FIELD_CHANGE_INLINE_LIMIT).toBe(live.FIELD_CHANGE_INLINE_LIMIT);
    expect(script.SUMMARY_MAX_KEYS).toBe(live.SUMMARY_MAX_KEYS);
    expect(script.SUMMARY_MAX_KEY_LENGTH).toBe(live.SUMMARY_MAX_KEY_LENGTH);
    expect(script.SUMMARY_HASH_LENGTH).toBe(live.SUMMARY_HASH_LENGTH);
  });
});

describe("what the script says about itself", () => {
  const source = readFileSync(scriptPath, "utf8");

  it("states what a finished run does not mean", () => {
    expect(source).toMatch(/does not mean no large event exists afterwards/);
  });

  it("does not take the database address as an argument", () => {
    expect(source).toMatch(/read from the environment only/);
  });
});
