// Plain-text rules for the fields a person reads on the board — a title and a
// one-line headline.
//
// The board is for people. What it shows is short and plain: a name, one
// sentence, the next step. Dates, ids, quotes, who approved what, codenames,
// branch names, version numbers and process belong on the item as notes,
// loops or documents, where agents read them and the board does not.
//
// ── Advisory, never a refusal ───────────────────────────────────────────
//
// `item-title.ts` argues at length why "reads well to a person" has no
// predicate that is right about every string, and this module inherits the
// whole argument: each rule is a *shape* that correlates with text nobody
// meant to put on a board. A wrong nudge costs one sentence in a response; a
// wrong refusal blocks a write the caller can only fix by writing something
// worse. So every function here returns findings and none throws.
//
// ── What a quiet result does and does not mean ──────────────────────────
//
// An empty list means none of the shapes below matched. It does NOT mean the
// text is good: a title can be unreadable without matching any of them. The
// rules were written against shapes that actually recurred, and deliberately
// stay narrow where the natural pattern would fire on ordinary prose —
// `up-to-date` is not a branch name, `3 a.m.` is not a date, `0.5 seconds`
// is not a version. The tests pin each of those false-positive guards.
//
// Pure and total: no database, no settings, no locale. Every regex is linear
// (no nested quantifiers) and callers hand over text already bounded by
// `TITLE_SCAN_MAX_CHARS`, so a pathological input cannot stall a request.

/** One thing about a field that will read badly on a board. Same shape as `TitleFinding`. */
export interface PlainTextFinding {
  readonly field: string;
  readonly rule: string;
  readonly message: string;
}

/** The longest title that reads as a name before it is nudged, in characters. */
export const TITLE_ADVISE_MAX_CHARS = 80;

/** The longest title that reads as a name before it is nudged, in words. */
export const TITLE_ADVISE_MAX_WORDS = 12;

const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

/**
 * A calendar date: `2026-10-29`, `29/10/2026`, `3 Nov`, `Nov 3`, `3rd November`.
 *
 * Month names are matched capitalised and followed by a word boundary, so
 * `Show 2 decimals` (no capital, not a month) and a bare year (`the 2026
 * pricing tier`) are left alone. A date needs a day next to its month.
 */
const DATE = new RegExp(
  [
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b\d{1,2}/\d{1,2}/\d{2,4}\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}\b`,
    String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b(?!\d)`,
  ].join("|"),
);

/**
 * An id: a full UUID, or a long hex token that mixes digits and letters
 * (`767322fe`). Requiring both a digit and a letter keeps an all-digit
 * number and an all-letter word (`effaced`) out of it.
 */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const HEX_TOKEN = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/i;

/**
 * Quoted text of more than one word: `"yes start it please"`, curly quotes,
 * or single quotes that open after a space or bracket (so an apostrophe in
 * `users' sessions` never opens one). A single quoted word (`rename "Inbox"`)
 * is a name, not quoted speech, and is left alone.
 */
const DOUBLE_QUOTED = /"([^"]+)"|“([^”]+)”/g;
const SINGLE_QUOTED = /(?:^|[\s(\[])'([^']+)'(?=$|[\s).,;:!?\]])/g;

function hasQuotedText(text: string): boolean {
  for (const pattern of [DOUBLE_QUOTED, SINGLE_QUOTED]) {
    for (const match of text.matchAll(pattern)) {
      const inner = match[1] ?? match[2] ?? "";
      if (/\S\s+\S/.test(inner)) return true;
    }
  }
  return false;
}

/**
 * A "who and when" tag: a name followed by a date, either leading
 * (`Name 2026-10-17: ...`, `Name 3 Nov - ...`) or in brackets
 * (`(Name 2026-10-29)`). The date rule also fires on these; this one exists
 * so the message can say what the pattern means — an author tag belongs in a
 * note.
 */
const AUTHOR_DATE = new RegExp(
  [
    String.raw`^[A-Z][\p{L}'’-]*(?:\s[A-Z][\p{L}'’-]*)?\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}|${MONTH}\s+\d{1,2})\s*[:\-–—]`,
    String.raw`\(\s*[A-Z][\p{L}'’-]*(?:\s[A-Z][\p{L}'’-]*)?\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+${MONTH}|${MONTH}\s+\d{1,2})\s*\)`,
  ].join("|"),
  "u",
);

/** A web address or any `scheme://` link (`https://...`, `app://open`, `www.`). */
const URL_SHAPE = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.[a-z0-9-]+\.\S+/i;

/**
 * An internal codename: a short wave id (`w12`), a numbered or lettered wave
 * (`Wave A`, `wave 2`, `Waves 1`), or a crew name (`crew-w12`).
 *
 * `wave` alone is ordinary English (`Handle the wave animation`); it only
 * counts when followed by a single capital letter or a number, which is how
 * a work package is labelled and almost never how prose uses the word.
 */
const CODENAME_WAVE_ID = /\bw\d{1,3}\b/i;
// Case-sensitive on purpose: `wave a bit` is prose, `Wave A` is a label.
const CODENAME_WAVE_LABEL = /\b[Ww]aves?\s+(?:[A-Z]\b|\d)/;
const CODENAME_CREW = /\bcrew-[\w-]+/i;

/**
 * A branch name: a path-style prefix (`feat/login`), or three-plus hyphenated
 * lowercase segments that either start with a branch prefix or carry a
 * letters-then-digits label segment (`w12-health-delight`).
 *
 * Plain hyphenated English survives: `up-to-date`, `end-to-end`,
 * `3-step-process` and `state-of-the-art` have three or more segments but
 * neither a label segment nor a branch prefix, so they are not branch names.
 */
const BRANCH_SLASH = /\b(?:feat|feature|fix|bugfix|hotfix|chore|release|wip|crew|bf)\/[\w./-]+/;
const BRANCH_HYPHEN = /\b[a-z0-9]+(?:-[a-z0-9]+){2,}\b/g;
// A segment of letters then digits (`w12`, `v2`): a label, where `3-step` is a count.
const BRANCH_LABEL_SEGMENT = /(?:^|-)[a-z]+\d+[a-z0-9]*(?=-|$)/;
const BRANCH_PREFIX = /^(?:feat|fix|bugfix|hotfix|chore|wip|crew|bf)-/;

function hasBranchLikeWord(text: string): boolean {
  if (BRANCH_SLASH.test(text)) return true;
  for (const match of text.matchAll(BRANCH_HYPHEN)) {
    const word = match[0];
    if (BRANCH_LABEL_SEGMENT.test(word) || BRANCH_PREFIX.test(word)) return true;
  }
  return false;
}

/**
 * A version number: `v1.2`, `1.2.3`, or two parts after a version word
 * (`version 0.7`, `release 2.1`).
 *
 * A bare two-part number is NOT a version — `0.5 seconds`, `4.99` and `3.5
 * hours` are quantities. That leaves `the 0.7 pass` unflagged, a deliberate
 * miss: the alternative flags every decimal on the board.
 */
const VERSION =
  /\bv\d+\.\d+(?:\.\d+)*\b|\b\d+\.\d+\.\d+(?:\.\d+)*\b|\b(?:version|release|build|ver)\s+v?\d+\.\d+\b/i;

/**
 * A separator that makes a title two things at once: a spaced hyphen or
 * dash, a semicolon, or a colon followed by a space. A colon inside a time
 * (`10:30`) or a link (`https://`) is not followed by a space, so it never
 * matches.
 */
const SPACED_DASH = /\s[-–—]\s/;
const SEMICOLON = /;/;
const COLON = /[^\s:]:(?:\s|$)/;

function wordsIn(text: string): string[] {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token));
}

/**
 * Whether the title uses a separator to say two things at once.
 *
 * One exemption, because it is how a short scoped name is honestly written:
 * a SINGLE-word label before ONE colon on a title of eight words or fewer
 * (`Helm: fixes, themes and sounds`). A label with a date in front of it is
 * still caught by the date and author-tag rules, and a multi-word prefix or
 * a second colon is caught here.
 */
export function hasTitleSeparator(title: string): boolean {
  if (SPACED_DASH.test(title) || SEMICOLON.test(title)) return true;
  if (!COLON.test(title)) return false;
  const colonCount = (title.match(/:/g) ?? []).length;
  const prefix = title.slice(0, title.indexOf(":"));
  const singleWordLabel = wordsIn(prefix).length === 1;
  return !(colonCount === 1 && singleWordLabel && wordsIn(title).length <= 8);
}

/** "the title" / "the headline", for messages that name the field. */
function theField(field: string): string {
  return `The ${field}`;
}

/**
 * Where the displaced detail goes, per field. A title's detail goes in the
 * headline or a document; a headline's goes in a note, a loop or a document.
 */
function whereItGoes(field: string, isTitle: boolean): string {
  return isTitle
    ? "Keep the title a short name; put the detail in the headline, a note or a document."
    : `Keep the ${field} one plain sentence; put the detail in a note, a loop or a document.`;
}

/**
 * Every plain-text shape `text` carries, for one field. `field` names it in
 * each message; `"title"` additionally gets the title-only rules (a long
 * title, a separator).
 *
 * Takes text already bounded by the caller — see the header.
 */
export function findPlainTextFindings(
  text: string,
  field: string,
  isTitle = field === "title",
): PlainTextFinding[] {
  const out: PlainTextFinding[] = [];
  const add = (rule: string, message: string): void => {
    out.push({
      field,
      rule,
      message: `${theField(field)} ${message} ${whereItGoes(field, isTitle)}`,
    });
  };

  if (AUTHOR_DATE.test(text)) {
    add(
      "author_date",
      "carries a name and a date (who said or approved it, and when). That is a note on the item, not part of what the board shows.",
    );
  } else if (DATE.test(text)) {
    add("date", "carries a date, which goes stale and means nothing at a glance.");
  }
  if (UUID.test(text) || HEX_TOKEN.test(text)) {
    add("id", "carries an id, which a person cannot read.");
  }
  if (hasQuotedText(text)) {
    add("quoted_text", "quotes someone. Who approved or asked for the work is a note, not a name.");
  }
  if (URL_SHAPE.test(text)) {
    add("url", "carries a web address or a link scheme, which is technical detail.");
  }
  if (CODENAME_WAVE_ID.test(text) || CODENAME_WAVE_LABEL.test(text) || CODENAME_CREW.test(text)) {
    add("codename", "carries an internal codename (a wave, a crew or a work-package label).");
  }
  if (hasBranchLikeWord(text)) {
    add("branch_name", "carries a branch-style name, which means nothing outside the code.");
  }
  if (VERSION.test(text)) {
    add("version", "carries a version number.");
  }

  if (isTitle) {
    if (text.length > TITLE_ADVISE_MAX_CHARS || wordsIn(text).length > TITLE_ADVISE_MAX_WORDS) {
      out.push({
        field,
        rule: "title_long",
        message: `The title is long: a title is a short name of a few words (under ${TITLE_ADVISE_MAX_CHARS} characters). Say the rest in the headline, and attach a document for anything big or technical.`,
      });
    }
    if (hasTitleSeparator(text)) {
      out.push({
        field,
        rule: "title_separator",
        message:
          "The title uses a separator (a dash, colon or semicolon) to say two things at once. Keep the name, and move the explanation into the headline as one plain sentence.",
      });
    }
  }

  return out;
}
