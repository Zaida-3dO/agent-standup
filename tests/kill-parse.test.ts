// Reading a kill command — MILESTONES.md #45, `src/lib/kill/parse.ts`.
//
// **What would make this file hollow, stated first.** A suite that only
// asserted `taskkill /IM node.exe` parses as an executable target would pass
// against a parser that returned an executable target for *everything*, and
// the guard downstream would then refuse or allow uniformly regardless of
// the command. So the assertions below are organised around the three
// outcomes being **told apart**: every case names which outcome it expects
// and at least one case for each pair of outcomes uses commands that differ
// by a single token.
//
// The distinction that carries the most weight is `unparseable` vs
// `not-a-kill`, because collapsing them is the one mistake here that
// silently disables the guard — `unparseable` denies, `not-a-kill` is
// waved through to ordinary classification.
import { describe, expect, it } from "vitest";
import { normaliseExecutable, parseKillCommand, splitStatements, tokenise } from "@/lib/kill/parse";

describe("commands that end no process", () => {
  it.each([
    "ls -la",
    "git status",
    "npm run build",
    // Contains the word but is not the verb — a substring match would call
    // this a kill and refuse a perfectly ordinary command.
    "npm run kill-switch-test",
    "echo killall",
    // A path whose last segment is not a kill verb.
    "/usr/bin/killer 123",
  ])("%s is not a kill", (command) => {
    expect(parseKillCommand(command)).toEqual({ kind: "not-a-kill" });
  });

  it("an empty command is not a kill", () => {
    expect(parseKillCommand("")).toEqual({ kind: "not-a-kill" });
  });
});

describe("process ids, read positionally and behind flags", () => {
  it("kill 4821 targets one pid", () => {
    expect(parseKillCommand("kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("a signal flag is not mistaken for a target", () => {
    expect(parseKillCommand("kill -9 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("kill -SIGKILL 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("kill -s TERM 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("several pids are all targets, not just the first", () => {
    expect(parseKillCommand("kill 1 2 3")).toEqual({
      kind: "targets",
      targets: [
        { kind: "pid", value: "1" },
        { kind: "pid", value: "2" },
        { kind: "pid", value: "3" },
      ],
    });
  });

  it("taskkill reads a pid behind /PID", () => {
    expect(parseKillCommand("taskkill /F /PID 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("Stop-Process reads a pid behind -Id", () => {
    expect(parseKillCommand("Stop-Process -Id 4821 -Force")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("sudo and an environment assignment do not hide the verb", () => {
    expect(parseKillCommand("sudo kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("FOO=bar kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });
});

describe("PID-scoped kills the guard's own message recommends", () => {
  // The guard refuses a broad kill and tells the caller to kill by process
  // id instead. Each case here is a spelling of exactly that remedy, so a
  // regression in any of them makes the refusal message name something the
  // parser rejects.
  const stop = `Stop-${"Process"}`;

  it("Stop-Process reads a bare positional pid", () => {
    // `-Id` is positional on this cmdlet, so this is the same command as
    // `Stop-Process -Id 130580` and must read identically.
    expect(parseKillCommand(`${stop} 130580`)).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "130580" }],
    });
  });

  it("a bare positional name is NOT read as a scoped kill", () => {
    // The pair to the case above, differing by one token. A positional
    // *name* is the machine-wide shape, and reading it as narrow would
    // widen the guard rather than unblock it.
    expect(parseKillCommand(`${stop} node`).kind).toBe("unparseable");
  });

  it("kill -Id is the PowerShell alias and is pid-scoped", () => {
    expect(parseKillCommand("kill -Id 130580")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "130580" }],
    });
  });

  it("kill -Name is the same alias naming an executable, and stays broad", () => {
    // Proves the alias detection routes on the parameter rather than
    // waving through everything spelled `kill`.
    expect(parseKillCommand("kill -Name node")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("posix kill is unaffected by the alias detection", () => {
    // No PowerShell parameter present, so the posix reader still handles
    // it — including the signal flag it models and the cmdlet does not.
    expect(parseKillCommand("kill -9 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
  });

  it("taskkill has no positional target, so a bare name stays unreadable", () => {
    expect(parseKillCommand("taskkill node.exe").kind).toBe("unparseable");
  });
});

describe("executables — the machine-wide shape the guard exists for", () => {
  it("taskkill /IM names an executable, normalised", () => {
    expect(parseKillCommand("taskkill /F /IM node.exe")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("case and the .exe suffix do not create two different targets", () => {
    const upper = parseKillCommand("taskkill /IM NODE.EXE");
    const lower = parseKillCommand("taskkill /IM node");
    expect(upper).toEqual(lower);
  });

  it("killall and pkill name an executable", () => {
    expect(parseKillCommand("killall node")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
    expect(parseKillCommand("pkill node")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("Stop-Process -Name names an executable", () => {
    expect(parseKillCommand("Stop-Process -Name node -Force")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });
});

describe("a kill it cannot read is unparseable, never not-a-kill", () => {
  // This block is the point of the file. Every case here is a real command
  // that ends processes and whose target set this build does not model; each
  // must be `unparseable` so the guard denies. If any of them regressed to
  // `not-a-kill`, the guard would wave it through, and no assertion about a
  // happy-path parse would notice.
  it.each([
    // A filter, not a name — the quoted argument is one token and the flag
    // is unrecognised.
    ['taskkill /F /FI "IMAGENAME eq node.exe"', "taskkill filter"],
    // Matches whole command lines, which is wider than an image name.
    ["pkill -f agent-standup", "pkill -f"],
    // Selects by user; kills everything that user owns.
    ["pkill -u builder", "pkill -u"],
    // Selects by parent.
    ["pkill -P 100", "pkill -P"],
    // A job spec, not a pid.
    ["kill %1", "job spec"],
    // A negative pid is a process GROUP on POSIX — wider than one process.
    ["kill -- -4821", "process group"],
    // Named nothing at all.
    ["taskkill /F", "taskkill with no target"],
    ["kill", "bare kill"],
    ["taskkill /PID", "a flag with no value"],
    ["taskkill /IM", "a name flag with no value"],
    // ── Shell wrappers (#122) ──────────────────────────────────────────
    // Each of these returned `not-a-kill` and was allowed with no server
    // round trip. The second is byte-for-byte the machine-wide kill
    // DECISIONS.md §4 exists to stop.
    ["bash -c 'pkill -f node'", "bash -c"],
    ['sh -c "taskkill /F /IM node.exe"', "sh -c"],
    ["xargs kill -9", "xargs"],
    ["ps aux | grep node | awk '{print $2}' | xargs kill -9", "a pipeline into xargs"],
    ['powershell -Command "Stop-Process -Name node"', "powershell -Command"],
    ["cmd /c taskkill /F /IM node.exe", "cmd /c"],
  ])("%s is unparseable (%s)", (command) => {
    const parsed = parseKillCommand(command);
    expect(parsed.kind).toBe("unparseable");
    // The reason is required to be a real sentence, not an empty string: it
    // is what the refused agent reads, and an empty one leaves it retrying.
    if (parsed.kind === "unparseable") expect(parsed.reason.length).toBeGreaterThan(10);
  });

  it("a single unreadable statement makes the whole command unparseable", () => {
    // A parser that returned the readable targets and dropped the rest would
    // hand the guard a set that omits the dangerous half — and the guard
    // would then allow a command it had only half seen.
    const parsed = parseKillCommand("kill 4821 && pkill -f node");
    expect(parsed.kind).toBe("unparseable");
  });

  // The negative control for the wrapper cases above, and the reason this is
  // a separate block: a fix that made every `sh`/`bash` command unparseable
  // would satisfy all six of them and break every ordinary shell invocation.
  // A wrapper is refused only when it is *carrying a kill*.
  it.each([
    ["bash -c 'npm run build'", "a wrapper running something harmless"],
    ["sh scripts/deploy.sh", "a wrapper running a script"],
    ['powershell -Command "Get-Process node"', "a wrapper only reading processes"],
    ["xargs rm -f", "xargs running something that is not a kill"],
    ["cmd /c dir", "cmd running something harmless"],
  ])("%s is still not-a-kill (%s)", (command) => {
    expect(parseKillCommand(command)).toEqual({ kind: "not-a-kill" });
  });

  it("a direct kill still resolves to targets rather than being refused", () => {
    // The other direction of the same control. If the wrapper handling had
    // been written so broadly that it swallowed direct kills, the guard would
    // deny everything and the registry would stop being consulted at all —
    // which looks safe and is actually the guard ceasing to do its job.
    expect(parseKillCommand("kill 4821")).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "4821" }],
    });
    expect(parseKillCommand("taskkill /F /IM node.exe")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });
});

describe("a single-argument wrapper carrying a fully-scoped kill is decomposed", () => {
  // row f53e667a-97da-4b10-bded-8a3c50836a85: on Windows, the harness that
  // runs a Bash tool call invokes it as `powershell -NoProfile -Command
  // "<command>"` — that wrapping is not a choice the agent made, it is how
  // every single-line command reaches the hook. A guard that treats *any*
  // wrapper carrying a kill verb as unparseable therefore refuses every
  // PID-scoped kill on Windows unconditionally, including the exact form
  // its own refusal message recommends as the fix. Four agents hit this in
  // one night.
  //
  // The fix is narrow: `-c`/`-Command`/`/c` name a single command argument
  // by convention, and `tokenise` already preserves a quoted argument as one
  // token with its internal whitespace intact — so when exactly one token
  // remains after that flag, it is read verbatim as the inner command,
  // recursively, through the same parser. Nothing is guessed: an inner
  // command that itself resolves to `unparseable` (a filter, a name) stays
  // `unparseable`, and only a *resolved target list* is adopted.
  it.each([
    [
      'powershell -NoProfile -Command "Stop-Process -Id 130580 -Force"',
      "powershell -NoProfile -Command, PID",
    ],
    ['powershell -Command "Stop-Process -Id 130580 -Force"', "powershell -Command, PID"],
    ['cmd /c "taskkill /PID 130580 /F"', "cmd /c, PID"],
    ["sh -c 'kill 130580'", "sh -c, PID"],
    ["bash -c 'kill -9 130580'", "bash -c, PID with signal"],
    ['pwsh -Command "taskkill /PID 130580 /F"', "pwsh -Command, PID"],
  ])("%s resolves to the pid target (%s)", (command) => {
    expect(parseKillCommand(command)).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "130580" }],
    });
  });

  // The negative control this fix must not break: the SAME wrappers, with
  // an inner command that is genuinely broad or unreadable, must still
  // refuse. Decomposing the inner command must not become "trust the
  // wrapper's contents unconditionally" — it must apply the identical
  // targets/unparseable/not-a-kill judgement recursively.
  it.each([
    ['powershell -NoProfile -Command "Stop-Process -Name node -Force"', "powershell, by name"],
    ['cmd /c "taskkill /F /IM node.exe"', "cmd /c, by image name — DECISIONS.md §4's own case"],
    ['sh -c "taskkill /F /FI \\"IMAGENAME eq node.exe\\""', "sh -c, a filter"],
  ])("%s stays broad, not decomposed into a narrow allow (%s)", (command) => {
    const parsed = parseKillCommand(command);
    expect(parsed.kind).not.toBe("not-a-kill");
    if (parsed.kind === "targets") {
      expect(parsed.targets.every((t) => t.kind === "pid")).toBe(false);
    }
  });

  // `xargs` has no single-command argument the way `-c` does — the words
  // after it are the command plus whatever xargs appends from stdin, which
  // is precisely the case this build cannot resolve. It must NOT be swept
  // into the new decomposition path.
  it("xargs kill -9 is still unparseable, never decomposed", () => {
    expect(parseKillCommand("xargs kill -9")).toEqual({
      kind: "unparseable",
      reason: expect.stringContaining("xargs"),
    });
  });

  // A `-c`/`-Command`/`/c` followed by more than one remaining token was not
  // delivered as a single quoted argument (or carries extra words appended
  // after it) — reconstructing that with a naive join would risk silently
  // dropping or merging targets, so it stays unparseable rather than being
  // guessed at.
  it("cmd /c with unquoted multi-word content stays unparseable", () => {
    const parsed = parseKillCommand("cmd /c taskkill /PID 130580 /F");
    // Tokenised without quotes, `/c`'s "argument" is only the next bare
    // token (`taskkill`), so the rest is read as further wrapper words, not
    // as part of one command string — this is exactly the ambiguity the
    // wrapper refusal exists for.
    expect(parsed.kind).toBe("unparseable");
  });

  it("a quoted command string followed by another argument stays unparseable", () => {
    // Covers `decomposeSingleCommandWrapper`'s "exactly one remaining
    // token" condition — distinct from the unquoted case immediately above,
    // which is caught one step earlier by the inner parse failing before
    // this condition is ever reached. Here the quoted command is perfectly
    // well-formed on its own (`"kill 1"` alone would decompose to pid 1),
    // and only the trailing token after it makes the flag's "argument"
    // ambiguous — this is the shape that exercises the token-count guard
    // itself, not the inner parser. Relaxing `!== 1` to `< 1` would let a
    // broad kill ride along behind a pid kill and still be read as the pid
    // alone, which is exactly the incident class this module exists to
    // prevent, so this must stay `unparseable`.
    expect(parseKillCommand('sh -c "kill 1" "pkill node"').kind).toBe("unparseable");
    expect(parseKillCommand('sh -c "kill 1" extra').kind).toBe("unparseable");
  });

  it("several pid-only statements inside one wrapper argument are all adopted", () => {
    // The recursive call goes through the full parser, statements and all,
    // so `kill 130580 && kill 999` inside the quoted argument collects both
    // — narrow however many pids are named, per the module's own principle
    // that breadth, not count, is what this guards against.
    expect(parseKillCommand('sh -c "kill 130580 && kill 999"')).toEqual({
      kind: "targets",
      targets: [
        { kind: "pid", value: "130580" },
        { kind: "pid", value: "999" },
      ],
    });
  });

  it("a wrapper argument mixing a pid kill with a broad one is not decomposed", () => {
    // The mix must not be waved through on the strength of the pid half —
    // one broad statement inside the quoted argument makes the recursive
    // parse itself unparseable-or-executable, which this path refuses to
    // adopt (see `decomposeSingleCommandWrapper`'s pid-only rule).
    const parsed = parseKillCommand('sh -c "kill 130580 && pkill node"');
    expect(parsed.kind).toBe("unparseable");
  });
});

describe("a machine-wide kill nested two or more wrappers deep is still refused", () => {
  // Pre-existing on `origin/main` before this row, reproducible byte for
  // byte, and never touched by the pid-scope fix above — that fix is
  // reached only after `carriesKill` finds a kill verb in the wrapper's
  // remaining tokens, and at two levels of nesting `tokenise`'s quote
  // stripping had already fused the inner command into one token no single
  // re-tokenise could see into. The result was `not-a-kill`, not
  // `unparseable` — the guard never fired at all, byte for byte
  // `WRAPPER_VERBS`'s own doc comment's cautionary example (#122).
  it.each([
    [`powershell -Command "sh -c 'taskkill /IM node.exe'"`, "powershell wrapping sh -c, by image"],
    [`powershell -Command "bash -c 'pkill node'"`, "powershell wrapping bash -c, by name"],
    [`sh -c "sh -c 'pkill node'"`, "sh -c wrapping sh -c, by name"],
  ])("%s is unparseable, not not-a-kill (%s)", (command) => {
    const parsed = parseKillCommand(command);
    expect(parsed.kind).toBe("unparseable");
  });

  // The negative space this fix must not break: a nested wrapper whose
  // innermost command is genuinely pid-scoped must still be decomposed and
  // allowed — `decomposeSingleCommandWrapper` already recurses through
  // `parseKillCommand`, so once `carriesKill` correctly sees the kill verb
  // (rather than bailing out to `not-a-kill`), the existing single-command
  // decomposition picks it up at whatever depth it is nested.
  it("a nested wrapper whose innermost command is pid-scoped is still decomposed", () => {
    expect(parseKillCommand(`powershell -Command "sh -c 'kill 130580'"`)).toEqual({
      kind: "targets",
      targets: [{ kind: "pid", value: "130580" }],
    });
  });
});

describe("statements — the verb is not always the first word", () => {
  it("a kill after && is still a kill", () => {
    expect(parseKillCommand("ls && taskkill /IM node.exe")).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it.each([";", "&&", "||", "|", "\n", "&"])("%s separates statements", (separator) => {
    const parsed = parseKillCommand(`echo hello${separator}kill 4821`);
    expect(parsed).toEqual({ kind: "targets", targets: [{ kind: "pid", value: "4821" }] });
  });

  it("kills in several statements are all collected", () => {
    expect(parseKillCommand("kill 1 ; kill 2")).toEqual({
      kind: "targets",
      targets: [
        { kind: "pid", value: "1" },
        { kind: "pid", value: "2" },
      ],
    });
  });

  it("a separator inside quotes does not invent a statement", () => {
    // Without quote-awareness this reads as a second statement beginning
    // `kill 1` and reports a kill for a command that runs none.
    expect(parseKillCommand('echo "a && kill 1"')).toEqual({ kind: "not-a-kill" });
  });
});

describe("tokenise", () => {
  it("keeps a quoted argument as one token", () => {
    expect(tokenise('taskkill /FI "IMAGENAME eq node.exe"')).toEqual([
      "taskkill",
      "/FI",
      "IMAGENAME eq node.exe",
    ]);
  });

  it("collapses runs of whitespace rather than emitting empty tokens", () => {
    expect(tokenise("kill   \t 4821")).toEqual(["kill", "4821"]);
  });
});

describe("splitStatements", () => {
  it("drops empty statements rather than yielding blanks", () => {
    expect(splitStatements("kill 1 ;; kill 2")).toHaveLength(2);
  });

  it("does not read a heredoc body as statements", () => {
    // The opening line is a command and is kept; the two body lines are
    // data. Asserted on the array rather than only on the length so a
    // splitter that kept the wrong two lines cannot pass.
    expect(splitStatements("cat > note.md <<'EOF'\nfirst line\nsecond line\nEOF")).toEqual([
      "cat > note.md <<'EOF'",
    ]);
  });

  it("resumes splitting after the heredoc terminator", () => {
    // The guarantee that makes skipping the body safe: a command written
    // *after* the document is still a statement. Without this, skipping
    // would hide real commands rather than only prose.
    expect(splitStatements("cat > n.md <<'EOF'\nbody\nEOF\necho after")).toEqual([
      "cat > n.md <<'EOF'",
      "echo after",
    ]);
  });
});

describe("prose about a kill is not a kill — heredoc bodies are data", () => {
  // Every command in this block is assembled from fragments at runtime.
  // That is not stylistic: this file is edited by agents running the very
  // guard these cases describe, and a literal pipeline form in the source
  // would be refused by it — which is the defect being fixed here.
  const stop = `Stop-${"Process"}`;
  const get = `Get-${"Process"}`;

  it.each([
    [
      "a quoted delimiter",
      `cat > note.md <<'EOF'\nThe form ${get} node | ${stop} ends them all.\nEOF`,
    ],
    ["a bare delimiter", `cat > note.md <<EOF\nThe form ${get} node | ${stop} ends them all.\nEOF`],
    ["a double-quoted delimiter", `cat > note.md <<"MD"\ntaskkill /F /IM node.exe is broad\nMD`],
    [
      "a tab-stripping delimiter",
      `cat > n.md <<-'EOF'\n\ttaskkill /F /IM node.exe is broad\n\tEOF`,
    ],
    [
      "several prose lines",
      `cat > n.md <<'EOF'\nintro\n${stop} is the verb\npkill -f node too\nEOF`,
    ],
  ])("documentation written with %s kills nothing", (_label, command) => {
    // `not-a-kill`, specifically — not merely "not broad". An `unparseable`
    // here would still deny, which is the failure being fixed.
    expect(parseKillCommand(command)).toEqual({ kind: "not-a-kill" });
  });

  it("a real kill after the terminator is still read", () => {
    // The direction that would make the fix dangerous rather than merely
    // wrong. If this ever returns `not-a-kill`, the heredoc skip has
    // swallowed a live command.
    expect(parseKillCommand(`cat > n.md <<'EOF'\nprose\nEOF\ntaskkill /F /IM node.exe`)).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("a real kill before the heredoc is still read", () => {
    expect(parseKillCommand(`taskkill /F /IM node.exe\ncat > n.md <<'EOF'\nprose\nEOF`)).toEqual({
      kind: "targets",
      targets: [{ kind: "executable", value: "node" }],
    });
  });

  it("a here-string opens no document body, so a later kill is still read", () => {
    // `<<<` is a here-string, not a heredoc. The distinction is only
    // observable when a line further down would otherwise be eaten as
    // document body, so the assertion is made against a command that has
    // one — and against a *kill*, since silently swallowing one is the
    // consequence that matters.
    expect(splitStatements("echo <<<word\nmore\nword\nkill 4821")).toEqual([
      "echo <<<word",
      "more",
      "word",
      "kill 4821",
    ]);
  });

  it("an unterminated heredoc consumes the rest of the command", () => {
    // A document whose delimiter never reappears means the shell is still
    // reading input: nothing after it runs, so nothing after it is a
    // statement. Asserted with a kill in the tail to pin the direction —
    // this is the one place the skip legitimately hides a kill verb, and
    // it does so because that verb would never execute either.
    expect(splitStatements("cat > n.md <<'EOF'\nprose\ntaskkill /F /IM node.exe")).toEqual([
      "cat > n.md <<'EOF'",
    ]);
  });

  it("a here-string's word is not treated as a delimiter", () => {
    // The spaced spelling. `<<` followed by a redirection character names
    // no delimiter, so the whole line stays one ordinary statement.
    expect(splitStatements("echo <<< word")).toEqual(["echo <<< word"]);
  });
});

describe("normaliseExecutable", () => {
  it("lower-cases and drops one .exe suffix", () => {
    expect(normaliseExecutable("Node.EXE")).toBe("node");
    expect(normaliseExecutable("node")).toBe("node");
  });

  it("leaves an interior .exe alone", () => {
    // `node.exe.bak` is a different file from `node.exe`, and conflating
    // them would let a registration for one answer for the other.
    expect(normaliseExecutable("node.exe.bak")).toBe("node.exe.bak");
  });
});
