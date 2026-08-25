// Quick create's request shaping, checked against the operations that will
// receive it — T18.
//
// **Why this file parses the real Zod schemas instead of asserting on a
// literal.** A test that says `expect(body.originType).toBe("auto")` proves
// the dialog sends what this test was told to expect, which is circular: the
// requirement it is really defending is that *the operation accepts the
// body*. So the assertions below feed `createRequestBody`'s output through
// `create_project`, `create_task` and `create_subtask`'s own `input` schemas,
// which are the exact objects `service.call` validates against. If a required
// field is dropped, a key is misspelled, or a `.strict()` schema is handed
// something it does not recognise, these fail — including when the change
// that breaks it is made to the operation rather than to the dialog.
//
// Parsing a schema opens no transaction and touches no database: Zod
// validates before the handler runs, so this suite is not DB-gated.
import { describe, expect, it } from "vitest";
import { createProject } from "@/lib/service/operations/create-project";
import { createTask, INBOX_PROJECT_ID } from "@/lib/service/operations/create-task";
import { createSubtask } from "@/lib/service/operations/create-subtask";
import { normalizeEmDash } from "@/lib/text-normalize";
import { CREATE_KINDS, CREATE_KIND_ORDER, DEFAULT_PRIORITY } from "@/lib/create/kinds";
import { INBOX_PROJECT_ID as UI_INBOX_PROJECT_ID } from "@/lib/create/inbox";
import { createRequestBody, emptyDraft, titlePreview } from "@/lib/create/state";
import type { QuickCreateDraft } from "@/lib/create/state";

/** A draft that is complete for its kind — the base every case varies from. */
function draftFor(kind: QuickCreateDraft["kind"], over: Partial<QuickCreateDraft> = {}) {
  return {
    ...emptyDraft(kind),
    title: "Let people create an item without an agent",
    area: "web",
    ...over,
  };
}

/** The operation each kind names, as an object with the schema to parse against. */
const OPERATIONS = {
  project: createProject,
  task: createTask,
  subtask: createSubtask,
} as const;

describe("the duplicated constants agree with the modules that own them", () => {
  // `src/lib/create/inbox.ts` re-declares this rather than importing the
  // operation, so the service layer stays out of the client bundle. That is
  // a drift risk, and this is the check that makes it a checked duplication
  // rather than a hoped-for one.
  it("re-declares the inbox sentinel as exactly the literal create_task owns", () => {
    expect(UI_INBOX_PROJECT_ID).toBe(INBOX_PROJECT_ID);
  });

  it("names, for each kind, the operation that operation actually registers", () => {
    for (const kind of CREATE_KIND_ORDER) {
      expect(CREATE_KINDS[kind].operation).toBe(OPERATIONS[kind].name);
    }
  });

  it("defaults priority to the value the shared create schema defaults to", () => {
    // The schema's own `.default("P2")` — read out of the parse rather than
    // retyped, so a change to the operation moves this expectation.
    const parsed = createProject.input.parse({
      title: "A title with several words",
      body: "",
      area: "web",
      originType: "auto",
    });
    expect(DEFAULT_PRIORITY).toBe(parsed.priority);
  });

  it("previews the title exactly as the schema will normalise it", () => {
    // The preview promises to show what will be STORED. The schema applies
    // `.trim()` then `normalizeEmDash`; the preview re-implements that. A
    // table rather than one case, because the two must agree on every shape
    // — em dash at the edge, in the middle, absent, and repeated.
    const inputs = [
      "  padded either side  ",
      "an em—dash in the middle",
      "—leading em dash",
      "trailing em dash—",
      "two—em—dashes",
      "nothing special here",
      "  —mixed padding and dash— ",
    ];
    for (const input of inputs) {
      const bySchema = createProject.input.parse({
        title: input,
        body: "",
        area: "web",
        originType: "auto",
      }).title;
      expect(titlePreview(input).text).toBe(bySchema);
      // And the same fact stated against the normaliser directly, so a
      // failure says which half disagreed.
      expect(titlePreview(input).text).toBe(normalizeEmDash(input.trim()));
    }
  });
});

describe("createRequestBody produces a body each operation accepts", () => {
  it("is accepted by create_project for a project", () => {
    const body = createRequestBody(draftFor("project"));
    const parsed = createProject.input.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("is accepted by create_task for a task", () => {
    const body = createRequestBody(draftFor("task", { parent: "a-real-project-id" }));
    const parsed = createTask.input.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("is accepted by create_subtask for a subtask", () => {
    const body = createRequestBody(draftFor("subtask", { parent: "a-real-task-id" }));
    const parsed = createSubtask.input.safeParse(body);
    expect(parsed.success).toBe(true);
  });

  it("sends the inbox sentinel when a task names no project, and it parses", () => {
    const body = createRequestBody(draftFor("task", { parent: "" }));
    expect(body.projectId).toBe(INBOX_PROJECT_ID);
    expect(createTask.input.safeParse(body).success).toBe(true);
  });

  it("sends the named project when a task names one", () => {
    const body = createRequestBody(draftFor("task", { parent: "  proj-42  " }));
    // Trimmed: a pasted id commonly carries whitespace, and the schema's
    // `.trim().min(1)` would accept "   " as far as this key is concerned
    // only to have the lookup fail with a confusing "no such project".
    expect(body.projectId).toBe("proj-42");
  });

  it("keys a subtask's parent as taskId, never projectId", () => {
    // The two kinds spell the parent differently and both schemas are
    // `.strict()`, so sending the wrong key is a refusal rather than a
    // silently-ignored field. This is the mistake `create_item`'s
    // parent-inference used to hide.
    const body = createRequestBody(draftFor("subtask", { parent: "task-9" }));
    expect(body.taskId).toBe("task-9");
    expect(body.projectId).toBeUndefined();
  });

  it("sends a project no parent key at all", () => {
    // `create_project`'s schema takes no parent field and is `.strict()`, so
    // a stray `projectId` or `parentId` is an unrecognised key and refused.
    const body = createRequestBody(draftFor("project", { parent: "ignored" }));
    expect(body.projectId).toBeUndefined();
    expect(body.taskId).toBeUndefined();
    expect(body.parentId).toBeUndefined();
  });
});

describe("the required fields the schema does not advertise", () => {
  // Each of these is a refusal this repository has really paid for. The
  // point of the test is that dropping the field is caught here rather than
  // by a person filling in a form.

  it("always sends originType, which the handler requires though Zod marks it optional", () => {
    for (const kind of CREATE_KIND_ORDER) {
      const body = createRequestBody(draftFor(kind, { parent: "p" }));
      expect(body.originType).toBe("auto");
    }
  });

  it('never sends "person" as originType, which would need an originPersonId', () => {
    // A browser registers no session and so has no person to name. `person`
    // without `originPersonId` fails `originPersonCheck` — proven here
    // rather than asserted, so the reasoning is verified not just stated.
    const body = { ...createRequestBody(draftFor("project")), originType: "person" };
    expect(createProject.input.safeParse(body).success).toBe(false);
  });

  it("sends an empty body, because body is required and a three-field dialog has none", () => {
    for (const kind of CREATE_KIND_ORDER) {
      expect(createRequestBody(draftFor(kind, { parent: "p" })).body).toBe("");
    }
    // And the reason it cannot simply be omitted:
    const withoutBody = { title: "A perfectly fine title", area: "web", originType: "auto" };
    expect(createProject.input.safeParse(withoutBody).success).toBe(false);
  });

  it("sends area and never areas, because supplying both is refused", () => {
    const body = createRequestBody(draftFor("project"));
    expect(body.area).toBe("web");
    expect(body.areas).toBeUndefined();
    // The XOR, proven: both spellings together is a refusal.
    expect(createProject.input.safeParse({ ...body, areas: ["web"] }).success).toBe(false);
    // And neither is too.
    const withoutArea: Record<string, unknown> = { ...body };
    delete withoutArea.area;
    expect(createProject.input.safeParse(withoutArea).success).toBe(false);
  });

  it("trims the title and the area before sending", () => {
    const body = createRequestBody(
      draftFor("project", { title: "  Spaces around the title  ", area: "  web  " }),
    );
    expect(body.title).toBe("Spaces around the title");
    expect(body.area).toBe("web");
  });

  it("sends the chosen priority, not always the default", () => {
    const body = createRequestBody(draftFor("project", { priority: "P0" }));
    expect(body.priority).toBe("P0");
    expect(createProject.input.safeParse(body).success).toBe(true);
  });
});
