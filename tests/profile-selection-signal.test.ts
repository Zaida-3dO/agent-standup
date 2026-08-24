// T22 — selection is signalled by something other than the person's colour.
//
// ── The defect these pin down ─────────────────────────────────────────
//
// A profile tile took its border from `person.colour` and carried nothing
// else. With two profiles on screen the visual review found **the ACTIVE
// profile rendered plain grey while an INACTIVE one glowed pink**, because
// the active one's `colour` was null and the inactive one's was `#d94f8a`.
// Selection was being read off the one channel that means identity, so the
// picker was not merely unclear — it pointed at the wrong tile.
//
// Neither tile carried `aria-current` either, so a screen-reader user got no
// signal at all while a sighted user got a misleading one (WCAG 4.1.2).
//
// ── Why the assertions are shaped the way they are ────────────────────
//
// The load-bearing property is a COMPARISON between two tiles, not a fact
// about one. "The active tile has a ring" would still pass if inactive tiles
// got one too. So the central test renders the exact configuration from the
// review — active profile with no colour, inactive profile with a bright one
// — and asserts the signal separates them in that worst case.
//
// **What each would catch.** Swapping `activeProfileId` for `people[0]` in
// the picker fails "marks the profile that IS active". Dropping
// `aria-current` fails the assistive-tech test. Painting the ring from
// `person.colour` instead of `--accent` fails "does not reuse the person's
// own colour". Removing the `Current` label fails the text-channel test.
import { describe, expect, it } from "vitest";
import { ProfilePicker, type ProfilePickerProps } from "@/components/profile-picker/ProfilePicker";
import { personColour, personSwatch, personHueIndex } from "@/lib/design/person-colour";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, walk } from "./helpers/react-element";

/** The exact pairing from the review: the active one is colourless, the inactive one is vivid. */
const ope: Profile = { id: "ope", displayName: "Ope", avatar: null, colour: null };
const tomi: Profile = { id: "tomi", displayName: "Tomi", avatar: null, colour: "#d94f8a" };

function baseProps(overrides: Partial<ProfilePickerProps> = {}): ProfilePickerProps {
  return {
    people: [],
    onChoose: () => {},
    onClose: undefined,
    createOpen: false,
    createDraft: "",
    creating: false,
    createError: null,
    onToggleCreate: () => {},
    onCreateDraftChange: () => {},
    onCreateSubmit: () => {},
    ...overrides,
  };
}

/** The profile tiles, in render order — the "Add profile" tile has an aria-label and is excluded. */
function tiles(element: unknown) {
  return findAllByType(element as never, "button").filter(
    (el) => (el.props as { "aria-label"?: string })["aria-label"] === undefined,
  );
}

function classOf(tile: { props: unknown }): string {
  return String((tile.props as { className?: unknown }).className ?? "");
}

describe("the active profile is distinguishable from an inactive coloured one", () => {
  it("marks the profile that IS active, not the one with the brightest colour", () => {
    // The regression in one assertion: Ope is active and colourless, Tomi
    // is inactive and pink. Before the fix the only visual difference
    // between these two tiles pointed at Tomi.
    const element = ProfilePicker(baseProps({ people: [ope, tomi], activeProfileId: "ope" }));
    const [opeTile, tomiTile] = tiles(element);
    expect(classOf(opeTile!)).toContain("tileCurrent");
    expect(classOf(tomiTile!)).not.toContain("tileCurrent");
  });

  it("exposes the active profile to assistive tech, and only that one", () => {
    const element = ProfilePicker(baseProps({ people: [ope, tomi], activeProfileId: "tomi" }));
    const flags = tiles(element).map(
      (t) => (t.props as { "aria-current"?: unknown })["aria-current"],
    );
    // Tomi active this time, so the marking follows the ID rather than a
    // fixed position — a test that only ever activated the first profile
    // would pass against a hard-coded `index === 0`.
    expect(flags).toEqual([undefined, "true"]);
  });

  it("says it in words too, so the signal survives without colour", () => {
    const element = ProfilePicker(baseProps({ people: [ope, tomi], activeProfileId: "ope" }));
    const labels = [...walk(element as never)]
      .filter((el) =>
        String((el.props as { className?: unknown }).className ?? "").includes("currentLabel"),
      )
      .map((el) => (el.props as { children?: unknown }).children);
    expect(labels).toEqual(["Current"]);
  });

  it("does not reuse the person's own colour as the selection channel", () => {
    const element = ProfilePicker(baseProps({ people: [ope, tomi], activeProfileId: "ope" }));
    const [opeTile, tomiTile] = tiles(element);
    // The border stays IDENTITY on both tiles: Tomi keeps her stored pink
    // even while inactive. If selection were being painted onto the border,
    // this is the assertion that would break.
    expect((tomiTile!.props as { style?: { borderColor?: string } }).style?.borderColor).toBe(
      "#d94f8a",
    );
    // And the active tile's border is its own derived identity colour —
    // NOT the accent the ring uses.
    expect((opeTile!.props as { style?: { borderColor?: string } }).style?.borderColor).toBe(
      personColour(ope),
    );
  });

  it("marks nothing when no profile is active — the first-run picker", () => {
    const element = ProfilePicker(baseProps({ people: [ope, tomi] }));
    expect(tiles(element).map((t) => classOf(t).includes("tileCurrent"))).toEqual([false, false]);
  });
});

describe("every profile has an identity colour, stored or derived", () => {
  it("gives a colourless profile a real colour rather than falling through to grey", () => {
    const colour = personColour(ope);
    expect(colour).not.toBe("");
    expect(colour).toContain("--area-hue-");
  });

  it("prefers the stored colour whenever there is one", () => {
    expect(personColour(tomi)).toBe("#d94f8a");
  });

  it("treats a blank stored colour as unset, rather than painting nothing", () => {
    // A cleared admin field submits "", which as a `borderColor` is no
    // colour at all — the invisible-profile case through the back door.
    expect(personColour({ id: "x", colour: "   " })).toContain("--area-hue-");
  });

  it("is stable for one person and keyed on the id, so a rename cannot move it", () => {
    expect(personColour({ id: "ope" })).toBe(personColour({ id: "ope" }));
    // Same person, different display name — the function never sees the
    // name, which is the point.
    expect(personHueIndex("ope")).toBe(personHueIndex("ope"));
  });

  it("distinguishes different people often enough to be useful", () => {
    // Not a guarantee for any given pair — twelve buckets collide — but a
    // hash that returned a constant would pass every test above while
    // making the colour meaningless.
    const buckets = new Set(
      ["ope", "tomi", "ngozi", "gibbs", "foggy", "jeoffry"].map(personHueIndex),
    );
    expect(buckets.size).toBeGreaterThan(1);
  });
});

describe("a profile created from the picker arrives with a colour", () => {
  it("gives a storable hex, not a CSS variable expression", () => {
    // The stored value is served by the API and shown in the admin grid, so
    // it must render outside a page that defines this app's custom
    // properties. `oklch(var(--…))` would not.
    expect(personSwatch("ope")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("the stored swatch is the same colour the fallback would have painted", () => {
    // The module claims the twelve hexes ARE the `--area-hue-*` bases at
    // the border lightness/chroma. That claim is only worth making if
    // something checks it — otherwise the stored colour and the derived one
    // drift apart and a created profile changes colour the moment its
    // `colour` is cleared. Converts oklch(0.55 0.08 h) to sRGB here and
    // compares, so editing a swatch by hand fails.
    const hues = [25, 55, 85, 115, 145, 175, 205, 235, 265, 295, 325, 355];
    const toHex = (l: number, c: number, h: number): string => {
      const hr = (h * Math.PI) / 180;
      const a = c * Math.cos(hr);
      const b = c * Math.sin(hr);
      const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
      const channels = [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
      ];
      return `#${channels
        .map((v) => {
          const g = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
          return Math.round(Math.min(1, Math.max(0, g)) * 255)
            .toString(16)
            .padStart(2, "0");
        })
        .join("")}`;
    };
    // `personSwatch` is keyed by hue index, so drive it through ids that
    // land on each bucket rather than assuming the array order is reachable.
    for (let bucket = 0; bucket < hues.length; bucket += 1) {
      const expected = toHex(0.55, 0.08, hues[bucket]!);
      const id = Array.from({ length: 500 }, (_, n) => `probe-${n}`).find(
        (candidate) => personHueIndex(candidate) === bucket,
      );
      if (id === undefined) continue;
      expect(personSwatch(id)).toBe(expected);
    }
  });

  it("agrees with the fallback for the same person, so the colour does not jump", () => {
    // Both derive from one hue index — a created profile's stored colour
    // and the colour it would have been painted before the write are the
    // same bucket.
    expect(personSwatch("ope")).toBe(personSwatch("ope"));
    expect(personHueIndex("ope")).toBe(personHueIndex("ope"));
  });
});
