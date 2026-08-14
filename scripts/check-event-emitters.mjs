#!/usr/bin/env node
/**
 * Fails when the `EventType` enum declares a value that nothing in the
 * application ever writes.
 *
 * `SCHEMA.md` §3 already states the rule — **Postgres cannot remove an enum
 * value, so add one only when the code that emits it exists.** The rule was
 * right and unenforced, and the cost of that is a matter of record: an
 * event type can be declared in the schema, given a payload validator, given
 * a guard, and given a read path that displays it, with nothing anywhere that
 * produces one. Every layer looks complete in isolation. The gap is *between*
 * layers, which is the one place a per-row status cannot show it, and the one
 * place a reviewer reading a single diff does not look.
 *
 * So this is a check rather than another sentence in the spec. The failure
 * mode is not disagreement — nobody argues the rule is wrong — it is that a
 * value gets added at the moment its reader is being written, and the writer
 * is left for a follow-up nobody files.
 *
 * ── How it matches: WRITE SITES, NOT MENTIONS ───────────────────────────
 *
 * The interesting half of this check is what it refuses to count. An event
 * type is "emitted" only when the code *inserts a row with that type*. A
 * mention of the same string in a `WHERE` clause, a validator, a type union
 * or a comment is a **read**, and counting reads is the exact bug this gate
 * exists to catch: the read path is precisely what gets built first.
 *
 * That distinction is load-bearing and not hypothetical. At the time of
 * writing, `orientation.ts` names `checkpoint` and both open-loop values in
 * `WHERE ... "type" IN (...)` clauses. A grep for the bare string reports all
 * three as present; two of them have no writer anywhere in the tree. A gate
 * that counted mentions would pass, green, on the precise defect it was built
 * for.
 *
 * Two write shapes exist, and both are recognised:
 *
 *   1. **Through `appendEvent`** — the normal path. A `type: "<value>"`
 *      property in an object literal that reaches `events.ts`. Recognised by
 *      the property syntax, so a `WHERE type = 'checkpoint'` string cannot
 *      impersonate one.
 *   2. **A raw `INSERT INTO "Event"`** — a literal `'<value>'::"EventType"`
 *      cast appearing inside an INSERT statement. Recognised by finding the
 *      enclosing SQL statement and requiring it to be an INSERT, so the same
 *      cast in a SELECT's `WHERE` does not count.
 *
 * ── What this does NOT check, and what a green run therefore means ──────
 *
 * **A green run means every declared event type has at least one syntactic
 * write site. It does not mean the emitter is reachable, correct, or ever
 * actually runs.** Those are different claims and only the first is tested
 * here. Specifically:
 *
 *   - **It counts sites, not executions.** One write site behind a condition
 *     that is never true, in a function nothing calls, satisfies this check
 *     completely. It proves a writer was *written*, which is the thing that
 *     was missing — not that the writer works.
 *   - **It does not check payloads.** A site that emits the right type with
 *     a payload no reader understands passes.
 *   - **It is syntactic, so it can be fooled by construction.** A type
 *     assembled at run time (`type: someVariable`) is invisible to it, and
 *     would report as unemitted even when it is emitted. That direction is
 *     safe — it fails loudly rather than passing quietly — but it means the
 *     recognised shapes are a contract: write an event type as a literal.
 *   - **The scanned scope is a fixed list of roots.** Code outside them is
 *     not searched. A new directory that emits events needs adding to
 *     `EMITTER_ROOTS`, and until it is, its writes do not count.
 *
 * The one asymmetry worth stating plainly: **every failure mode above makes
 * this check stricter, never laxer.** An unrecognised write shape produces a
 * false failure, which someone fixes. That is the correct direction for a gate
 * whose whole purpose is catching an absence.
 *
 * That claim used to end "…there is no shape that makes an unemitted type look
 * emitted", and **it was false** (#124). A `type:` property was counted
 * wherever it appeared, so a read path naming a type made it look written:
 * `where: { type: "x" }`, an `interface` field, or a read model returning
 * `{ type: "x" }` all did it — the last was demonstrated on a real helper and
 * took the gate green on a type nothing writes. `findPropertyWrites` now
 * requires the property to be an argument of an `EMIT_CALLERS` call, which is
 * what makes the asymmetry true rather than asserted. Anything the walk cannot
 * resolve reports as unemitted, which fails loudly.
 *
 * ── The import path is deliberately not an emitter ──────────────────────
 *
 * `import-events.ts` and `events-backfill.ts` can write any type at all —
 * they replay a corpus produced elsewhere. Counting them would mean every
 * enum value is "emitted" the moment an importer can carry it, which is
 * exactly the reasoning that let a read-only capability look finished. They
 * are excluded by path, and the exclusion list is asserted in the tests so it
 * cannot quietly grow.
 *
 * ── Recording a deliberate exception ────────────────────────────────────
 *
 * A value may legitimately have no emitter for a time — reserved ahead of the
 * row that will write it. Waive it in `KNOWN_UNEMITTED` below, with the
 * milestone row that closes it. The reason is mandatory and the run summary
 * prints how many waivers are active, so a list that grows shows up in the CI
 * log rather than only in a careful reading of the diff.
 *
 * A waiver is a promise, not a dismissal: an entry whose type *has* since
 * gained an emitter fails the check too. Otherwise the list becomes a place
 * values go to be forgotten, and the gate quietly stops covering them.
 *
 * Usage:
 *   node scripts/check-event-emitters.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the enum is declared. The single source of truth for what exists. */
export const SCHEMA_PATH = "prisma/schema.prisma";

/**
 * Directories searched for write sites. Narrow on purpose: everything that
 * legitimately writes an event lives in the service layer or the small set of
 * `src/lib` modules that own a lifecycle (claims, liveness, takeover).
 */
export const EMITTER_ROOTS = ["src"];

/**
 * Paths whose writes do not count as emitters, and why.
 *
 * The import path can carry any type in the enum — it replays events produced
 * by something else. If it counted, adding an importer would mark every value
 * emitted and the check would certify nothing.
 */
export const NON_EMITTER_PATHS = [
  "src/lib/import-events.ts",
  "src/lib/events-backfill.ts",
  // The two generic writers. They take `type` as a parameter, so they emit
  // nothing in particular — the caller decides, and the caller is what this
  // check is looking for.
  "src/lib/events-insert.ts",
  "src/lib/events.ts",
];

/** File extensions worth reading for a write site. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/**
 * Values allowed to have no emitter, each with the reason.
 *
 * Every entry is a debt with a name on it. An entry that has since gained an
 * emitter is itself a failure — see the header.
 */
export const KNOWN_UNEMITTED = [
  {
    type: "merge",
    why: "the merge transition owns this emitter — MILESTONES.md #98",
  },
  {
    type: "dispatch",
    why: "the dispatch operation owns this emitter — MILESTONES.md #43",
  },
  {
    type: "dispatch_claimed",
    why: "the dispatch operation owns this emitter — MILESTONES.md #43",
  },
  {
    type: "nudge",
    why: "the nudge operation owns this emitter — MILESTONES.md #47",
  },
];

/**
 * Parses the `EventType` enum out of the Prisma schema.
 *
 * Reads the schema text rather than importing the generated client: the
 * generated client is a build artifact, and a check that depends on
 * `prisma generate` having been run is a check that fails for the wrong
 * reason on a clean checkout. The schema file is the source of truth and is
 * always present.
 */
export function parseEventTypes(schemaText) {
  const match = /enum\s+EventType\s*\{([\s\S]*?)\}/.exec(schemaText);
  if (!match) {
    throw new Error(
      `Could not find "enum EventType { ... }" in ${SCHEMA_PATH}. ` +
        "If the enum was renamed, this check needs updating with it — it cannot " +
        "verify emitters for an enum it cannot find, and silently scanning nothing " +
        "would be the worst possible outcome for a gate.",
    );
  }

  const values = [];
  for (const rawLine of match[1].split(/\r?\n/)) {
    // Strip comments before reading the value, so a commented-out value or a
    // prose line mentioning one is not mistaken for a declaration.
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(line)) values.push(line);
  }
  return values;
}

/**
 * The functions whose argument object *is* an event write. A `type:` property
 * counts as an emitter only inside a call to one of these.
 *
 * Kept as a list rather than inferred: "which function writes an event" is a
 * fact about this codebase, and stating it is what lets the check tell an emit
 * from a read. A new writer must be added here, and until it is, its type
 * reports as unemitted — the safe direction, because it fails loudly.
 */
export const EMIT_CALLERS = ["appendEvent", "recordFieldChanges"];

/**
 * Finds every `type: "<value>"` object property that sits inside a call to one
 * of `EMIT_CALLERS`.
 *
 * **The call context is load-bearing, and this is the second version (#124).**
 * The first matched any `type:` property anywhere, on the reasoning that the
 * property syntax was itself the discriminator — a bare occurrence in a union
 * type or a `WHERE` clause is a mention, and mentions are what this check
 * exists not to count. That reasoning was wrong in one direction, and the
 * header claimed "there is no shape that makes an unemitted type look
 * emitted" on the strength of it. There is; several:
 *
 *     db.event.findMany({ where: { type: "x" } })   // a read
 *     interface L { type: "x"; loopId: string }     // a declaration
 *     return { type: "x", open: true }              // a read model
 *
 * Each is a plain `type:` property and each made an unwritten type report as
 * emitted. Demonstrated on a real read-model helper appended to
 * `src/lib/open-loops.ts`: the gate went green on a type nothing writes.
 *
 * Requiring the property to be an argument of an emit call closes all three at
 * once, because none of them is one. It is still syntactic and still fooled by
 * construction — `appendEvent(buildArgs())` hides the type from it — but that
 * direction reports the type as *unemitted*, which fails loudly.
 */
export function findPropertyWrites(text) {
  const found = [];
  const pattern = /(^|[\s{,(])type\s*:\s*["'`]([a-z_]+)["'`]/g;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    // A `type: "merge"` written in a comment is prose about an emitter, not
    // one. Comments are where this check gets *discussed*, so counting them
    // would let a header explaining that a type has no writer stand in for
    // the writer.
    if (isInComment(text, index)) continue;
    if (!isInsideEmitCall(text, index)) continue;
    found.push({ type: match[2], line: lineOf(text, index), kind: "property" });
  }
  return found;
}

/**
 * Is `index` inside the argument list of a call to one of `EMIT_CALLERS`?
 *
 * Walks backwards counting bracket depth, ignoring brackets inside strings, to
 * find the `(` that opens the call this position sits in — then checks the
 * identifier immediately before it. Nested object and array literals are
 * crossed transparently, because an emit's `type:` is normally one level
 * inside the argument object, and a `payload: { ... }` may be deeper still.
 *
 * Walking the text rather than parsing it keeps this script dependency-free,
 * which is the same tradeoff the rest of the file makes. The failure mode is
 * "cannot find the opening paren", which returns false and reports the type as
 * unemitted — loud, not silent.
 */
function isInsideEmitCall(text, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = text[i];
    if (char === ")" || char === "}" || char === "]") {
      depth += 1;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      // An unmatched opener at depth 0 — the bracket enclosing `index`. Only
      // a `(` can be a call; an enclosing `{` means walk further out, because
      // the `type:` is inside an object literal that may itself be an
      // argument.
      if (char !== "(") continue;
      const before = text.slice(Math.max(0, i - 80), i);
      const callee = /([A-Za-z_$][\w$]*)\s*$/.exec(before);
      return callee !== null && EMIT_CALLERS.includes(callee[1]);
    }
  }
  return false;
}

/**
 * Is `index` inside a comment?
 *
 * Line comments are decided by looking for `//` earlier on the same line;
 * block comments by counting whether the nearest delimiter behind is an
 * opener. Both remain approximations, and both err toward *not* counting a
 * site, which makes an emitter look absent rather than present. That is the
 * safe direction for this gate: it over-reports a missing writer, never
 * under-reports one.
 *
 * String literals are blanked before the `//` search (#124). Without that,
 * `const url = "http://x"; await appendEvent(db, { type: "merge" })` reads as
 * commented-out and the emit is skipped — a false failure rather than a false
 * pass, but a confusing one to debug, and the fix is one substitution.
 */
function isInComment(text, index) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  // Replace each string literal's contents with an equal number of spaces, so
  // offsets are preserved while a `//` inside one is not read as a comment
  // opener.
  const beforeOnLine = text
    .slice(lineStart, index)
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) => " ".repeat(literal.length));
  if (beforeOnLine.includes("//")) return true;
  if (/^\s*\*/.test(beforeOnLine)) return true;

  const before = text.slice(0, index);
  const open = before.lastIndexOf("/*");
  if (open === -1) return false;
  return before.lastIndexOf("*/") < open;
}

/**
 * Finds every `'<value>'::"EventType"` cast that sits inside an INSERT.
 *
 * The enclosing-statement test is what separates a write from a read. The
 * same cast appears in `orientation.ts` inside `WHERE "type" IN (...)`, and
 * counting that would mean the check passes on a type that is only ever read
 * — the precise defect it was built to catch.
 *
 * "Enclosing statement" is approximated by looking backwards from the cast to
 * the nearest preceding SQL verb. That is deliberately simple, and it is safe
 * in the direction that matters: a cast whose verb cannot be determined is
 * not counted, so the failure is a false alarm rather than a false pass.
 */
export function findSqlWrites(text) {
  const found = [];
  const pattern = /["'`]?([a-z_]+)["'`]?\s*::\s*"EventType"/g;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    // A cast of a bound parameter (`$6::"EventType"`) names no value.
    if (!/^[a-z_]+$/.test(match[1])) continue;
    // The literal must actually be quoted — `type::"EventType"` on a column
    // is a read of that column, not a literal value.
    if (!/["'`]/.test(match[0][0])) continue;
    if (enclosingSqlVerb(text, index) !== "insert") continue;
    found.push({ type: match[1], line: lineOf(text, index), kind: "sql-insert" });
  }
  return found;
}

/**
 * The nearest SQL verb before `index`, lowercased, or null when there is none
 * close enough to be meaningful.
 */
function enclosingSqlVerb(text, index) {
  const before = text.slice(0, index);
  const verbs = [...before.matchAll(/\b(insert|select|update|delete|with)\b/gi)];
  const last = verbs[verbs.length - 1];
  if (!last) return null;
  return last[1].toLowerCase();
}

function lineOf(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

/** Every scannable file under the emitter roots, repo-relative with `/`. */
export function emitterFiles(root = repoRoot) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
        continue;
      }
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (NON_EMITTER_PATHS.includes(relative)) continue;
      files.push(relative);
    }
  };
  for (const rootDir of EMITTER_ROOTS) walk(path.join(root, rootDir));
  return files.sort();
}

/**
 * The whole check, as data: which declared types have a write site, where,
 * and which waivers were used or are now stale.
 */
export function analyse(root = repoRoot) {
  const declared = parseEventTypes(readFileSync(path.join(root, SCHEMA_PATH), "utf8"));

  /** @type {Map<string, {file: string, line: number, kind: string}[]>} */
  const emitters = new Map();
  for (const relative of emitterFiles(root)) {
    let text;
    try {
      text = readFileSync(path.join(root, relative), "utf8");
    } catch {
      continue; // deleted between listing and reading
    }
    for (const write of [...findPropertyWrites(text), ...findSqlWrites(text)]) {
      if (!declared.includes(write.type)) continue;
      const sites = emitters.get(write.type) ?? [];
      sites.push({ file: relative, line: write.line, kind: write.kind });
      emitters.set(write.type, sites);
    }
  }

  const waived = new Map(KNOWN_UNEMITTED.map((entry) => [entry.type, entry.why]));
  const unemitted = [];
  const staleWaivers = [];
  const unknownWaivers = [];

  for (const type of declared) {
    const hasEmitter = emitters.has(type);
    const waiver = waived.get(type);
    if (!hasEmitter && waiver === undefined) unemitted.push(type);
    if (hasEmitter && waiver !== undefined) {
      staleWaivers.push({ type, sites: emitters.get(type) ?? [] });
    }
  }
  for (const [type] of waived) {
    if (!declared.includes(type)) unknownWaivers.push(type);
  }

  return { declared, emitters, unemitted, staleWaivers, unknownWaivers };
}

function main() {
  const { declared, emitters, unemitted, staleWaivers, unknownWaivers } = analyse();
  const failures = [];

  for (const type of unemitted) {
    failures.push(
      `${SCHEMA_PATH}  [no-emitter]  "${type}" is declared in EventType and nothing writes it.\n` +
        "    ↳ add the code that emits it, or record it in KNOWN_UNEMITTED with the\n" +
        "      milestone row that will. Postgres cannot remove an enum value, so a\n" +
        "      value added ahead of its writer is permanent (SCHEMA.md §3).",
    );
  }

  for (const { type, sites } of staleWaivers) {
    const where = sites.map((s) => `${s.file}:${s.line}`).join(", ");
    failures.push(
      `scripts/check-event-emitters.mjs  [stale-waiver]  "${type}" is in KNOWN_UNEMITTED but is now emitted at ${where}.\n` +
        "    ↳ remove the entry. A waiver that outlives its reason turns the list into\n" +
        "      a place values go to stop being checked.",
    );
  }

  for (const type of unknownWaivers) {
    failures.push(
      `scripts/check-event-emitters.mjs  [unknown-waiver]  "${type}" is in KNOWN_UNEMITTED but is not declared in EventType.\n` +
        "    ↳ remove the entry; it waives nothing and hides a typo.",
    );
  }

  const emittedCount = declared.filter((t) => emitters.has(t)).length;
  const waiverNote =
    KNOWN_UNEMITTED.length > 0
      ? ` ${KNOWN_UNEMITTED.length} waiver${KNOWN_UNEMITTED.length === 1 ? "" : "s"} active.`
      : "";
  const coverage =
    `Checked ${declared.length} declared event type${declared.length === 1 ? "" : "s"}: ` +
    `${emittedCount} emitted, ${declared.length - emittedCount} not.${waiverNote}`;

  if (failures.length === 0) {
    console.log(`${coverage} Every declared event type has a writer or a recorded reason.`);
    return 0;
  }

  console.error(failures.join("\n\n"));
  console.error(
    `\n${coverage}\n\n` +
      `${failures.length} problem${failures.length === 1 ? "" : "s"} with the EventType enum.\n\n` +
      "An event type is only real when something writes one. A value with a reader,\n" +
      "a validator and a guard but no writer looks complete from every layer and is\n" +
      "not — and because Postgres cannot drop an enum value, it stays.\n\n" +
      "Note what a green run here does NOT prove: this counts syntactic write sites,\n" +
      "not reachable ones. A writer nothing calls satisfies it.",
  );
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
