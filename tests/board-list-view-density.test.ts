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
// nothing below observes a real title column at 1024px. What it proves is
// that the *declarations the browser would act on* are present and are
// internally consistent.
//
// That limit is not academic — it is how the first fix for this shipped
// broken. An earlier version of this file computed
// `1024 - padding - (State+Priority+Area)` under the comment "OWNER is
// display:none at this width", asserted the result exceeded 201px, and
// passed. Both halves of its premise were false: the reflow was a `@media`
// query at 900px so OWNER was still visible at a 1024px viewport, and the
// arithmetic subtracted nothing for the 216px rail. The stylesheet it was
// checking rendered the title at exactly the 201px the assertion claimed
// to have ruled out. **A test that computes a width from the stylesheet
// cannot see the layout the browser produces**, so the tests below assert
// only mechanisms — which property binds under `table-layout: fixed`,
// which box the reflow measures — and the rendered numbers are recorded in
// the PR from a real browser instead.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting `table-layout: fixed` from `.table` fails "holds the table
//     to its container".
//   - Giving `.colTitle` any `width` at full size fails "states NO width" —
//     that column takes the remainder only by staying silent.
//   - Re-adding `min-width` to `.colTitle` fails its own test; it is the
//     inert declaration the failed fix shipped.
//   - Turning any metadata column's `width` back into a `max-width` fails
//     "states a constant width for `fixed` to bind".
//   - Removing `container-type` from `.list` fails the container test, and
//     makes every `@container` rule below match nothing.
//   - Moving either reflow back to `@media` fails "no viewport query drops
//     a column any more" — the exact regression this row was filed for.
//   - Widening the rail past the point where a 1024px window still clears
//     the breakpoint fails the geometry test.
//   - Removing `-webkit-line-clamp` from `.rowTitle` fails the clamp test.
//   - Re-pointing the tone edge at `td:first-child` fails the tone test.
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
 * The stylesheet with every `@media` and `@container` block removed — the
 * rules that apply at full width.
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
    // Both at-rules, not just `@media`: the reflow now lives in
    // `@container` blocks, and a stripper that only knew about `@media`
    // would leak a narrow-width `.colTitle { width: auto }` into the
    // "full width" text and report it as the unconditional rule — the same
    // class of false premise this file exists to stop.
    const candidates = [CODE.indexOf("@media", index), CODE.indexOf("@container", index)].filter(
      (at) => at !== -1,
    );
    const next = candidates.length === 0 ? -1 : Math.min(...candidates);
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
  return atRuleBlock(`@media (max-width: ${maxWidth}px)`);
}

/**
 * The body of the one `@container list (max-width: Npx)` block.
 *
 * Separate from `mediaBlock` because the two ask different questions of the
 * layout and this file now asserts on both: a `@media` query reads the
 * VIEWPORT, a `@container` query reads the list's own box. Conflating them
 * is the defect this file guards: a reflow keyed on the viewport while the
 * columns compete for a box 216px narrower.
 */
function containerBlock(maxWidth: number): string {
  return atRuleBlock(`@container list (max-width: ${maxWidth}px)`);
}

/** The body of the one block with this exact at-rule prelude. */
function atRuleBlock(header: string): string {
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
  throw new Error(`Unbalanced \`${header}\` block.`);
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

/**
 * Whether any full-width rule for this selector declares this property.
 *
 * `false` both when the rule states something else and when there is no such
 * rule at all — the distinction `ruleFor` cannot express, since it throws.
 * The claim under test is about what the browser is told, and a missing rule
 * and a rule that omits the property tell it the same thing.
 */
function topLevelDeclares(selectorPattern: string, property: string): boolean {
  let body: string;
  try {
    body = ruleFor(selectorPattern);
  } catch {
    return false;
  }
  return has(body, property);
}

const ROOT_FONT_PX = 16;

/**
 * The navigation rail's width, from `Sidebar.module.css`.
 *
 * Read from that stylesheet rather than written as a literal here: the rail
 * being 216px wide is half the cause of the defect this file guards, and a
 * copy of the number would keep asserting a stale geometry after someone
 * changed the rail.
 */
const RAIL_PX = (() => {
  const rail = readFileSync(
    path.resolve(import.meta.dirname, "../src/components/sidebar/Sidebar.module.css"),
    "utf8",
  );
  const match = /\.rail\s*\{[^}]*?width:\s*(\d+)px/s.exec(rail);
  if (match === null) throw new Error("No `.rail` width in Sidebar.module.css.");
  return Number(match[1]);
})();

/** A column's stated width in px. */
const widthOf = (selector: string) => rem(declaration(ruleFor(selector), "width")) * ROOT_FONT_PX;

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

describe("the title column takes the remainder, in the only vocabulary `fixed` reads", () => {
  // The cause of the density defect, and of the FAILED fix for it.
  //
  // Under `table-layout: fixed` the column widths come from the first
  // row's stated `width` and nothing else — `min-width` and `max-width` on
  // a column are not consulted at all. The previous attempt added
  // `.colTitle { min-width: 14rem }` and turned the metadata columns'
  // `width` into `max-width`, and a browser measurement afterwards found
  // the title still at exactly 201px with `getComputedStyle` reporting the
  // 224px floor: the declarations were present and inert.
  //
  // So what is asserted here is the property that actually binds.
  const metadata = ["\\.colState", "\\.colPriority", "\\.colArea", "\\.colOwner"];

  for (const selector of metadata) {
    it(`${selector.replace(/\\/g, "")} states a constant width for \`fixed\` to bind`, () => {
      const body = ruleFor(selector);
      // A `max-width` here instead of a `width` is the exact shape of the
      // failed fix: it looks like a constraint and binds nothing.
      expect(has(body, "width")).toBe(true);
      expect(rem(declaration(body, "width"))).toBeGreaterThan(0);
    });
  }

  it("the title column states NO width, so `fixed` hands it what is left", () => {
    // This is the fix, stated as the absence it actually is. A column with
    // no `width` receives the leftover space; any stated value takes that
    // away. A percentage is the tempting wrong answer — 45% plus the four
    // constants over-subscribes the table, and `fixed` resolves an
    // over-subscription by shrinking every column proportionally, which
    // gives the title LESS than saying nothing would.
    // Expressed as "no full-width rule declares one" rather than by reading
    // a rule body, because the fix removes the declaration and with it the
    // whole rule — both are the same statement about what the browser is
    // told, and a test demanding the rule still exist would fail a change
    // that is correct.
    expect(topLevelDeclares("\\.colTitle", "width")).toBe(false);
  });

  it("the title column states no inert min-width either", () => {
    // The failed fix's own declaration. Re-adding it would not break the
    // layout, which is precisely why it needs a test: it is a floor that
    // reads as a guarantee and provides none, and its presence is what
    // made the previous round's CSS look correct while rendering 201px.
    expect(topLevelDeclares("\\.colTitle", "min-width")).toBe(false);
  });

  it("the metadata columns cannot outgrow the box they are budgeted from", () => {
    // The arithmetic that makes "the title gets the remainder" a
    // non-empty promise: if the four constants alone filled the container
    // there would be no remainder to get. Asserted against the CONTENT BOX
    // at the width this row was filed for — a 1024px window minus the
    // 216px rail minus the list's own padding — and not against the
    // viewport, which is the mistake the deleted test made.
    const listPadding = rem(declaration(ruleFor("\\.list"), "padding")) * ROOT_FONT_PX * 2;
    const box = 1024 - RAIL_PX - listPadding;
    // OWNER is dropped by the 900px CONTAINER query at this box (asserted
    // in the reflow block below). Asserting this of a VIEWPORT query is
    // false at 1024px, which is the trap this arithmetic avoids.
    const metadataPx = widthOf("\\.colState") + widthOf("\\.colPriority") + widthOf("\\.colArea");
    expect(box).toBeLessThan(900);
    expect(box - metadataPx).toBeGreaterThan(201);
  });
});

describe("the list reflows on its own box, not on the viewport", () => {
  // The second cause of the defect, and the one a stylesheet-parsing test
  // can genuinely hold: the reflow used `@media (max-width: 900px)` while
  // the rail in `Sidebar.module.css` takes 216px off the box those columns
  // compete for AND disappears at that same 900px viewport. Between a
  // 901px and a ~1140px window the rail was present and OWNER was still
  // shown, which is the band where a browser measured the title at 93px.
  it("declares the list an inline-size container, so a container query can resolve", () => {
    // Without this the `@container` rules below match nothing and every
    // column simply keeps its full width at every size — the reflow would
    // silently stop happening at all.
    const body = ruleFor("\\.list");
    expect(declaration(body, "container-type")).toBe("inline-size");
    expect(declaration(body, "container-name")).toBe("list");
  });

  it("drops OWNER below a 900px BOX — widest column, most often empty", () => {
    const block = containerBlock(900);
    expect(block).toContain("colOwner");
    expect(declaration(ruleFor("\\.colOwner,\\s*\\.row td\\.colOwner", block), "display")).toBe(
      "none",
    );
  });

  it("no viewport query drops a column any more", () => {
    // The regression guard for the actual bug. Re-adding a `@media` rule
    // that hides OWNER or AREA would reintroduce exactly the sidebar blind
    // spot, and would do it while every other test here still passed.
    for (const width of [900, 560]) {
      let block: string;
      try {
        block = mediaBlock(width);
      } catch {
        continue;
      }
      expect(block).not.toContain("colOwner");
      expect(block).not.toContain("colArea");
    }
  });

  it("the OWNER breakpoint is reached before the box is too small for the title", () => {
    // Ties the breakpoint to the geometry rather than leaving it a magic
    // number: at a 1024px window the box is below the breakpoint, so OWNER
    // is gone exactly where the review measured it still present.
    const listPadding = rem(declaration(ruleFor("\\.list"), "padding")) * ROOT_FONT_PX * 2;
    expect(1024 - RAIL_PX - listPadding).toBeLessThan(900);
  });

  it("drops the AREA column below a 560px box", () => {
    const block = containerBlock(560);
    expect(block).toContain("colArea");
    expect(declaration(ruleFor("\\.colArea,\\s*\\.row td\\.colArea", block), "display")).toBe(
      "none",
    );
  });

  it("lets the title span the row once only the chips remain", () => {
    // With AREA and OWNER gone the title should take everything left
    // rather than a share of it. `auto` is the value that does that under
    // `fixed`; a stated width here would leave the rest of the row empty.
    expect(declaration(ruleFor("\\.colTitle", containerBlock(560)), "width")).toBe("auto");
  });

  it("shrinks the chip columns below a 420px box, so the title is not the smallest", () => {
    // Measured: at a 390px phone the box is ~366px, and STATE's 8.5rem
    // left the title 134px — narrower than STATE itself, so the one column
    // of prose was the smallest thing on the row. These two reductions are
    // what move it to 176px.
    const block = containerBlock(420);
    expect(rem(declaration(ruleFor("\\.colState", block), "width"))).toBeLessThan(
      rem(declaration(ruleFor("\\.colState"), "width")),
    );
    expect(rem(declaration(ruleFor("\\.colPriority", block), "width"))).toBeLessThan(
      rem(declaration(ruleFor("\\.colPriority"), "width")),
    );
  });

  it("the surviving columns fit inside a 390px viewport", () => {
    // The arithmetic behind "no horizontal overflow at 390px". At that
    // width the rail is gone, so the box is the viewport less the narrow
    // padding, and only STATE and PRIORITY are stated — the title takes
    // what is left, which cannot overflow because it IS the remainder.
    const narrowest = containerBlock(420);
    const listPadding =
      rem(declaration(ruleFor("\\.list", mediaBlock(560)), "padding")) * ROOT_FONT_PX * 2;
    const stateWidth = rem(declaration(ruleFor("\\.colState", narrowest), "width")) * ROOT_FONT_PX;
    const priorityWidth =
      rem(declaration(ruleFor("\\.colPriority", narrowest), "width")) * ROOT_FONT_PX;
    expect(listPadding + stateWidth + priorityWidth).toBeLessThan(390);
  });

  it("restates the dropped AREA facts inside the row at a 560px box", () => {
    // The columns are dropped, not the facts. `.rowMeta` is `display: none`
    // at full width and becomes visible exactly where the AREA column goes
    // away, so a narrow row still carries the area chip.
    expect(declaration(ruleFor("\\.rowMeta"), "display")).toBe("none");
    expect(declaration(ruleFor("\\.rowMeta", containerBlock(560)), "display")).toBe("flex");
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
    // STATE must never be DROPPED at any breakpoint, or the edge is
    // painted onto a cell that is not there. It is allowed to be narrowed
    // — the 420px block does exactly that — so the assertion is about
    // `display: none`, not about the column being left untouched.
    for (const block of [containerBlock(900), containerBlock(560), containerBlock(420)]) {
      const hides = /\.colState[^{]*\{[^}]*display:\s*none/s.test(block);
      expect(hides).toBe(false);
    }
  });
});
