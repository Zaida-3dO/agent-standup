// A repo, rendered.
//
// **Why this exists at all.** A repo was a bare `<span>` of muted text in
// five places (the board card, both list-view rows, the project card, the
// project header) and plain text inside a `ChipLink` on item detail — the
// same treatment as a timestamp. Area and repo are the two things a reader
// scans a board FOR, and rendering them as the quietest thing on the card
// is most of why the app read as an undifferentiated wall.
//
// **Why it reuses the area mechanism rather than inventing one.** A repo has
// exactly the properties that made hashing right for areas: unbounded,
// minted by agents at will, and needing a colour that is stable across
// sessions and machines with no storage. Writing a second hash here would
// be two implementations of one idea that could drift; `areaColour` is
// already general over "a name that needs a stable hue", so it is used
// directly. See `src/lib/design/area-colour.ts` for the reasoning about
// twelve buckets and why collisions are accepted.
//
// **Why it does not look identical to an AreaChip.** One vocabulary must
// mean one thing (docs/DESIGN-LANGUAGE.md §2), and an area and a repo
// sitting side by side in the same outlined pill would read as two members
// of one set — which is exactly the confusion that made the metadata row
// unscannable in the first place. They differ in SHAPE, not in colour
// rules: a repo takes the square-ish `--radius-sm` and a monospace label,
// because a repo name IS an identifier (the same class of string as a
// branch or a SHA, per `globals.css` §8) where an area is a human label.
// That distinction survives greyscale and colour blindness; two hues of
// pill would not.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { areaColour } from "@/lib/design/area-colour";
import styles from "./Chips.module.css";

export interface RepoChipProps {
  readonly repo: string;
}

export function RepoChip({ repo }: RepoChipProps) {
  const colour = areaColour(repo);

  return (
    <span
      className={`${styles.chip} ${styles.outlined} ${styles.repoChip}`}
      style={{ color: colour.fg, borderColor: colour.border }}
      data-repo={repo}
      data-variant="outlined"
      aria-label={`Repo: ${repo}`}
    >
      {/* The name always renders, for the reason `AreaChip` gives: twelve
          buckets over unbounded names means two repos will eventually share
          a hue, so the text is what identifies it and the colour only helps
          you find it again. */}
      <span aria-hidden="true">{repo}</span>
    </span>
  );
}
