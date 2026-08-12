import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ProfileProvider } from "@/lib/profile/ProfileProvider";
import { AppShell } from "@/components/app-shell/AppShell";

export const metadata: Metadata = {
  title: "Agent Standup",
  description: "A task tracker for AI coding agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ProfileProvider>
          <AppShell>{children}</AppShell>
        </ProfileProvider>
      </body>
    </html>
  );
}
