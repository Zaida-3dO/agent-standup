"use client";

// The thin container: reads profile state/actions from context and hands
// them to `AppShellView` as plain props. Kept deliberately empty of
// conditionals — see `AppShellView.tsx`'s header for why the branching
// logic lives there instead, where it's directly testable.
import type { ReactNode } from "react";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { AppShellView } from "./AppShellView";

export function AppShell({ children }: { children: ReactNode }) {
  const profile = useProfile();
  return <AppShellView {...profile}>{children}</AppShellView>;
}
