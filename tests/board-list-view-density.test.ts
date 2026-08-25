// The list view's width behaviour — the density and overflow defects found
// in the T6 §3 visual review.
//
// ── Why this test PARSES THE STYLESHEET ───────────────────────────────
//
// The same reason `tests/design-density-tokens.test.ts` and
// `tests/design-tokens-contrast.test.ts` do: the claims here are properties
// of the shipped `ListView.module.css`, and this repo's harness runs
// `environment: "node"` with no DOM and no layout engine. A test that
// carried its own copy of the widths would pass forever after someone
// edited the CSS, and a test asserting that the module exports a class name
// would prove nothing about what renders at 1024px.
//
// ── What this test does NOT claim ─────────────────────────────────────
//
// **It does not measure a rendered layout.** There is no browser here, so
// nothing below observes a real title column at 1024px or a real overflow
// at 390px. What it proves is that the *declarations the browser would act
// on* are present and are internally consistent — the width ceilings, the
// `table-layout`, the reflow breakpoints, the clamp. The measured numbers
// in the review (201px title, 273px overflow) can only be re-confirmed in a
// browser, and the handoff says so and names the widths to check.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting `table-layout: fixed` from `.table` fails "holds the table
//     to its container" — that one declaration is what stops the sideways
//     scroll, and removing it is the single change that reintroduces the
//     defect.
//   - Changing either `max-width` back to a bare `width` fails "no
//     metadata column is a floor".
//   - Deleting the `max-width: 900px` or `max-width: 560px` block fails the
//     reflow tests.
//   - Removing `-webkit-line-clamp` from `.rowTitle` fails the clamp test —
//     the change that let rows reach 290px tall.
//   - Re-pointing the tone edge at `td:first-child` fails the tone test,
//     and dropping the tone rules entirely fails it too.
//   - Raising `.colTitle`'s `min-width` above the 560px content box fails
//     the narrow-width arithmetic test.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const CSS = readFileSync(
  path.resolve(import.meta.dirname, "../src/components/board/ListView.module.css"),
  "utf8",
);

/** Strip comments, so a rule discussed in prose is never mistaken for a declared one. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The stylesheet with every `@media` block removed — the rules that apply
 * at full width.
 *
 * The distinction matters: `.rowMeta` and `.colTitle` are each declared
 * twice, once unconditionally and once inside a narrow-width block. A
 * lookup that scanned the whole file would find whichever came first in
 * source order and silently report a narrow-width value as the full-width
 * one, which would let the reflow tests below pass while asserting nothing.
 */
const TOP_LEVEL = (() => {
  let out = "";
  let depth = 0;
  let index = 0;
  while (index < CODE.length) {
    const next = CODE.indexOf("@media", index);
    if (next === -1) {
      out += CODE.slice(index);
      break;
    }
    out += CODE.slice(index, next);
    const open = CODE.indexOf("{", next);
    depth = 0;
    let i = open;
    for (; i < CODE.length; i += 1) {
      if (CODE[i] === "{") depth += 1;
      if (CODE[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = i + 1;
  }
  return out;
})();

/**
 * The declarations of the first rule whose selector matches, from the
 * comment-stripped source.
 *
 * Deliberately reads the SHIPPED text rather than importing the CSS module
 * (which under this harness resolves to a proxy of class names and carries
 * no declarations at all).
 */
function ruleFor(selectorPattern: string, from: string = TOP_LEVEL): string {
  // The boundary is "start of a line", not "after `}` or `;`": stripping
  // comments leaves arbitrary characters before a rule, and every selector
  // in this stylesheet starts its own line. Anchoring on `[};]` silently
  // failed to find any rule that followed a comment — which is most of
  // them in a file this heavily annotated.
  // Leading whitespace is allowed because a rule inside an `@media` block
  // is indented, and those blocks are looked up with this same function.
  const pattern = new RegExp(`^[ \\t]*${selectorPattern}\\s*\\{([^}]*)\\}`, "m");
  const match = pattern.exec(from);
  if (match === null) throw new Error(`No rule matching \`${selectorPattern}\`.`);
  return match[1]!;
}

/**
 * The body of the one `@media (max-width: Npx)` block.
 *
 * **Refuses to guess when there is more than one.** Splitting a breakpoint
 * across two blocks is how a rule and the rule it depends on drift apart,
 * and it would silently make this helper read whichever came first —
 * reporting a block that does not contain the declaration under test as
 * simply not having it. One block per breakpoint is the invariant, so it is
 * asserted rather than tolerated.
 */
function mediaBlock(maxWidth: number): string {
  const header = `@media (max-width: ${maxWidth}px)`;
  const occurrences = CODE.split(header).length - 1;
  if (occurrences === 0) throw new Error(`No \`${header}\` block.`);
  if (occurrences > 1) {
    throw new Error(`${occurrences} \`${header}\` blocks — a breakpoint must be declared once.`);
  }
  const start = CODE.indexOf(header);
  const open = CODE.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < CODE.length; i += 1) {
    if (CODE[i] === "{") depth += 1;
    if (CODE[i] === "}") {
      depth -= 1;
      if (depth === 0) return CODE.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced \`@media (max-width: ${maxWidth}px)\` block.`);
}

/**
 * A length in rem.
 *
 * A bare `0` is accepted because CSS permits a unitless zero, and
 * `min-width: 0` is exactly what the 560px block declares — the value this
 * file most needs to be able to read.
 */
function rem(value: string): number {
  const trimmed = value.trim();
  if (/^0$/.test(trimmed)) return 0;
  const match = /(-?\d+(?:\.\d+)?)rem/.exec(trimmed);
  if (match === null) throw new Error(`Expected a rem value, got \`${value}\`.`);
  return Number(match[1]);
}

/**
 * The declared value of one property in a rule body.
 *
 * Split on `;` and compare the property name exactly, rather than matching
 * an anchored regex: a vendor-prefixed property begins with `-`, so a
 * substring match for `line-clamp` would also find `-webkit-line-clamp` and
 * the two would be indistinguishable.
 */
function declaration(body: string, property: string): string {
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    if (part.slice(0, colon).trim() === property) return part.slice(colon + 1).trim();
  }
  throw new Error(`No \`${property}\` in that rule.`);
}

function has(body: string, property: string): boolean {
  return body.split(";").some((part) => {
    const colon = part.indexOf(":");
    return colon !== -1 && part.slice(0, colon).trim() === property;
  });
}

const ROOT_FONT_PX = 16;

describe("the table holds itself to its container", () => {
  it("uses `table-layout: fixed` — the declaration that stops the sideways scroll", () => {
    // THE test of this file. Under the default `auto` layout the browser
    // sizes columns to content and `width: 100%` is only a suggestion, so
    // a long title pushed the table past the viewport — the review
    // measured 273px of horizontal overflow at 390px against the kanban's
    // zero. Deleting this one declaration reintroduces exactly that.
    expect(declaration(ruleFor("\\.table"), "table-layout")).toBe("fixed");
  });

  it("still asks the table to fill its container and no more", () => {
    // `table-layout: fixed` binds the column widths, but `width: 100%` is
    // what ties them to the container's width in the first place. Changing
    // this to `max-content` would overflow again with `fixed` still set.
    expect(declaration(ruleFor("\\.table"), "width")).toBe("100%");
  });

  it("lets a cell break an unbreakable token", () => {
    // `fixed` does not wrap a long URL or branch name on its own — it lets
    // it spill out of the cell. Without this, a single spaceless title
    // reintroduces the overflow that `table-layout: fixed` just fixed.
    expect(declaration(ruleFor("\\.row td"), "overflow-wrap")).toBe("anywhere");
  });
});

describe("no metadata column is a floor as well as a ceiling", () => {
  // The cause of the density defect: `width` on four columns held all
  // 34.5rem of metadata at every viewport, so the title column was the
  // only one that could yield and fell to 201px at 1024px — narrower than
  // the usually-empty 192px OWNER column beside it.
  const metadata = ["\\.colState", "\\.colPriority", "\\.colArea", "\\.colOwner"];

  for (const selector of metadata) {
    it(`${selector.replace(/\\/g, "")} states a max-width so it can give ground`, () => {
      const body = ruleFor(selector);
      expect(has(body, "max-width")).toBe(true);
      // And the ceiling equals the preferred width — the column is allowed
      // to shrink, never to grow past what the layout budgeted for it.
      expect(rem(declaration(body, "max-width"))).toBe(rem(declaration(body, "width")));
    });
  }

  it("the title column keeps a legible floor at full width", () => {
    // Without this the fixed layout is free to hand the remainder to
    // whichever column has the widest content, which is how the title
    // column got squeezed in the first place.
    expect(rem(declaration(ruleFor("\\.colTitle"), "min-width"))).toBeGreaterThanOrEqual(14);
  });

  it("the metadata columns leave the title a majority of a 1024px viewport", () => {
    // The density claim, as arithmetic rather than as a rendered
    // measurement. At 1024px, with the OWNER column dropped by the 900px
    // reflow below, the three remaining metadata columns must leave the
    // title far more room than the 201px the review measured.
    const widthOf = (selector: string) =>
      rem(declaration(ruleFor(selector), "width")) * ROOT_FONT_PX;
    const listPadding = rem(declaration(ruleFor("\\.list"), "padding")) * ROOT_FONT_PX * 2;
    // OWNER is display:none at this width (asserted in the reflow block).
    const metadataPx = widthOf("\\.colState") + widthOf("\\.colPriority") + widthOf("\\.colArea");
    const titlePx = 1024 - listPadding - metadataPx;
    expect(titlePx).toBeGreaterThan(201);
    // And comfortably more than the OWNER column that used to out-measure it.
    expect(titlePx).toBeGreaterThan(12 * ROOT_FONT_PX);
  });
});

describe("the list reflows at narrow widths, as the kanban does", () => {
  // `Board.module.css` reflows at 900px and 560px, and this file matches
  // it. A list with no reflow at all overflows at 390px where the kanban
  // does not — which is the defect these breakpoints prevent.
  it("drops the OWNER column at 900px — widest and most often empty", () => {
    const block = mediaBlock(900);
    expect(block).toContain("colOwner");
    expect(declaration(ruleFor("\\.colOwner,\\s*\\.row td\\.colOwner", block), "display")).toBe(
      "none",
    );
  });

  it("drops the AREA column at 560px", () => {
    const block = mediaBlock(560);
    expect(block).toContain("colArea");
    expect(declaration(ruleFor("\\.colArea,\\s*\\.row td\\.colArea", block), "display")).toBe(
      "none",
    );
  });

  it("releases the title's floor at 560px, so the floor cannot itself overflow", () => {
    // A 14rem (224px) floor inside a 390px viewport is fine on its own, but
    // with STATE (8.5rem) still beside it the two sum past the content box
    // and the table would overflow again — the floor would become the new
    // cause of the defect it was added to prevent.
    expect(rem(declaration(ruleFor("\\.colTitle", mediaBlock(560)), "min-width"))).toBe(0);
  });

  it("the surviving columns fit inside a 390px viewport", () => {
    // The arithmetic behind "no horizontal overflow at 390px". At that
    // width only STATE and the title remain, inside the narrow padding.
    const narrow = mediaBlock(560);
    const listPadding = rem(declaration(ruleFor("\\.list", narrow), "padding")) * ROOT_FONT_PX * 2;
    const stateWidth = rem(declaration(ruleFor("\\.colState"), "width")) * ROOT_FONT_PX;
    const titleFloor = rem(declaration(ruleFor("\\.colTitle", narrow), "min-width")) * ROOT_FONT_PX;
    expect(listPadding + stateWidth + titleFloor).toBeLessThan(390);
  });

  it("restates the dropped AREA facts inside the row at 560px", () => {
    // The columns are dropped, not the facts. `.rowMeta` is `display: none`
    // at full width and becomes visible exactly where the AREA column goes
    // away, so a narrow row still carries the area chip.
    expect(declaration(ruleFor("\\.rowMeta"), "display")).toBe("none");
    expect(declaration(ruleFor("\\.rowMeta", mediaBlock(560)), "display")).toBe("flex");
  });
});

describe("a long title cannot balloon a row", () => {
  it("clamps the title to two lines", () => {
    // The other half of the density defect: narrowing a column does not
    // bound a row's height on its own — a long title just wraps further,
    // which is how rows reached 200–290px tall. Deleting this line-clamp
    // restores that.
    const body = ruleFor("\\.rowTitle");
    expect(declaration(body, "-webkit-line-clamp")).toBe("2");
    expect(declaration(body, "overflow")).toBe("hidden");
  });

  it("keeps the existing two-line clamp on a waiting reason", () => {
    // Pre-existing behaviour this change must not have disturbed — a
    // blocked reason can run to a paragraph.
    expect(declaration(ruleFor("\\.rowReason"), "-webkit-line-clamp")).toBe("2");
  });
});

describe("the amber/red tone edge survives the reflow", () => {
  // Explicitly checked by the visual review and called out as a
  // must-not-regress. It is the paused/blocked distinction (SCHEMA.md
  // §1.1), and it is not colour-only — a 3px inset edge at row height.
  it("paints an inset edge for both tones, from the state tokens", () => {
    expect(declaration(ruleFor('\\.row\\[data-tone="amber"\\] td\\.colState'), "box-shadow")).toBe(
      "inset 3px 0 0 var(--state-paused-border)",
    );
    expect(declaration(ruleFor('\\.row\\[data-tone="red"\\] td\\.colState'), "box-shadow")).toBe(
      "inset 3px 0 0 var(--state-blocked-border)",
    );
  });

  it("anchors the edge to the STATE column, which is never dropped", () => {
    // The two tone rules must target `.colState` by class rather than by
    // position: `td:first-child` would follow a reordering, and would keep
    // matching a cell that a narrow-width rule had hidden — painting the
    // edge onto nothing. And `.colState` must survive every breakpoint,
    // or the edge goes with it.
    expect(CODE).toContain('.row[data-tone="amber"] td.colState');
    expect(CODE).not.toContain('data-tone="amber"] td:first-child');
    for (const width of [900, 560]) {
      expect(mediaBlock(width)).not.toContain("colState");
    }
  });
});
