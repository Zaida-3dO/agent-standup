// An item's links — normalising a list of them, and writing the set.
//
// The counterpart of `item-areas.ts` for the other multi-valued thing an
// item carries, and deliberately shaped like it: one function that resolves
// caller input to storable values, one that writes the whole set inside the
// caller's transaction. Following that shape rather than inventing a second
// one means a reader who has understood areas already understands links.
//
// **Where it differs from areas, and why.** An area is a reference to a row
// in a vocabulary table that is created on first use; a link is a pair of
// plain strings referencing nothing. So there is no `ensure`-style lookup
// here, and correspondingly no way for a link to fail because something else
// did not exist — the only refusals are about the values themselves.
import { z } from "zod";
import type { ServiceContext } from "../context";
import { GuardRejectedError } from "../errors";
import { LINK_KEY_MAX_CHARS, LINK_URL_MAX_CHARS, refuseLinkUrl } from "./link-url";

/**
 * How many links one item may carry.
 *
 * A bound rather than an opinion about how many pointers work deserves: the
 * corpus that motivated this feature tops out at five on its busiest item,
 * so this is far above real use. It is here because every link is rendered
 * on a card and returned on every full item read, and an item with ten
 * thousand of them would make both unusable — a cap keeps one caller's
 * mistake from degrading a shared surface.
 */
export const MAX_LINKS_PER_ITEM = 50;

/** One link, as a caller supplies it and as it is stored. */
export interface ItemLinkInput {
  readonly key: string;
  readonly url: string;
}

/**
 * The input schema every operation that accepts links shares.
 *
 * One definition rather than the shape repeated per operation, so `create_*`
 * and `update_item` cannot come to disagree about what a link is — which is
 * the drift the service layer's shared shapes exist to rule out, and the
 * reason `commonCreateShape` exists at all.
 *
 * **The schema checks length and structure only; the scheme rule lives in
 * `normalizeLinks`.** That split is deliberate rather than an oversight. A
 * Zod refinement runs before the transaction opens and would refuse with a
 * validation error naming a path, but the refusal a caller needs here
 * explains *why* a scheme is unacceptable and what is accepted instead —
 * and it has to be the same sentence whether the value arrived through an
 * operation's schema or through any other call site of `setItemLinks`. One
 * rule enforced in one place cannot be bypassed by a path that forgot to
 * attach the refinement.
 */
export const linksInputSchema = z
  .array(
    z
      .object({
        /** The chip's label — lowercased and whitespace-collapsed on the way in. */
        key: z.string().min(1).max(LINK_KEY_MAX_CHARS),
        /**
         * Where it points. Any scheme except the executable ones
         * (`javascript:`, `data:`, `vbscript:`) — so `https://`, `coda://`,
         * `slack://` and an installation's own handler are all accepted.
         */
        url: z.string().min(1).max(LINK_URL_MAX_CHARS),
      })
      .strict(),
  )
  .max(MAX_LINKS_PER_ITEM);

/**
 * Normalises and de-duplicates a caller's list of links.
 *
 * **The key is lowercased and whitespace-collapsed; the url is trimmed and
 * otherwise left exactly as given.** That asymmetry is the important part.
 * A key is a label a person types and a chip displays, so `Slack`, `slack `
 * and `SLACK` are one label and storing three rows for them would put three
 * identical-looking chips on a card — the de-duplication a caller expects
 * has to happen on the value they *meant*, not the bytes they sent. A URL is
 * the opposite: case is significant after the host in most schemes, and
 * `%2F` is not `/`, so any normalisation beyond trimming risks storing a
 * pointer to something other than what the caller named. The product does
 * not resolve these URLs and must not rewrite them.
 *
 * De-duplication is on the normalised `(key, url)` pair — the same identity
 * the primary key enforces — so a caller sending a duplicate twice in ONE
 * call gets one row, exactly as sending it in two calls does. Without this
 * the two paths would disagree: the database would silently absorb the
 * within-call duplicate via `ON CONFLICT`, which is the right outcome
 * reached by an accident of the write rather than by a rule, and the
 * returned set would not match what the caller was told was stored.
 *
 * Order is preserved (first occurrence wins), because a caller listing
 * `[pr, ticket, slack]` has expressed an order and a chip row that
 * re-arranged it would look arbitrary.
 */
export function normalizeLinks(raw: readonly ItemLinkInput[]): ItemLinkInput[] {
  if (raw.length > MAX_LINKS_PER_ITEM) {
    throw new GuardRejectedError(
      "items.links.too_many",
      `An item may carry at most ${MAX_LINKS_PER_ITEM} links; ${raw.length} were given.`,
      { fields: ["links"] },
    );
  }

  const seen = new Set<string>();
  const normalized: ItemLinkInput[] = [];

  for (const entry of raw) {
    // Interior whitespace collapses too, so `design  doc` and `design doc`
    // are one key. A tab or a newline pasted into a label is invisible on a
    // chip, which is exactly the kind of difference that produces two rows
    // a reader cannot tell apart.
    const key = entry.key.trim().replace(/\s+/g, " ").toLowerCase();
    const url = entry.url.trim();

    if (key === "") {
      throw new GuardRejectedError("items.links.key_required", "A link's key must not be empty.", {
        fields: ["links"],
      });
    }
    if (key.length > LINK_KEY_MAX_CHARS) {
      throw new GuardRejectedError(
        "items.links.key_too_long",
        `A link's key must be at most ${LINK_KEY_MAX_CHARS} characters; "${key}" is ${key.length}.`,
        { fields: ["links"] },
      );
    }

    // The security boundary. Raised as a guard rejection with the offending
    // reason verbatim, so a caller holding a `coda://` URI is told whether
    // the rule or their value is the problem — see `link-url.ts`.
    const refusal = refuseLinkUrl(url);
    if (refusal !== null) {
      throw new GuardRejectedError("items.links.invalid_url", refusal, { fields: ["links"] });
    }

    // `\u0000` cannot appear in either value, so it is an unambiguous
    // separator: no pair of distinct (key, url) values can collide on the
    // joined string the way they could with a printable delimiter.
    const identity = `${key}\u0000${url}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push({ key, url });
  }

  return normalized;
}

/**
 * Writes an item's link set as exactly `links` (already normalised).
 *
 * Delete-then-insert rather than a diff, for the same reason `setItemAreas`
 * does it: a link set is a handful of rows that arrives whole, and computing
 * the difference would be more code for the same result.
 *
 * `ON CONFLICT DO NOTHING` is redundant after `normalizeLinks` has
 * de-duplicated the list, and is kept anyway as the second of two
 * independent mechanisms enforcing one rule. The application-level dedupe is
 * what lets a caller be *told* what was stored; the database constraint is
 * what makes the guarantee true regardless of who writes. A defect in either
 * one alone leaves the behaviour correct, which is why
 * `tests/item-links.test.ts` asserts the outcome rather than either
 * mechanism.
 */
export async function setItemLinks(
  ctx: ServiceContext,
  itemId: string,
  links: readonly ItemLinkInput[],
): Promise<void> {
  await ctx.db.$executeRawUnsafe(`DELETE FROM "ItemLink" WHERE "itemId" = $1`, itemId);
  for (const link of links) {
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "ItemLink" ("itemId", "key", "url") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      itemId,
      link.key,
      link.url,
    );
  }
}
