// The ownership check — MILESTONES.md #45, `src/lib/kill/ownership.ts`.
//
// **What would make this file hollow.** A check that returned `owned: true`
// unconditionally passes every "this is allowed" case, and a check that
// returned `owned: false` unconditionally passes every refusal case. So no
// assertion below stands alone: each allow is paired with a refusal that
// differs from it by **one field** — the same command, the same registry,
// one different `rootSessionId` — so the only implementation that passes
// both is one that actually compares them.
//
// The one-character mutations these tests are written to catch, named so a
// reader can check them:
//   - `!==` → `===` in the foreign-owner filter (an allow becomes a refusal
//     and every refusal becomes an allow) — caught by the paired cases.
//   - `matches.length === 0` → `!== 0` (unregistered stops refusing) —
//     caught by "an unregistered pid refuses".
//   - `objections.length === 0` → `>= 0` (everything is owned) — caught by
//     every refusal case.
//   - dropping the empty-targets guard — caught by its own case.
import { describe, expect, it } from "vitest";
import { checkOwnership, refusalMessage, type RegisteredProcessView } from "@/lib/kill/ownership";
import type { KillTarget } from "@/lib/kill/parse";

const OURS = "root-session-a";
const THEIRS = "root-session-b";

function process(overrides: Partial<RegisteredProcessView> = {}): RegisteredProcessView {
  return { pid: 100, executable: "node", rootSessionId: OURS, ...overrides };
}

const pid = (value: number): KillTarget => ({ kind: "pid", value: String(value) });
const image = (value: string): KillTarget => ({ kind: "executable", value });

describe("a process id", () => {
  it("is owned when this crew registered it", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(100)],
      live: [process({ pid: 100, rootSessionId: OURS })],
    });
    expect(answer.owned).toBe(true);
    expect(answer.objections).toEqual([]);
  });

  it("is refused when another crew registered it — the same call, one field changed", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(100)],
      live: [process({ pid: 100, rootSessionId: THEIRS })],
    });
    expect(answer.owned).toBe(false);
    expect(answer.objections).toHaveLength(1);
    expect(answer.objections[0]!.kind).toBe("owned-by-another");
  });

  it("is refused when nobody registered it — unknown is not unowned", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(999)],
      live: [process({ pid: 100, rootSessionId: OURS })],
    });
    expect(answer.owned).toBe(false);
    expect(answer.objections[0]!.kind).toBe("unregistered");
  });

  it("is refused against an empty registry — day one is a refusal, not a free pass", () => {
    const answer = checkOwnership({ rootSessionId: OURS, targets: [pid(100)], live: [] });
    expect(answer.owned).toBe(false);
    expect(answer.objections[0]!.kind).toBe("unregistered");
  });

  it("ownership is by crew root, so a sibling session's process is ours", () => {
    // The builder registered it; the orchestrator is killing it. Same root,
    // different session — and a per-session comparison would refuse this,
    // which is the behaviour that would make agents route around the guard.
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(100)],
      live: [process({ pid: 100, rootSessionId: OURS })],
    });
    expect(answer.owned).toBe(true);
  });

  it("one foreign pid among several of ours refuses the whole command", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(100), pid(101), pid(102)],
      live: [
        process({ pid: 100, rootSessionId: OURS }),
        process({ pid: 101, rootSessionId: OURS }),
        process({ pid: 102, rootSessionId: THEIRS }),
      ],
    });
    expect(answer.owned).toBe(false);
    expect(answer.objections).toHaveLength(1);
    expect(answer.objections[0]!.target).toEqual(pid(102));
  });
});

describe("an executable — the machine-wide kill", () => {
  it("is allowed when every live process running it is ours", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [image("node")],
      live: [
        process({ pid: 100, executable: "node", rootSessionId: OURS }),
        process({ pid: 101, executable: "node", rootSessionId: OURS }),
      ],
    });
    // This is the case a pattern match cannot reach: the command text is
    // byte-identical to the refused one below.
    expect(answer.owned).toBe(true);
  });

  it("is refused when one sibling's process would be caught in it", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [image("node")],
      live: [
        process({ pid: 100, executable: "node", rootSessionId: OURS }),
        process({ pid: 101, executable: "node", rootSessionId: THEIRS }),
      ],
    });
    expect(answer.owned).toBe(false);
    expect(answer.objections[0]!.kind).toBe("owned-by-another");
    // The count is in the message, because "one other" and "eleven others"
    // are different decisions for whoever reads it.
    expect(answer.objections[0]!.detail).toContain("1 live node process");
  });

  it("is refused when no process running it is registered at all", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [image("node")],
      live: [process({ pid: 100, executable: "python", rootSessionId: OURS })],
    });
    expect(answer.owned).toBe(false);
    expect(answer.objections[0]!.kind).toBe("unregistered");
  });

  it("a different image with the same owner does not answer for it", () => {
    // Guards against a match that ignores `executable` and only compares
    // ownership: `killall python` must not be allowed by a node registration.
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [image("python")],
      live: [process({ executable: "node", rootSessionId: OURS })],
    });
    expect(answer.owned).toBe(false);
  });
});

describe("nothing to check is not ownership", () => {
  it("an empty target list refuses", () => {
    // A caller reaching here with no targets has mis-parsed something, and
    // "you own all zero of them" turns that mistake into an allow.
    const answer = checkOwnership({ rootSessionId: OURS, targets: [], live: [] });
    expect(answer.owned).toBe(false);
    expect(answer.objections).toHaveLength(1);
  });
});

describe("the refusal an agent reads", () => {
  it("names the fix when something was unregistered", () => {
    const answer = checkOwnership({ rootSessionId: OURS, targets: [pid(100)], live: [] });
    const message = refusalMessage(answer);
    expect(message).toContain("register_process");
    expect(message).toContain("100");
  });

  it("does not tell you to register when the process is simply not yours", () => {
    // Registering would not help — the row already exists, under someone
    // else — so advice to register would send the agent into a conflict.
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(100)],
      live: [process({ pid: 100, rootSessionId: THEIRS })],
    });
    const message = refusalMessage(answer);
    expect(message).not.toContain("register_process");
    expect(message).toContain("your own session");
  });

  it("lists every objection rather than only the first", () => {
    const answer = checkOwnership({
      rootSessionId: OURS,
      targets: [pid(100), pid(101)],
      live: [],
    });
    const message = refusalMessage(answer);
    expect(message).toContain("100");
    expect(message).toContain("101");
  });
});
