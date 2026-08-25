// The quick create dialog's rendered output — T18.
//
// Called directly as a function rather than mounted: this repo's harness
// runs `environment: "node"` with no DOM, and the component is hook-free
// precisely so that its returned element tree can be walked and its handlers
// invoked as the plain function references they are
// (`tests/helpers/react-element.ts`).
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { QuickCreateDialog } from "@/components/create/QuickCreateDialog";
import { emptyDraft, type QuickCreateDraft } from "@/lib/create/state";
import { walk, findAllByType } from "./helpers/react-element";

function draft(over: Partial<QuickCreateDraft> = {}): QuickCreateDraft {
  return { ...emptyDraft("task"), title: "A title of several words", area: "web", ...over };
}

function render(over: Partial<Parameters<typeof QuickCreateDialog>[0]> = {}) {
  return QuickCreateDialog({
    draft: draft(),
    submitting: false,
    errorMessage: null,
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  }) as ReactElement;
}

/** Every element carrying the given prop value, e.g. `id`. */
function byProp(tree: ReactNode, prop: string, value: unknown): ReactElement[] {
  return [...walk(tree)].filter((el) => (el.props as Record<string, unknown>)[prop] === value);
}

/** The single element with this `id`. */
function byId(tree: ReactNode, id: string): ReactElement {
  const matches = byProp(tree, "id", id);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

/** All rendered text, flattened — for asserting a message appears at all. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

describe("structure and accessibility", () => {
  it("is a labelled modal dialog", () => {
    const tree = render();
    const dialogs = [...walk(tree)].filter(
      (el) => (el.props as Record<string, unknown>).role === "dialog",
    );
    expect(dialogs).toHaveLength(1);
    expect((dialogs[0]!.props as Record<string, unknown>)["aria-modal"]).toBe("true");
    expect((dialogs[0]!.props as Record<string, unknown>)["aria-label"]).toBe("Create an item");
  });

  it("focuses the title field on open, so the dialog is usable without a mouse", () => {
    expect((byId(render(), "quick-create-title").props as Record<string, unknown>).autoFocus).toBe(
      true,
    );
  });

  it("ties the title field to its preview for a screen reader", () => {
    const tree = render();
    const input = byId(tree, "quick-create-title").props as Record<string, unknown>;
    expect(input["aria-describedby"]).toBe("quick-create-title-preview");
    const preview = byId(tree, "quick-create-title-preview").props as Record<string, unknown>;
    expect(preview["aria-live"]).toBe("polite");
  });

  it("renders the three fields the row asks for", () => {
    const tree = render();
    for (const id of ["quick-create-title", "quick-create-area", "quick-create-priority"]) {
      expect(byProp(tree, "id", id)).toHaveLength(1);
    }
  });
});

describe("the live card-title preview", () => {
  it("shows the normalised title as it will read on a card", () => {
    // Asserted as the card element's EXACT text, not a `toContain` over the
    // whole preview. `toContain` cannot tell the normalised title from the
    // raw one — "  Let people…  " contains "Let people…" — so it passes just
    // as happily on a card wired to `draft.title`, which would preview a
    // string that is not what gets stored. A surviving mutant proved this:
    // swapping `preview.text` for `draft.title` left the suite green.
    const tree = render({ draft: draft({ title: "  Let people create an item  " }) });
    const preview = byId(tree, "quick-create-title-preview");
    const cardText = [...walk(preview)]
      .map((el) => (el.props as Record<string, unknown>).children)
      .filter((child): child is string => typeof child === "string");
    expect(cardText).toContain("Let people create an item");
    // The untrimmed original must appear nowhere in the preview.
    expect(cardText).not.toContain("  Let people create an item  ");
  });

  it("previews the em-dash-normalised title, not the typed one", () => {
    // The other half of "what is previewed is what is stored": the schema
    // folds an em dash to a hyphen on the way in.
    const tree = render({ draft: draft({ title: "an em—dash title" }) });
    const cardText = [...walk(byId(tree, "quick-create-title-preview"))]
      .map((el) => (el.props as Record<string, unknown>).children)
      .filter((child): child is string => typeof child === "string");
    expect(cardText).toContain("an em-dash title");
    expect(cardText).not.toContain("an em—dash title");
  });

  it("prompts rather than scolds before anything is typed", () => {
    const text = textOf(
      byId(render({ draft: draft({ title: "" }) }), "quick-create-title-preview"),
    );
    expect(text).toContain("will appear here");
    // The empty field must not be reported as a too-short title.
    expect(text).not.toContain("single word");
  });

  it("surfaces the title convention's advice before submit", () => {
    // The row's whole reason for the preview: the advice arrives while the
    // cursor is still in the field, not attached to a create that already
    // happened.
    const tree = render({ draft: draft({ title: "agent-standup #102 - fix it" }) });
    const advice = byProp(tree, "data-rule", "cross_reference");
    expect(advice).toHaveLength(1);
    expect(textOf(advice[0]!)).toContain("board");
  });

  it("shows every finding a title earns, not just the first", () => {
    const tree = render({ draft: draft({ title: "src/lib/thing.ts #9" }) });
    expect(byProp(tree, "data-rule", "file_path")).toHaveLength(1);
    expect(byProp(tree, "data-rule", "cross_reference")).toHaveLength(1);
  });

  it("does NOT disable submit on title advice — the judgement is the author's", () => {
    // `item-title.ts` advises rather than refuses because "reads well to a
    // person" has no predicate right about every string. A dialog that
    // blocked on it would convert that advice into the refusal the module
    // deliberately is not.
    const tree = render({ draft: draft({ title: "agent-standup #102 - fix it" }) });
    const submit = findAllByType(tree, "button").find(
      (b) => (b.props as Record<string, unknown>).type === "submit",
    )!;
    expect((submit.props as Record<string, unknown>).disabled).toBe(false);
  });
});

describe("validation", () => {
  function submitButton(tree: ReactNode) {
    return findAllByType(tree, "button").find(
      (b) => (b.props as Record<string, unknown>).type === "submit",
    )!.props as Record<string, unknown>;
  }

  it("disables submit while a required field is empty", () => {
    expect(submitButton(render({ draft: draft({ title: "" }) })).disabled).toBe(true);
    expect(submitButton(render({ draft: draft({ area: "" }) })).disabled).toBe(true);
  });

  it("enables submit on a complete draft", () => {
    expect(submitButton(render()).disabled).toBe(false);
  });

  it("says why submit is disabled rather than leaving a dead button", () => {
    expect(String(submitButton(render({ draft: draft({ area: "" }) })).title)).toContain(
      "area is required",
    );
  });

  it("marks the offending field invalid and states the reason beside it", () => {
    const tree = render({ draft: draft({ area: "" }) });
    expect((byId(tree, "quick-create-area").props as Record<string, unknown>)["aria-invalid"]).toBe(
      true,
    );
    expect(textOf(tree)).toContain("An area is required");
  });

  it("disables submit while a create is in flight, and names the state", () => {
    const button = submitButton(render({ submitting: true }));
    expect(button.disabled).toBe(true);
    expect(textOf(button.children as ReactNode)).toContain("Creating");
  });
});

describe("the parent field", () => {
  it("asks a task for a project, and says the empty case is the inbox", () => {
    const tree = render({ draft: draft({ kind: "task" }) });
    expect(byProp(tree, "id", "quick-create-parent")).toHaveLength(1);
    expect(textOf(tree)).toContain("filed in the inbox project");
  });

  it("asks a subtask for a task, with no inbox promise it cannot keep", () => {
    const tree = render({ draft: draft({ kind: "subtask", parent: "t-1" }) });
    expect(byProp(tree, "id", "quick-create-parent")).toHaveLength(1);
    expect(textOf(tree)).not.toContain("filed in the inbox project");
  });

  it("asks a project for no parent at all", () => {
    // `create_project`'s schema is `.strict()` and takes no parent field, so
    // offering one would be offering a refusal.
    const tree = render({ draft: draft({ kind: "project" }) });
    expect(byProp(tree, "id", "quick-create-parent")).toHaveLength(0);
  });

  it("blocks a subtask with no task named", () => {
    const tree = render({ draft: draft({ kind: "subtask", parent: "" }) });
    expect(textOf(tree)).toContain("must belong to a task");
  });
});

describe("handlers", () => {
  it("reports a typed title to its container", () => {
    const onChange = vi.fn();
    const tree = render({ onChange });
    const input = byId(tree, "quick-create-title").props as Record<string, unknown>;
    (input.onChange as (e: unknown) => void)({ target: { value: "A new title here" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ title: "A new title here" }));
  });

  it("clears the parent when the kind changes", () => {
    // A project id left in the field after switching to a subtask would be
    // sent as a `taskId` and refused with a confusing "not a task".
    const onChange = vi.fn();
    const tree = render({ draft: draft({ kind: "task", parent: "proj-1" }), onChange });
    const select = byId(tree, "quick-create-kind").props as Record<string, unknown>;
    (select.onChange as (e: unknown) => void)({ target: { value: "subtask" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "subtask", parent: "" }));
  });

  it("submits a valid draft and never navigates", () => {
    const onSubmit = vi.fn();
    const preventDefault = vi.fn();
    const form = findAllByType(render({ onSubmit }), "form")[0]!.props as Record<string, unknown>;
    (form.onSubmit as (e: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("refuses to submit an invalid draft even if the form is submitted directly", () => {
    // Enter in a text field submits a form regardless of the button's
    // disabled state, so the guard has to be on the handler too.
    const onSubmit = vi.fn();
    const form = findAllByType(render({ draft: draft({ title: "" }), onSubmit }), "form")[0]!
      .props as Record<string, unknown>;
    (form.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit twice while a create is in flight", () => {
    const onSubmit = vi.fn();
    const form = findAllByType(render({ submitting: true, onSubmit }), "form")[0]!.props as Record<
      string,
      unknown
    >;
    (form.onSubmit as (e: unknown) => void)({ preventDefault: vi.fn() });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on Escape from anywhere inside the dialog", () => {
    const onCancel = vi.fn();
    const tree = render({ onCancel });
    const backdrop = tree.props as Record<string, unknown>;
    (backdrop.onKeyDown as (e: unknown) => void)({
      key: "Escape",
      stopPropagation: vi.fn(),
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys, so typing does not close the dialog", () => {
    const onCancel = vi.fn();
    const backdrop = render({ onCancel }).props as Record<string, unknown>;
    (backdrop.onKeyDown as (e: unknown) => void)({ key: "e", stopPropagation: vi.fn() });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels from the cancel button", () => {
    const onCancel = vi.fn();
    const button = findAllByType(render({ onCancel }), "button").find(
      (b) => (b.props as Record<string, unknown>).type === "button",
    )!.props as Record<string, unknown>;
    (button.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a failed create's message as the service worded it", () => {
    const tree = render({ errorMessage: "No such project: proj-9." });
    expect(textOf(tree)).toContain("No such project: proj-9.");
  });
});
