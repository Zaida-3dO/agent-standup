// The shape of a capability document reference (`notify.doc`,
// `visual_review.doc`) — SCHEMA.md §17.5.
//
// The core never reads one of these: it hands the path or URL over, and the
// agent (or a person) reads it. Server and agent do not necessarily share a
// filesystem, so existence cannot always be checked — but well-formedness
// can, always, from the value alone, which is exactly what §17.5's table
// says is "provable from the value alone" and belongs at write time. This
// module is that one check, used by both registry entries so neither
// silently drifts from the other's rule.
//
// Deliberately narrow: refuses what is definitely wrong (relative, or
// escaping via `..`), accepts what could be right (an absolute path, or a
// URL), and leaves "does this actually exist" to the separate, later checks
// §17.5's table describes (write-time existence where the server can see
// the filesystem, and the periodic sweep) — neither of which is this
// module's job.
import { z } from "zod";

/**
 * True if `value` contains a `..` path segment — the traversal §17.5 names
 * explicitly. Checked on the raw string, not a normalised one: normalising
 * first (e.g. `path.posix.normalize`) would silently collapse `a/../../etc`
 * into a string with no `..` segment, passing a value that should be
 * refused — the point is to catch the segment as written, not to decide
 * whether it would cancel out.
 */
function hasTraversalSegment(value: string): boolean {
  return value.split(/[/\\]/).includes("..");
}

/**
 * True if `value` is a well-formed absolute filesystem path.
 *
 * The application ships as a single Linux container (CLAUDE.md: built in
 * CI, pulled on the server), so "absolute" means POSIX-absolute — starting
 * with `/` — rather than also accepting a Windows drive-letter form
 * (`C:\...`), which this deployment never runs on and which would collide
 * with a URL's own `scheme:` syntax (`new URL("C:\\notes")` parses without
 * throwing, treating `c` as the scheme — exactly the ambiguity a permissive
 * check would need to resolve, and this one avoids by not accepting it).
 */
function isWellFormedAbsolutePath(value: string): boolean {
  return value.startsWith("/") && value.trim() === value && value.length > 1;
}

/**
 * True if `value` parses as a URL with an explicit `scheme://` — not merely
 * "whatever `new URL` accepts", because `new URL` also accepts a bare
 * `c:\notes\doc.md`-shaped string (reading `c` as the scheme), which is a
 * Windows path, not a URL, and must be refused rather than silently
 * reclassified.
 */
function isWellFormedUrl(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The schema for a capability document reference: a well-formed absolute
 * path or a well-formed URL, never a relative reference, never one
 * containing a `..` traversal segment. Nullable — null is "this capability
 * is off" (§17.2, §17.5), a legal and distinct value from an unset key.
 */
export const capabilityDocSchema = z
  .string()
  .min(1)
  .refine((value) => !hasTraversalSegment(value), {
    message: 'must not contain a ".." path segment',
  })
  .refine((value) => isWellFormedAbsolutePath(value) || isWellFormedUrl(value), {
    message: 'must be a well-formed absolute path (starting with "/") or a URL (scheme://…)',
  })
  .nullable();
