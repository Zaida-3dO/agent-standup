"use client";

// The thin container: reads profile state/actions from context and hands
// them to `AppShellView` as plain props. Kept deliberately empty of
// conditionals — see `AppShellView.tsx`'s header for why the branching
// logic lives there instead, where it's directly testable.
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useProfile } from "@/lib/profile/ProfileProvider";
import { AppShellView } from "./AppShellView";

export function AppShell({ children }: { children: ReactNode }) {
  const profile = useProfile();
  // Read here rather than in the view, so the view stays hook-free and
  // callable as a plain function in the DOM-free harness. `usePathname` can
  // return null before the router has resolved; `?? undefined` maps that to
  // "path unknown", which the view treats as gate-everything.
  const pathname = usePathname() ?? undefined;
  return (
    <AppShellView {...profile} pathname={pathname}>
      {children}
    </AppShellView>
  );
}
