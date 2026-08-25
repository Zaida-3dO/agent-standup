// The palette's public surface.
//
// `PaletteHost` is what `AppShell` mounts; `usePalette` is how every other
// surface opens an overlay without importing one. The two views are
// exported for their own tests and for anyone rendering them outside the
// host — ordinary callers should not need them, which is the same division
// `@/components/toast` draws for the undo toast.
export { PaletteHost, usePalette, type PaletteApi } from "./PaletteHost";
export { CommandPalette, type CommandPaletteProps } from "./CommandPalette";
export { ShortcutHelp, type ShortcutHelpProps } from "./ShortcutHelp";
