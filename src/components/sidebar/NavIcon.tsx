// The string-to-icon map.
//
// `@/lib/nav/routes` names an icon as a string so it can stay React-free
// and testable as plain data; this is the one place that turns those names
// into components. Keeping the map here rather than in the route list is
// what lets the route list be imported by a module that must not pull a
// component library into its import graph.
//
// Hook-free, so `tests/sidebar-nav.test.ts` can walk a rendered nav tree
// without a DOM.
import {
  Activity,
  Banknote,
  CircleAlert,
  Columns3,
  Cpu,
  FolderKanban,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from "lucide-react";

const ICONS: Readonly<Record<string, LucideIcon>> = {
  "layout-dashboard": LayoutDashboard,
  "folder-kanban": FolderKanban,
  "columns-3": Columns3,
  "circle-alert": CircleAlert,
  cpu: Cpu,
  activity: Activity,
  banknote: Banknote,
  settings: Settings,
};

export interface NavIconProps {
  readonly name: string;
}

/**
 * Renders the named icon, or nothing for a name with no mapping.
 *
 * Nothing rather than a fallback glyph: a stand-in icon in a nav rail reads
 * as a real destination with a real (if odd) meaning, whereas a missing one
 * leaves the label carrying the whole message, which it can. Every name in
 * `NAV_ROUTES` is asserted to have a mapping, so an unmapped name means
 * someone added a route and this failed to notice — a caught mistake, not a
 * rendered one.
 */
export function NavIcon({ name }: NavIconProps) {
  const Icon = ICONS[name];
  if (Icon === undefined) return null;
  // Decorative: every icon here sits beside its own text label, so
  // announcing it would read the destination twice.
  return <Icon size={16} aria-hidden="true" />;
}

/** Exposed so a test can assert every declared route name resolves. */
export function hasIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}
