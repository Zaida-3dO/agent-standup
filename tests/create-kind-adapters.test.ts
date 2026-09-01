// The adapter surface for `create_project` / `create_task` /
// `create_subtask` — SCHEMA.md §19, §20, §22.
//
// §22's completeness rule is that every operation is reachable from every
// adapter or carries a written waiver, so registering an operation is only
// *most* of the work: MCP derives itself from the registry, but HTTP needs a
// route and the command line needs a verb. This file proves all four doors
// exist and agree, because "the operation is registered" and "a caller can
// reach it" are different claims and only the second one is useful.
//
// Split from `create-kind-operations.test.ts` deliberately: everything here
// runs without a database, so it fails fast and on a machine with no
// Postgres. The route *handlers* are exercised there, where there is a
// database for them to write to.
import { describe, expect, it } from "vitest";
import { COMMANDS, HTTP_ROUTES } from "@/lib/cli";
import { OPERATION_NAMES, OPERATION_REGISTRY, listOperations } from "@/lib/service/registry";
import { exposedOperations } from "@/lib/adapters/waivers";
import { toolsFromOperations } from "@/lib/mcp/tools";

const NEW_OPERATIONS = ["create_project", "create_task", "create_subtask"] as const;

describe("the three explicit creates are registered operations", () => {
  // Fails if any of the three is left out of OPERATION_REGISTRY — which is
  // the one edit that makes an operation unreachable from every adapter at
  // once, since `callOperation` dispatches by looking the name up there.
  it.each(NEW_OPERATIONS)("%s is in the registry as a write", (name) => {
    expect(OPERATION_NAMES).toContain(name);
    expect(OPERATION_REGISTRY[name].kind).toBe("write");
  });

  // The summary is the tool description an agent reads. Fails if a summary
  // stops naming the required parent, which is the single most important
  // thing a caller needs to know before calling it.
  it("create_task's summary names projectId and the inbox escape hatch", () => {
    const summary = OPERATION_REGISTRY.create_task.summary;
    expect(summary).toContain("projectId");
    expect(summary).toContain("inbox");
  });

  // `create_work` is the tool MCP actually serves — the three above are
  // waived from both transports and reached over HTTP and the command line
  // — so its summary is the only one most agents ever read. It was the one
  // create summary with no assertion on it at all, which a trim pass found
  // by mutating the escape hatch out of it and watching every test pass.
  //
  // Each `toContain` names something a caller cannot learn anywhere else in
  // the tool list: which pointer each type takes, and that `inbox` is the
  // way to file a task whose project is not known. Dropping any one of them
  // is the edit that makes the tool unusable without `describe_tool`.
  it("create_work's summary names each type's parent and the inbox escape hatch", () => {
    const summary = OPERATION_REGISTRY.create_work.summary;
    expect(summary).toContain("projectId");
    expect(summary).toContain("taskId");
    expect(summary).toContain("inbox");
    expect(summary).toContain("type");
  });

  // Fails if the summary stops saying a project has no state of its own —
  // the surprise the explicit-type design exists to prevent, and the one
  // thing a tool list can say to stop a caller trying to transition one.
  it("create_work's summary warns that a project cannot be transitioned", () => {
    expect(OPERATION_REGISTRY.create_work.summary.toLowerCase()).toMatch(
      /no state|cannot be transitioned|derives its column/,
    );
  });

  it("create_subtask's summary names taskId and says it is not a project", () => {
    const summary = OPERATION_REGISTRY.create_subtask.summary;
    expect(summary).toContain("taskId");
    expect(summary.toLowerCase()).toContain("project");
  });

  // Fails if `create_project`'s summary drops the fact that a project cannot
  // be transitioned — the whole reason a caller was surprised in the first
  // place, and the one thing the tool list can say to prevent it recurring.
  it("create_project's summary warns that a project has no state", () => {
    expect(OPERATION_REGISTRY.create_project.summary.toLowerCase()).toMatch(
      /no state|cannot be transitioned/,
    );
  });
});

describe("MCP derives its create tool with no second list", () => {
  // On MCP the three are reached through `create_work`, which carries the
  // kind as a required `type` field; the three themselves are waived off
  // both MCP transports so one tool describes one decision. This asserts
  // the derivation actually held rather than trusting it. Fails if
  // `create_work` is excluded from the derived list.
  it("create_work appears as an MCP tool over each transport", () => {
    for (const adapter of ["mcp_http", "mcp_stdio"] as const) {
      const tools = toolsFromOperations(exposedOperations(adapter, listOperations()));
      const tool = tools.find((t) => t.name === "create_work");
      expect(tool, `create_work missing from ${adapter}`).toBeDefined();
      // A write must not be advertised read-only — a client acting on that
      // hint would treat a create as safe to retry or to run speculatively.
      expect(tool!.readOnly).toBe(false);
    }
  });

  // The three stay registered — they are what `create_work` dispatches to,
  // and they remain the operations HTTP and the command line expose. Fails
  // if a fold at the adapter layer is mistaken for deleting them.
  it.each(NEW_OPERATIONS)("%s stays a registered operation", (name) => {
    expect(listOperations().find((operation) => operation.name === name)).toBeDefined();
  });

  // The advertised schema has to carry the parent field, or an agent
  // reading the tool list cannot know to send it — which is precisely the
  // failure mode this whole change exists to fix, reintroduced at the
  // discovery layer. Fails if the schema is replaced with a bare object,
  // which is exactly what a discriminated union would advertise.
  it("create_work advertises type, projectId and taskId in its input schema", () => {
    const tools = toolsFromOperations(listOperations());
    const tool = tools.find((t) => t.name === "create_work")!;
    const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    for (const field of ["type", "projectId", "taskId"]) {
      expect(shape[field], `${field} missing from create_work's advertised shape`).toBeDefined();
    }
    // `type` is required: a call that omits it does not parse.
    expect(
      tool.inputSchema.safeParse({ title: "x", body: "y", area: "z", originType: "auto" }).success,
    ).toBe(false);
  });
});

describe("HTTP routes the three operations", () => {
  /**
   * The route spec for `name`, failing loudly when there is none.
   *
   * `HTTP_ROUTES` is keyed by `string`, so every lookup is possibly
   * undefined. Throwing here rather than asserting non-null keeps a missing
   * route a *test failure naming the operation* instead of a
   * `Cannot read properties of undefined` several lines later.
   */
  function routeFor(name: string) {
    const route = HTTP_ROUTES[name];
    if (!route) throw new Error(`no HTTP route spec for ${name}`);
    return route;
  }

  // The `http` CLI binding is keyed on operation name, and refuses an
  // operation it has no route for with `not_implemented`. Fails if a route
  // spec is missing — which would make `standup task create --url ...`
  // refuse while the identical `--direct` call succeeded.
  it.each(NEW_OPERATIONS)("%s has a route spec", (name) => {
    expect(routeFor(name).method).toBe("POST");
  });

  it("each posts to its own collection, so the kind is visible in the request", () => {
    expect(routeFor("create_project").request({}).path).toBe("/api/projects");
    expect(routeFor("create_task").request({}).path).toBe("/api/tasks");
    expect(routeFor("create_subtask").request({}).path).toBe("/api/subtasks");
  });

  // The parent travels in the body, not the path — see the route modules for
  // why. Fails if a spec started splicing the parent into the path, which
  // would send `"inbox"` as a path segment.
  it("sends the whole input as the body, parent included", () => {
    const input = { title: "t", projectId: "inbox" };
    expect(routeFor("create_task").request(input).body).toEqual(input);
  });

  // The API wraps a single item as `{ item }` and the service returns it
  // unwrapped; unwrapping here is what makes the two bindings comparable.
  // Fails if `unwrap` were left as the identity, which would make the http
  // binding return a different shape from `direct` for the same command.
  it.each(NEW_OPERATIONS)("%s unwraps the item envelope", (name) => {
    expect(routeFor(name).unwrap({ item: { id: "x" } })).toEqual({ id: "x" });
  });
});

describe("the command line has a verb per kind", () => {
  function commandFor(noun: string, verb: string) {
    const command = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
    if (!command) throw new Error(`no such command: ${noun} ${verb}`);
    return command;
  }

  it.each([
    ["project", "create_project"],
    ["task", "create_task"],
    ["subtask", "create_subtask"],
  ])("`standup %s create` calls %s", (noun, operation) => {
    expect(commandFor(noun, "create").operation).toBe(operation);
  });

  // The noun *is* the kind, so there is no `--kind` flag to reconcile
  // against the parent. Fails if someone reintroduced one.
  it("passes the parent flag straight through as an operation input field", () => {
    const built = commandFor("task", "create").buildInput([], {
      title: "t",
      projectId: "p-1",
    });
    expect(built).toEqual({ ok: true, input: { title: "t", projectId: "p-1" } });
  });

  it("drops the global flags, same as every other verb", () => {
    const built = commandFor("subtask", "create").buildInput([], {
      title: "t",
      taskId: "t-1",
      json: true,
      direct: true,
    });
    expect(built).toEqual({ ok: true, input: { title: "t", taskId: "t-1" } });
  });

  // Requiredness belongs to the operation's schema, not to the adapter
  // (commands.ts: "Field validation is not done here"). This asserts the
  // command does NOT invent its own rejection — otherwise the CLI would
  // refuse with a different code and message than every other door, which
  // is exactly what §22's identical-rejections assertion forbids. Fails if
  // someone added a "task create needs --projectId" check to buildInput.
  it("does not pre-validate the required parent — the schema does that", () => {
    const built = commandFor("task", "create").buildInput([], { title: "t" });
    expect(built.ok).toBe(true);
  });

  // Fails if the deprecation is dropped from `item create`'s help line, the
  // only place a person running `standup --help` would learn to stop using
  // it.
  it("`standup item create` is marked deprecated in its help line", () => {
    expect(commandFor("item", "create").summary.toLowerCase()).toContain("deprecated");
  });
});
