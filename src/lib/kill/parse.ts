// Reading a kill command — MILESTONES.md #45, DECISIONS.md §4.
//
// This module answers exactly one question: **what would this command
// kill?** It does not decide whether killing it is allowed — that is
// `./ownership.ts`, reached through the `kill_guard` operation
// (`../service/operations/kill-guard.ts`), server-side, where the registry
// lives. Keeping the two apart is the same split the merge gate uses
// (#44: "the judgement server-side, only command parsing local"): parsing a
// command string is the one part that genuinely cannot run anywhere but
// next to the command, and everything downstream of it can.
//
// ── Why a target set rather than a boolean ─────────────────────────────
//
// A pattern match can only say "this looks like a kill". The row's own
// framing is an **ownership check** — "do you own this process" rather than
// "does this command match a pattern" — and an ownership check needs to
// know *which* processes, so this returns identifiers the registry can be
// asked about. A command naming three PIDs produces three targets and each
// is checked; a command naming an executable produces one target of a
// different kind, and the registry answers a different question about it
// (does anyone *else* own a live process running that executable).
//
// ── Why unparseable is its own outcome ─────────────────────────────────
//
// A kill-shaped command this module cannot decompose is NOT "not a kill".
// `taskkill /F /FI "IMAGENAME eq node.exe"` kills by filter, and a parser
// that reported "no targets found" for it would hand the guard an empty set
// — which reads identically to a command that kills nothing, and would be
// allowed. So the third outcome exists and is distinct, and the guard denies
// on it. This is the same fail-closed posture the hook applies to a payload
// it cannot read (`../hook/run.ts`).

/**
 * What a parsed kill command is aimed at.
 *
 * - `pid` — a specific process, by number. The narrow, ordinarily-safe form;
 *   the guard resolves it against the registry and allows it when the
 *   caller's own session tree registered it.
 * - `executable` — every process running an image, by name. This is the
 *   machine-wide kill DECISIONS.md §4 exists to stop: `taskkill /IM
 *   node.exe` takes out every sibling agent's processes and the caller has
 *   no way to tell.
 */
export type KillTargetKind = "pid" | "executable";

export interface KillTarget {
  readonly kind: KillTargetKind;
  /** The PID as written, or the executable name, lower-cased and de-suffixed. */
  readonly value: string;
}

/** What `parseKillCommand` concluded about one command string. */
export type KillCommandParse =
  /** Not a kill command at all. Nothing here to guard. */
  | { readonly kind: "not-a-kill" }
  /** A kill command whose targets are fully known. */
  | { readonly kind: "targets"; readonly targets: readonly KillTarget[] }
  /**
   * A kill command this build cannot decompose into targets. Distinct from
   * an empty target list on purpose — see the header.
   */
  | { readonly kind: "unparseable"; readonly reason: string };

/**
 * The verbs that end processes, and how each names what it ends.
 *
 * Written as an explicit table rather than one regular expression, because
 * the shapes genuinely differ: `kill` takes PIDs positionally, `taskkill`
 * takes them behind `/PID`, and `pkill`/`killall` take a name. A single
 * expression covering all three would have to be permissive enough to match
 * things that are not any of them.
 */
const KILL_VERBS = ["kill", "taskkill", "pkill", "killall", "stop-process"] as const;

/**
 * Verbs that run *another* command rather than being one.
 *
 * A shell wrapper does not kill anything itself, so its verb is not a kill
 * verb and the statement read as `not-a-kill` — which the guard treats as
 * final. `sh -c "taskkill /F /IM node.exe"` was therefore allowed with no
 * server round trip: byte for byte the machine-wide kill DECISIONS.md §4
 * exists to stop (#122).
 *
 * The module's own principle (see the header) is that a kill-shaped command
 * it cannot decompose must be `unparseable`, not `not-a-kill`. A wrapper
 * whose arguments contain a kill verb is exactly that: this build does not
 * reliably know what the inner command targets — quoting, `$()`, a script
 * path, and `xargs` reading its arguments from stdin all defeat it — so it
 * refuses rather than guessing, and the guard's fail-closed path takes over.
 */
const WRAPPER_VERBS = ["sh", "bash", "zsh", "dash", "ksh", "powershell", "pwsh", "cmd", "xargs"];

/** Whether `token` names a wrapper verb, ignoring any path prefix and `.exe`. */
function wrapperVerb(token: string): string | null {
  const bare = token
    .toLowerCase()
    .replace(/\.exe$/, "")
    .split(/[/\\]/)
    .pop();
  if (bare === undefined) return null;
  return WRAPPER_VERBS.includes(bare) ? bare : null;
}

/**
 * How many times {@link carriesKill} will re-tokenise a fused token looking
 * for a kill verb, before giving up and reporting none found.
 *
 * `tokenise` strips quotes, so a doubly (or deeper) nested wrapper —
 * `powershell -Command "sh -c 'taskkill /IM node.exe'"` — collapses one
 * quote layer *per wrapper level* into a single fused token, and each
 * additional level needs one more re-tokenise to peel back off. A single
 * fixed re-tokenise (the original shape of this check) only ever recovers
 * one level, so anything nested two or more wrappers deep produced a fused
 * token containing no single word that matched a kill verb, and the guard
 * silently reported `not-a-kill` for a command that byte-for-byte types
 * `taskkill /IM node.exe`. A bound, rather than unconditional recursion,
 * exists only so a pathologically long chain of nested quotes cannot grow
 * the call stack — ordinary nesting a person or an agent would type is a
 * handful of levels deep at most.
 */
const CARRIES_KILL_MAX_DEPTH = 40;

/**
 * Whether any token in `tokens`, or anything a fused token re-tokenises
 * into, names a kill verb — however many wrapper levels deep the quoting
 * collapsed it to.
 *
 * See `CARRIES_KILL_MAX_DEPTH` for why this recurses instead of checking a
 * single re-tokenise, and `WRAPPER_VERBS`'s doc comment for the incident
 * this exists to keep closed (#122). This is purely a *sighting* — it only
 * says a kill verb is present somewhere in the (possibly still-fused)
 * remainder, never what it would target. The wrapper branch that calls this
 * remains fail-closed either way: finding a kill verb here refuses the
 * statement (or hands it to `decomposeSingleCommandWrapper`), and finding
 * none allows it to fall through to ordinary, non-wrapper classification —
 * exactly as before this recursed.
 */
function carriesKill(tokens: readonly string[], depth = 0): boolean {
  if (depth >= CARRIES_KILL_MAX_DEPTH) return true;
  return tokens.some((token) => {
    if (killVerb(token) !== null) return true;
    const inner = tokenise(token);
    // A fused token that re-tokenises to itself (no further quoting left to
    // peel back) is not progress — recursing on it again would loop
    // forever on that single token rather than terminating on
    // `CARRIES_KILL_MAX_DEPTH`, which exists precisely to bound this.
    if (inner.length === 1 && inner[0] === token) return false;
    return carriesKill(inner, depth + 1);
  });
}

/**
 * The flag, per wrapper, that by convention takes **exactly one** argument:
 * "run this string as a command". Lower-cased, leading `-`/`/` stripped —
 * matched the same way `parseWindowsKill` normalises a flag.
 *
 * row f53e667a-97da-4b10-bded-8a3c50836a85: on Windows every single-line
 * `Bash` tool call reaches this parser already wrapped as `powershell
 * -NoProfile -Command "<command>"` — that is the harness's own invocation
 * shape, not a choice the agent made. Treating that wrapping as
 * indistinguishable from `xargs kill -9` (whose targets genuinely come from
 * stdin, unreadable here) refused every PID-scoped kill on the platform
 * unconditionally, including the exact form the guard's own message
 * recommends.
 *
 * `xargs` is deliberately absent: it has no such argument — the words after
 * it are the command *plus* whatever it appends from stdin — so it is not
 * eligible for this path and stays maximally conservative.
 */
const SINGLE_COMMAND_FLAGS: Readonly<Record<string, string>> = {
  sh: "c",
  bash: "c",
  zsh: "c",
  dash: "c",
  ksh: "c",
  powershell: "command",
  pwsh: "command",
  cmd: "c",
};

/**
 * Tries to read the inner command out of a wrapper invocation, when doing so
 * is safe rather than a guess.
 *
 * Two conditions, both required:
 *
 *   1. The wrapper has a single-command flag (`SINGLE_COMMAND_FLAGS`), it
 *      appears in `rest`, and it is followed by **exactly one** remaining
 *      token. `tokenise` already keeps a quoted argument as one token with
 *      its internal whitespace intact, so one token after the flag means
 *      the inner command arrived as a single quoted (or otherwise atomic)
 *      unit — the same guarantee `-c`'s own contract makes. More than one
 *      remaining token means either no quoting was used (so this build
 *      cannot tell where the inner command ends and further wrapper words
 *      begin) or extra arguments were appended after it — both genuinely
 *      ambiguous, and left to the caller.
 *   2. Recursively parsing that inner token must produce `targets` made up
 *      **entirely of pids** — never `not-a-kill` (nothing to adopt), never
 *      `unparseable` (the inner command is itself unreadable, e.g. a
 *      filter or another wrapper), and never a target naming an executable
 *      (`Stop-Process -Name node` through a wrapper is exactly the
 *      machine-wide shape DECISIONS.md §4 exists to stop — this path exists
 *      to unblock the narrow PID form, not to widen what a wrapper can
 *      smuggle through).
 *
 * Returns `null` when either condition fails, and the caller keeps its
 * existing fail-closed `unparseable` verdict. Nothing here widens what is
 * allowed beyond what a direct, unwrapped invocation of the same inner
 * command would already resolve to.
 */
function decomposeSingleCommandWrapper(
  wrapper: string,
  rest: readonly string[],
): KillCommandParse | null {
  const flag = SINGLE_COMMAND_FLAGS[wrapper];
  if (flag === undefined) return null;

  const flagIndex = rest.findIndex((token) => token.toLowerCase().replace(/^[-/]+/, "") === flag);
  if (flagIndex === -1) return null;

  const remaining = rest.slice(flagIndex + 1);
  if (remaining.length !== 1) return null;

  const inner = parseKillCommand(remaining[0]!);
  if (inner.kind !== "targets") return null;

  // Only PID targets are adopted. An executable target through a wrapper
  // (`powershell -Command "Stop-Process -Name node"`) is exactly the
  // machine-wide shape DECISIONS.md §4 exists to stop, and this path exists
  // to unblock the narrow form, not to widen what a wrapper can smuggle
  // through — see the description above.
  return inner.targets.every((target) => target.kind === "pid") ? inner : null;
}

/**
 * Splits a command into whitespace-separated words, honouring quotes.
 *
 * Quotes matter: `taskkill /FI "IMAGENAME eq node.exe"` is three words, not
 * five, and a naive split would see the bare word `node.exe` and report a
 * confident executable target for a command whose real semantics are a
 * filter this module does not implement.
 */
export function tokenise(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (const char of command) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      // A quote always starts a token, even an empty one, so that
      // `taskkill ""` does not silently vanish.
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Whether `token` names a kill verb, ignoring any path prefix and `.exe`. */
function killVerb(token: string): string | null {
  const bare = token
    .toLowerCase()
    .replace(/\.exe$/, "")
    .split(/[/\\]/)
    .pop();
  if (bare === undefined) return null;
  return (KILL_VERBS as readonly string[]).includes(bare) ? bare : null;
}

/** Normalises an executable name so `Node.EXE` and `node` are one value. */
export function normaliseExecutable(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

const PID_PATTERN = /^\d+$/;

/**
 * A flag that names a signal rather than a target.
 *
 * Deliberately a closed list of the signals that actually end a process,
 * plus any bare number. A flag not on it is refused rather than skipped —
 * see `parsePosixKill`: an unrecognised flag on `pkill` is far more likely
 * to be a *selector* (`-f`, `-u`, `-P`) than a signal, and skipping a
 * selector drops the very thing that decides what dies.
 */
const SIGNAL_FLAG = /^(\d+|(sig)?(kill|term|int|hup|quit|abrt|usr1|usr2|stop|cont))$/;

/**
 * Reads one kill command.
 *
 * **Every branch that cannot produce a confident target list produces
 * `unparseable`, never `not-a-kill`** — the two are not interchangeable and
 * confusing them is the one mistake here that silently disables the guard.
 * `not-a-kill` is reserved for a command whose first meaningful word is not
 * a kill verb at all.
 *
 * The command is examined **statement by statement**: `ls && taskkill /IM
 * node.exe` is a kill command, and a parser that only looked at the first
 * word would report `not-a-kill` for it. Anything that ends a statement —
 * `;`, `&&`, `||`, `&`, `|`, a newline — starts a new one.
 */
export function parseKillCommand(command: string): KillCommandParse {
  const statements = splitStatements(command);

  const targets: KillTarget[] = [];
  let sawKill = false;

  for (const statement of statements) {
    const parsed = parseStatement(statement);
    if (parsed.kind === "not-a-kill") continue;
    if (parsed.kind === "unparseable") return parsed;
    sawKill = true;
    targets.push(...parsed.targets);
  }

  if (!sawKill) return { kind: "not-a-kill" };
  return { kind: "targets", targets };
}

/**
 * Splits on statement separators, respecting quotes.
 *
 * A separator inside a quoted string is not a separator — `echo "a && b"`
 * is one statement — which matters because the alternative would invent a
 * second statement out of quoted text and could invent a kill verb with it.
 */
export function splitStatements(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "&" || char === "|") {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.filter((statement) => statement.trim().length > 0);
}

/**
 * Flags that name a target in the next token. `/PID 123` and `-p 123`.
 *
 * `taskkill`'s `/IM` is here as well as `/PID`, because both name a target;
 * they differ only in which kind of target, which the reader below decides.
 */
function parseStatement(statement: string): KillCommandParse {
  const tokens = tokenise(statement);
  if (tokens.length === 0) return { kind: "not-a-kill" };

  // A statement may be prefixed by an environment assignment or `sudo`; the
  // verb is the first token that is neither.
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    break;
  }

  const verbToken = tokens[index];
  if (verbToken === undefined) return { kind: "not-a-kill" };

  // A wrapper running something that looks like a kill. Refused rather than
  // decomposed — see `WRAPPER_VERBS`. `xargs` is included with no kill verb
  // required in its arguments, because `… | xargs kill -9` puts `kill` in a
  // *separate* statement (`splitStatements` splits on `|`) and bare
  // `xargs kill` is still a kill this build cannot resolve to targets.
  const wrapper = wrapperVerb(verbToken);
  if (wrapper !== null) {
    const rest = tokens.slice(index + 1);
    if (carriesKill(rest)) {
      // Safe to decompose only when the inner command arrived as one atomic
      // token behind a single-command flag (`-c`, `-Command`, `/c`) and
      // that inner command itself resolves to real targets — see
      // `decomposeSingleCommandWrapper`. Anything else keeps the existing
      // fail-closed refusal.
      const decomposed = decomposeSingleCommandWrapper(wrapper, rest);
      if (decomposed !== null) return decomposed;

      return {
        kind: "unparseable",
        reason:
          `\`${wrapper}\` is running a command that contains a kill verb, and this build ` +
          "does not decompose commands inside a wrapper. Run the kill directly so its " +
          "targets can be read, rather than through a shell.",
      };
    }
  }

  const verb = killVerb(verbToken);
  if (verb === null) return { kind: "not-a-kill" };

  const args = tokens.slice(index + 1);
  return verb === "taskkill" || verb === "stop-process"
    ? parseWindowsKill(verb, args)
    : parsePosixKill(verb, args);
}

/**
 * `taskkill` and PowerShell's `Stop-Process`.
 *
 * Both are flag-driven, and both have forms this module deliberately does
 * not implement — `/FI` filters, `Stop-Process -InputObject` — which is why
 * an unrecognised flag that takes a value is `unparseable` rather than
 * ignored. Ignoring it would drop a target from the set and turn a
 * machine-wide kill into an empty, allowable one.
 */
function parseWindowsKill(verb: string, args: readonly string[]): KillCommandParse {
  const targets: KillTarget[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = arg.toLowerCase().replace(/^[-/]+/, "");

    // Flags with no value that change nothing about the target set.
    if (flag === "f" || flag === "t" || flag === "force" || flag === "confirm") continue;

    if (flag === "pid" || flag === "id") {
      const value = args[index + 1];
      if (value === undefined || !PID_PATTERN.test(value)) {
        return { kind: "unparseable", reason: `${verb} ${arg} was not followed by a process id` };
      }
      targets.push({ kind: "pid", value });
      index += 1;
      continue;
    }

    if (flag === "im" || flag === "name" || flag === "processname") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        return {
          kind: "unparseable",
          reason: `${verb} ${arg} was not followed by a process name`,
        };
      }
      targets.push({ kind: "executable", value: normaliseExecutable(value) });
      index += 1;
      continue;
    }

    return {
      kind: "unparseable",
      reason: `${verb} option ${arg} is not one this build knows how to read, so it cannot tell what would be killed`,
    };
  }

  if (targets.length === 0) {
    return { kind: "unparseable", reason: `${verb} named no target this build could read` };
  }
  return { kind: "targets", targets };
}

/**
 * `kill`, `pkill`, `killall`.
 *
 * `kill` names PIDs positionally; `pkill`/`killall` name an executable. A
 * `pkill -f <pattern>` matches against a whole command line rather than an
 * image name, which is a broader thing than this module models — so it is
 * `unparseable` and the guard denies it, rather than being read as an
 * executable target it is not.
 */
function parsePosixKill(verb: string, args: readonly string[]): KillCommandParse {
  const targets: KillTarget[] = [];
  const byName = verb === "pkill" || verb === "killall";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg.startsWith("-")) {
      const flag = arg.replace(/^-+/, "").toLowerCase();

      // A signal, in any of its spellings: `-9`, `-KILL`, `-SIGKILL`,
      // `-s TERM`. None of these change *what* is targeted, so they are
      // skipped rather than refused.
      if (flag === "s" || flag === "signal") {
        index += 1;
        continue;
      }
      if (SIGNAL_FLAG.test(flag)) continue;
      // `-f` on pkill matches the full command line, which is wider than an
      // image name; `-u`, `-P` and friends select by owner or parent. All
      // are targets this build does not model.
      return {
        kind: "unparseable",
        reason: `${verb} option ${arg} selects processes in a way this build cannot read, so it cannot tell what would be killed`,
      };
    }

    if (byName) {
      targets.push({ kind: "executable", value: normaliseExecutable(arg) });
      continue;
    }

    if (!PID_PATTERN.test(arg)) {
      // `kill %1` (a job spec) and anything else non-numeric.
      return {
        kind: "unparseable",
        reason: `${verb} was given ${arg}, which is not a process id this build can resolve`,
      };
    }
    targets.push({ kind: "pid", value: arg });
  }

  if (targets.length === 0) {
    return { kind: "unparseable", reason: `${verb} named no target this build could read` };
  }
  return { kind: "targets", targets };
}
