// Session-shape signals — MILESTONES.md #54 ("Repeat-command detection, how
// wide the file spread is, read-to-write ratio"), over `@/lib/telemetry/shape`.
//
// These are pure functions with no database, so every case here runs
// everywhere rather than skipping without `TEST_DATABASE_URL`. That matters
// more than usual for this module: the judgements it makes are the kind a
// later edit weakens by accident (a `>=` relaxed to `>`, a tool moved
// between the two lists), and a test that only runs where Postgres is
// available does not protect them on the machine the edit is made on.
//
// ── What these tests are really defending ──────────────────────────────
//
// Two decisions in this module are load-bearing and both are invisible to a
// happy-path test:
//
//   1. **A retry loop is not circling.** A consecutive run of one command
//      counts once; only a *return* to a command counts. The naive
//      implementation — count duplicates — passes every test that only
//      looks at a session going in circles, and fires constantly on the most
//      normal thing an agent does. So the retry-loop case is asserted as
//      hard as the circling case.
//   2. **`Bash` is neither a read nor a write here.** `@/lib/hook/nudge`
//      classifies it as write-shaped for a different question, and reusing
//      that would be the obvious economy. A test that only used `Read` and
//      `Write` would never notice.
//
// Boundaries are asserted on both sides of every threshold, because a
// threshold is exactly the kind of code where the off-by-one is the bug.
import { describe, expect, it } from "vitest";
import { TRUNCATION_MARKER } from "@/lib/telemetry/contract";
import {
  countRepeats,
  countSpread,
  isReadTool,
  isWriteTool,
  readSessionShape,
  readShare,
  SHAPE_LEVELS,
  type ShapeCall,
  type ShapeThresholds,
} from "@/lib/telemetry/shape";

/** A Bash call carrying `command`. The shape of every repeat-detection case. */
function bash(command: string): ShapeCall {
  return { tool: "Bash", command };
}

/** A call by tool name alone, for the read-to-write cases. */
function call(tool: string, paths?: readonly string[]): ShapeCall {
  return paths === undefined ? { tool } : { tool, paths };
}

/**
 * Thresholds that trigger on nothing, so a test asserting one signal is not
 * accidentally asserting another. Individual cases override one field.
 */
const NEVER: ShapeThresholds = {
  minimumSample: 1,
  repeatThreshold: Number.MAX_SAFE_INTEGER,
  spreadThreshold: Number.MAX_SAFE_INTEGER,
  readShareThreshold: 2,
};

describe("countRepeats — a retry loop is not circling", () => {
  it("counts a command run many times in a row exactly once, however long the run", () => {
    // The case the row names as noise: "npm test, fix, npm test, fix" is a
    // session working, and an implementation counting duplicates would
    // score this 39 and report the hardest-working session as the most
    // stuck. Deliberately long, so an off-by-one cannot pass it by accident.
    const calls = Array.from({ length: 40 }, () => bash("npm test"));
    expect(countRepeats(calls)).toBe(0);
  });

  it("counts a return to a command after other work in between", () => {
    // The shape worth reporting: the session left the command, did
    // something else, and came back to it.
    expect(countRepeats([bash("npm test"), bash("git diff"), bash("npm test")])).toBe(1);
  });

  it("counts each separate return, not each attempt", () => {
    // Three visits to `npm test`, two of them returns — and the middle
    // visit is itself a retry loop, which must not inflate the count.
    const calls = [
      bash("npm test"),
      bash("npm test"),
      bash("git diff"),
      bash("npm test"),
      bash("npm test"),
      bash("npm test"),
      bash("git status"),
      bash("npm test"),
    ];
    expect(countRepeats(calls)).toBe(2);
  });

  it("does not count a first run of anything", () => {
    expect(countRepeats([bash("a"), bash("b"), bash("c")])).toBe(0);
  });

  it("counts returns to different commands independently", () => {
    expect(countRepeats([bash("a"), bash("b"), bash("a"), bash("b")])).toBe(2);
  });

  it("treats a call with no command as work in between", () => {
    // A Read between two runs of one command is exactly the "went and did
    // something else" that separates circling from a retry loop, so it must
    // break the consecutive run rather than being skipped over.
    expect(countRepeats([bash("npm test"), call("Read"), bash("npm test")])).toBe(1);
  });

  it("reads calls in the order given rather than sorting them", () => {
    // Ordering is the caller's job (the operation orders by ts). Reversed,
    // the same three calls are still one departure and one return — but a
    // test that only ran forwards could not tell a function that sorted
    // internally from one that did not, so this asserts the count is taken
    // over the sequence as handed in.
    const forwards = [bash("a"), bash("b"), bash("a")];
    expect(countRepeats(forwards)).toBe(1);
    expect(countRepeats([...forwards].reverse())).toBe(1);
  });
});

describe("countRepeats — what is not comparable", () => {
  it("never counts a truncated command as a repeat of anything", () => {
    // `contract.ts` states the hazard outright: two different long commands
    // sharing a prefix are stored byte-identically, so comparing them
    // reports a repeat that did not happen. A wrong repeat is worse than a
    // missed one for a signal whose job is to say a session is stuck.
    const truncated = `npm run something-very-long${TRUNCATION_MARKER}`;
    expect(countRepeats([bash(truncated), bash("git diff"), bash(truncated)])).toBe(0);
  });

  it("still counts repeats of untruncated commands in the same session", () => {
    // The exclusion is per command, not per session — a truncated command
    // must not disable the signal for everything around it.
    const truncated = `long${TRUNCATION_MARKER}`;
    expect(
      countRepeats([bash("npm test"), bash(truncated), bash("npm test"), bash(truncated)]),
    ).toBe(1);
  });

  it("ignores an empty or whitespace-only command", () => {
    expect(countRepeats([bash("   "), bash("   "), bash("   ")])).toBe(0);
  });

  it("compares commands ignoring surrounding whitespace", () => {
    expect(countRepeats([bash("npm test"), bash("git diff"), bash("  npm test  ")])).toBe(1);
  });

  it("treats a null command as carrying nothing to compare", () => {
    const calls: ShapeCall[] = [
      { tool: "Bash", command: null },
      { tool: "Bash", command: null },
    ];
    expect(countRepeats(calls)).toBe(0);
  });

  it("counts nothing over no calls at all", () => {
    expect(countRepeats([])).toBe(0);
  });
});

describe("countSpread — breadth, not volume", () => {
  it("counts distinct paths rather than calls", () => {
    // Reading one file thirty times is not a spread of thirty. This is the
    // whole difference between a breadth measurement and a call count.
    const calls = Array.from({ length: 30 }, () => call("Read", ["src/a.ts"]));
    expect(countSpread(calls)).toBe(1);
  });

  it("unions paths across calls", () => {
    expect(
      countSpread([call("Read", ["src/a.ts", "src/b.ts"]), call("Edit", ["src/b.ts", "src/c.ts"])]),
    ).toBe(3);
  });

  it("counts nothing for calls that touched no paths", () => {
    expect(countSpread([bash("ls"), call("Read")])).toBe(0);
  });

  it("ignores empty and whitespace-only path entries", () => {
    // An empty string is not a file, and counting one would inflate a
    // breadth measurement with a path that names nothing.
    expect(countSpread([call("Read", ["src/a.ts", "", "   "])])).toBe(1);
  });

  it("does not conflate paths that differ only in separator", () => {
    // Normalising would mean inventing knowledge about a filesystem this
    // process cannot see. Two spellings are two strings, and treating them
    // as one would make two genuinely different paths collide.
    expect(countSpread([call("Read", ["src/a.ts", "src\\a.ts"])])).toBe(2);
  });

  it("tolerates a null path list", () => {
    expect(countSpread([{ tool: "Read", paths: null }])).toBe(0);
  });
});

describe("read-to-write — Bash is deliberately neither", () => {
  it("classifies the read tools as reads and the write tools as writes", () => {
    for (const tool of ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookRead"]) {
      expect(isReadTool(tool)).toBe(true);
      expect(isWriteTool(tool)).toBe(false);
    }
    for (const tool of ["Write", "Edit", "NotebookEdit", "MultiEdit"]) {
      expect(isWriteTool(tool)).toBe(true);
      expect(isReadTool(tool)).toBe(false);
    }
  });

  it("classifies Bash as neither, unlike the nudge module's write-shaped test", () => {
    // The decision this module's header calls out. `@/lib/hook/nudge`
    // answers "should this session be told to commit", where treating Bash
    // as a write is right. Here it would report almost every session as
    // mostly-changing, because most shell calls are `ls`, `grep` and `cat`.
    expect(isReadTool("Bash")).toBe(false);
    expect(isWriteTool("Bash")).toBe(false);
  });

  it("classifies an unrecognised tool as neither", () => {
    expect(isReadTool("mcp__something__do_a_thing")).toBe(false);
    expect(isWriteTool("mcp__something__do_a_thing")).toBe(false);
  });

  it("takes the share over classifiable calls, not over every call", () => {
    // Nine reads, one write and fifty shell calls. Over every call the
    // share would be 9/60 = 0.15 and would say this session barely reads;
    // over what can be classified it is 0.9, which is the truth. The fifty
    // are what makes the two answers far apart enough that no rounding
    // could confuse them.
    const calls = [
      ...Array.from({ length: 9 }, () => call("Read")),
      call("Write"),
      ...Array.from({ length: 50 }, () => bash("ls")),
    ];
    expect(readShare(calls)).toBeCloseTo(0.9, 10);
  });

  it("reports undefined rather than zero when nothing could be classified", () => {
    // Not the same statement: zero means this session only wrote, undefined
    // means the question cannot be answered. Collapsing them would report a
    // session of pure shell as one that never read anything.
    expect(readShare([bash("ls"), bash("pwd")])).toBe(undefined);
    expect(readShare([])).toBe(undefined);
  });

  it("reports zero for a session that only wrote", () => {
    expect(readShare([call("Write"), call("Edit")])).toBe(0);
  });

  it("reports one for a session that only read", () => {
    expect(readShare([call("Read"), call("Grep")])).toBe(1);
  });
});

describe("readSessionShape — the sample gate", () => {
  const thresholds: ShapeThresholds = { ...NEVER, minimumSample: 10 };

  it("answers unknown for every signal below the minimum sample", () => {
    // A judgement drawn from a handful of calls is noise presented as a
    // finding, and `unknown` is the honest third answer.
    const calls = Array.from({ length: 9 }, () => call("Read", ["src/a.ts"]));
    const shape = readSessionShape(calls, thresholds);
    expect(shape.repeats.level).toBe("unknown");
    expect(shape.spread.level).toBe("unknown");
    expect(shape.readShare.level).toBe("unknown");
  });

  it("starts answering exactly at the minimum sample, not one past it", () => {
    const calls = Array.from({ length: 10 }, () => call("Read", ["src/a.ts"]));
    const shape = readSessionShape(calls, thresholds);
    expect(shape.repeats.level).toBe("normal");
    expect(shape.spread.level).toBe("normal");
    expect(shape.readShare.level).toBe("normal");
  });

  it("still reports the measured numbers below the sample gate", () => {
    // The gate withholds the *judgement*, not the measurement — a consumer
    // that wants to show its working can still see what was counted.
    const shape = readSessionShape([bash("a"), bash("b"), bash("a")], thresholds);
    expect(shape.repeats.level).toBe("unknown");
    expect(shape.repeats.value).toBe(1);
  });

  it("gates the whole reading together rather than per signal", () => {
    // A reading where one signal is a judgement and another is a shrug is
    // one a consumer cannot present coherently.
    const shape = readSessionShape([call("Read")], thresholds);
    const levels = [shape.repeats.level, shape.spread.level, shape.readShare.level];
    expect(new Set(levels)).toEqual(new Set(["unknown"]));
  });
});

describe("readSessionShape — the thresholds", () => {
  /** Pads a case out past the sample gate with calls that trip nothing. */
  function padded(calls: readonly ShapeCall[], to = 20): ShapeCall[] {
    const filler = Array.from({ length: Math.max(0, to - calls.length) }, (_, index) =>
      bash(`filler-${index}`),
    );
    return [...calls, ...filler];
  }

  it("reads elevated exactly at the repeat threshold, and normal one below", () => {
    const base: ShapeThresholds = { ...NEVER, minimumSample: 5, repeatThreshold: 3 };
    // Three returns to three commands.
    const three = padded([
      bash("a"),
      bash("b"),
      bash("a"),
      bash("c"),
      bash("b"),
      bash("d"),
      bash("c"),
    ]);
    expect(readSessionShape(three, base).repeats).toMatchObject({ level: "elevated", value: 3 });

    const two = padded([bash("a"), bash("b"), bash("a"), bash("c"), bash("b")]);
    expect(readSessionShape(two, base).repeats).toMatchObject({ level: "normal", value: 2 });
  });

  it("reads elevated exactly at the spread threshold, and normal one below", () => {
    const base: ShapeThresholds = { ...NEVER, minimumSample: 1, spreadThreshold: 5 };
    const spread = (n: number) =>
      readSessionShape(
        [
          call(
            "Read",
            Array.from({ length: n }, (_, index) => `src/f${index}.ts`),
          ),
        ],
        base,
      ).spread;
    expect(spread(5)).toMatchObject({ level: "elevated", value: 5 });
    expect(spread(4)).toMatchObject({ level: "normal", value: 4 });
  });

  it("reads elevated exactly at the read-share threshold, and normal one below", () => {
    const base: ShapeThresholds = { ...NEVER, minimumSample: 1, readShareThreshold: 0.8 };
    // 8 reads / 10 classifiable = exactly 0.8.
    const at = [...Array.from({ length: 8 }, () => call("Read")), call("Write"), call("Edit")];
    expect(readSessionShape(at, base).readShare).toMatchObject({ level: "elevated", value: 80 });

    // 7 reads / 10 = 0.7.
    const below = [
      ...Array.from({ length: 7 }, () => call("Read")),
      call("Write"),
      call("Edit"),
      call("Write"),
    ];
    expect(readSessionShape(below, base).readShare).toMatchObject({ level: "normal", value: 70 });
  });

  it("answers unknown for the read share when nothing was classifiable, however long the session", () => {
    // A thousand shell calls is plenty of evidence about the session and
    // none at all about this question — so the sample gate passing must not
    // be enough on its own.
    const base: ShapeThresholds = { ...NEVER, minimumSample: 5, readShareThreshold: 0.5 };
    const shape = readSessionShape(
      Array.from({ length: 1000 }, (_, index) => bash(`cmd-${index}`)),
      base,
    );
    expect(shape.readShare.level).toBe("unknown");
    expect(shape.readShare.sampleSize).toBe(0);
    // The other two signals are answerable over the same calls, and must be.
    expect(shape.spread.level).toBe("normal");
  });
});

describe("readSessionShape — what a consumer is handed", () => {
  const thresholds: ShapeThresholds = { ...NEVER, minimumSample: 2 };

  it("carries the number beside every judgement", () => {
    // A nudge that says "you are going in circles" and cannot say how many
    // times is one an agent has no way to check.
    const shape = readSessionShape([bash("a"), bash("b"), bash("a")], thresholds);
    for (const signal of [shape.repeats, shape.spread, shape.readShare]) {
      expect(typeof signal.value).toBe("number");
      expect(SHAPE_LEVELS).toContain(signal.level);
    }
  });

  it("reports the read share as a whole-number percentage", () => {
    const calls = [call("Read"), call("Read"), call("Read"), call("Write")];
    expect(readSessionShape(calls, thresholds).readShare.value).toBe(75);
  });

  it("reports the sample the read share was taken over, not the call count", () => {
    // The two differ exactly when a session used shell, which is always —
    // so a consumer weighing the signal needs the classifiable count.
    const calls = [call("Read"), call("Write"), bash("ls"), bash("pwd")];
    const shape = readSessionShape(calls, thresholds);
    expect(shape.calls).toBe(4);
    expect(shape.readShare.sampleSize).toBe(2);
    expect(shape.repeats.sampleSize).toBe(4);
  });

  it("answers over an empty session without throwing", () => {
    const shape = readSessionShape([], thresholds);
    expect(shape.calls).toBe(0);
    expect(shape.repeats.level).toBe("unknown");
    expect(shape.readShare.value).toBe(0);
  });
});
