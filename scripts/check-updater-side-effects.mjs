#!/usr/bin/env node
/**
 * Fails when a variable is assigned inside a React state updater and the
 * updater's own result is not the only thing the caller relies on.
 *
 * ── The defect this exists for ──────────────────────────────────────────
 *
 * A `setX(updater)` call does not run `updater` at the moment you call it.
 * React evaluates one eagerly only when no update is already pending on the
 * fiber, and defers it otherwise; under StrictMode it additionally invokes it
 * twice. So a value assigned inside the updater and read on the line after it
 * is not reliably there:
 *
 *     let opening = false;
 *     setExpandedIds((current) => {
 *       ...
 *       opening = true;          // assigned inside the updater
 *       return next;
 *     });
 *     if (!opening) return;      // read on the next line — not set yet
 *
 * This has now shipped three separate times in this repo: in `Board.tsx`
 * (#128, the drag request), in `UndoToastHost.tsx` (the undo plan), and again
 * in `Board.tsx` (the subtask expand). Each time it passed review, and each
 * time the unit tests stayed green, because the pure functions being composed
 * were all individually correct. It is a composition defect, and the third
 * occurrence was written the same day the second was fixed.
 *
 * The established fix is a ref read synchronously *before* the `setState`,
 * which leaves the updater a pure function of its argument.
 *
 * ── What this check matches, precisely ──────────────────────────────────
 *
 * It parses each `set<Name>(` call whose first argument is an arrow function
 * or `function` expression, extracts that callback's body by brace matching,
 * and reports an assignment inside the body to a name that is **not** declared
 * within it and is not a member expression on `current`-style parameters.
 *
 * Two shapes are flagged:
 *
 *   1. **`name = ...`** where `name` is a plain identifier declared outside
 *      the updater — the exact defect above.
 *   2. **`some.thing.current = ...`** — a ref written inside an updater.
 *      Benign when the written value is idempotent, but it is the same
 *      discipline breach and it is what the next reader copies.
 *
 * Deliberately NOT flagged: `const`/`let` declared inside the updater body,
 * assignments to properties of the updater's own parameter (building the next
 * value is the job), and `+=`-style compound assignment to a local.
 *
 * ── What a green run does NOT prove ─────────────────────────────────────
 *
 * This is a syntactic check and it is honest about its reach:
 *
 *   - It only sees updaters passed **inline**. A callback hoisted to a named
 *     function and passed by reference (`setX(myUpdater)`) is not analysed,
 *     because the assignment and the `setState` are then in different places
 *     and matching them would need real scope analysis.
 *   - It does not prove the outer variable is actually *read* after the call.
 *     It flags the assignment, which is the thing that is always wrong to do;
 *     an assignment nothing reads is dead code rather than a bug, but it is
 *     still the pattern that becomes one.
 *   - It cannot catch the inverse defect — a handler that *should* have read
 *     a ref and instead read a render-time value. Only a composition test
 *     mounted under real React catches that. `tests/board-react-wiring.test.ts`
 *     and `tests/undo-toast-host-wiring.test.ts` are that layer, and this
 *     check does not replace them.
 *
 * So: this makes the *known* recurrence shape mechanically detectable. It does
 * not make the whole family detectable, and it should not be read as if it did.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/**
 * Assignments that are understood and deliberately allowed, each with the
 * reason. An entry is `<relative-path>:<variable>`; keep the reason current,
 * because a waiver nobody can justify is how a check stops meaning anything.
 */
const WAIVERS = new Map([]);

/**
 * `set<Capital>` calls that are not React state setters. Their callbacks are
 * invoked by the platform at a defined time, never deferred or double-invoked
 * by React, so an assignment inside one is ordinary code rather than this
 * defect. Excluded by name because the false positive is specific and the
 * list is short — inferring "is this a state setter" from syntax alone would
 * need scope analysis this check deliberately does not do.
 */
const NOT_STATE_SETTERS = new Set(["setTimeout", "setInterval", "setImmediate"]);

/** Every `.ts`/`.tsx` file under `src/`, excluding generated output. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "generated" || entry === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.d\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * The body of the callback starting at `open` (the index of its `{`), by
 * brace matching that skips strings, template literals and comments.
 *
 * Returns `null` when the braces do not balance, which means the file is
 * mid-edit or uses a shape this parser does not model — reported by the
 * caller rather than silently treated as "no findings".
 */
function callbackBody(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      if (nl === -1) return null;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
    i += 1;
  }
  return null;
}

/** Names declared with const/let/var inside this body — assigning them is fine. */
function declaredWithin(body) {
  const names = new Set();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // Destructured declarations, conservatively: every identifier inside the
  // pattern counts as declared, which can only make this check quieter.
  for (const m of body.matchAll(/\b(?:const|let|var)\s*[[{]([^}\]]*)[}\]]/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=\s]/)[0];
      if (name) names.add(name);
    }
  }
  return names;
}

/** The 1-based line number of `index` within `text`. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function findingsIn(file, text) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const findings = [];
  // `setSomething(` followed by an inline callback. The capital after `set`
  // is what distinguishes a state setter from `settings(...)` or `setup(...)`.
  const callPattern = /\bset([A-Z][\w$]*)\s*\(\s*(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/g;
  for (const match of text.matchAll(callPattern)) {
    if (NOT_STATE_SETTERS.has(`set${match[1]}`)) continue;
    const open = text.indexOf("{", match.index + match[0].length - 1);
    if (open === -1) continue;
    const found = callbackBody(text, open);
    if (found === null) continue;
    const { body } = found;
    const params = (match[2] ?? match[3] ?? "")
      .split(",")
      .map((p) => p.trim().split(/[:=\s]/)[0])
      .filter(Boolean);
    const local = declaredWithin(body);
    for (const p of params) local.add(p);

    // Shape 1: a bare identifier assigned, declared outside this body.
    for (const assign of body.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)) {
      const name = assign[2];
      if (local.has(name)) continue;
      if (WAIVERS.has(`${rel}:${name}`)) continue;
      findings.push({
        file: rel,
        line: lineOf(text, open) + lineOf(body, assign.index) - 1,
        detail: `\`${name}\` is assigned inside a state updater but declared outside it`,
      });
    }

    // Shape 2: a ref written inside the updater.
    for (const assign of body.matchAll(/([A-Za-z_$][\w$]*)\.current\s*=(?!=)/g)) {
      const name = `${assign[1]}.current`;
      if (WAIVERS.has(`${rel}:${name}`)) continue;
      findings.push({
        file: rel,
        line: lineOf(text, open) + lineOf(body, assign.index) - 1,
        detail: `\`${name}\` is written inside a state updater — write it before the setState instead`,
      });
    }
  }
  return findings;
}

function main() {
  const files = sourceFiles(SRC);
  const findings = [];
  for (const file of files) {
    findings.push(...findingsIn(file, readFileSync(file, "utf8")));
  }

  const coverage =
    `Scanned ${files.length} source file${files.length === 1 ? "" : "s"} for ` +
    `assignments inside React state updaters.`;

  if (findings.length === 0) {
    console.log(
      `${coverage} None found.\n` +
        "Note what this does NOT prove: it matches inline updaters only, and it\n" +
        "cannot tell whether a handler reads a stale render value instead of a ref.\n" +
        "The composition tests are what cover that.",
    );
    return 0;
  }

  for (const f of findings) {
    console.error(`${f.file}:${f.line}\n  ${f.detail}`);
  }
  console.error(
    `\n${coverage}\n\n` +
      `${findings.length} assignment${findings.length === 1 ? "" : "s"} inside a state updater.\n\n` +
      "An updater is not a callback that runs when you call it. React defers it\n" +
      "whenever a lane is already pending on the fiber, and StrictMode invokes it\n" +
      "twice — so a value assigned inside one is not reliably set on the next line.\n" +
      "This shipped three times in this repo before it was made detectable.\n\n" +
      "The fix: read a ref synchronously BEFORE the setState, and leave the updater\n" +
      "a pure function of its argument. `UndoToastHost.onUndo` and `Board.onDrop`\n" +
      "are both worked examples.",
  );
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
