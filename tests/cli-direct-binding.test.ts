// AC3 — the `direct` binding's own behaviour.
//
// The equivalence test (`cli-one-interface.test.ts`) proves the two bindings
// agree on what a caller sees. This one covers what only *this* binding can
// get wrong, because there is no `http` behaviour to compare it against:
// what it stamps onto the call, and what it does with a throw that is not a
// service refusal.
//
// **Why these cases exist at all**: mutation testing found every mutant in
// the identity-stamping block surviving. Dropping `transport`, inverting the
// session guard, or emptying the whole `caller` object left every other test
// green — because nothing downstream of a `BindingResult` can see the caller.
// A rejection the service makes travels in the result; who made the call
// does not, so it needs asserting where it is set.
import { describe, expect, it } from "vitest";
import { GuardRejectedError, NotFoundError } from "@/lib/service";
import { createDirectBinding } from "@/lib/cli";

/** Records the arguments each `service.call` received. */
function recordingService(answer: () => unknown = () => ({ id: "item-1" })) {
  const calls: { name: string; input: unknown; options: unknown }[] = [];
  return {
    calls,
    service: {
      async call(name: string, input: unknown, options?: unknown): Promise<unknown> {
        calls.push({ name, input, options });
        return answer();
      },
    },
  };
}

/** The `caller` the binding passed on the one call it made. */
function callerOf(calls: { options: unknown }[]): Record<string, unknown> {
  const options = calls[0]?.options as { caller?: Record<string, unknown> } | undefined;
  return options?.caller ?? {};
}

describe("what the direct binding stamps onto a call", () => {
  it("stamps the transport as cli, so a command cannot claim another one", async () => {
    // SCHEMA.md §21: the registration transport is "stamped by the adapter,
    // not supplied by the caller", because it is a *capability signal* —
    // registering over the command line proves the command line is
    // installed. A binding that omitted it would make that signal absent
    // rather than wrong, which is harder to notice.
    const { calls, service } = recordingService();
    const binding = createDirectBinding({ service });
    await binding.invoke("get_item", { id: "x" });
    expect(callerOf(calls).transport).toBe("cli");
  });

  it("passes the session and actor through when they were resolved", async () => {
    const { calls, service } = recordingService();
    const binding = createDirectBinding({ service, sessionId: "s-1", actor: "user-a" });
    await binding.invoke("get_item", { id: "x" });

    expect(callerOf(calls)).toEqual({ transport: "cli", sessionId: "s-1", actor: "user-a" });
  });

  it("omits the session rather than sending it undefined when none resolved", async () => {
    // An absent session and a session that is literally `undefined` are
    // different facts to an operation that checks for one — the first says
    // "no session", the second is a key that exists with no value.
    const { calls, service } = recordingService();
    const binding = createDirectBinding({ service, actor: "user-a" });
    await binding.invoke("get_item", { id: "x" });

    const caller = callerOf(calls);
    expect(caller).toEqual({ transport: "cli", actor: "user-a" });
    expect("sessionId" in caller).toBe(false);
  });

  it("omits the actor rather than sending it undefined when none resolved", async () => {
    const { calls, service } = recordingService();
    const binding = createDirectBinding({ service, sessionId: "s-1" });
    await binding.invoke("get_item", { id: "x" });

    const caller = callerOf(calls);
    expect(caller).toEqual({ transport: "cli", sessionId: "s-1" });
    expect("actor" in caller).toBe(false);
  });

  it("passes the operation name and input through unchanged", async () => {
    const { calls, service } = recordingService();
    const binding = createDirectBinding({ service });
    await binding.invoke("list_items", { state: "open" });

    expect(calls[0]?.name).toBe("list_items");
    expect(calls[0]?.input).toEqual({ state: "open" });
  });

  it("names itself direct", () => {
    expect(createDirectBinding({ service: recordingService().service }).name).toBe("direct");
  });
});

describe("how the direct binding normalises a throw", () => {
  it("carries a service refusal through with its code, fields and rule intact", async () => {
    const binding = createDirectBinding({
      service: {
        async call(): Promise<unknown> {
          throw new GuardRejectedError("a_rule", "refused", { fields: ["state"] });
        },
      },
    });
    const result = await binding.invoke("get_item", { id: "x" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.rejection).toEqual({
      code: "guard_rejected",
      fields: ["state"],
      guard: "a_rule",
    });
    expect(result.message).toBe("refused");
  });

  it("returns a refusal rather than throwing, so one caller shape covers both bindings", async () => {
    const binding = createDirectBinding({
      service: {
        async call(): Promise<unknown> {
          throw new NotFoundError("gone", { fields: ["id"] });
        },
      },
    });
    // `.invoke` resolving — not rejecting — is the contract the `Binding`
    // interface promises. A binding that rethrew would force every command
    // to handle two error shapes, which is the coupling this row removes.
    await expect(binding.invoke("get_item", { id: "x" })).resolves.toMatchObject({ ok: false });
  });

  it("wraps a throw that is not a service error as internal, not as a rule refusing", async () => {
    const binding = createDirectBinding({
      service: {
        async call(): Promise<unknown> {
          throw new TypeError("cannot read properties of undefined");
        },
      },
    });
    const result = await binding.invoke("get_item", { id: "x" });

    if (result.ok) throw new Error("unreachable");
    // `internal` exits 1 ("something is broken"), not 3 ("the installation
    // decided"). A `TypeError` escaping as an unclassifiable throw is
    // exactly what would make the two bindings behave differently: the http
    // binding would have reported the same bug as a 500.
    expect(result.rejection.code).toBe("internal");
    expect(result.rejection.fields).toEqual([]);
  });

  it("does not render the underlying failure's own text for an unexpected throw", async () => {
    // `InternalError` fixes its message rather than taking the cause's,
    // because an unexpected failure's text routinely carries a query or a
    // connection string. The binding must not undo that.
    const binding = createDirectBinding({
      service: {
        async call(): Promise<unknown> {
          throw new Error("connect failed for postgresql://ops:hunter2@db.internal/app");
        },
      },
    });
    const result = await binding.invoke("get_item", { id: "x" });

    if (result.ok) throw new Error("unreachable");
    expect(result.message).not.toContain("hunter2");
    expect(result.message).not.toContain("db.internal");
  });

  it("returns the service's result unchanged on acceptance", async () => {
    const { service } = recordingService(() => ({ id: "item-1", title: "kept" }));
    const binding = createDirectBinding({ service });
    const result = await binding.invoke("get_item", { id: "item-1" });

    expect(result).toEqual({ ok: true, data: { id: "item-1", title: "kept" } });
  });
});
