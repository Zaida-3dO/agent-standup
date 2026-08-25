// Quick create's validation, preview and submit path — T18.
//
// The request *shaping* is proven against the real operation schemas in
// `create-contract.test.ts`. This file covers the branching either side of
// it: what blocks a submit, what the preview says, and what `submitCreate`
// does with each shape of response.
import { describe, expect, it, vi } from "vitest";
import {
  blockingIssues,
  canSubmit,
  createPath,
  emptyDraft,
  submitCreate,
  titlePreview,
  type QuickCreateDraft,
} from "@/lib/create/state";
import { UI_API_PREFIX } from "@/lib/ui-proxy/path";

function draft(over: Partial<QuickCreateDraft> = {}): QuickCreateDraft {
  return { ...emptyDraft("task"), title: "A title of several words", area: "web", ...over };
}

/**
 * A `fetch` that answers once with `body` at `status`, and records its call.
 *
 * Typed as `typeof fetch` rather than left to inference: an arrow taking no
 * parameters infers `mock.calls` as an empty tuple, so reading the url and
 * the init back out of it does not typecheck.
 */
function stubFetch(status: number, body: unknown) {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return vi.fn(impl);
}

describe("blockingIssues", () => {
  it("passes a complete draft", () => {
    expect(blockingIssues(draft())).toEqual([]);
    expect(canSubmit(draft())).toBe(true);
  });

  it("blocks an empty title", () => {
    const issues = blockingIssues(draft({ title: "" }));
    expect(issues.map((issue) => issue.rule)).toContain("title_required");
    expect(canSubmit(draft({ title: "" }))).toBe(false);
  });

  it("blocks a title that is only whitespace", () => {
    // The schema trims before `.min(1)`, so "   " is refused server-side.
    // Treating it as present here would send a submit that cannot succeed.
    expect(blockingIssues(draft({ title: "   " })).map((i) => i.rule)).toContain("title_required");
  });

  it("blocks an empty area, because exactly one of area or areas is required", () => {
    expect(blockingIssues(draft({ area: "" })).map((i) => i.rule)).toContain("area_required");
  });

  it("blocks a whitespace-only area", () => {
    expect(blockingIssues(draft({ area: " \t " })).map((i) => i.rule)).toContain("area_required");
  });

  it("reports every issue at once rather than only the first", () => {
    const issues = blockingIssues(draft({ title: "", area: "" }));
    expect(issues.map((issue) => issue.rule).sort()).toEqual(["area_required", "title_required"]);
  });

  it("does NOT block a task with no project — that is the inbox sentinel", () => {
    // The distinguishing case for the whole parent rule. A task with an
    // empty project is a legal, named choice, so blocking it would force a
    // person to create a project they do not need.
    expect(blockingIssues(draft({ kind: "task", parent: "" }))).toEqual([]);
    expect(canSubmit(draft({ kind: "task", parent: "" }))).toBe(true);
  });

  it("DOES block a subtask with no task, which has no sentinel to fall back to", () => {
    const issues = blockingIssues(draft({ kind: "subtask", parent: "" }));
    expect(issues.map((issue) => issue.rule)).toContain("parent_required");
    expect(canSubmit(draft({ kind: "subtask", parent: "" }))).toBe(false);
  });

  it("accepts a subtask once a task is named", () => {
    expect(blockingIssues(draft({ kind: "subtask", parent: "task-1" }))).toEqual([]);
  });

  it("blocks a subtask whose task is only whitespace", () => {
    expect(blockingIssues(draft({ kind: "subtask", parent: "  " })).map((i) => i.rule)).toContain(
      "parent_required",
    );
  });

  it("never asks a project for a parent", () => {
    expect(blockingIssues(draft({ kind: "project", parent: "" }))).toEqual([]);
  });
});

describe("titlePreview", () => {
  it("says nothing about an untouched field", () => {
    // A dialog that opens already scolding has spent its one chance to be
    // listened to.
    expect(titlePreview("")).toEqual({ text: null, findings: [] });
    expect(titlePreview("   ")).toEqual({ text: null, findings: [] });
  });

  it("shows a good title with no advice", () => {
    const preview = titlePreview("Let people reset a forgotten password");
    expect(preview.text).toBe("Let people reset a forgotten password");
    expect(preview.findings).toEqual([]);
  });

  it("surfaces the cross-reference finding before submit", () => {
    const preview = titlePreview("agent-standup #102 - fix the thing");
    expect(preview.findings.map((f) => f.rule)).toContain("cross_reference");
  });

  it("surfaces the code-identifier finding", () => {
    const preview = titlePreview("Fix resolveInboxProject for tasks");
    expect(preview.findings.map((f) => f.rule)).toContain("code_identifier");
  });

  it("surfaces the file-path finding", () => {
    const preview = titlePreview("Update src/lib/create/state.ts");
    expect(preview.findings.map((f) => f.rule)).toContain("file_path");
  });

  it("surfaces the too-short finding on a one-word title", () => {
    expect(titlePreview("Inbox").findings.map((f) => f.rule)).toContain("too_short");
  });

  it("previews the normalised text, not the raw input", () => {
    // What is shown must be what is stored — see the preview's own header.
    expect(titlePreview("  A padded title  ").text).toBe("A padded title");
    expect(titlePreview("an em—dash title").text).toBe("an em-dash title");
  });

  it("runs the findings against the normalised text", () => {
    // A title whose only fault is at a trimmed edge must still be judged on
    // what will actually be stored.
    expect(titlePreview("   Inbox   ").findings.map((f) => f.rule)).toContain("too_short");
  });
});

describe("createPath", () => {
  it("routes every kind through the forwarding prefix", () => {
    // A browser holds no credential; a bare `/api/` call 401s on that screen
    // only. `tests/ui-proxy-paths.test.ts` asserts the structural property —
    // this asserts the resulting value.
    expect(createPath("project")).toBe(`${UI_API_PREFIX}/projects`);
    expect(createPath("task")).toBe(`${UI_API_PREFIX}/tasks`);
    expect(createPath("subtask")).toBe(`${UI_API_PREFIX}/subtasks`);
  });
});

describe("submitCreate", () => {
  it("posts JSON to the kind's own collection and returns the created item", async () => {
    const fetchImpl = stubFetch(201, { item: { id: "new-1", title: "A title of several words" } });
    const item = await submitCreate(draft({ kind: "task" }), fetchImpl);

    expect(item.id).toBe("new-1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${UI_API_PREFIX}/tasks`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).title).toBe("A title of several words");
  });

  it("posts a project to the projects collection", async () => {
    const fetchImpl = stubFetch(201, { item: { id: "p-1", title: "t" } });
    await submitCreate(draft({ kind: "project" }), fetchImpl);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${UI_API_PREFIX}/projects`);
  });

  it("throws the service's own sentence when the create is refused", async () => {
    // The service names the field and says what was wrong; the status is a
    // far worse thing to show a person.
    const fetchImpl = stubFetch(400, {
      error: { code: "invalid_input", message: "exactly one of area or areas is required" },
    });
    await expect(submitCreate(draft(), fetchImpl)).rejects.toThrow(
      "exactly one of area or areas is required",
    );
  });

  it("falls back to the status when the error body carries no message", async () => {
    const fetchImpl = stubFetch(500, { error: {} });
    await expect(submitCreate(draft(), fetchImpl)).rejects.toThrow("(500)");
  });

  it("falls back to the status when the error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>gateway</html>", { status: 502 }));
    await expect(submitCreate(draft(), fetchImpl)).rejects.toThrow("(502)");
  });

  it("does not claim failure when the item cannot be read from a success", async () => {
    // The write may well have landed, so the message says what is known —
    // the response could not be read — rather than asserting a failure.
    const fetchImpl = stubFetch(201, { notTheItem: true });
    await expect(submitCreate(draft(), fetchImpl)).rejects.toThrow(
      "created but the response could not be read",
    );
  });
});
