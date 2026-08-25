// Whether a card's `state` can be taken on faith — MILESTONES.md #131's
// second half.
//
// A verified state and an unverifiable one must not look the same, exactly
// as an empty column and a withheld one must not (#123's rule, applied to a
// single card rather than a whole section). Two things carry that
// difference here, deliberately redundant so neither channel alone has to
// do the whole job:
//
//   - This badge — text plus the `--trust-unverified` fill, so the fact is
//     legible even to a reader who cannot see the border.
//   - The card's own dashed border (`Board.module.css` `.cardUnverified`),
//     painted from the same token, so the fact is visible even at a glance
//     that never reaches the text.
//
// Never a severity colour: `globals.css` §6 is explicit that an unverified
// row "is not *wrong*, it is unconfirmed", so this shares no visual
// vocabulary with `blocked`'s red or `merged`'s green — painting it that way
// would tell a reader the item has a problem, when the honest claim is
// narrower: nobody has checked.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { trustTokens } from "@/lib/design/tokens";
import styles from "./Chips.module.css";

export interface TrustBadgeProps {
  /** ISO 8601 — when the newest check happened. Present only once `verified` is true. */
  readonly checkedAt?: string;
  /** `person` or `agent` — who ran the newest check. Present only once `verified` is true. */
  readonly checkedByType?: string;
  /**
   * *Which* person or agent ran it, where the artifact recorded an id.
   *
   * Optional independently of `checkedByType`, because the two are stored
   * independently: an artifact can name a type with no id. When it is
   * absent the badge falls back to the type alone ("by a person") rather
   * than claiming an unknown checker — the weaker sentence is the true one.
   */
  readonly checkedById?: string | null;
  /**
   * True when a `historical_verification` exists for this item — i.e.
   * someone has actually looked, whatever they found. False renders the
   * plain "Imported" marking the row header asks for.
   */
  readonly verified: boolean;
}

/**
 * The badge.
 *
 * Two states, not a spectrum: `verified` names whether a check is ON
 * RECORD, never whether that check agreed with the current `state` — a
 * verification that found the state WRONG is still a verification, and
 * still means someone can be asked what they found rather than the row
 * standing wholly unaccounted for. Reading the verdict of the check, if any,
 * is the reader's job once they open the item; this badge only answers "has
 * anyone looked".
 */
/**
 * Who ran the check, in words — the `by …` clause of the tooltip.
 *
 * Names the holder where one was recorded, and degrades to the type alone
 * where one was not. The id is preferred over the type because "checked by
 * gary" is a claim a reader can follow up and "checked by an agent" is not,
 * which is the whole difference this badge exists to carry. An id with no
 * type still names somebody, so it is not gated on the type being present.
 */
export function verifierPhrase(
  checkedByType: string | undefined,
  checkedById: string | null | undefined,
): string {
  if (checkedById !== undefined && checkedById !== null && checkedById !== "") {
    return checkedById;
  }
  if (checkedByType === undefined || checkedByType === "") return "";
  return checkedByType === "person" ? "a person" : "an agent";
}

export function TrustBadge({ checkedAt, checkedByType, checkedById, verified }: TrustBadgeProps) {
  const tokens = trustTokens();
  const label = verified ? "Verified" : "Imported";
  const verifier = verifierPhrase(checkedByType, checkedById);
  const title = verified
    ? `Checked ${checkedAt ?? "at an unrecorded time"}${verifier === "" ? "" : ` by ${verifier}`}`
    : "Imported from an external store — this state has never been checked against the live system.";

  return (
    <span
      className={`${styles.chip} ${styles.outlined} ${styles.trustBadge}`}
      style={{ color: tokens.fg, borderColor: tokens.border }}
      data-trust={verified ? "verified" : "unverified"}
      aria-label={`Trust: ${label}`}
      title={title}
    >
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
