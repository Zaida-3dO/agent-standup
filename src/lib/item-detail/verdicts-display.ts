// How each review verdict READS on screen — the display half of
// `@/lib/verdicts`, which owns what the verdicts mean to the merge gate.
//
// ── Why a tier is not a string substitution ────────────────────────────
//
// The detail view rendered a verdict by stripping its underscores, so
// `lgtm_with_followups` reached the reader as "lgtm with followups" and
// `lgtm_with_nits` as "lgtm with nits" — two labels that differ by one word
// and mean two genuinely different things about what happens next. One says
// the change is sound and some cosmetic work is owed against THIS change
// before it lands; the other says the change is sound, the findings are
// real, and they are being done as separate work that is already filed.
// The difference between "merge it" and "merge it, and something else must
// still happen" is precisely what a reviewer is communicating, and an
// underscore-stripper communicates none of it.
//
// So a verdict carries three things here rather than one:
//
//   `label`    what it is called, in words a reader does not have to decode.
//   `meaning`  what it obliges — one sentence, shown beside the label,
//              because the label alone cannot carry "only if a follow-up is
//              linked".
//   `tone`     which of four visual treatments it takes. Four, not two:
//              a pass with outstanding work must not look identical to a
//              clean pass, or the tiering is flattened again in colour
//              having been un-flattened in text.
//
// ── Why `tone` has a `na` of its own ───────────────────────────────────
//
// `na` means "this artifact kind has no verdict to give" — a `test_run`, a
// `commit`. It is not an approval (`@/lib/verdicts` is explicit that reading
// it as one would let an item merge on an artifact that reviewed nothing)
// and it is not a rejection either. Painting it with the blocked treatment
// would report a refusal nobody made; painting it with the pass treatment
// would report an approval nobody gave. It gets the neutral one.
import { VERDICTS, type Verdict } from "@/lib/verdicts";

/**
 * The four visual treatments a verdict can take.
 *
 * `pass` — cleared, nothing further owed.
 * `pass_with_work` — cleared, and something else is still outstanding.
 * `blocked` — not cleared; the work comes back.
 * `neutral` — no claim either way.
 */
export type VerdictTone = "pass" | "pass_with_work" | "blocked" | "neutral";

export interface VerdictDisplay {
  readonly verdict: string;
  readonly label: string;
  readonly meaning: string;
  readonly tone: VerdictTone;
}

/**
 * Every verdict, spelled out.
 *
 * A `Record<Verdict, …>` deliberately: a seventh label added to the enum in
 * `@/lib/verdicts` fails to compile here until somebody decides what it is
 * called and what it obliges, which is the property that stops a new tier
 * shipping as its own raw identifier — the exact failure this module exists
 * to correct.
 */
const DISPLAY: Record<Verdict, Omit<VerdictDisplay, "verdict">> = {
  lgtm: {
    label: "LGTM",
    meaning: "Clean. Nothing outstanding — this merges as it stands.",
    tone: "pass",
  },
  lgtm_with_nits: {
    label: "LGTM, with nits",
    meaning:
      "Sound, with cosmetic findings left against this change. Addressing them moves the tip, so a light re-review at the new commit is required before it merges.",
    tone: "pass_with_work",
  },
  lgtm_with_followups: {
    label: "LGTM, with follow-ups",
    meaning:
      "Sound. The findings are real but are not blocking this change — it merges now, only if the follow-up work is linked as its own item.",
    tone: "pass_with_work",
  },
  changes_required: {
    label: "Changes required",
    meaning: "Blocking. The work comes back, and the next round is a full fresh review.",
    tone: "blocked",
  },
  approved: {
    label: "Approved",
    meaning: "Cleared. An accepted synonym of LGTM, and decided identically by the merge gate.",
    tone: "pass",
  },
  na: {
    label: "Not applicable",
    meaning:
      "This artifact has no verdict to give — it is evidence, not an assessment. It approves nothing.",
    tone: "neutral",
  },
};

/**
 * What an unrecognised verdict displays as.
 *
 * It keeps its raw value as the label rather than being hidden or renamed:
 * a reader seeing a verdict this build has never heard of should see exactly
 * what is stored, because the stored value is the only true thing available.
 * The tone is `neutral` for the same reason `PASSING_VERDICTS` refuses to
 * assume — a value nobody taught this code makes no claim it is safe to
 * paint as cleared, and none it is fair to paint as a refusal.
 */
function unknownDisplay(verdict: string): VerdictDisplay {
  return {
    verdict,
    label: verdict,
    meaning: "An unrecognised verdict — this build does not know what it obliges.",
    tone: "neutral",
  };
}

/** How `verdict` reads on screen. Never throws: an unrecognised value gets `unknownDisplay`. */
export function verdictDisplay(verdict: string): VerdictDisplay {
  const known = (DISPLAY as Record<string, Omit<VerdictDisplay, "verdict"> | undefined>)[verdict];
  return known === undefined ? unknownDisplay(verdict) : { verdict, ...known };
}

/**
 * Every verdict this build knows, in the order the enum declares them —
 * exported so a legend or a test can range over the whole vocabulary rather
 * than over the subset somebody remembered to list.
 */
export function allVerdictDisplays(): readonly VerdictDisplay[] {
  return VERDICTS.map((verdict) => verdictDisplay(verdict));
}
