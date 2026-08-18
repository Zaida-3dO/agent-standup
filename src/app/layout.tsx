import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ProfileProvider } from "@/lib/profile/ProfileProvider";
import { AppShell } from "@/components/app-shell/AppShell";
// The design system. Imported here and nowhere else — this is the only
// place in the app that loads a global stylesheet, so every token below is
// available to every component's CSS module without any of them importing
// it. Before this, the layout imported no stylesheet at all and each module
// carried its own hex literals.
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Standup",
  description: "A task tracker for AI coding agents.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `dark` is set here rather than left to a media query or a script.
    //
    // Dark is this product's default — it is a tool read on a dark screen —
    // but "default" now means "the class on <html> happens to say dark",
    // not "dark is the only thing that exists". `globals.css` declares a
    // full `.light` token set, so a future preference toggle changes this
    // one attribute and nothing else.
    //
    // Deliberately NOT `prefers-color-scheme`: honouring the OS setting
    // would flip an unfinished light theme on for anyone whose machine is
    // in light mode, on a surface nobody has looked at yet. Opting in is
    // the honest default until a toggle ships.
    //
    // The Geist variables are attached here too, so the font tokens in
    // `globals.css` (`--font-geist-sans`, `--font-geist-mono`) resolve for
    // the whole tree.
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <ProfileProvider>
          <AppShell>{children}</AppShell>
        </ProfileProvider>
      </body>
    </html>
  );
}
