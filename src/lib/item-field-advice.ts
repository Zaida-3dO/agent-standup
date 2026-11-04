// Advice on the fields a person reads besides the title — the headline (one
// plain sentence), the body, and a subtask's title read as a deliverable.
//
// The title has its own advice (`item-title.ts`, answered as `titleAdvice`).
// This module answers the rest as `fieldAdvice`, on the same terms: a note
// attached to a write that SUCCEEDED, never a refusal. See `item-title.ts`
// for why a rule about how text reads cannot be a refusal, and
// `plain-text-rules.ts` for what a quiet result does and does not mean.
//
// What the board shows is short and plain. Anything big or technical belongs
// in a document attached to the item, which agents load on demand and the
// board does not render — so every size warning below says exactly that.
//
// Pure and total: no database, no settings.
import { findShapeFindings, TITLE_SCAN_MAX_CHARS, type TitleFinding } from "@/lib/item-title";
import { findPlainTextFindings } from "@/lib/plain-text-rules";

/**
 * The longest headline that reads as one plain sentence, in characters.
 *
 * Below the hard cap of 200 that the schema enforces (`HEADLINE_MAX_CHARS`):
 * the cap refuses, this nudges, and the gap is where a sentence that has
 * started to carry a paragraph is told so before it is refused.
 */
export const HEADLINE_ADVISE_MAX_CHARS = 160;

/**
 * The longest body that is still read as a description, in characters.
 *
 * A body is unbounded in the schema and is what an agent reads when it picks
 * the work up. Past this it is a document, not a description: it is a few
 * screens of text, and a log, a plan or a data dump belongs in a document
 * where it does not travel with every read of the item.
 */
export const BODY_ADVISE_MAX_CHARS = 4_000;

/** The same shape a title finding has, so one renderer serves every field. */
export type FieldFinding = TitleFinding;

/**
 * Verbs that open a title in the vocabulary of doing the work rather than
 * naming a result: the step an agent takes on the way to a deliverable.
 *
 * Deliberately NOT here: `move`, `add`, `fix`, `make`, `let`, `send`,
 * `show` — each opens plenty of honest deliverables ("Move the admin page to
 * its own address"). Only verbs that name a mechanical change count.
 */
const STEP_VERBS: ReadonlySet<string> = new Set([
  "split",
  "refactor",
  "wire",
  "wrap",
  "bump",
  "rename",
  "extract",
  "implement",
  "scaffold",
  "stub",
  "install",
  "configure",
  "migrate",
  "hook",
  "tweak",
  "patch",
  "plumb",
  "inline",
  "revert",
  "regenerate",
  "rebase",
  "mock",
  "lint",
  "instrument",
]);

/** Mechanical nouns that make a title about the work's own machinery. */
const STEP_PHRASE =
  /\b(?:(?:unit|integration|e2e)\s+tests?|tests?\s+for|env(?:ironment)?\s+vars?|config(?:uration)?\s+(?:file|key|value|flag)s?|dockerfile|docker\s+compose|container\s+ports?|port\s+mappings?|migrations?|schemas?|api\s+routes?|handlers?|regex)\b/i;

/** Whether a subtask's title reads like a step the agent takes, not a result a person would recognise. */
export function looksLikeImplementationStep(title: string): boolean {
  const first =
    title
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z-]/g, "") ?? "";
  if (STEP_VERBS.has(first)) return true;
  return STEP_PHRASE.test(title.slice(0, TITLE_SCAN_MAX_CHARS));
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether a headline just says the title again.
 *
 * Equal after normalisation, or one contains the other and they are close in
 * length (so a title with a short date prefix on the headline still counts,
 * while a short title inside a long, informative headline does not).
 */
export function headlineRepeatsTitle(title: string, headline: string): boolean {
  const t = normalise(title);
  const h = normalise(headline);
  if (t === "" || h === "") return false;
  if (t === h) return true;
  const [shorter, longer] = t.length <= h.length ? [t, h] : [h, t];
  return longer.includes(shorter) && shorter.length / longer.length >= 0.7;
}

/** What to check; every key is optional and only the keys present are checked. */
export interface FieldAdviceInput {
  /** A headline being written: shape rules and the length nudge. */
  readonly headline?: string | null;
  /** A body being written: the size nudge. */
  readonly body?: string | null;
  /** When present, the headline is compared with the title it sits under. */
  readonly repeatCheck?: { readonly title: string; readonly headline: string | null };
  /** When present, this subtask title is checked for reading like a step. */
  readonly subtaskTitle?: string;
}

/** Every way the fields in `input` depart from the convention, or an empty list. */
export function findFieldFindings(input: FieldAdviceInput): FieldFinding[] {
  const findings: FieldFinding[] = [];

  const headline = input.headline;
  if (typeof headline === "string" && headline !== "") {
    const scanned =
      headline.length > TITLE_SCAN_MAX_CHARS ? headline.slice(0, TITLE_SCAN_MAX_CHARS) : headline;
    findings.push(...findShapeFindings(scanned, "headline"));
    findings.push(...findPlainTextFindings(scanned, "headline", false));
    if (headline.length > HEADLINE_ADVISE_MAX_CHARS) {
      findings.push({
        field: "headline",
        rule: "headline_long",
        message: `The headline is ${headline.length} characters; it should be one plain sentence (under ${HEADLINE_ADVISE_MAX_CHARS}). Attach a document for anything longer or more technical.`,
      });
    }
  }

  const body = input.body;
  if (typeof body === "string" && body.length > BODY_ADVISE_MAX_CHARS) {
    findings.push({
      field: "body",
      rule: "body_long",
      message: `The body is ${body.length} characters (over ${BODY_ADVISE_MAX_CHARS}). Keep it to a short description and attach a document for plans, logs, data or long notes.`,
    });
  }

  const repeat = input.repeatCheck;
  if (
    repeat !== undefined &&
    repeat.headline !== null &&
    headlineRepeatsTitle(repeat.title, repeat.headline)
  ) {
    findings.push({
      field: "headline",
      rule: "headline_repeats_title",
      message:
        "The headline repeats the title. Say something the title does not: one plain sentence on what changes for the person.",
    });
  }

  if (input.subtaskTitle !== undefined && looksLikeImplementationStep(input.subtaskTitle)) {
    findings.push({
      field: "title",
      rule: "step_like_subtask",
      message:
        "This subtask's title reads like an implementation step. The board shows results a person would recognise or check; record steps as loops on the parent task (loop, action add) and keep subtasks for deliverables.",
    });
  }

  return findings;
}

/**
 * The findings as one note to hand back on a successful write, or `null` when
 * there is nothing to say. `null` rather than an empty string, matching
 * `titleAdviceFor`: a caller tests presence, and a response with nothing to
 * say carries no key.
 */
export function fieldAdviceFor(input: FieldAdviceInput): string | null {
  const findings = findFieldFindings(input);
  if (findings.length === 0) return null;
  return `A note on the fields: ${findings.map((finding) => finding.message).join(" ")}`;
}

/** The convention in the words a caller needs, shared by the tool contracts so the prose and the check come from one place. */
export const FIELD_CONVENTION_RULE =
  `\`headline\` is one plain sentence (under ${HEADLINE_ADVISE_MAX_CHARS} characters) that says something the title does not — never a copy of the title. ` +
  "Titles and headlines carry no dates, author tags, ids, quotes, approvals, codenames, branch names, versions or process; those go in a note or a loop. " +
  `A body over ${BODY_ADVISE_MAX_CHARS} characters, or anything big or technical (plans, logs, data), belongs in a document attached to the item. ` +
  "Create a task only for a result a person would recognise or check, and record implementation steps as loops on the task, not subtasks. " +
  "None of this is refused: a write that departs from it succeeds and returns a `fieldAdvice` or `titleAdvice` note.";
