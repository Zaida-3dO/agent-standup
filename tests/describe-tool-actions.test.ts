// `describe_tool` answering about a folded tool, and about one of its verbs.
//
// ── What this file exists to pin ────────────────────────────────────────
//
// A folded tool takes its verb as a field, so "what does `loop` require?" has
// no single answer: `add` needs `text`, `close` needs `loopId`. A caller told
// "loopId is optional" because the schema says so has been told something
// true and useless.
//
// **The required list is READ from the same table the fold refuses from.**
// That is the property worth protecting: if `describe_tool` retyped those
// lists, the advertised requirement and the enforced one could drift, and
// both halves would look correct in isolation. So the tests below compare
// what the tool ADVERTISES against what the operation actually REFUSES,
// rather than against a third list written here.
import { describe, expect, it } from "vitest";

import { ServiceRuntime } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { FOLD_ACTIONS } from "@/lib/service/describe/fold-actions";
import { LOOP_ACTIONS } from "@/lib/service/operations/loop";
import { SCORE_ACTIONS } from "@/lib/service/operations/score";
import { PROJECT_ACTIONS } from "@/lib/service/operations/project";
import { SESSION_ACTIONS } from "@/lib/service/operations/session";

interface Contract {
  readonly name: string;
  readonly onMcp: boolean;
  readonly foldedInto?: string;
  readonly verbs?: readonly string[];
  readonly requiredForAction?: readonly string[];
  readonly invocation: Record<string, string>;
}

interface ServiceError {
  code: string;
  fields?: string[];
  message: string;
  details?: { known?: readonly string[] };
}

/**
 * A runtime with no database.
 *
 * `describe_tool` reads the operation registry and the settings snapshot and
 * touches no table for the tool-contract answer, so a transaction runner
 * that hands back an empty object is enough — and keeps this file out of the
 * DB-gated set, so it runs everywhere.
 */
const runtime = new ServiceRuntime({
  transaction: (async (fn: (db: unknown) => unknown) => fn({})) as never,
  resolveSnapshot: async () => defaultSnapshot(),
});

const describeTool = (input: Record<string, unknown>): Promise<Contract> =>
  runtime.call("describe_tool" as never, input, {
    caller: { actor: "tester", transport: "mcp-http" },
  } as never) as Promise<Contract>;

async function rejection(call: Promise<unknown>): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

describe("describe_tool lists a folded tool's verbs", () => {
  const FOLDS: readonly (readonly [string, readonly string[]])[] = [
    ["loop", LOOP_ACTIONS],
    ["score", SCORE_ACTIONS],
    ["project", PROJECT_ACTIONS],
    ["session", SESSION_ACTIONS],
  ];

  it.each(FOLDS)("reports every verb `%s` accepts", async (tool, actions) => {
    const contract = await describeTool({ tool });
    // Compared against each fold's OWN enum, imported from the module that
    // dispatches on it. A verb added there and not advertised here fails,
    // which is the drift this file exists to catch.
    expect(contract.verbs).toEqual([...actions]);
  });

  it("reports no verbs for a tool that folds nothing", async () => {
    const contract = await describeTool({ tool: "get_item" });
    // Absent, not empty. "This tool folds nothing" and "this tool folds an
    // empty set" are different answers, and an empty array would collapse
    // them — the same distinction `rules` already draws.
    expect(contract.verbs).toBeUndefined();
  });
});

describe("describe_tool answers per action", () => {
  it("reports what `loop close` requires, not what the whole schema allows", async () => {
    const contract = await describeTool({ tool: "loop", action: "close" });
    expect(contract.requiredForAction).toEqual(["loopId"]);
  });

  it("reports a different list for a different verb of the same tool", async () => {
    // The point of the parameter. If these two ever returned the same list,
    // naming an action would be decoration.
    const add = await describeTool({ tool: "loop", action: "add" });
    const del = await describeTool({ tool: "loop", action: "delete" });
    expect(add.requiredForAction).toEqual(["text"]);
    expect(del.requiredForAction).toEqual(["loopId", "reason"]);
    expect(add.requiredForAction).not.toEqual(del.requiredForAction);
  });

  it("reports an empty list for a verb that requires nothing", async () => {
    const contract = await describeTool({ tool: "loop", action: "list" });
    // Empty, not absent: an action WAS named and the answer is "nothing".
    expect(contract.requiredForAction).toEqual([]);
  });

  it("omits the per-action list when no action is named", async () => {
    const contract = await describeTool({ tool: "loop" });
    expect(contract.requiredForAction).toBeUndefined();
  });

  it("ignores an action on a tool that folds nothing, rather than refusing", async () => {
    // A caller passing one by habit is not making an error worth a round
    // trip, and the answer it gets is the answer it wanted.
    const contract = await describeTool({ tool: "get_item", action: "anything" });
    expect(contract.name).toBe("get_item");
    expect(contract.requiredForAction).toBeUndefined();
  });
});

describe("an unknown verb is refused with the full list", () => {
  it("names every verb the tool does have", async () => {
    const error = await rejection(describeTool({ tool: "loop", action: "obliterate" }));
    expect(error.code).toBe("not_found");
    expect(error.fields).toContain("action");
    // The list is the point: a caller reaching here has a verb that is
    // wrong, and the likely cause is a near miss. Denying without the list
    // makes finding the right one a second call.
    for (const action of LOOP_ACTIONS) {
      expect(error.message, `refusal should name ${action}`).toContain(action);
    }
    expect(error.details?.known).toEqual([...LOOP_ACTIONS]);
  });

  it("calls the field by the name that tool actually uses", async () => {
    // `create_work` spells its discriminator `type`, not `action`. A refusal
    // that said "no such action" would name a field that tool has no way to
    // accept, which is the unfollowable-advice defect in miniature.
    const error = await rejection(describeTool({ tool: "create_work", action: "nonsense" }));
    expect(error.message).toContain("type");
    expect(error.message).not.toContain("No such action");
  });
});

describe("describe_tool reports where a folded operation went", () => {
  it("tells a caller holding a folded name which tool replaced it", async () => {
    const contract = await describeTool({ tool: "loop_close" });
    // The question a caller refused on a remembered name actually has.
    expect(contract.onMcp).toBe(false);
    expect(contract.foldedInto).toBe("loop");
  });

  it.each([
    ["score_run", "score"],
    ["get_projects", "project"],
    ["register_session", "session"],
    ["create_task", "create_work"],
  ])("resolves %s to %s", async (operation, fold) => {
    const contract = await describeTool({ tool: operation });
    expect(contract.onMcp).toBe(false);
    expect(contract.foldedInto).toBe(fold);
  });

  it("reports an unfolded MCP tool as on-MCP with no fold", async () => {
    const contract = await describeTool({ tool: "get_item" });
    expect(contract.onMcp).toBe(true);
    expect(contract.foldedInto).toBeUndefined();
  });

  it("omits the MCP spelling for an operation an MCP caller cannot name", async () => {
    // `spellingsFor` already omits `mcp` when `onMcp` is false, so a folded
    // operation's invocation offers the surfaces the caller can actually
    // use. Asserted rather than assumed, because an invocation naming a
    // tool that is not in the caller's list is the exact stale-advice
    // defect this surface has been corrected for before.
    const contract = await describeTool({ tool: "loop_close" });
    expect(contract.invocation.mcp).toBeUndefined();
    expect(contract.invocation.cli).toBe("standup loop close");
  });
});

describe("the advertised requirements come from the fold's own table", () => {
  it.each([...FOLD_ACTIONS.keys()])(
    "%s advertises a required list for every verb it accepts",
    async (tool) => {
      const fold = FOLD_ACTIONS.get(tool)!;
      for (const action of fold.actions) {
        const contract = await describeTool({ tool, action });
        // Every verb answers. A verb present in the enum but missing from
        // the required map would report `undefined` here rather than a list,
        // which is how a fold that grew a verb without describing it shows
        // up.
        expect(contract.requiredForAction, `${tool} ${action}`).toBeDefined();
      }
    },
  );

  it("advertises exactly what the loop fold refuses", async () => {
    // The cross-check that makes this more than a copy of a copy: drive the
    // real operation with an empty call and compare the fields it NAMES in
    // its refusal against the list `describe_tool` advertised.
    for (const action of LOOP_ACTIONS) {
      const advertised = (await describeTool({ tool: "loop", action })).requiredForAction ?? [];
      if (advertised.length === 0) continue;
      const error = await rejection(
        runtime.call("loop" as never, { action, itemId: "some-item" }, {
          caller: { actor: "tester", transport: "mcp-http" },
        } as never),
      );
      expect(error.fields, `loop ${action}`).toEqual([...advertised]);
    }
  });
});
