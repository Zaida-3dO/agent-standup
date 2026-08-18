// What the top strip says you are looking at.
//
// The sidebar answers "where can I go"; the breadcrumb answers "where am
// I", and the two are not the same question on a route the sidebar does
// not list. `/items/abc` and `/admin/repos` are both reachable and neither
// is a nav destination, so a top strip that only mirrored the highlighted
// nav entry would go blank on exactly the pages a reader is most likely to
// have arrived at from a link.
//
// Plain data over a string, no React and no router, so every path shape is
// exercisable directly (`tests/nav-breadcrumb.test.ts`).
import { activeRoute } from "./routes";

export interface Crumb {
  readonly label: string;
  /** Where this crumb goes, or `null` for the trailing one (you are already there). */
  readonly href: string | null;
}

/**
 * Turns a path segment that is an identifier into something readable.
 *
 * Ids are shown truncated rather than in full: an item id is long enough
 * to push the rest of the strip off a narrow screen, and the crumb's job
 * is orientation, not citation — the page itself shows the id. A short
 * segment is left exactly as it is, because truncating something already
 * short only removes information.
 */
const ID_DISPLAY_LENGTH = 8;

export function shortenSegment(segment: string): string {
  return segment.length > ID_DISPLAY_LENGTH ? `${segment.slice(0, ID_DISPLAY_LENGTH)}…` : segment;
}

/**
 * Whether a segment reads as an identifier rather than as a word.
 *
 * The distinction decides whether the segment is truncated, and getting it
 * wrong is visible: `projects-archive` shortened to `Projects…` is a crumb
 * that has lost the half of its name that identified it, whereas a uuid
 * left in full pushes the rest of the strip off a phone.
 *
 * The test is "long, and contains a digit" — every id this application
 * mints (uuidv7, cuid, a numeric row id) carries digits, and an English
 * word in a route segment essentially never does. It is deliberately a
 * heuristic and not a parse: the cost of being wrong in either direction
 * is a crumb that reads slightly oddly, which does not justify teaching
 * this module every id format the product might ever use.
 */
export function looksLikeId(segment: string): boolean {
  return segment.length > ID_DISPLAY_LENGTH && /\d/.test(segment);
}

/** `repos` → `Repos`, `needs-you` → `Needs you`. Sentence case, not title case — a heading, not a headline. */
export function humanise(segment: string): string {
  const spaced = segment.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The crumbs for a path.
 *
 * Three shapes, and the third is why this is a function rather than a map:
 *
 *   - `/` is the root, and renders as the single crumb `Standup` with no
 *     link — linking a crumb to the page you are on is a control that does
 *     nothing.
 *   - A path the sidebar owns renders as that entry's label alone. There is
 *     no `Home / Board` because there is no hierarchy to express: the
 *     sidebar is the level above, and it is on screen.
 *   - A path the sidebar does not own (`/items/abc`) renders its segments,
 *     with identifier-looking ones shortened. The first segment links back
 *     to its section so there is a way up; the last never does.
 */
export function crumbsFor(pathname: string): readonly Crumb[] {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return [{ label: "Standup", href: null }];

  const route = activeRoute(pathname);
  if (route !== null && route.href === pathname) return [{ label: route.label, href: null }];

  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const known = index === 0 ? activeRoute(`/${segment}`) : null;
    const label =
      known !== null
        ? known.label
        : looksLikeId(segment)
          ? shortenSegment(segment)
          : humanise(segment);
    // Only the first segment gets a link, and only when it is a real
    // destination. A middle crumb built by joining segments back together
    // can easily name a path that does not resolve — `/items` is not a page
    // — and a breadcrumb that 404s is worse than one that is plain text.
    const href = !isLast && known !== null ? known.href : null;
    return { label, href };
  });
}
