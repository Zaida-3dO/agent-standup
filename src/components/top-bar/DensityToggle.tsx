// The density switch.
//
// A two-state toggle rather than a select: there are exactly two densities
// and there is no third coming, so a menu would be two clicks to do what
// one does. It reports its state through `aria-pressed`, which is what
// makes "which one am I in" answerable without seeing the icon.
//
// Hook-free and prop-driven — the persisted value and the class on `<html>`
// are `DensityShell`'s job.
import { Rows2, Rows3 } from "lucide-react";
import type { Density } from "@/lib/nav/density";
import styles from "./TopBar.module.css";

export interface DensityToggleProps {
  readonly density: Density;
  readonly onToggle: () => void;
}

export function DensityToggle({ density, onToggle }: DensityToggleProps) {
  const compact = density === "compact";
  const Icon = compact ? Rows3 : Rows2;
  return (
    <button
      type="button"
      className={styles.densityButton}
      onClick={onToggle}
      aria-pressed={compact}
      // Names the state it is IN, not the one it switches to. A button
      // labelled with its destination and pressed-state with its origin
      // contradicts itself out loud on every screen reader.
      aria-label={`Compact density (${compact ? "on" : "off"})`}
      title={compact ? "Switch to comfortable density" : "Switch to compact density"}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
