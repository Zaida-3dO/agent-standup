"use client";

// The thin container: reads profile state/actions from context, holds the
// profile-create form's own state (T13 — the picker's inline create form),
// and hands everything to `AppShellView` as plain props. Kept deliberately
// thin on branching — see `AppShellView.tsx`'s header for why the picker's
// display logic lives there instead, where it's directly testable.
//
// **Why create-form state lives here and not in `ProfileProvider`.** The
// draft, the pending flag and the error are UI-only and specific to the one
// place a create form renders; putting them in the shared profile context
// would make every consumer of `useProfile()` (not just the shell) carry
// state that only this component ever reads. `choose` and `addPerson`
// (both already on the context) are enough to wire a freshly created
// profile in as active and visible — see `onCreateSubmit` below, and
// `addPerson`'s own header (`./state.ts`) for why landing it in `people`
// is a separate step from activating it.
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { createErrorMessage, createPerson } from "@/lib/profile/create";
import { AppShellView } from "./AppShellView";

export function AppShell({ children }: { children: ReactNode }) {
  const profile = useProfile();
  // Read here rather than in the view, so the view stays hook-free and
  // callable as a plain function in the DOM-free harness. `usePathname` can
  // return null before the router has resolved; `?? undefined` maps that to
  // "path unknown", which the view treats as gate-everything.
  const pathname = usePathname() ?? undefined;

  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const onToggleCreate = useCallback(() => {
    setCreateOpen((open) => !open);
    setCreateError(null);
  }, []);

  const onCreateSubmit = useCallback(() => {
    const displayName = createDraft.trim();
    if (displayName === "" || creating) return;
    setCreating(true);
    setCreateError(null);
    createPerson(displayName)
      .then((created) => {
        setCreating(false);
        setCreateDraft("");
        setCreateOpen(false);
        // T21 — lands the new row in `people` first, so the picker (which
        // reads `people` to decide what to render) never sees `choose`'s
        // activation before the profile it is activating exists in the
        // list. See `addPerson` (`ProfileProvider.tsx`/`state.ts`) for why
        // this appends rather than refetching.
        profile.addPerson(created);
        // Activates the person just created — see the module header on why
        // this reuses `choose` rather than the shell tracking its own
        // "who's active" state a second time.
        profile.choose(created);
      })
      .catch((err: unknown) => {
        setCreating(false);
        setCreateError(createErrorMessage(err));
      });
  }, [createDraft, creating, profile]);

  return (
    <AppShellView
      {...profile}
      pathname={pathname}
      createOpen={createOpen}
      createDraft={createDraft}
      creating={creating}
      createError={createError}
      onToggleCreate={onToggleCreate}
      onCreateDraftChange={setCreateDraft}
      onCreateSubmit={onCreateSubmit}
    >
      {children}
    </AppShellView>
  );
}
