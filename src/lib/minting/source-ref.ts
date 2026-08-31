// The identity of a source version — DECISIONS.md §13, MILESTONES.md #63.
//
// **The file is the atom, not the section.** §13 settles this: two agents
// can split one document differently, so per-section identity cannot be
// made deterministic, while a file's bytes can. Every function here is
// therefore about a whole file and never about a part of one.
//
// `items.source_ref` is the record (SCHEMA.md §1) and there is no `sources`
// table, so this module owns the *format* of that column and nothing else.
// It is deliberately pure — no filesystem, no database — because the format
// is the part every caller has to agree on, and a pure function is the part
// a test can pin exactly.
import { createHash } from "node:crypto";

/**
 * The separator between a source's path and its content hash.
 *
 * `@`, matching SCHEMA.md §1's `path@content_hash` and the worked example
 * in BACKFILL.md. A path may itself contain `@`, which is why every reader
 * below splits at the LAST one rather than the first.
 */
export const SOURCE_REF_SEPARATOR = "@";

/**
 * How many hex characters of the digest a ref carries.
 *
 * The full SHA-256 is 64 and this keeps 16 — 64 bits, the same order as a
 * git object id abbreviated to 16, and long enough that an accidental
 * collision across a corpus of source files is not a practical concern
 * (birthday-bound: ~5 billion files for a 1-in-a-billion chance). The
 * reason not to keep all 64 is that this value is read by people in a board
 * row and in a summary line, and a ref whose hash is longer than its path
 * is one nobody reads.
 *
 * **Truncation is safe here in a way it would not be for a security claim**
 * — this hash answers "have the bytes changed since we minted?", where the
 * adversary is an editor saving a file, not someone constructing a
 * collision.
 */
export const SOURCE_HASH_LENGTH = 16;

/**
 * The content hash of a source file's bytes.
 *
 * Takes the bytes rather than a path: hashing is a pure function of
 * content, and keeping the read out of it is what lets every test here run
 * without a filesystem. It also means a caller that already holds the
 * content — a poll payload carrying pending source hashes (SCHEMA.md §19,
 * `POST /poll`) — does not have to write it to disk to ask.
 */
export function hashSourceContent(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex").slice(0, SOURCE_HASH_LENGTH);
}

/**
 * The `source_ref` for a path at a particular content hash.
 *
 * The path is used verbatim. Normalising it here would be the wrong place:
 * what counts as the same path is a property of the scanner's own root and
 * separator conventions, and a normaliser buried in a formatter would apply
 * silently to callers that had already normalised — see `normaliseSourcePath`,
 * which is the one the scanner calls explicitly.
 */
export function formatSourceRef(path: string, contentHash: string): string {
  return `${path}${SOURCE_REF_SEPARATOR}${contentHash}`;
}

/** A `source_ref` taken apart again. Null when the string is not one. */
export function parseSourceRef(ref: string): { path: string; contentHash: string } | null {
  const at = ref.lastIndexOf(SOURCE_REF_SEPARATOR);
  // A separator at position 0 would mean an empty path, and one at the end
  // an empty hash. Neither is a ref this module would ever have produced,
  // and accepting either would make `path` or `contentHash` empty for a
  // caller that then queries on it.
  if (at <= 0 || at === ref.length - 1) return null;
  return { path: ref.slice(0, at), contentHash: ref.slice(at + 1) };
}

/**
 * The path half of a ref, for the read §13 ends on — *"the agent is told
 * which items already came from the previous version"*.
 *
 * That read is a prefix match (`source_ref LIKE 'path@%'`) rather than an
 * equality, which is the reason the plain `Item_sourceRef_idx` stays
 * alongside the unique one: the unique index answers "this exact version",
 * and only a prefix scan answers "any version of this file".
 */
export function sourcePathOf(ref: string): string | null {
  return parseSourceRef(ref)?.path ?? null;
}

/**
 * A path in the one form a ref stores.
 *
 * Backslashes become forward slashes and a trailing slash is dropped, so
 * the same file scanned from a machine using either separator produces the
 * same ref and therefore dedupes against itself. **This is why it exists at
 * all**: `machines.source_globs` is per-machine precisely because
 * filesystem layouts differ (SCHEMA.md §17.7), so the same source reached
 * two ways must not mint twice.
 *
 * Deliberately NOT absolutising and not resolving symlinks. An absolute
 * path is machine-specific — it would make the same file in a checkout on
 * two machines two different sources, which is the opposite of what this
 * is for — and it would put a local path into a public database. Callers
 * pass a path relative to the scan root.
 */
export function normaliseSourcePath(path: string): string {
  const forward = path.replace(/\\/g, "/");
  const collapsed = forward.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}
