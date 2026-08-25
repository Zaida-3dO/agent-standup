// The dismiss-control vocabulary, pinned as a test because the defect it
// guards is a *word* rather than a behaviour — and a word is the one kind of
// regression that no behavioural test in this suite can see. Every assertion
// below still passes if a label is changed back, unless something asserts the
// label itself. That is what this file is.
//
// ── The collision ───────────────────────────────────────────────────────
//
// The item detail panel carries **"Cancel this work"** — a recorded decision
// that work is not being done, written to the ledger and shown on the row
// afterwards. It also carried, a few hundred pixels away, an archive form
// whose dismiss button said **"Cancel"** and whose entire effect was closing
// a form.
//
// Same word, one view, opposite consequences — on the one screen whose job is
// teaching that archiving and cancelling are different things. The crew that
// built the cancel path (PR #286) renamed the *cancel* form's own dismiss
// button to "Keep it open" and left the rest, which is how this row exists.
//
// ── The convention these tests encode ───────────────────────────────────
//
// **A dismiss control names what the thing will still be afterwards; it never
// borrows the verb of a neighbouring recorded act.**
//
//   - "Keep it" / "Keep it open" — the row survives untouched.
//   - "Discard draft" / "Discard edit" — nothing was created or saved, so the
//     honest description is what is thrown away.
//   - "Leave it with them" — the assignment stays where it is.
//   - "Close …" — a pure overlay dismissal with no pending state at all.
//
// The rule that actually matters, and the one asserted hardest below, is the
// negative: **no dismiss control anywhere may be labelled with a bare
// "Cancel"**, because `cancel_item` is a real operation in this product and
// "Cancel this work" is a real button. A reader cannot be asked to infer
// which meaning is in play from context.
import { describe, expect, it } from "vitest";
import { ArchiveAction } from "@/components/item-detail/ArchiveAction";
import { CancelAction } from "@/components/item-detail/CancelAction";
import { InlineEditField } from "@/components/item-detail/InlineEditField";
import { TakeoverDialog } from "@/components/fleet/TakeoverDialog";
import { ProfilePicker } from "@/components/profile-picker/ProfilePicker";
import type { ReactElement } from "react";
import type { FleetAssignment } from "@/lib/fleet/types";

/**
 * Every rendered element of a given type, found by walking the tree the
 * component returned.
 *
 * The same shape `tests/profile-picker.test.ts` uses, and for the same
 * reason: this repo's harness is `environment: "node"` with no DOM, so a
 * hook-free presentational component is called as a plain function and its
 * returned tree inspected directly.
 */
function findAllByType(node: unknown, type: string): ReactElement[] {
  const found: ReactElement[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (current === null || typeof current !== "object") return;
    const element = current as ReactElement & { props?: Record<string, unknown> };
    if (element.type === type) found.push(element);
    const props = element.props;
    if (props && "children" in props) visit(props.children);
  };
  visit(node);
  return found;
}

/** The visible text of every `<button>` in the tree, as a reader meets them. */
function buttonLabels(node: unknown): string[] {
  return findAllByType(node, "button")
    .map((button) => {
      const children = (button.props as { children?: unknown }).children;
      // A label may be a bare string or an array of fragments; only the
      // string parts are what a person reads.
      const parts = Array.isArray(children) ? children : [children];
      return parts
        .filter((part): part is string => typeof part === "string")
        .join("")
        .trim();
    })
    .filter((label) => label !== "");
}

/** Accessible names, for controls whose visible content is an icon like "×". */
function buttonAriaLabels(node: unknown): string[] {
  return findAllByType(node, "button")
    .map((button) => (button.props as { "aria-label"?: string })["aria-label"])
    .filter((label): label is string => typeof label === "string");
}

const archiveProps = {
  archived: false,
  archivedReason: null,
  supersededById: null,
  state: { status: "composing" as const, reason: "a".repeat(30) },
  onBeginArchive: () => {},
  onCancel: () => {},
  onReasonChange: () => {},
  onArchive: () => {},
  onRestore: () => {},
  onAcknowledge: () => {},
};

const cancelProps = {
  // Open, not already closed — the only case in which the cancel form (and
  // therefore its dismiss button) renders at all.
  alreadyClosed: false,
  state: "executing",
  cancelState: { status: "composing" as const, decision: "a".repeat(30) },
  onBegin: () => {},
  onDecisionChange: () => {},
  onCancelItem: () => {},
  onDismiss: () => {},
};

describe("the archive form's dismiss control does not borrow the cancel verb", () => {
  it('labels it "Keep it" rather than "Cancel"', () => {
    const labels = buttonLabels(ArchiveAction(archiveProps));

    // The positive: it says what the item will still be.
    expect(labels).toContain("Keep it");
    // The negative, which is the actual acceptance criterion — a bare
    // "Cancel" beside "Cancel this work" is the defect.
    expect(labels).not.toContain("Cancel");
  });

  it("still offers the archive act itself, so the rename did not remove a control", () => {
    // Guards the lazy way to make the assertion above pass: deleting the
    // button. The form must still be able to archive and to be dismissed.
    const labels = buttonLabels(ArchiveAction(archiveProps));
    expect(labels).toContain("Archive this item");
    expect(labels).toHaveLength(2);
  });
});

describe("archiving and cancelling read as different acts on the same panel", () => {
  it("the two panels share no label between them", () => {
    // The point of the whole row: these two components render side by side,
    // and every word on one must mean something different from every word on
    // the other. An overlap is the collision returning in a new place.
    const archiveLabels = buttonLabels(ArchiveAction(archiveProps));
    const cancelLabels = buttonLabels(CancelAction(cancelProps));

    const shared = archiveLabels.filter((label) => cancelLabels.includes(label));
    expect(shared).toEqual([]);
  });

  it("the cancel panel keeps its recorded act and its own dismiss wording", () => {
    const labels = buttonLabels(CancelAction(cancelProps));
    // "Cancel this work" is the recorded act and MUST keep saying cancel —
    // it is the thing the word properly belongs to. Renaming this instead of
    // the dismiss buttons would be the wrong fix.
    expect(labels).toContain("Cancel this work");
    expect(labels).toContain("Keep it open");
  });
});

describe("dismiss controls elsewhere do not say Cancel either", () => {
  it("the inline field editor discards an edit rather than cancelling", () => {
    // Renders on the item detail page, the same view as "Cancel this work".
    const labels = buttonLabels(
      InlineEditField({
        label: "Title",
        value: "A title",
        kind: "text",
        editing: true,
        draft: "A title",
        onDraftChange: () => {},
        onSave: () => {},
        onCancel: () => {},
      }),
    );

    expect(labels).toContain("Discard edit");
    expect(labels).not.toContain("Cancel");
  });

  it("the takeover dialog names what happens to the assignment", () => {
    const labels = buttonLabels(
      TakeoverDialog({
        // Only the two fields this dialog's prose reads. The full
        // `FleetAssignment` is seventeen fields describing a live claim, and
        // spelling them out here would be noise that says nothing about
        // labels — the cast is narrowed to this fixture alone.
        assignment: {
          itemTitle: "A tracked item",
          displayName: "someone",
        } as unknown as FleetAssignment,
        reason: "",
        submitting: false,
        errorMessage: null,
        onReasonChange: () => {},
        onCancel: () => {},
        onConfirm: () => {},
      }),
    );

    expect(labels).toContain("Leave it with them");
    expect(labels).not.toContain("Cancel");
  });

  it("the profile picker's close affordance is named Close, not Cancel", () => {
    // An icon button, so the assertion is on its accessible name — which is
    // the only label a screen-reader user gets. It said "Cancel", announcing
    // a cancellation that does not happen.
    const element = ProfilePicker({
      people: [{ id: "p1", displayName: "A", avatar: null, colour: null }],
      activeProfileId: null,
      createOpen: false,
      createDraft: "",
      creating: false,
      createError: null,
      onChoose: () => {},
      // Present, because the close affordance only renders in the
      // dismissable "switch" form of the picker.
      onClose: () => {},
      onToggleCreate: () => {},
      onCreateDraftChange: () => {},
      onCreateSubmit: () => {},
    });

    const ariaLabels = buttonAriaLabels(element);
    expect(ariaLabels).toContain("Close profile picker");
    expect(ariaLabels).not.toContain("Cancel");
  });
});
