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
 * adding one of *those* proper nouns here, stop: the answer is a shape, or
 * nothing. (There is exactly one construction that legitimately writes
 * proper nouns into a check like this, and it is the opposite one — an
 * allowlist of the names this repository is *permitted* to say. See the
 * next section for why that is a cost decision rather than a rule.)
 *
 * ── What this does NOT check, and what a green run therefore means ──────
 *
 * **A green run means the recurring phrasings are absent. It does not mean
 * the prose is clean.** Those are different claims and only the first is
 * tested here. Specifically:
 *
 *   - **No shape matches a private proper noun.** A name dropped into a
 *     sentence — a machine, a service, a project — passes every pattern
 *     below, and that is the single most likely thing to leak.
 *   - **No shape matches a sentence that is merely unverifiable**: prose
 *     that reads fine but only makes sense to someone who has seen a system
 *     this repository does not contain.
 *   - **The vocabulary lists are finite, on both sides of every shape.**
 *     `old <noun>` matches a fixed set of nouns, and an unlisted one goes
 *     through — but so does an unlisted *inflection* of a verb that is
 *     otherwise covered. A live example, left unfixed deliberately so the
 *     limit is concrete rather than abstract: `supersession` carries
 *     `replaces` and `replacing` and **not `replaced`**, so "it replaced
 *     the folder-based store" passes clean. Closing that one would cost
 *     zero waivers — nothing in the tree says `replaced` — and it is not
 *     closed here only because widening a shape wants its own pass over
 *     the corpus for false positives. Treat every alternation below as a
 *     list somebody wrote once, not as a category.
 *
 * The proper-noun gap is a **cost decision, not an impossibility**, and it
 * is worth being exact about which, because the two have different
 * consequences. It could be decided by an *allowlist* — the proper nouns
 * this repository is allowed to name (itself, its dependencies, the
 * standard tools, the headings) — flagging every capitalised token that is
 * not on it. That names nothing private, so it does not breach the rule
 * above. What it costs is a list that has to be extended on every new
 * dependency, tool, heading and product name, whose failure mode is noise
 * on legitimate additions — which is how a check gets waived, then ignored,
 * then deleted. Judged not worth it here; it is the first thing to reach
 * for if that judgement stops holding.
 *
 * So: this is a backstop, not a proof. **Reading the diff is not something
 * a green tick discharges** — it is the mechanism that catches everything
 * in the list above, and this check exists to stop the recurring phrasings
 * consuming the attention that reading needs.
 *
 * ── Recording a deliberate exception ────────────────────────────────────
 *
 * Some of these shapes have honest in-repo uses. Waive them one line at a
 * time, with a reason, in a comment the language already supports:
 *
 *     <!-- external-ref-ok: <why this one is about this repo> -->
 *     // external-ref-ok-next-line: <why this one is about this repo>
 *
 * A waiver's own line is never scanned — its reason is prose about the rule,
 * not content the rule applies to. So `external-ref-ok` covers the line it
 * sits on, and `external-ref-ok-next-line` covers **that line and the one
 * after it**. Be precise about which line you attach it to: a waiver covers
 * the *whole* line, so on a long hard-wrapped one it can silence more than
 * you meant. The run summary prints how many matches the waivers in a tree
 * are silencing, so that creep is visible rather than quiet.
 *
 * ── Why a `-next-line` waiver cannot be trusted to stay put ──────────────
 *
 * A `-next-line` waiver is anchored by POSITION, and position is not stable
 * under formatting. In markdown, Prettier inserts a blank line after a
 * standalone HTML comment — so the line a waiver was written to cover moves
 * down by one the first time the file is formatted. Two things follow, and
 * the second is the dangerous one:
 *
 *   1. The intended line is no longer covered, so the check fires on
 *      something already reviewed and waived. Noisy, but visible.
 *   2. The waiver now covers whatever line landed in that position instead,
 *      silently excusing a violation nobody chose to excuse — while the
 *      waiver and its reason sit right there in the diff looking correct.
 *
 * That second case breaks the guarantee the whole mechanism exists for:
 * silencing this check should always cost a written explanation. Two
 * defences, because either alone leaves a hole:
 *
 *   - **A blank line does not break the link.** A `-next-line` waiver covers
 *     the next line with content, skipping blank lines between. Prettier's
 *     insertion is exactly a blank line, so the waiver keeps covering the
 *     text it was attached to and case 1 stops happening.
 *   - **A waiver that covers nothing is itself a failure.** If the line a
 *     `-next-line` waiver points at holds no match, the waiver is either
 *     shifted or stale — and both are worth surfacing loudly rather than
 *     leaving in place to catch an unrelated line later. This is what stops
 *     case 2: a shifted waiver cannot sit quietly, because covering nothing
 *     is reported.
 *
 * Prefer the same-line form (`external-ref-ok`) where the language allows
 * it. It is anchored to the text it excuses rather than to a position, so
 * no formatter can separate the two.
 *
 * The reason is mandatory and has to read as a phrase — several real words,
 * not twelve characters of padding. A waiver that says nothing fails the
 * check itself, so silencing it always costs an explanation sitting in the
 * diff beside the text it excuses.
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
 *
 * Every `regex` here must join words with a literal single space, never
 * `\s+` or `\s*`. The second pass below (search "Second pass") relies on
 * that: a blank line trims to "" and still contributes the join's own
 * separator, so two paragraphs land exactly two spaces apart and a
 * literal-space pattern cannot bridge them. A whitespace-class pattern
 * could, and would start welding unrelated paragraphs across every blank
 * line in the corpus. A test enforces this (`no \s in any pattern source`)
 * — if it's failing, that's why, and the fix is the pattern, not the test.
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
    // `used to` is deliberately restricted to the *change* sense. Bare
    // `used to` is far more often the ordinary purpose sense ("`kind` is
    // used to derive the column"), and a check that fires on correct prose
    // gets waived, then ignored, then deleted.
    id: "temporal-changed",
    regex:
      /\bused to (be|live|lives?|work|sit|run|have|has|do|exist|happen|handle|hold|mean)\b|\bno longer\b|\bnowadays\b|\bthese days\b|\buntil now\b|\bcarried over from\b|\bmov(e|ed|ing) (off|away from)\b/,
    why: "contrasts against an earlier state — say what is true now and stop there",
  },
  {
    // `legacy` is noun-narrowed rather than dropped: "the legacy store" is a
    // predecessor reference, while "legacy shim" and "legacy config format"
    // are ordinary terms of art in this ecosystem. (It never matched
    // `legacy_id` — the underscore removes the right word boundary.)
    //
    // `supersede` is deliberately absent and must stay absent: it is this
    // product's own vocabulary. An assignment is superseded when another
    // session takes it over, so the word is live in `schema.prisma`, in the
    // baseline migration and throughout `SCHEMA.md` — a shape for it would
    // fire on ten-plus lines of correct prose the day it was added.
    id: "supersession",
    regex:
      /\breplaces\b|\breplacing\b|\breplacement for\b|\bin place of\b|\bpredecessors?\b|\blegacy (system|systems|store|stores|app|application|tool|tools|scripts?|setup|board|cli|hooks?|implementation|client|surface|way|world)\b/,
    why: "frames a feature by what it supersedes — describe the capability on its own terms",
  },
  {
    // Narrowed to the "carried over" sense: `a port of X`, `ported from`.
    // Left broad it fires on network ports, which this repository talks
    // about constantly.
    id: "ported",
    regex:
      /\ba port of\b|\bported from\b|\bporting\b|\bport of (today|the old|the existing|the current|an? existing)\b/,
    why: "describes work as carried over from elsewhere — describe what it delivers instead",
  },
  {
    // `old(er)?`, not `older?` — the `?` binds to a single character, so
    // `older?` means "olde" plus an optional "r" and matches nothing anyone
    // writes. `\bthe old\b` covered the commonest form, which is why the
    // hole stayed invisible: every other determiner ("an old board", "our
    // old scripts", "old way") passed clean.
    id: "the-old-thing",
    regex:
      /\bthe old\b|\bprior (state|system|app|application|version|setup|implementation|tool|world)\b|\bthe (original|earlier) (system|app|application|tool|script|scripts|setup|store|board|cli|version|implementation|way|world)\b|\bold(er)? (system|app|application|tool|script|scripts|setup|store|board|cli|version|one|way|world)\b/,
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
    // Not `environment` — "fill in the values for your environment" is the
    // sentence a README needs, and `setup` / `world` / `rig` carry the intent.
    id: "someones-own-setup",
    regex: /\b(the user's|the owner's|your|his|her|their|our|my) (own )?(setup|world|rig)\b/,
    why: "gestures at a particular person's machines — write it for anyone who installs this",
  },
  {
    // If this repository ever ships a launcher script of its own (the poller
    // in M8 is the likely one), waive it at that file rather than deleting
    // this pattern — the point is references pointing outward.
    id: "foreign-script-file",
    regex: /\.ps1\b|\.psm1\b/,
    why: "a script file from another codebase — nothing here ships one, so it reads as a reference outward",
  },
];

/**
 * Two files necessarily contain the shapes: the one that defines them, and
 * the one that proves they are caught. Nothing else belongs here, and a
 * test asserts as much — an exemption list that can grow quietly is just a
 * slower way of deleting the check.
 */
export const SELF_EXEMPT = ["scripts/check-external-refs.mjs", "tests/check-external-refs.test.ts"];

/**
 * Lockfiles are generated, enormous, and prose-free. Exported and pinned by a
 * test for the same reason as `SELF_EXEMPT`: one name added here silences a
 * whole file, and that has to be a visible change rather than a quiet one.
 */
export const SKIPPED_FILES = ["package-lock.json"];

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

/** …and three of them have to carry information. See `FILLER_WORDS`. */
const MIN_REASON_WORDS = 3;

/**
 * Words a reason can be made entirely of while explaining nothing.
 *
 * Three kinds: the grammar a sentence needs, the noises people make when
 * they mean "leave me alone", and the text written where a reason was
 * meant to go. `this is fine`, `TODO TODO TODO` and `lorem ipsum dolor`
 * are each three words and twelve-plus characters, and each says exactly
 * as much as an empty waiver.
 *
 * **This is not the denylist the repository's scanning rule forbids.** That
 * rule is about the real names, hosts and project names that must stay out
 * of a public repository — writing them down to grep for them publishes
 * them. This list is ordinary English and publishes nothing. It is also
 * still gameable by anyone determined to game it, which is fine: it can
 * only be gamed *visibly*, by writing a sentence that reads like a reason
 * into a comment sitting in the diff. Costing an explanation was always the
 * design; this only stops the explanation being a placeholder.
 */
const FILLER_WORDS = new Set([
  // Grammar.
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "but",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "will",
  "with",
  "we",
  "you",
  "your",
  // Assertions that a thing is acceptable, which is the claim under review.
  "fine",
  "good",
  "great",
  "harmless",
  "irrelevant",
  "just",
  "nice",
  "obviously",
  "okay",
  "really",
  "safe",
  "sure",
  "true",
  "valid",
  "whatever",
  "yes",
  // Words about the waiver rather than about the text it excuses.
  "exception",
  "ignore",
  "reason",
  "reasons",
  "skip",
  "waived",
  "waiver",
  // Placeholders.
  "asdf",
  "bar",
  "baz",
  "blah",
  "dolor",
  "dummy",
  "etc",
  "fixme",
  "foo",
  "ipsum",
  "lorem",
  "placeholder",
  "qux",
  "sample",
  "stuff",
  "tbd",
  "temp",
  "thing",
  "things",
  "tmp",
  "todo",
  "wip",
  "xxx",
  "yyy",
  "zzz",
]);

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
 * A length check alone lets `xxxxxxxxxxxx` through, and a word count alone
 * lets `this is fine` through — each satisfies the letter of "say why" and
 * none of its point. So require three **distinct, non-filler** words.
 *
 * The two halves catch different things, and it is worth being exact about
 * which does what, because an earlier version of this comment credited
 * distinctness with a rejection the filler list was performing:
 *
 *   - **non-filler** is what rejects `this is fine`, `waived for reasons`,
 *     `lorem ipsum dolor` and `TODO TODO TODO` — every word in each is
 *     filler, `todo` included, so they fail on the count alone;
 *   - **distinctness** is what rejects `schema schema schema` — one real
 *     word padded out to three. Nothing else in the rule reaches that, so
 *     the suite pins it with a fixture of exactly that shape.
 */
function isRealReason(reason) {
  if (reason.length < MIN_REASON_LENGTH) return false;
  const substantive = new Set(
    reason
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 2 && !FILLER_WORDS.has(word)),
  );
  return substantive.size >= MIN_REASON_WORDS;
}

/**
 * Locate the waivers in a file, and reject the ones that say nothing.
 *
 * **A waiver inside a fenced code block is documentation, not a waiver.**
 * The rules file has to show the syntax to teach it, and those examples
 * would otherwise be live — inflating the waiver count and, worse, silently
 * excusing any violating text pasted into that block later. Fenced content
 * is still *scanned*; it just cannot waive.
 */
function waiversIn(lines) {
  /** Line numbers (1-based) that carry a waiver of their own. */
  const waiverLines = new Set();
  /** Line numbers (1-based) that a `-next-line` waiver above them covers. */
  const waivedNextLines = new Set();
  /** Waivers that fail to give a reason — themselves a failure. */
  const malformed = [];
  /**
   * Each `-next-line` waiver and the line it ended up covering, so a waiver
   * covering no match can be reported once the file has been scanned. Kept
   * as a list here rather than judged inline because whether the covered
   * line holds a match is not known until the patterns have run over it.
   */
  const nextLineWaivers = [];

  let inFence = false;

  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const found = line.match(WAIVER);
    if (!found) return;

    const lineNumber = index + 1;
    waiverLines.add(lineNumber);
    if (found[1]) {
      // The next line WITH CONTENT, not simply the next line. Prettier puts
      // a blank line after a standalone HTML comment in markdown, which
      // would otherwise move the covered line off the text it was attached
      // to the first time the file is formatted.
      let target = lineNumber + 1;
      while (target <= lines.length && (lines[target - 1] ?? "").trim() === "") target += 1;
      if (target <= lines.length) {
        waivedNextLines.add(target);
        nextLineWaivers.push({
          line: lineNumber,
          column: (found.index ?? 0) + 1,
          match: found[0].trim(),
          text: line,
          covers: target,
        });
      } else {
        // A `-next-line` waiver with nothing after it but blank lines covers
        // nothing at all and never can — reported on its own line.
        nextLineWaivers.push({
          line: lineNumber,
          column: (found.index ?? 0) + 1,
          match: found[0].trim(),
          text: line,
          covers: null,
        });
      }
    }

    const reason = cleanReason(found[2] ?? "");
    if (!isRealReason(reason)) {
      malformed.push({
        line: lineNumber,
        column: (found.index ?? 0) + 1,
        match: found[0].trim(),
        text: line,
      });
    }
  });

  return { waiverLines, waivedNextLines, malformed, nextLineWaivers };
}

/**
 * Find every violation in one file's text.
 *
 * Returns objects of `{ line, column, patternId, match, text, kind }` where
 * `kind` is `"external-ref"` for a matched shape, `"empty-waiver"` for a
 * waiver that silences the check without saying why, and `"stale-waiver"`
 * for a `-next-line` waiver that covers no match at all.
 */
export function findViolations(text) {
  const lines = text.split(/\r?\n/);
  const violations = [];
  const { waiverLines, waivedNextLines, malformed, nextLineWaivers } = waiversIn(lines);

  /**
   * Whether a line holds at least one of the shapes this check matches —
   * **including one that only exists across the following line break.**
   *
   * The straddle case is not an edge case here. This corpus is hard-wrapped,
   * so a phrase like "the old system" lands astride a break roughly as often
   * as not, and the second pass below exists entirely to catch those. A
   * waiver attached to the line where such a phrase *begins* is covering a
   * real match even though that line, read alone, contains none — so judging
   * it on the line's own text would call a working waiver stale and force it
   * to be deleted or moved somewhere it does nothing.
   *
   * Joining with the next line mirrors how the second pass flattens the
   * text: trimmed, single space for the newline. Rebuilds each regex with
   * `i` — the same case-insensitivity the scan applies — rather than reusing
   * the pattern objects, so this cannot disagree with the scan about whether
   * something matches, and a fresh regex per test keeps `lastIndex` out of
   * it entirely.
   */
  const hasMatch = (lineNumber) => {
    const own = (lines[lineNumber - 1] ?? "").trim();
    const next = (lines[lineNumber] ?? "").trim();
    // A blank line is a paragraph boundary, and the second pass treats it as
    // one — so a phrase cannot form across it and neither can a waiver's
    // coverage.
    const withNext = next === "" ? own : `${own} ${next}`;
    return PATTERNS.some((pattern) => new RegExp(pattern.regex.source, "i").test(withNext));
  };

  // A `-next-line` waiver that covers no match excuses nothing, and is
  // reported rather than left in place.
  //
  // It is either shifted — the line it was written for moved, and it is now
  // aimed at unrelated text it would silence the moment that text acquired a
  // match — or stale, left behind after the violation it excused was
  // reworded away. Both are worth failing on: the whole point of the waiver
  // mechanism is that silencing this check costs a written explanation, and
  // a waiver that has drifted off its target still *looks* like one while
  // guaranteeing nothing.
  for (const waiver of nextLineWaivers) {
    if (waiver.covers !== null && hasMatch(waiver.covers)) continue;
    violations.push({
      line: waiver.line,
      column: waiver.column,
      patternId: "waiver-covering-nothing",
      match: waiver.match,
      text: waiver.text,
      kind: "stale-waiver",
    });
  }

  for (const found of malformed) {
    violations.push({
      line: found.line,
      column: found.column,
      patternId: "waiver-without-a-reason",
      match: found.match,
      text: found.text,
      kind: "empty-waiver",
    });
  }

  const isWaived = (lineNumber) => waiverLines.has(lineNumber) || waivedNextLines.has(lineNumber);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (isWaived(lineNumber)) return;

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

  // Second pass, over the same text with the newlines collapsed to spaces.
  //
  // Every doc here is hard-wrapped at ~100 columns, so a phrase like "the
  // old system" lands astride a line break roughly as often as not — and a
  // line-at-a-time matcher cannot see it. That is a blind spot the width of
  // the corpus, not an edge case. Only *straddling* matches are reported
  // here; anything contained in one line was already found above.
  //
  // **Each line is trimmed before joining, and that is load-bearing.** A
  // wrapped list item, a numbered point or an indented paragraph continues
  // on a line that starts with two or three spaces, and joining those raw
  // puts three spaces where the rendered text has one — so `the old` never
  // matches and every straddle inside indented prose is invisible. This
  // corpus is mostly indented prose, so that is most of the corpus.
  //
  // Trimming does **not** weaken the paragraph-break rule, which is the
  // property pulling the other way: a blank line trims to the empty string
  // and still contributes its own separator, so the two halves are joined
  // by two spaces and cannot form a phrase. A blank line remains a
  // boundary; a wrap does not.
  //
  // What is dropped has to be added back when reporting, or every column on
  // an indented line points at the wrong character — hence `indents`.
  const offsets = []; // where each line's trimmed content starts in `flattened`
  const indents = []; // how much leading whitespace was dropped from that line
  const pieces = [];
  let cursor = 0;
  for (const line of lines) {
    const piece = line.trim();
    offsets.push(cursor);
    indents.push(line.length - line.trimStart().length);
    pieces.push(piece);
    cursor += piece.length + 1; // the separator that replaced the newline
  }
  const flattened = pieces.join(" ");

  /** Which 1-based line an offset into `flattened` belongs to. */
  const lineAt = (offset) => {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((offsets[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  for (const pattern of PATTERNS) {
    const global = new RegExp(pattern.regex.source, "gi");
    for (const match of flattened.matchAll(global)) {
      const start = match.index ?? 0;
      const startLine = lineAt(start);
      const endLine = lineAt(start + match[0].length - 1);
      if (startLine === endLine) continue; // pass one already had it
      if (isWaived(startLine) || isWaived(endLine)) continue;

      violations.push({
        line: startLine,
        // Back into the original line's coordinates: the offset within the
        // trimmed piece, plus whatever indentation the trim removed.
        column: start - (offsets[startLine - 1] ?? 0) + (indents[startLine - 1] ?? 0) + 1,
        patternId: pattern.id,
        // Show it as one phrase; the line break is why it was invisible.
        match: match[0],
        text: `${lines[startLine - 1] ?? ""} ⏎ ${lines[endLine - 1] ?? ""}`.trim(),
        kind: "external-ref",
      });
    }
  }

  return violations.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * How much this file's waivers are actually silencing.
 *
 * A waiver covers a whole line, and a line is unbounded — on a long one a
 * single reason can quietly excuse several matches across several shapes.
 * That is a fair design (the alternative is per-shape waivers, which is more
 * ceremony than this is worth), but it should not be *invisible*. The run
 * summary prints these counts, so waiver creep shows up in the CI log
 * instead of only in a careful reading of the diff.
 */
export function summariseWaivers(text) {
  const lines = text.split(/\r?\n/);
  const { waiverLines, waivedNextLines } = waiversIn(lines);
  let suppressed = 0;

  for (const lineNumber of new Set([...waiverLines, ...waivedNextLines])) {
    const line = lines[lineNumber - 1];
    if (line === undefined) continue;
    for (const pattern of PATTERNS) {
      const global = new RegExp(pattern.regex.source, "gi");
      suppressed += [...line.matchAll(global)].length;
    }
  }

  return { waivers: waiverLines.size, suppressed };
}

/** Should this path be read at all? */
export function isScannable(path) {
  if (SELF_EXEMPT.includes(path)) return false;

  const name = path.split("/").pop() ?? path;
  if (SKIPPED_FILES.includes(name)) return false;

  const extension = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return !BINARY_EXTENSIONS.has(extension);
}

/**
 * Every file in the working tree the repository would keep — tracked **and**
 * untracked-but-not-ignored.
 *
 * **Why the untracked half is not optional.** This check exists to fail
 * before CI does. Listing only tracked files made it reliably wrong in the
 * one case a developer most needs it: a file they have just written and not
 * yet staged. The scan reported success having never opened that file, so a
 * green result said nothing at all about the new work — and CI, which reads
 * the file once it is committed, then failed on it. That cost a real
 * round-trip on PR #223, and would have cost one on every new file forever.
 *
 * A check that cannot tell "this is clean" apart from "I never looked at
 * this" is the silent-success failure this repository treats as worse than
 * no check at all.
 *
 * `--others` adds the untracked files; `--exclude-standard` applies
 * `.gitignore` and friends, which is what keeps `node_modules` and build
 * output out, and is presumably why `ls-files` was chosen over a directory
 * walk in the first place. Paths that are tracked but deleted from disk are
 * handled by the caller's `statSync`, which already skips them.
 */
function trackedFiles() {
  const listing = (extra) => {
    const result = spawnSync("git", ["ls-files", "-z", ...extra], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(
        `git ls-files failed: ${result.stderr || result.error?.message || "unknown error"}`,
      );
    }
    return result.stdout.split("\0").filter(Boolean);
  };
  // A path can appear in both listings in some index states, so dedupe: a
  // file scanned twice would report the same violation twice.
  return [...new Set([...listing([]), ...listing(["--others", "--exclude-standard"])])];
}

/** What to say about a violation that came from a waiver rather than a pattern. */
const WAIVER_ADVICE = {
  "waiver-without-a-reason": "a waiver has to say why the match is really about this repository",
  "waiver-covering-nothing":
    "this -next-line waiver covers no match — it has either shifted off the line it was " +
    "written for or the text it excused is gone. Delete it, or move it onto the line it " +
    "means; prefer the same-line `external-ref-ok` form, which no formatter can separate " +
    "from the text it excuses",
};

function describe(violation, path) {
  const pattern = PATTERNS.find((p) => p.id === violation.patternId);
  const why =
    pattern?.why ??
    WAIVER_ADVICE[violation.patternId] ??
    "a waiver has to say why the match is really about this repository";
  return [
    `${path}:${violation.line}:${violation.column}  [${violation.patternId}]  matched: ${JSON.stringify(violation.match)}`,
    `    ${violation.text.trim()}`,
    `    ↳ ${why}`,
  ].join("\n");
}

function main(argv) {
  const explicit = argv.slice(2);
  const listed = explicit.length > 0 ? explicit : trackedFiles();
  const paths = listed.filter(isScannable);

  const failures = [];
  let scanned = 0;
  let waivers = 0;
  let suppressed = 0;

  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // deleted between listing and reading; nothing to check
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) continue;

    scanned += 1;
    const contents = readFileSync(path, "utf8");
    for (const violation of findViolations(contents)) {
      failures.push(describe(violation, path));
    }
    const waived = summariseWaivers(contents);
    waivers += waived.waivers;
    suppressed += waived.suppressed;
  }

  // Say what was *not* read as well as what was. Coverage can otherwise fall
  // silently — one entry added to the skip list and the summary looks the
  // same, which is the failure mode of every check that only reports success.
  const skipped = listed.length - scanned;
  const coverage = `Scanned ${scanned} of ${listed.length} files${skipped > 0 ? ` (${skipped} skipped: binary, generated, or self-exempt)` : ""}`;
  const waiverNote =
    waivers > 0
      ? ` ${waivers} waiver${waivers === 1 ? "" : "s"} active, silencing ${suppressed} match${suppressed === 1 ? "" : "es"}.`
      : "";

  if (failures.length === 0) {
    console.log(`${coverage}: nothing refers to anything outside this repository.${waiverNote}`);
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
      "    // external-ref-ok-next-line: <reason>        (code, covers this line and the next)\n" +
      "The reason must read as a phrase, not padding, so silencing the check always costs an\n" +
      "explanation sitting in the diff beside the text it excuses.",
  );
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
