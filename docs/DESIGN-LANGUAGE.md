# Agent Standup — the design language

What this app looks like, and why. One vocabulary, applied everywhere.

`src/app/globals.css` is the **implementation** — every token, with the reasoning for each palette
choice, lives in that file's header and should stay there. This document is the **rulebook that sits
above it**: what the tokens are _for_, which one to reach for, and the handful of rules that a
component is not free to break. It exists because the tokens were already excellent and the app still
read as a wall of grey text — a design system nothing consumes is not a design system.

> **The one-line version.** Reach for a token, never a literal. Size carries rank, colour carries
> identity, fill carries urgency, and the reader's eye should land on the content before it lands on
> the chrome.

---

## 0. The problem this language was written against

Measured on the live app, 2026-09-17, before this pass:

| Symptom                            | Measurement                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Ad-hoc font sizes in component CSS | **29 distinct values**, e.g. `0.68` `0.72` `0.74` `0.75` `0.76` `0.78` `0.8` `0.82` `0.85` `0.88` `0.9rem` |
| Type scale bypassed                | **299 raw `font-size` literals** vs **113** token uses (73% bypass)                                        |
| Rendered sizes on one board page   | **15 distinct**, nine of them inside a 4px band (9.6–13.6px)                                               |
| Top of the scale                   | `--text-xl` used **0 times**, `--text-md` **twice**                                                        |
| Board chrome before the first card | **495px** of a 900px viewport                                                                              |
| The blurb on item detail           | **12.8px at L=62.8** — _smaller and fainter than the 13px/L=77.9 body it summarises_                       |

Two conclusions follow, and they drive everything below.

**Hierarchy needs distance, not more steps.** Fourteen sizes between 0.68 and 0.9rem cannot rank
anything: at that spacing the eye reads them as one size with noise. A scale works because its steps
are far enough apart to be _told apart_.

**The wall was never a colour problem.** The palette was rich and unused. Muted grey was being applied
to things that carry meaning — an area, a repo, a blurb — while the loud tokens sat idle.

---

## 1. Type

### The scale

Seven steps, defined in `globals.css` §8. **These are the only sizes in the app.** A component that
needs a size picks the nearest step; it does not invent one between two of them.

| Token        | px  | What it is for                                              |
| ------------ | --- | ----------------------------------------------------------- |
| `--text-3xs` | 11  | Chip labels, badge text. The floor — nothing is smaller.    |
| `--text-2xs` | 12  | Metadata: timestamps, counts, axis labels.                  |
| `--text-xs`  | 13  | Secondary UI text and dense table rows.                     |
| `--text-sm`  | 15  | **Body.** The default; prose and card titles.               |
| `--text-md`  | 18  | Sub-headings, and a card's primary line where it must lead. |
| `--text-lg`  | 22  | Page and panel headings.                                    |
| `--text-xl`  | 28  | The one thing a page is about. At most **one per page**.    |

**Why a step was not added for anything.** Every one of the 29 ad-hoc values rounded to a step already
in the scale. `0.85rem` and `0.82rem` and `0.8rem` were three spellings of `--text-xs`; they existed
because it was easier to type a number than to decide. Adding steps to accommodate them would encode
the indecision.

**The top of the scale is meant to be used.** `--text-xl` being unused is why no page had a focal
point. A page that never rises above 15px has no entry point for the eye, and the reader has to parse
their way in from the top-left.

### Weight, and the rule about it

Three weights (400 / 500 / 600), and **no 700** — bold-on-dark blooms and smears at small sizes.

**Emphasis is size and colour before it is weight.** Reaching for bold to make something matter is
what produced a page where everything was bold and nothing mattered. Rank it with a step and a text
colour first; use 600 to separate a heading from the body beneath it, and 500 for a label that must
detach from its value.

### The header/body pairing

**One family: Geist Sans, for both headings and body.** This is a deliberate decision _against_ the
display/body split the brief raised as a possibility, and the reason is that the split solves a problem
this app does not have. A second family earns its keep on a marketing page, where a heading is a
graphic element. Here, headings are dense, functional and frequently a task title — a string someone
typed, at arbitrary length, that must sit unremarkably beside the body text explaining it. Two families
would make every item title read as a banner.

What the app was actually missing was not a second typeface but **conscious use of the one it has**:
the top two steps, a real weight jump at headings, and tight leading on them. Those are applied here.

Geist Mono remains restricted to the four identifier kinds `globals.css` §8 names — commit SHAs, branch
names, item ids, machine names — where character ambiguity is a correctness problem. **Prose never gets
mono, and a number is not an identifier**: counts and costs are tabular sans via `.tabular`.

### Measure

Prose is capped at **`--measure-prose` (68ch)**. An item body rendered across a 1400px viewport is ~180
characters a line; the eye loses the start of the next line and re-reads. This is the single cheapest
readability fix in the app, and it is why the item body is no longer full-bleed.

---

## 2. Colour — what it is FOR

The brief asked the question directly, and the answer is the rule the whole palette hangs on:

> **Colour encodes one of four things, and never anything else: identity, state, urgency, or
> severity. Decoration is not on the list.**

| Channel            | Encodes                            | Shape                                        | Tokens                               |
| ------------------ | ---------------------------------- | -------------------------------------------- | ------------------------------------ |
| **Identity**       | _Which_ thing — area, repo, person | Outlined pill, hue **derived from the name** | `--area-*`, `--repo-*`, `--person-*` |
| **State**          | Where in the lifecycle             | Outlined chip + icon                         | `--state-<s>-{fg,bg,border}`         |
| **Urgency**        | Priority                           | **Filled** chip                              | `--priority-p{0..3}-*`               |
| **Severity / age** | Staleness, liveness                | Bare dot                                     | `--stale-*`, `--presence-*`          |

Three rules fall out of that table, and they are the ones to check a change against:

1. **Identity hue is derived, never chosen.** Areas and repos are unbounded — agents mint them at
   will — so a hand-written map goes stale on the next `create_work`. The name is hashed to one of
   twelve fixed hues at constant L and C, so no area can accidentally be louder than another.
   Collisions are accepted: **the text is the identifier, the colour is a recognition aid.**

2. **Shape separates the categories, because colour cannot.** Priority and state sit in the same
   corner of a card. Filled-vs-outlined is sorted pre-attentively; two shades of small text are not.
   This survives greyscale, colour-blindness, and a 16px card.

3. **Hue is never the only signal** (WCAG 1.4.1). Every state renders a label, and an icon _shape_
   where space drops the label. This matters more here than in most products because red and green
   carry **opposite** meanings — `blocked` vs `merged` — so a reader relying on hue alone would read
   the board _backwards_, not merely lose detail.

### Two prohibitions

**`cancelled` is not red.** Red means "act on this" — `blocked`, `P0`. A cancelled item needs nothing
from anyone and must not compete with a blocked one. Both `wont_do` and `cancelled` are the quietest
thing on the board.

**Muted grey is not the default for metadata.** It was, and that is precisely what made area and repo
disappear into prose. `--text-muted` is for _supporting detail_ — a timestamp, a hint. A value a reader
scans for is identity, and identity gets a pill.

---

## 3. Pills and chips

One geometry, in `Chips.module.css`. Variants differ in **fill, never in size or position**.

- **Radius** `--radius-full`, **padding** `2px var(--space-2)`, **size** `--text-3xs`, **weight** 500.
- **Outlined** — identity and state. The surface shows through, so a column of them reads as
  annotation _on_ the cards rather than objects sitting on them.
- **Filled** — priority only. Heavier by construction, which is right: priority is what you scan a
  backlog by.

**When to render a pill rather than text:** the value is drawn from a **closed or named set** and a
reader **scans for it** — area, repo, state, priority, verdict. Free prose is never a pill; a one-off
string is not made scannable by rounding its corners.

---

## 4. Space and density

The 4px grid in `globals.css` §8. Every margin, padding and gap is one of `--space-1..12`.

**Spacing encodes grouping** (Gestalt proximity), so it is not free decoration. Within a component,
related things get `--space-1/2`; a component's internal padding is `--space-3/4`; sections are
separated by `--space-6/8`. If two things need a border to look separate, they are usually just too
close together.

Compact density changes **spacing and line-height only, never font size** — the reasoning is in
`globals.css` §10 and it is load-bearing: a density that shrank the type would be a second, unstated
scale under which none of the contrast work still holds.

---

## 5. Elevation

**Borders and surface lightness, not shadows.** On a dark surface a drop shadow has nothing to darken
— it composites black onto near-black and reads as smudge. Depth is the four-level surface ramp
(`app` → `sunken` → `panel` → `card` → `raised`) plus a border.

`--shadow-overlay` is the only shadow token and should stay the only one; an overlay floats above
arbitrary content and genuinely needs to detach from it.

---

## 6. Interaction and editing

### Editing is in place — there is no `Edit` button

A value that can be edited **is** its own control. Click a label and it becomes a text box; click a
pill and it opens a dropdown. The affordance appears on **hover and focus**, not permanently.

The reasoning: `Edit` repeated beside every field is chrome competing with the content for attention,
and it scales badly — a page with eight editable fields grows eight buttons that all say the same
word. The value is the thing the reader came for, so the value is the thing they should be able to act
on.

**This is an accessibility contract, not just a visual one.** A hover-only affordance that a keyboard
cannot reach is a regression, so every in-place editor must satisfy all of:

- a real `<button>` wrapping the value — reachable by Tab, activated by Enter _and_ Space;
- an accessible name that says what will be edited (`Edit headline`), never the bare value;
- the focus ring from `globals.css` §9 — the editable affordance is **always** visible on
  `:focus-visible`, never hover-gated;
- `Enter` saves, `Escape` cancels, and focus returns to the trigger on exit;
- in-flight and error states announced, not merely coloured.

### Focus

One treatment app-wide, on `:focus-visible` only. **Deliberately loud** — this app is keyboard-heavy
and a subtle focus ring is an accessibility failure with good taste.

---

## 7. Progressive disclosure

> **A landing page summarises and signposts. It does not dump.**

The item page opens on what the item _is_ — the blurb at full weight, its identity pills, its status —
plus **counts and links** to everything else. Detail lives behind the tabs that already exist
(Plan · Reviews · Subtasks · Activity · Summary).

The test to apply: **would a reader read this on every visit?** If not, it belongs behind a tab with a
count on it. A count is what makes disclosure honest — "Reviews 0" and "Reviews 3" are different
invitations, and hiding content behind a tab that does not say how much is there is how a reader
learns to distrust the tabs.

---

## 8. Hierarchy — the rule that was inverted

> **Rank by what the reader wants, not by what the schema calls important.**

On item detail the three text fields are three _different_ jobs, and they are ranked accordingly:

| Field        | Job                                     | Treatment                                                   |
| ------------ | --------------------------------------- | ----------------------------------------------------------- |
| **headline** | The one-line BLUF — what this work _is_ | **Primary.** `--text-lg`, `--text-primary`. Leads the page. |
| **title**    | The stored label, for search and links  | Secondary line, `--text-sm`, `--text-secondary`.            |
| **body**     | The full brief                          | Behind the fold, capped to `--measure-prose`.               |

Before this pass all three were stacked at near-identical weight, which is much of why the page read as
a wall — three restatements of the same sentence, none of them winning. The headline now leads and the
title supports it; where an item has no distinct headline the title is promoted into the primary slot
rather than leaving a gap.

---

## 9. Applying this to a change

1. **Never write a raw `font-size`, colour, or spacing value.** Use a token. If none fits, the
   question is which step this _is_, not what number looks right.
2. **Ask what the colour means.** Identity, state, urgency, severity — or it should not be coloured.
3. **Metadata from a named set gets a pill**; supporting detail gets `--text-muted`.
4. **One `--text-xl` per page**, and it is what the page is about.
5. **New editable field → in-place, with the keyboard contract in §6.** No `Edit` button.
6. **Verify contrast**, do not eyeball it. `tests/design-tokens-contrast.test.ts` recomputes ratios
   from the declarations rather than trusting a comment. Body text clears 4.5:1; borders that are
   affordances clear 3:1.

### Known debt, deliberately not fixed in this pass

`Budget.module.css` (69 hardcoded hex values) and `Cost.module.css` (6) are almost entirely off-token —
they literally paint `#0e0e11`, the exact failure `globals.css`'s header warns about, and they will not
follow a theme change. They are isolated and self-consistent, so they were left rather than expanding a
presentation pass into two more surfaces. **They are the next thing to bring onto tokens.**
