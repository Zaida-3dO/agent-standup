#!/usr/bin/env node
/**
 * One-off cleanup: shrinks `field_change` events that stored a large value.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 *
 * Before `recordFieldChanges` learned to summarise large values
 * (`src/lib/event-summary.ts`), every edit copied the whole old and new value
 * of each changed field onto its `field_change` event. For an item whose
 * `customFields` value is tens of thousands of characters and is rewritten on
 * every edit, that is ~2x that size per edit, kept forever — enough that a read
 * of the last few events came to several times the response limit and was refused. Fixing the
 * writer stops new events growing; this script shrinks the ones already stored,
 * to the same summary the writer now produces (field, that it changed, old and
 * new sizes, a short hash of each, and the changed keys of an object value).
 *
 * ── The three guards ────────────────────────────────────────────────────
 *
 * The events table is the audit ledger, so this script is deliberately slow to
 * write:
 *
 *   1. **Dry run is the default.** With no flags it connects read-only
 *      (`BEGIN READ ONLY`, so the database itself refuses a write), prints how
 *      many events would change, which items they belong to, and the bytes
 *      before and after, and changes nothing.
 *   2. **`--apply` is required to write**, and nothing else turns writing on.
 *   3. **`--apply` without `--backup-confirmed` is refused** before any
 *      connection is opened. The flag is a statement by the person running the
 *      script that a database backup has been taken; the script cannot check
 *      that, so it makes the person say it. `--backup-confirmed` without
 *      `--apply` is refused too, because it would mean nothing.
 *
 * All writes happen in one transaction: either every listed event is shrunk or
 * none is.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *
 *   DATABASE_URL=... node scripts/shrink-field-change-events.mjs
 *   DATABASE_URL=... node scripts/shrink-field-change-events.mjs --apply --backup-confirmed
 *
 * `DATABASE_URL` is read from the environment only; it is never accepted as an
 * argument, so it cannot end up in a shell history or a process listing.
 *
 * ── What a green result does, and does not, mean ────────────────────────
 *
 * A finished run means every `field_change` event whose `from` or `to` value
 * serialised to more than the limit *when the script ran* now carries a summary
 * (or, in a dry run, would). It does not mean no large event exists afterwards:
 * a writer running an earlier build can append one after the script finishes, and
 * a payload that is large for a reason other than `from`/`to` (no writer
 * produces one) is not looked at. It also does not recover disk space by
 * itself: Postgres reclaims rewritten rows through (auto)vacuum, and shrinking
 * the file on disk takes a `VACUUM FULL`, which is a separate decision.
 *
 * The summary rules below are a copy of `src/lib/event-summary.ts`, because this
 * script runs from a container that has no TypeScript sources.
 * `tests/shrink-field-change-events.test.ts` runs both on the same inputs and
 * fails if they disagree.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Summary rules: keep identical to src/lib/event-summary.ts ───────────

export const FIELD_CHANGE_INLINE_LIMIT = 2000;
export const SUMMARY_MAX_KEYS = 25;
export const SUMMARY_MAX_KEY_LENGTH = 100;
export const SUMMARY_HASH_LENGTH = 12;

export function serialisedSize(value) {
  return (JSON.stringify(value) ?? "null").length;
}

function canonicalOfPlain(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalOfPlain).join(",")}]`;
  const parts = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalOfPlain(value[key])}`);
  return `{${parts.join(",")}}`;
}

export function canonicalJson(value) {
  const plain = value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null");
  return canonicalOfPlain(plain);
}

export function shortHash(value) {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return digest.slice(0, SUMMARY_HASH_LENGTH);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyChanges(from, to) {
  const fromObject = isPlainObject(from) ? from : from === null ? {} : undefined;
  const toObject = isPlainObject(to) ? to : to === null ? {} : undefined;
  if (fromObject === undefined || toObject === undefined) return undefined;
  if (!isPlainObject(from) && !isPlainObject(to)) return undefined;

  const names = [...new Set([...Object.keys(fromObject), ...Object.keys(toObject)])].sort();
  const all = [];
  for (const name of names) {
    const inFrom = Object.prototype.hasOwnProperty.call(fromObject, name);
    const inTo = Object.prototype.hasOwnProperty.call(toObject, name);
    const key = name.length > SUMMARY_MAX_KEY_LENGTH ? name.slice(0, SUMMARY_MAX_KEY_LENGTH) : name;
    if (inFrom && !inTo) {
      all.push({
        key,
        change: "removed",
        fromSize: serialisedSize(fromObject[name]),
        toSize: null,
        hash: shortHash(fromObject[name]),
      });
    } else if (!inFrom && inTo) {
      all.push({
        key,
        change: "added",
        fromSize: null,
        toSize: serialisedSize(toObject[name]),
        hash: shortHash(toObject[name]),
      });
    } else if (canonicalJson(fromObject[name]) !== canonicalJson(toObject[name])) {
      all.push({
        key,
        change: "changed",
        fromSize: serialisedSize(fromObject[name]),
        toSize: serialisedSize(toObject[name]),
        hash: shortHash(toObject[name]),
      });
    }
  }
  return {
    keys: all.slice(0, SUMMARY_MAX_KEYS),
    omitted: Math.max(0, all.length - SUMMARY_MAX_KEYS),
  };
}

export function isOversizedChange(from, to) {
  return (
    serialisedSize(from) > FIELD_CHANGE_INLINE_LIMIT ||
    serialisedSize(to) > FIELD_CHANGE_INLINE_LIMIT
  );
}

export function summariseFieldChange(field, from, to) {
  const base = {
    field,
    summarised: true,
    changed: true,
    fromSize: serialisedSize(from),
    toSize: serialisedSize(to),
    fromHash: shortHash(from),
    toHash: shortHash(to),
  };
  const diff = keyChanges(from, to);
  if (diff === undefined) return base;
  return diff.omitted > 0
    ? { ...base, keys: diff.keys, keysOmitted: diff.omitted }
    : { ...base, keys: diff.keys };
}

// ── Planning (pure) ─────────────────────────────────────────────────────

/**
 * The replacement payload for one stored event, or `null` when the event
 * should be left alone: not an object, already a summary, no `from`/`to`
 * values, or both values small enough to keep.
 */
export function shrunkPayload(payload) {
  if (!isPlainObject(payload)) return null;
  if (payload.summarised === true) return null;
  if (!("from" in payload) && !("to" in payload)) return null;
  const from = payload.from ?? null;
  const to = payload.to ?? null;
  if (!isOversizedChange(from, to)) return null;
  const { from: _from, to: _to, field: storedField, ...rest } = payload;
  const field = typeof storedField === "string" ? storedField : "(unknown field)";
  return { ...rest, ...summariseFieldChange(field, from, to) };
}

/**
 * Turns stored rows (`{id, itemId, title, payload}`) into the list of events to
 * shrink, each with its before and after size in characters.
 */
export function planShrinks(rows) {
  const shrinks = [];
  for (const row of rows) {
    const next = shrunkPayload(row.payload);
    if (next === null) continue;
    shrinks.push({
      id: row.id,
      itemId: row.itemId ?? null,
      title: row.title ?? null,
      before: JSON.stringify(row.payload).length,
      after: JSON.stringify(next).length,
      payload: next,
    });
  }
  return shrinks;
}

/** Totals and the per-item breakdown for the report. */
export function summariseDryRun(shrinks) {
  const items = new Map();
  let before = 0;
  let after = 0;
  for (const shrink of shrinks) {
    before += shrink.before;
    after += shrink.after;
    const key = shrink.itemId ?? "(no item)";
    const entry = items.get(key) ?? {
      itemId: key,
      title: shrink.title,
      events: 0,
      before: 0,
      after: 0,
    };
    entry.events += 1;
    entry.before += shrink.before;
    entry.after += shrink.after;
    items.set(key, entry);
  }
  return { events: shrinks.length, before, after, items: [...items.values()] };
}

// ── Arguments ───────────────────────────────────────────────────────────

export class UsageError extends Error {}

const KNOWN_FLAGS = new Set(["--apply", "--backup-confirmed", "--help"]);

/**
 * Reads the command line. Unknown arguments are refused rather than ignored: a
 * mistyped `--appply` must not quietly become a dry run that the person reads
 * as a completed cleanup.
 */
export function parseArgs(argv) {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) {
      throw new UsageError(`Unknown argument ${arg}. Known: ${[...KNOWN_FLAGS].join(", ")}.`);
    }
  }
  const apply = argv.includes("--apply");
  const backupConfirmed = argv.includes("--backup-confirmed");
  const help = argv.includes("--help");
  if (apply && !backupConfirmed) {
    throw new UsageError(
      "Refusing to write: --apply needs --backup-confirmed, to say a database backup has been " +
        "taken. Nothing was changed.",
    );
  }
  if (backupConfirmed && !apply) {
    throw new UsageError(
      "--backup-confirmed only means something together with --apply. Run without flags for a " +
        "dry run.",
    );
  }
  return { apply, backupConfirmed, help };
}

const USAGE = `Shrinks oversized field_change events to a summary.

  DATABASE_URL=... node scripts/shrink-field-change-events.mjs
      dry run: reports what would change, writes nothing
  DATABASE_URL=... node scripts/shrink-field-change-events.mjs --apply --backup-confirmed
      writes, in one transaction; only after a database backup has been taken
`;

// ── Reading and writing ─────────────────────────────────────────────────

const PAGE_SIZE = 100;

const SELECT_PAGE = `
  SELECT e."id"::text AS "id", e."itemId", i."title", e."payload"
    FROM "Event" e
    LEFT JOIN "Item" i ON i."id" = e."itemId"
   WHERE e."type" = 'field_change'
     AND e."id" > $2::bigint
     AND (e."payload"->>'summarised') IS NULL
     AND (length((e."payload"->'from')::text) > $1 OR length((e."payload"->'to')::text) > $1)
   ORDER BY e."id"
   LIMIT $3`;

const UPDATE_ONE = `
  UPDATE "Event"
     SET "payload" = $1::jsonb
   WHERE "id" = $2::bigint
     AND "type" = 'field_change'
     AND ("payload"->>'summarised') IS NULL`;

function kb(characters) {
  return `${(characters / 1024).toFixed(1)} KB`;
}

/**
 * Runs the cleanup. Returns the process exit code; prints through `log`.
 * `connect` is injectable so tests can drive it without a database.
 */
export async function run({ argv, env, connect, log }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    log(error.message);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    log("Set DATABASE_URL to the database to clean. Nothing was changed.");
    return 2;
  }

  let client;
  try {
    client = await connect(databaseUrl);
  } catch (error) {
    log(`Could not connect: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const shrinks = [];
  try {
    // Read-only unless writing was asked for and confirmed: the dry run cannot
    // write even by mistake, because the database refuses.
    await client.query(args.apply ? "BEGIN" : "BEGIN READ ONLY");

    let lastId = "0";
    for (;;) {
      const { rows } = await client.query(SELECT_PAGE, [
        FIELD_CHANGE_INLINE_LIMIT,
        lastId,
        PAGE_SIZE,
      ]);
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;
      for (const { payload, ...shrink } of planShrinks(rows)) {
        // The replacement payload is written now and not kept, so a long run
        // does not hold every summary in memory.
        shrinks.push(shrink);
        if (args.apply) {
          const result = await client.query(UPDATE_ONE, [JSON.stringify(payload), shrink.id]);
          if (result.rowCount !== 1) {
            throw new Error(`Event ${shrink.id} was not updated (already summarised or gone).`);
          }
        }
      }
      if (rows.length < PAGE_SIZE) break;
    }

    await client.query(args.apply ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    log(`Failed, nothing was changed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client.end();
  }

  const report = summariseDryRun(shrinks);
  log(
    `${args.apply ? "Shrunk" : "Would shrink"} ${report.events} field_change event(s) on ` +
      `${report.items.length} item(s): ${kb(report.before)} -> ${kb(report.after)} of payload.`,
  );
  for (const entry of report.items) {
    log(
      `  ${entry.itemId}  ${entry.title ?? "(untitled)"}  ${entry.events} event(s), ` +
        `${kb(entry.before)} -> ${kb(entry.after)}`,
    );
  }
  if (!args.apply) {
    log("Dry run: nothing was written. Re-run with --apply --backup-confirmed after a backup.");
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const code = await run({
    argv: process.argv.slice(2),
    env: process.env,
    connect: async (connectionString) => {
      // Loaded here so the refusals above never depend on the driver being present.
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString });
      await client.connect();
      return client;
    },
    log: (line) => console.log(line),
  });
  // Set rather than `process.exit`, so output to a pipe is flushed before the process ends.
  process.exitCode = code;
}
