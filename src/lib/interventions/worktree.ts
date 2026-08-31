// Deciding whether two claims name the same working tree — MILESTONES.md #128.
//
// I15 refuses a write into a checkout another live crew already holds. The
// question it actually has to answer is *"are we in the same working tree"*,
// and until this module existed it could not ask that: `(machine, repo)` is
// the same pair for a crew sharing one directory and for a crew in its own
// sibling worktree, and only the second is the arrangement the whole
// parallel-dispatch practice is built on.
//
// ── Why the comparison was avoided the first time ──────────────────────
//
// The entry's own header records the reason, and it was a good one:
// `Assignment.worktree` is free text a caller supplies, so `/path/to/repo`,
// `/path/to/repo/` and a differently-cased spelling of the same directory
// do not compare equal as strings. A predicate keyed on raw equality passes
// silently on exactly the collisions it exists to catch — wrong in the
// dangerous direction, and invisible.
//
// That argument is against *naive* comparison, not against comparison. What
// it actually demands is a normal form, which is what this module is: one
// function, total, with the spellings that occur in practice folded onto a
// single representative. Comparing normal forms is then an ordinary string
// equality that means what it says.
//
// ── What is folded, and what deliberately is not ───────────────────────
//
// Folded, because these are the same directory written differently and a
// caller has no reason to think the spelling matters:
//
//   - **Slash direction.** A Windows caller may send either, and the same
//     tool prints both in different contexts.
//   - **Trailing separators.** `.../repo` and `.../repo/` are one directory.
//   - **Repeated separators.** `a//b` is `a/b` to every filesystem here.
//   - **`.` segments, and `..` resolved against what precedes it.** These
//     are path arithmetic rather than identity.
//   - **Case, on a Windows-shaped path only.** See below — this is the one
//     fold that is conditional, and the condition is what keeps it honest.
//   - **A `file://` URL wrapper**, since a caller passing a URI still means
//     a directory.
//
// **Not** folded, and each omission is a decision rather than an oversight:
//
//   - **Junctions, symlinks and any other filesystem indirection.** Two
//     genuinely different spellings can denote one directory through a link,
//     and nothing here can tell without touching the disk. This module is
//     pure and the server is not on the machine the path describes, so
//     resolving them is not available even in principle. The consequence is
//     stated plainly because it decides how the caller must use this: an
//     unresolved link makes two claims look *different* when they are the
//     same, which suppresses a finding rather than inventing one. That is
//     the safe direction for a block, and it is the same direction the rest
//     of the catalogue chooses for an unanswerable question.
//   - **Relative against absolute.** `as-wt-thing` and `/somewhere/as-wt-thing`
//     are not comparable without knowing the base, and guessing a base is
//     how a comparison becomes confidently wrong.
//
// ── Case folding is conditional, and that is the careful part ───────────
//
// Case-folding every path would be wrong: POSIX filesystems distinguish
// `Build` from `build`, so folding them would call two genuinely different
// directories one, and I15 would then block a crew against a crew that is
// somewhere else entirely — the false positive this whole change exists to
// remove, reintroduced by the fix for it.
//
// Case is therefore folded only for a path that is *Windows-shaped*: one
// beginning with a drive letter, or a UNC path. Those are the spellings
// whose filesystem is case-insensitive in this setup, and a path in that
// shape cannot simultaneously be a case-sensitive POSIX path. A POSIX path
// keeps its case and compares exactly.

/**
 * Whether a path is in a Windows shape whose filesystem folds case.
 *
 * Two shapes qualify: a drive-letter path (`C:/...`), and a UNC path
 * (`//server/share/...`). Checked *after* separators are unified, so a
 * caller need not care which slash the original used.
 *
 * A bare drive letter with no following separator (`C:foo`) is deliberately
 * included: it is still a Windows spelling, whatever else is wrong with it.
 */
function isWindowsShaped(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith("//");
}

/**
 * Collapses `.` and `..` segments against what precedes them.
 *
 * `..` at the very start of a relative path is *kept*, because there is
 * nothing to resolve it against and dropping it would turn `../sibling`
 * into `sibling` — two different directories silently made one. On an
 * absolute path a leading `..` has nowhere to go and is dropped, matching
 * what every filesystem here does with `/..`.
 */
function collapseSegments(segments: readonly string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      out.push(segment);
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last !== "..") {
      out.pop();
      continue;
    }
    // Nothing to climb over. Keep it only where it can still mean something.
    if (!absolute) out.push("..");
  }
  return out;
}

/**
 * The normal form of a worktree path, or `undefined` when there is none.
 *
 * Total by construction: every input produces either a comparable string or
 * `undefined`, and `undefined` means *"this cannot be compared"* rather than
 * *"this is empty"*. Callers must read it as unknown, because a normaliser
 * that returned `""` for unusable input would make two unusable inputs
 * compare equal — which is the failure mode of the whole design, arrived at
 * from the other end.
 *
 * `null` and blank strings are the ordinary unknown here: `Assignment.worktree`
 * is nullable and `claim`'s `worktree` is optional, so most claims in the
 * wild carry nothing at all.
 */
export function normaliseWorktree(path: string | null | undefined): string | undefined {
  if (path === null || path === undefined) return undefined;

  let working = path.trim();
  if (working === "") return undefined;

  // A caller passing a URI still means a directory. Only the local form is
  // understood; a `file://host/share` authority is left alone rather than
  // guessed at, since dropping a host would merge two machines' paths.
  if (/^file:\/\/\//i.test(working)) {
    working = decodeURIComponent(working.slice("file://".length));
    // `file:///C:/x` decodes to `/C:/x`; the leading slash is URI syntax
    // rather than a root, and keeping it would make the drive-letter shape
    // unrecognisable.
    if (/^\/[A-Za-z]:/.test(working)) working = working.slice(1);
  }

  // One separator, so every later test can assume it.
  working = working.replace(/\\/g, "/");

  // A UNC path starts with exactly two separators and they are significant;
  // everywhere else repeats are noise. Recorded before collapsing, since
  // collapsing destroys the distinction.
  const isUnc = working.startsWith("//") && !working.startsWith("///");
  const absolute = working.startsWith("/") || /^[A-Za-z]:/.test(working);

  const segments = collapseSegments(working.split("/"), absolute);

  // The drive letter is a segment like any other after the split, so its
  // case is folded with the rest below; what it cannot lose is its colon.
  let joined = segments.join("/");
  if (isUnc) joined = `//${joined}`;
  else if (working.startsWith("/")) joined = `/${joined}`;

  // An absolute path that collapsed to nothing is the root itself.
  if (joined === "") return undefined;
  if (joined === "/" || joined === "//") return undefined;

  return isWindowsShaped(joined) ? joined.toLowerCase() : joined;
}

/**
 * Whether two recorded worktree paths denote the same working tree.
 *
 * Three-valued on purpose, and the third value is the point: `undefined`
 * means *"cannot tell"* — at least one side recorded nothing comparable —
 * and a caller must not collapse that into either `true` or `false`.
 *
 * The two collapses are both wrong in a way that has already happened here:
 * reading unknown as `true` (same tree) blocks every crew whose claim
 * omitted an optional field, which is the field failure this change fixes;
 * reading it as `false` (different trees) exempts them all and would have
 * let the 2026-08-23 shared-checkout incident through unremarked. Only the
 * caller knows which of those risks it is willing to take, so the decision
 * is left where the context is.
 */
export function sameWorktree(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean | undefined {
  const a = normaliseWorktree(left);
  const b = normaliseWorktree(right);
  if (a === undefined || b === undefined) return undefined;
  return a === b;
}
