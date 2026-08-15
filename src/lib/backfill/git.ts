// Reads a repository's real default branch from git, for a converter that
// has a checkout on disk to consult (BACKFILL.md, MILESTONES.md #124).
//
// The runner itself (`./runner.ts`) never reaches for git: it only ever
// sees the free-text labels a payload names, with no filesystem access of
// its own. A converter is the party that actually has a checkout, so
// reading the branch belongs here, at the one place with something to read
// it FROM — not defaulted downstream where there is nothing left to ask.
//
// `git symbolic-ref refs/remotes/origin/HEAD` reads what the remote
// actually reports as its default branch, resolved once by `git remote
// set-head origin --auto` (or by cloning) rather than guessed from a local
// branch name — a checkout can be sitting on any branch regardless of what
// the remote calls its default.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What actually runs a command — injected so this is testable without a real git binary or checkout. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<{ stdout: string }>;

const defaultRunner: CommandRunner = async (command, args, options) =>
  execFileAsync(command, [...args], { cwd: options.cwd });

export class DefaultBranchUndeterminedError extends Error {
  constructor(repoPath: string, cause: unknown) {
    super(
      `could not determine the default branch for ${JSON.stringify(repoPath)} — ` +
        `git symbolic-ref refs/remotes/origin/HEAD failed. This is not a fallback trigger: ` +
        "the caller should record this repository's defaultBranch as unknown (null) rather " +
        "than substitute a guess. " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "DefaultBranchUndeterminedError";
  }
}

/**
 * Reads a repository's default branch by asking git, never by assuming one.
 *
 * Rejects with `DefaultBranchUndeterminedError` — never returns a fallback
 * string — when git cannot answer: no `origin` remote, `origin/HEAD` never
 * resolved (a fresh clone always sets it; a hand-built checkout may not
 * have), or `repoPath` is not a git checkout at all. The caller decides
 * what "unknown" means for its own record (MILESTONES.md #124); this
 * function's only job is to distinguish "git told me X" from every other
 * case, never to guess on git's behalf.
 */
export async function readDefaultBranch(
  repoPath: string,
  runner: CommandRunner = defaultRunner,
): Promise<string> {
  let stdout: string;
  try {
    const result = await runner("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: repoPath,
    });
    stdout = result.stdout;
  } catch (error) {
    throw new DefaultBranchUndeterminedError(repoPath, error);
  }

  // `refs/remotes/origin/HEAD` resolves to e.g. `refs/remotes/origin/main`.
  const trimmed = stdout.trim();
  const prefix = "refs/remotes/origin/";
  if (!trimmed.startsWith(prefix) || trimmed.length <= prefix.length) {
    throw new DefaultBranchUndeterminedError(
      repoPath,
      new Error(`unexpected symbolic-ref output: ${JSON.stringify(trimmed)}`),
    );
  }
  return trimmed.slice(prefix.length);
}

/**
 * Reads every repository's default branch, for every `[label, path]` pair
 * supplied, and returns a `repoDefaultBranches`-shaped map plus the labels
 * that could not be determined. Never throws on an individual failure —
 * one unreadable checkout should not abort a batch reading many — so a
 * converter can report exactly which repositories it genuinely does not
 * know, and mint the rest with real values instead of one shared guess.
 */
export async function readDefaultBranches(
  repos: ReadonlyArray<{ readonly label: string; readonly path: string }>,
  runner: CommandRunner = defaultRunner,
): Promise<{ resolved: Record<string, string>; undetermined: string[] }> {
  const resolved: Record<string, string> = {};
  const undetermined: string[] = [];

  for (const { label, path } of repos) {
    try {
      resolved[label] = await readDefaultBranch(path, runner);
    } catch (error) {
      if (!(error instanceof DefaultBranchUndeterminedError)) throw error;
      undetermined.push(label);
    }
  }

  return { resolved, undetermined };
}
