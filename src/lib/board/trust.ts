// Whether a board row should carry a trust badge at all — the presence
// question, kept separate from the wording question `TrustBadge` answers.
//
// ── Why this module exists ───────────────────────────────────────────────
//
// `TrustBadge.tsx`'s header argues, correctly, that the badge itself carries
// no provenance: its two labels answer "has anyone checked this state?" and
// nothing more, and making them assert an origin they cannot see is how a
// label comes to claim an external source for a row that has none. That
// argument is about the COMPONENT, and it holds — nothing here changes what
// the badge says or what it is given.
//
// But **whether to render one is a different question, asked by the caller**,
// and the callers did not agree on it. `ItemDetailView.tsx` already gates the
// badge's presence on `isUnverifiedOrigin(item.originType)`, so a row created
// here shows no badge on its detail page. The two board surfaces
// (`ItemCard.tsx`, `ListView.tsx`) gated only on `entry.trust` being present,
// which is every non-project row — so the same item that the detail view
// leaves unbadged was badged "Unchecked" on the board.
//
// ── The contradiction that made this a defect rather than an asymmetry ───
//
// The board filter's `trusted` position is `NOT (imported AND unchecked)`
// (`trustCondition`, `trust-view.ts`). A row minted through `create_work` is
// therefore *inside* that filter. Filter the board to **Trusted** and the
// card that comes back reads "Unchecked" on its face: the filter calls the
// row trusted and the card calls it unchecked, at the same moment, in front
// of the reader. Neither statement is individually false — they are answering
// different questions with the same word — which is precisely why the reader
// cannot be expected to reconcile them.
//
// `trust-view.ts` names this failure mode itself, in `trustCondition`'s
// header: "Two independent spellings of 'unverified' — one in a renderer and
// one in a query — is precisely how a filter and a badge come to disagree,
// and the disagreement would be invisible because each is individually
// correct." It then guards the pairing by keeping `isUnverifiedOrigin` four
// lines from `UNVERIFIED_ORIGIN_SQL`. That guard was watching the wrong pair:
// the renderer half it protects is the one the *border* uses, and the badge
// reached the card by a third route nothing was comparing.
//
// So this module is that comparison, made explicit and shared: one predicate,
// imported by every board surface that decides whether a badge appears.
//
// ── What it deliberately does NOT do ─────────────────────────────────────
//
// It does not suppress the badge on an imported row that someone has since
// checked. That row is the case the badge is *for* — it names who looked and
// when, which is the "don't re-derive this a third time" record `trust-view.ts`
// was built to preserve (its header puts the cost at ~76k tokens per repeated
// reconciliation walk). `unverifiedOrigin` is permanent and does not clear on
// verification, so gating on it alone keeps that row badged "Verified" with
// its full provenance. A gate written as `!verified` instead would delete
// exactly this case, which is why the predicate below reads the origin and
// not the check.
//
// It also leaves the dashed border alone. The border keys on the same
// `unverifiedOrigin` fact and already agrees with the filter; two surfaces
// agreeing is not the problem here.
import type { TrustInfo } from "./types";

/**
 * Whether this row's trust position is worth marking on a board surface.
 *
 * True only for an imported row — one whose `state` arrived by copy rather
 * than through this product's own state machine, and so is the only kind of
 * row that has anything to verify. See `trust-view.ts`'s header for why
 * `originType` is the mechanical signal and "the headline disagrees with the
 * state" is not.
 *
 * `null` for a project (no `state` of its own to distrust, DECISIONS.md §13c)
 * and `undefined` where a caller has no trust information at all; both mean
 * "nothing to mark" rather than "trusted", and both return false.
 *
 * Typed as a predicate (`trust is TrustInfo`) rather than a plain `boolean`
 * so a caller can pass the result straight to `trustPresentation`, which
 * requires a non-null row. That is sound because reading `.unverifiedOrigin`
 * off `null`/`undefined` yields `undefined`, which is not `true` — so every
 * path returning true has already dereferenced a real object. Without it
 * each call site needs a second `&& entry.trust` that TypeScript understands
 * and a reader reads as a redundant check.
 */
export function showsTrustBadge(trust: TrustInfo | null | undefined): trust is TrustInfo {
  return trust?.unverifiedOrigin === true;
}

/**
 * The props a board surface passes to `TrustBadge`, derived from one row.
 *
 * Returned as a whole object rather than read field-by-field at each call
 * site, because field-by-field is how two surfaces drift into spelling the
 * same derivation differently — one passing the three check fields
 * unconditionally as `undefined`, the other spreading them only when a check
 * exists. Those two agree only while `verified` is false wherever they
 * differ, which is a coincidence rather than a guarantee, and this file's
 * whole subject is what such coincidences cost.
 *
 * Call only where `showsTrustBadge` is true; a caller that renders this on a
 * native row would reintroduce the defect this module exists to close.
 */
export function trustPresentation(trust: TrustInfo): {
  verified: boolean;
  checkedAt?: string;
  checkedByType?: string;
  checkedById?: string | null;
} {
  const verification = trust.verification;
  if (verification === null) return { verified: false };
  return {
    verified: true,
    checkedAt: verification.checkedAt,
    checkedByType: verification.checkedByType,
    checkedById: verification.checkedById,
  };
}
