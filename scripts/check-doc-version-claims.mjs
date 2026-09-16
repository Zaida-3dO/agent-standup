#!/usr/bin/env node
/**
 * Fails when a tracked document states a version number for the npm package,
 * because a document that states no version cannot state a stale one.
 *
 * ── The failure ─────────────────────────────────────────────────────────
 *
 * `README.md` § Installing opened with an accurate, carefully argued
 * blockquote: the published package was five minors behind what the
 * repository built, the publish step was failing, and a reader was better
 * served by a checkout than by the stale artifact. Every clause of it was
 * true on the morning it was written and load-bearing enough to justify its
 * length.
 *
 * It was false by that evening, when someone published. Nothing changed in
 * the file; the world moved underneath it. For the hours in between, the
 * first section a stranger reads steered them *away* from the one install
 * path that worked — the exact opposite of what the text was written to
 * achieve, and a worse outcome than having said nothing at all.
 *
 * The general shape: **prose that mirrors a value owned somewhere else is
 * wrong from the moment that value changes, and nothing tells you.** A
 * version number in a sentence has no mechanism behind it. It is a cached
 * copy with no invalidation.
 *
 * ── Why this shape of check, and not the obvious one ────────────────────
 *
 * The obvious check compares the README's claim against
 * `npm view agent-standup version` and fails when they disagree. It was
 * considered and rejected, for three reasons that compound:
 *
 *   1. **It needs the network**, so it is a check that goes yellow for
 *      reasons unrelated to the change under test — and a check people
 *      learn to re-run until it passes is not a gate.
 *   2. **It fails the wrong person.** Publishing is a manual, interactive
 *      step (it needs a 2FA prompt a runner cannot answer), so the moment
 *      someone publishes, *every open pull request* turns red for a
 *      discrepancy none of their authors introduced. Gates that blame the
 *      innocent get disabled.
 *   3. **It ratifies the mistake.** Making "the stated version matches the
 *      registry" enforceable means the version may go on being stated. The
 *      cheaper fix is to not state it, and then there is no pair of values
 *      that can disagree.
 *
 * So this check enforces the *property that makes drift impossible* rather
 * than policing the drift itself. It is offline, deterministic, and depends
 * on nothing outside the working tree — which also means it cannot rot the
 * way the sentence it replaced did.
 *
 * ── What a green run does and does not mean ─────────────────────────────
 *
 * **Green means no scanned file asserts a version of this npm package.** It
 * is not a claim that the install instructions work; nothing here executes
 * them. It does not check the container image tags, the badge at the top of
 * the README (which is rendered by a shield from the live release, so it is
 * generated rather than asserted, and cannot go stale), or version numbers
 * belonging to *other* software — `Node >= 24` and `Prisma 6` are facts
 * about dependencies, not claims about what the registry serves, and are
 * deliberately not matched.
 *
 * The match is a shape: a version-like number sitting close to a mention of
 * this package or the registry. It is meant to catch the sentence someone
 * writes in good faith while fixing something else.
 */

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

/** Files that describe installing this package to an outside reader. */
const SCANNED = ["README.md", "docs/using-agent-standup.md", "docs/orchestration.md"];

/**
 * A version-like number said *about this package*.
 *
 * Both halves are required. A bare `0.27.0` somewhere in a document is not
 * necessarily a claim about the registry — it could be a Postgres version,
 * a Node version, an example in a tag command. What makes it a claim is
 * proximity to the package name or to npm itself, so the pattern demands
 * both within a short window and in either order.
 */
const PACKAGE = String.raw`(?:agent-standup|npm|registry)`;
const VERSION = String.raw`v?\d+\.\d+\.\d+`;
const NEAR = 60;

const PATTERNS = [
  new RegExp(`${PACKAGE}[^\\n]{0,${NEAR}}?\\b${VERSION}\\b`, "i"),
  new RegExp(`\\b${VERSION}\\b[^\\n]{0,${NEAR}}?${PACKAGE}`, "i"),
];

/**
 * Lines this check is not entitled to an opinion about.
 *
 * `npm view agent-standup version` is the *remedy* this check exists to
 * steer people toward — it names the package and the word version in one
 * breath and must not be read as an assertion. A fenced command that
 * publishes or tags a release legitimately carries an example number.
 */
const EXEMPT = [/npm\s+view\s+agent-standup\s+version/i, /<!--\s*version-claim-ok\b/i, /^\s*#/];

function offenders(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let fenced = false;

  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    // Inside a fence a number is part of a command someone runs verbatim —
    // `git tag -a v1.2.3` is an example, not a claim about the registry.
    if (fenced) continue;
    if (EXEMPT.some((pattern) => pattern.test(line))) continue;
    if (PATTERNS.some((pattern) => pattern.test(line))) {
      found.push({ line: index + 1, text: line.trim() });
    }
  }
  return found;
}

function main() {
  const files = argv.slice(2).length > 0 ? argv.slice(2) : SCANNED;
  const failures = [];

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const hit of offenders(text)) failures.push({ file, ...hit });
  }

  if (failures.length === 0) {
    console.log(`check-doc-version-claims: ${files.length} file(s) state no npm version. OK`);
    return;
  }

  console.error("A tracked document states a version for the npm package.\n");
  for (const { file, line, text } of failures) {
    console.error(`  ${file}:${line}\n    ${text}\n`);
  }
  console.error(
    "A stated version is a cached copy of a number the registry owns, with nothing\n" +
      "to invalidate it: it is wrong from the moment someone publishes, and the docs\n" +
      "go on asserting it. Describe how to install `latest` instead, and let\n" +
      "`npm view agent-standup version` be the answer to what that is.\n",
  );
  exit(1);
}

main();
