#!/usr/bin/env node
/**
 * Fails when a tracked file describes something that lives *outside* this
 * repository: a system this one supposedly succeeds, "the old" way of doing
 * a thing, what is true "today", a setup the reader is assumed to already
 * know. Everything here has to read as an application built from scratch,
 * because that is the only thing a reader of a public repository can
 * actually verify.
 *
 * This is a check rather than a line in a style guide because the failure
 * mode is forgetting, not disagreeing. Prose drifts back toward whatever
 * the author had in their head; a gate in CI is the only version of the
 * rule that survives the tenth pull request.
 *
 * ── How it matches: SHAPES, NEVER VALUES ────────────────────────────────
 *
 * Every pattern below is a *grammatical shape* — "the old …", "port of …",
 * "replaces …". None of them is, or may become, a list of the real names,
 * hosts, usernames or project names that must stay out of this repository.
 * Writing those in "so they can be grepped for" publishes precisely what
 * the rule exists to keep out, and a denylist wearing a regular expression
 * as a costume is the same mistake with extra steps. If you find yourself
 * adding a proper noun here, stop: the answer is a shape, or nothing.
 *
 * A consequence worth stating plainly: this check is a backstop, not a
 * proof. It catches the phrasings that recur. Reading the diff is still
 * the mechanism that catches the rest.
 *
 * ── Recording a deliberate exception ────────────────────────────────────
 *
 * Some of these shapes have honest in-repo uses. Waive them one line at a
 * time, with a reason, in a comment the language already supports:
 *
 *     <!-- external-ref-ok: <why this one is about this repo> -->
 *     // external-ref-ok-next-line: <why this one is about this repo>
 *
 * `external-ref-ok` covers the line it sits on; `external-ref-ok-next-line`
 * covers the line after it. The reason is mandatory and must be a real
 * sentence — a waiver with nothing after the colon is itself a failure, so
 * silencing the check always costs an explanation that shows up in review
 * right beside the text it excuses.
 *
 * Usage:
 *   node scripts/check-external-refs.mjs            # every tracked file
 *   node scripts/check-external-refs.mjs a.md b.md  # just these
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The shapes. `id` is what the failure message names, so it wants to be
 * short and searchable; `why` is what the author reads at 2am, so it wants
 * to say what to write instead rather than merely restating the rule.
 */
export const PATTERNS = [
  {
    id: "temporal-today",
    regex: /\btoday'?s?\b/,
    why: 'anchors the text to a world outside this repository — describe what the app does, not what exists "today"',
  },
  {
    id: "temporal-now",
    regex: /\bcurrently\b|\bat present\b|\bas things stand\b/,
    why: "describes a present state the reader cannot see — state the behaviour itself, unqualified",
  },
  {
    id: "temporal-past",
    regex: /\bpreviously\b|\bformerly\b|\bhistorically\b|\bin the past\b/,
    why: "points at a history this repository does not have — give the reason, not the chronology",
  },
  {
    id: "temporal-changed",
    regex: /\bused to\b|\bno longer\b|\bnowadays\b|\bthese days\b/,
    why: "contrasts against an earlier state — say what is true now and stop there",
  },
  {
    id: "supersession",
    regex: /\breplaces\b|\breplacing\b|\breplacement for\b|\bin place of\b/,
    why: "frames a feature by what it supersedes — describe the capability on its own terms",
  },
  {
    id: "ported",
    regex: /\bport of\b|\bported from\b|\bporting\b/,
    why: "describes work as carried over from elsewhere — describe what it delivers instead",
  },
  {
    id: "the-old-thing",
    regex:
      /\bthe old\b|\bthe original\b|\bolder? (system|app|application|tool|script|scripts|setup|store|board|cli|version|one|way|world)\b/,
    why: "names a predecessor — rewrite the sentence around the principle, not the thing it improves on",
  },
  {
    id: "the-existing-thing",
    regex:
      /\bexisting setup\b|\b(the|an?|your|their|his|her|our) existing (setup|system|systems|app|application|tool|tools|script|scripts|store|stores|board|cli|mcp|hook|hooks|folder|folders|file|files|ledger|ledgers|installation|deployment|process|pipeline|infrastructure|codebase|repo|repos|stack|implementation)\b/,
    why: "assumes the reader already runs something — describe the interface or capability, not the incumbent",
  },
  {
    id: "the-current-thing",
    regex:
      /\bthe current (system|setup|implementation|script|scripts|tool|tools|board|cli|app|store|ping|process|way|world)\b/,
    why: "same as above, in the present tense — this repository is the only system in scope",
  },
  {
    id: "the-new-thing",
    regex: /\bthe new (app|system|tool|version|backend|world|thing)\b/,
    why: '"new" only means anything against an old one — it is just "the app"',
  },
  {
    id: "cutover",
    regex: /\bcut ?over\b/,
    why: "migration-off-something framing — name the capability (going live, importing) rather than the transition",
  },
  {
    id: "someones-own-setup",
    regex:
      /\b(the user's|the owner's|your|his|her|their|our|my) (own )?(setup|environment|world|rig)\b/,
    why: "gestures at a particular person's machines — write it for anyone who installs this",
  },
  {
    id: "foreign-script-file",
    regex: /\.ps1\b|\.psm1\b/,
    why: "a script file from another codebase — this repository does not ship one, so it can only be a reference outward",
  },
];

/**
 * Two files necessarily contain the shapes: the one that defines them, and
 * the one that proves they are caught. Nothing else belongs here, and a
 * test asserts as much — an exemption list that can grow quietly is just a
 * slower way of deleting the check.
 */
export const SELF_EXEMPT = ["scripts/check-external-refs.mjs", "tests/check-external-refs.test.ts"];

/** Lockfiles are generated, enormous, and prose-free. */
const SKIPPED_FILES = new Set(["package-lock.json"]);

const BINARY_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "pdf",
  "zip",
  "gz",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "mp4",
  "mp3",
]);

/** Anything larger than this is not prose anyone wrote by hand. */
const MAX_BYTES = 512 * 1024;

const WAIVER = /external-ref-ok(-next-line)?:(.*)$/i;

/** A waiver has to actually say something. Roughly four words. */
const MIN_REASON_LENGTH = 12;

/**
 * Strip the comment tail a reason inevitably ends in, so
 * `<!-- external-ref-ok: because X -->` reads as "because X".
 */
function cleanReason(raw) {
  return raw
    .replace(/-->\s*$/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/["'`]\s*[,;)]*\s*$/, "")
    .trim();
}

/**
 * Find every violation in one file's text.
 *
 * Returns objects of `{ line, column, patternId, match, text, kind }` where
 * `kind` is `"external-ref"` for a matched shape and `"empty-waiver"` for a
 * waiver that silences the check without saying why.
 */
export function findViolations(text) {
  const lines = text.split(/\r?\n/);
  const violations = [];

  /** Line numbers (1-based) that a waiver on the previous line covers. */
  const waivedNextLines = new Set();
  /** Line numbers (1-based) that carry a waiver of their own. */
  const waiverLines = new Set();

  lines.forEach((line, index) => {
    const found = line.match(WAIVER);
    if (!found) return;

    const lineNumber = index + 1;
    waiverLines.add(lineNumber);
    if (found[1]) waivedNextLines.add(lineNumber + 1);

    const reason = cleanReason(found[2] ?? "");
    if (reason.length < MIN_REASON_LENGTH) {
      violations.push({
        line: lineNumber,
        column: (found.index ?? 0) + 1,
        patternId: "waiver-without-a-reason",
        match: found[0].trim(),
        text: line,
        kind: "empty-waiver",
      });
    }
  });

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (waiverLines.has(lineNumber) || waivedNextLines.has(lineNumber)) return;

    for (const pattern of PATTERNS) {
      const global = new RegExp(pattern.regex.source, "gi");
      for (const match of line.matchAll(global)) {
        violations.push({
          line: lineNumber,
          column: (match.index ?? 0) + 1,
          patternId: pattern.id,
          match: match[0],
          text: line,
          kind: "external-ref",
        });
      }
    }
  });

  return violations.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Should this path be read at all? */
export function isScannable(path) {
  if (SELF_EXEMPT.includes(path)) return false;

  const name = path.split("/").pop() ?? path;
  if (SKIPPED_FILES.has(name)) return false;

  const extension = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return !BINARY_EXTENSIONS.has(extension);
}

/** Every tracked file, so a new file is covered the moment it is added. */
function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

function describe(violation, path) {
  const pattern = PATTERNS.find((p) => p.id === violation.patternId);
  const why = pattern?.why ?? "a waiver has to say why the match is really about this repository";
  return [
    `${path}:${violation.line}:${violation.column}  [${violation.patternId}]  matched: ${JSON.stringify(violation.match)}`,
    `    ${violation.text.trim()}`,
    `    ↳ ${why}`,
  ].join("\n");
}

function main(argv) {
  const explicit = argv.slice(2);
  const paths = (explicit.length > 0 ? explicit : trackedFiles()).filter(isScannable);

  const failures = [];
  let scanned = 0;

  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // deleted between listing and reading; nothing to check
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) continue;

    scanned += 1;
    for (const violation of findViolations(readFileSync(path, "utf8"))) {
      failures.push(describe(violation, path));
    }
  }

  if (failures.length === 0) {
    console.log(`Scanned ${scanned} files: nothing refers to anything outside this repository.`);
    return 0;
  }

  console.error(failures.join("\n\n"));
  console.error(
    `\n${failures.length} reference${failures.length === 1 ? "" : "s"} to something outside this repository.\n\n` +
      "This repository is public and has to read as an application built from scratch:\n" +
      "nothing in it may describe a predecessor, a prior state, or a setup the reader is\n" +
      "assumed to already have. Rewrite the sentence around the underlying reason — that is\n" +
      "almost always the better sentence anyway, and it keeps the decision's meaning.\n\n" +
      "If a match really is about this repository, waive that one line and say why:\n" +
      "    <!-- external-ref-ok: <reason> -->            (markdown, covers this line)\n" +
      "    // external-ref-ok-next-line: <reason>        (code, covers the line below)\n" +
      "A waiver with no reason fails too, so the explanation lands in the diff beside the text.",
  );
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
