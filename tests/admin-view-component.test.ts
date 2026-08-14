// src/components/admin/* — the branch selection and field rendering for
// MILESTONES.md #93.
//
// Hook-free and prop-driven (see each component's header), so they are
// called directly as functions and their returned element trees inspected —
// same technique as tests/board-view-component.test.ts.
//
// The point these tests defend is that **one component set renders every
// kind**: the assertions below run the same view over several kinds and
// check that what differs is exactly what the descriptor says differs.
import { describe, expect, it, vi } from "vitest";
import { AdminView, CREATE_ERROR_KEY, type AdminViewProps } from "@/components/admin/AdminView";
import { AdminRow } from "@/components/admin/AdminRow";
import { AdminField } from "@/components/admin/AdminField";
import { ADMIN_KINDS, adminKindBySlug, type AdminKind } from "@/lib/admin/kinds";
import { findAllByType, walk } from "./helpers/react-element";

const repos = adminKindBySlug("repos")!;
const machines = adminKindBySlug("machines")!;
const accounts = adminKindBySlug("accounts")!;
const people = adminKindBySlug("people")!;

function baseProps(overrides: Partial<AdminViewProps> = {}): AdminViewProps {
  return {
    kind: repos,
    loadState: { status: "loaded", rows: [] },
    includeArchived: false,
    expandedId: null,
    drafts: {},
    inheriting: {},
    errors: {},
    createOpen: false,
    createDrafts: {},
    onToggleArchivedFilter: () => {},
    onToggleRow: () => {},
    onDraftChange: () => {},
    onInheritChange: () => {},
    onSave: () => {},
    onArchive: () => {},
    onToggleCreate: () => {},
    onCreateDraftChange: () => {},
    onCreate: () => {},
    ...overrides,
  };
}

/**
 * Every string of text anywhere in the tree, joined and with runs of
 * whitespace collapsed.
 *
 * The collapse matters: JSX splits a sentence containing an interpolation
 * into several string children (`"No "`, `"repositories"`, `" yet."`), so a
 * naive join inserts spaces that no reader would ever see and a `toContain`
 * for the rendered sentence fails against text that is on screen exactly as
 * written.
 */
function textOf(element: unknown): string {
  const parts: string[] = [];
  for (const node of walk(element as never)) {
    const children = (node.props as { children?: unknown }).children;
    const collect = (value: unknown): void => {
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
    };
    collect(children);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function buttonLabels(element: unknown): string[] {
  return [...walk(element as never)]
    .filter((node) => node.type === "button")
    .map((node) => {
      const children = (node.props as { children?: unknown }).children;
      return Array.isArray(children)
        ? children.filter((c) => typeof c === "string").join("")
        : String(children);
    });
}

describe("the kind tabs", () => {
  it("offers one tab per kind, whichever kind is being shown", () => {
    for (const kind of ADMIN_KINDS) {
      const element = AdminView(baseProps({ kind }));
      const text = textOf(element);
      for (const other of ADMIN_KINDS) {
        expect(text, `${kind.slug} showing ${other.title}`).toContain(other.title);
      }
    }
  });

  it("links back to the settings page, which #86 links here from", () => {
    expect(textOf(AdminView(baseProps()))).toContain("Settings");
  });
});

describe("the load branches", () => {
  it("shows the error message when the load failed", () => {
    const element = AdminView(
      baseProps({ loadState: { status: "error", message: "could not load" } }),
    );
    expect(textOf(element)).toContain("could not load");
    expect(findAllByType(element, AdminRow).length).toBe(0);
  });

  it("shows a loading state before the rows arrive", () => {
    const element = AdminView(baseProps({ loadState: { status: "loading" } }));
    expect(textOf(element)).toContain("Loading");
    expect(findAllByType(element, AdminRow).length).toBe(0);
  });

  it("says so plainly when a kind has no rows", () => {
    expect(textOf(AdminView(baseProps()))).toContain("No repositories yet.");
  });

  it("renders one row component per row", () => {
    const element = AdminView(
      baseProps({
        loadState: { status: "loaded", rows: [{ id: "web" }, { id: "infra" }] },
      }),
    );
    expect(findAllByType(element, AdminRow).length).toBe(2);
  });

  it("keys a row by the id field the kind names, not by a hardcoded id", () => {
    // Machines are identified by `name`, everything else by `id`; a view
    // that assumed `id` would key every machine row on the empty string and
    // expand them all together. Asserted on the rendered `AdminRow`'s own
    // output rather than on the view's text, because the view holds the row
    // as an unrendered component reference.
    const element = AdminView(
      baseProps({
        kind: machines,
        expandedId: "desktop",
        loadState: { status: "loaded", rows: [{ name: "desktop" }] },
      }),
    );
    const row = findAllByType(element, AdminRow)[0]!;
    // The view decided this row is the expanded one, which it can only do by
    // reading `name` — with `id` assumed, the computed id would be "".
    expect((row.props as { expanded: boolean }).expanded).toBe(true);
    expect(textOf(AdminRow(row.props as Parameters<typeof AdminRow>[0]))).toContain("desktop");
  });
});

describe("what each kind offers", () => {
  it("offers a create button for a kind that can be created", () => {
    expect(buttonLabels(AdminView(baseProps({ kind: repos }))).join(" ")).toContain(
      "New repository",
    );
  });

  it("offers no create button for a machine, which registers itself", () => {
    expect(buttonLabels(AdminView(baseProps({ kind: machines }))).join(" ")).not.toContain("New ");
  });

  it("offers no create button for a person", () => {
    expect(buttonLabels(AdminView(baseProps({ kind: people }))).join(" ")).not.toContain("New ");
  });

  it("offers the show-archived filter only where archiving exists", () => {
    expect(textOf(AdminView(baseProps({ kind: repos })))).toContain("Show archived");
    expect(textOf(AdminView(baseProps({ kind: accounts })))).not.toContain("Show archived");
  });

  it("shows the kind's own explanation", () => {
    expect(textOf(AdminView(baseProps({ kind: repos })))).toContain(repos.blurb);
    expect(textOf(AdminView(baseProps({ kind: machines })))).toContain(machines.blurb);
  });
});

describe("the create form", () => {
  it("is hidden until opened", () => {
    expect(buttonLabels(AdminView(baseProps())).join(" ")).not.toContain("Create repository");
  });

  it("offers the identifier, which the row editor does not", () => {
    const element = AdminView(baseProps({ createOpen: true }));
    const fields = findAllByType(element, AdminField);
    const names = fields.map((node) => (node.props as { field: { name: string } }).field.name);
    expect(names).toContain("id");
  });

  it("makes the identifier editable in the create form specifically", () => {
    // It is `readOnly` in the descriptor because it cannot be *changed*;
    // creating is where it is set.
    const element = AdminView(baseProps({ createOpen: true }));
    const idField = findAllByType(element, AdminField).find(
      (node) => (node.props as { field: { name: string } }).field.name === "id",
    );
    expect((idField!.props as { field: { readOnly?: boolean } }).field.readOnly).toBeFalsy();
  });

  it("shows the create form's own error, keyed apart from every row", () => {
    const element = AdminView(
      baseProps({ createOpen: true, errors: { [CREATE_ERROR_KEY]: "id is required" } }),
    );
    expect(textOf(element)).toContain("id is required");
  });

  it("calls back when create is pressed", () => {
    const onCreate = vi.fn();
    const element = AdminView(baseProps({ createOpen: true, onCreate }));
    const create = [...walk(element as never)].find(
      (node) =>
        node.type === "button" &&
        String((node.props as { children?: unknown }).children).includes("Create"),
    );
    (create!.props as { onClick: () => void }).onClick();
    expect(onCreate).toHaveBeenCalled();
  });
});

describe("one row", () => {
  function rowElement(
    kind: AdminKind,
    row: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    return AdminRow({
      kind,
      row,
      expanded: false,
      drafts: {},
      inheriting: {},
      onToggle: () => {},
      onDraftChange: () => {},
      onInheritChange: () => {},
      onSave: () => {},
      onArchive: () => {},
      ...extra,
    } as Parameters<typeof AdminRow>[0]);
  }

  it("shows an override badge saying which state the row is in", () => {
    // SCHEMA.md §23.2: "Each row shows whether it carries an override or is
    // inheriting the setting."
    const inheriting = rowElement(machines, { name: "desktop", sourceGlobs: null });
    expect(textOf(inheriting)).toContain("Inheriting");

    const overridden = rowElement(machines, { name: "desktop", sourceGlobs: ["a/**"] });
    expect(textOf(overridden)).toContain("Override");
  });

  it("says Override for an EMPTY override, not Inheriting", () => {
    const element = rowElement(machines, { name: "desktop", sourceGlobs: [] });
    expect(textOf(element)).toContain("Override");
  });

  it("marks an archived row and offers to un-archive it", () => {
    const element = rowElement(repos, { id: "web", archivedAt: "2026-01-01T00:00:00.000Z" });
    expect(textOf(element)).toContain("Archived");
    expect(buttonLabels(element).join(" ")).toContain("Un-archive");
  });

  it("offers to archive a live row", () => {
    expect(buttonLabels(rowElement(repos, { id: "web", archivedAt: null })).join(" ")).toContain(
      "Archive",
    );
  });

  it("offers no archive control for a kind that cannot be archived", () => {
    expect(buttonLabels(rowElement(accounts, { id: "a" })).join(" ")).not.toContain("Archive");
  });

  it("shows no editor until it is expanded", () => {
    expect(findAllByType(rowElement(repos, { id: "web" }), AdminField).length).toBe(0);
  });

  it("shows one editor per editable field when expanded, and none for read-only ones", () => {
    const element = rowElement(repos, { id: "web" }, { expanded: true });
    const names = findAllByType(element, AdminField).map(
      (node) => (node.props as { field: { name: string } }).field.name,
    );
    expect(names).not.toContain("id");
    expect(names).toContain("displayName");
    expect(names).toContain("defaultBranch");
  });

  it("starts an untouched override field in whichever state the row is already in", () => {
    // Otherwise opening the editor and saving without changing anything
    // would flip an override off.
    const overridden = rowElement(
      machines,
      { name: "desktop", sourceGlobs: ["a/**"] },
      { expanded: true },
    );
    const field = findAllByType(overridden, AdminField).find(
      (node) => (node.props as { field: { name: string } }).field.name === "sourceGlobs",
    );
    expect((field!.props as { inheriting: boolean }).inheriting).toBe(false);

    const inheriting = rowElement(
      machines,
      { name: "desktop", sourceGlobs: null },
      { expanded: true },
    );
    const field2 = findAllByType(inheriting, AdminField).find(
      (node) => (node.props as { field: { name: string } }).field.name === "sourceGlobs",
    );
    expect((field2!.props as { inheriting: boolean }).inheriting).toBe(true);
  });

  it("calls back with the row id when save and archive are pressed", () => {
    const onSave = vi.fn();
    const onArchive = vi.fn();
    const element = rowElement(
      repos,
      { id: "web", archivedAt: null },
      { expanded: true, onSave, onArchive },
    );
    for (const button of [...walk(element as never)].filter((node) => node.type === "button")) {
      (button.props as { onClick: () => void }).onClick();
    }
    expect(onSave).toHaveBeenCalledWith("web");
    expect(onArchive).toHaveBeenCalledWith("web", true);
  });

  it("shows a per-row error message", () => {
    expect(textOf(rowElement(repos, { id: "web" }, { error: "Unknown vendor." }))).toContain(
      "Unknown vendor.",
    );
  });
});

describe("one field, drawn from its declared kind", () => {
  function field(name: string, kind = repos, extra: Record<string, unknown> = {}) {
    const descriptor = kind.fields.find((f) => f.name === name)!;
    return AdminField({
      field: descriptor,
      stored: "",
      inheriting: false,
      onChange: () => {},
      onInheritChange: () => {},
      ...extra,
    } as Parameters<typeof AdminField>[0]);
  }

  it("renders a text field as a text input", () => {
    const inputs = [...walk(field("displayName") as never)].filter((node) => node.type === "input");
    expect(inputs.some((node) => (node.props as { type?: string }).type === "text")).toBe(true);
  });

  it("renders a boolean as a two-option select", () => {
    const options = [...walk(field("needsVisualReview") as never)]
      .filter((node) => node.type === "option")
      .map((node) => (node.props as { value: string }).value);
    expect(options).toEqual(["true", "false"]);
  });

  it("renders an enum with exactly its declared options", () => {
    const options = [...walk(field("planType", accounts) as never)]
      .filter((node) => node.type === "option")
      .map((node) => (node.props as { value: string }).value);
    expect(options).toEqual(["subscription", "metered"]);
  });

  it("renders a list as a textarea", () => {
    const element = field("sourceGlobs", machines);
    expect([...walk(element as never)].some((node) => node.type === "textarea")).toBe(true);
  });

  it("shows a read-only field as a value, with no input to type into", () => {
    const element = field("name", machines);
    const editable = [...walk(element as never)].filter(
      (node) => node.type === "input" || node.type === "textarea" || node.type === "select",
    );
    expect(editable.length).toBe(0);
  });

  it("offers inheriting as its own control for an override field", () => {
    // An empty box means an empty *value*; inheriting is a different
    // instruction and needs its own way to say so.
    const element = field("sourceGlobs", machines);
    const checkbox = [...walk(element as never)].find(
      (node) => node.type === "input" && (node.props as { type?: string }).type === "checkbox",
    );
    expect(checkbox).toBeDefined();
    expect(textOf(element)).toContain("minting.source_globs");
  });

  it("hides the value editor while a field is set to inherit", () => {
    const element = field("sourceGlobs", machines, { inheriting: true });
    expect([...walk(element as never)].some((node) => node.type === "textarea")).toBe(false);
  });

  it("shows the field's help text", () => {
    const descriptor = repos.fields.find((f) => f.name === "defaultBranch")!;
    expect(textOf(field("defaultBranch"))).toContain(descriptor.help);
  });

  it("prefers the draft over the stored value once something is typed", () => {
    const element = field("displayName", repos, { stored: "Web", draft: "Website" });
    const input = [...walk(element as never)].find((node) => node.type === "input");
    expect((input!.props as { value: string }).value).toBe("Website");
  });
});
