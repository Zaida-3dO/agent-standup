// The agent view: `orientation` for one item, shaped for a screen.
//
// ── Why show this at all ───────────────────────────────────────────────
//
// `orientation` is the read a session makes when it picks an item up — the
// latest checkpoint, what changed since it, the open loops, who is on the
// crew. It is, precisely, the agent's own input. Every other panel on this
// page shows what a person can see; this one shows what the fleet sees, and
// those are the two halves of "why did it do that". When an agent behaves
// oddly the highest-value artifact is not the output it produced, it is the
// input it was given — and that input otherwise exists only inside a tool
// response, which nobody can look at once the session that made it is gone.
//
// ── Why every part of it is bounded ────────────────────────────────────
//
// The payload is not small and its size is not predictable. It embeds the
// whole item record — a single `body` has been measured at 49,000 characters
// — plus an unbounded event list, so a real response has come back at over
// 165,000 characters. Pasting that into the page would recreate exactly the
// unbounded-height problem the tabs were introduced to fix, one tab along.
//
// So nothing here renders at full length by default:
//
//   - Every text value is clipped to `FIELD_MAX_CHARS`, and says how much it
//     clipped. A clipped value that does not announce itself is worse than a
//     short one, because a reader cannot tell it from a complete one — the
//     same reasoning the response-size guard gives for refusing rather than
//     silently truncating.
//   - The event list is capped at `EVENT_MAX_ROWS`, and reports the total.
//   - The raw JSON sits in a separate collapsed block the reader opens
//     deliberately, and it is bounded as well. The escape hatch has to exist
//     — diagnosing an odd input sometimes needs the exact bytes — but it must
//     not be what the page costs on arrival, and the payload object itself is
//     not retained past the moment it is serialised.
//
// **The bound is applied here, not in CSS.** A `max-height` with an overflow
// still builds every node, still puts every character in the accessibility
// tree, and still pays the whole cost of the string; it only hides it. The
// values below never exist in the rendered tree at full length.

/**
 * The longest any single text value renders at.
 *
 * Long enough for a real checkpoint headline, a state, a title, and the
 * first meaningful paragraph of a body — short enough that a 49,000-char
 * body contributes 600 characters instead of 49,000.
 */
export const FIELD_MAX_CHARS = 600;

/**
 * How many `whatChanged` events render.
 *
 * The list is the part with no upper bound in the payload at all. Twenty is
 * the recent history a reader is actually reading; past that they want the
 * Activity tab, which is built for exactly this and is paginated.
 */
export const EVENT_MAX_ROWS = 20;

/** A text value as the view shows it: bounded, and honest about being bounded. */
export interface BoundedText {
  /** At most `FIELD_MAX_CHARS` characters. */
  readonly text: string;
  /** True when the stored value was longer than what `text` carries. */
  readonly clipped: boolean;
  /** The stored value's full length, so the view can say how much is not shown. */
  readonly fullLength: number;
}

/**
 * Clips `value` to `max`, recording what it clipped.
 *
 * `null` and the empty string both produce an empty `BoundedText` rather
 * than being distinguished, because on screen they are the same thing:
 * nothing to show. The `clipped` flag is what the caller branches on, and it
 * is false for both.
 */
export function boundedText(value: string | null | undefined, max = FIELD_MAX_CHARS): BoundedText {
  if (value === null || value === undefined || value === "") {
    return { text: "", clipped: false, fullLength: 0 };
  }
  if (value.length <= max) {
    return { text: value, clipped: false, fullLength: value.length };
  }
  return { text: value.slice(0, max), clipped: true, fullLength: value.length };
}

/** One `whatChanged` row, reduced to the fields the view shows. */
export interface AgentViewEvent {
  readonly id: string;
  readonly ts: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly body: BoundedText;
}

/** One open loop, however it was sourced — see `AgentViewOpenLoops` for why the three stay separate. */
export interface AgentViewLoop {
  readonly text: BoundedText;
  /** The second line a loop carries, if it has one — a reason, or a state. Empty when it does not. */
  readonly detail: BoundedText;
  /** The item this loop names, when it names one. Rendered as a link. */
  readonly itemId: string | null;
}

/**
 * The three sources of "something is still outstanding", kept apart exactly
 * as the operation returns them.
 *
 * The operation is explicit that merging them would lose which kind of thing
 * each entry is, and that this is the first thing a resuming session needs
 * to know because the three call for completely different responses. A view
 * that flattened them for tidiness would be undoing that on the one screen
 * built to show what the session was told.
 */
export interface AgentViewOpenLoops {
  readonly notDone: readonly AgentViewLoop[];
  readonly children: readonly AgentViewLoop[];
  readonly loops: readonly AgentViewLoop[];
}

/** One crew member, as the agent view lists them. */
export interface AgentViewCrew {
  readonly holder: string;
  readonly role: string;
  readonly machine: string | null;
}

/** The whole orientation payload, bounded and flattened for rendering. */
export interface AgentView {
  readonly itemTitle: BoundedText;
  readonly itemState: string;
  readonly itemBody: BoundedText;
  readonly checkpoint: {
    readonly ts: string;
    readonly headline: BoundedText;
    readonly body: BoundedText;
  } | null;
  readonly events: readonly AgentViewEvent[];
  /** How many events the payload carried, which is `events.length` only when nothing was capped. */
  readonly eventsTotal: number;
  readonly changedSince: string;
  readonly horizon: string;
  readonly openLoops: AgentViewOpenLoops;
  readonly crew: readonly AgentViewCrew[];
  /**
   * The payload serialised for the collapsed raw block — **already bounded**,
   * and holding no reference to the original object.
   *
   * The original is deliberately NOT retained here. A view that kept it
   * would still be carrying the 165,000-character payload for as long as the
   * panel is mounted, and would hand it, whole, to every component it passed
   * the view to — so the string would sit in the React tree as a prop even
   * though nothing rendered it. That is the same cost this module exists to
   * remove, hidden one level down. Serialising once at the boundary and
   * dropping the object is what actually bounds it.
   */
  readonly raw: BoundedText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Builds the agent view from a raw `orientation` response.
 *
 * **Every field is read defensively.** The payload arrives as parsed JSON
 * from an endpoint this component does not share a type with (the client
 * reaches the service layer only through the adapter's JSON — see
 * `@/lib/item-detail/types`), and a diagnostic panel is the last thing that
 * should be able to take out the page it diagnoses. A missing or
 * wrongly-shaped field renders as absent; it never throws.
 */
export function agentViewFrom(payload: unknown): AgentView {
  const root = isRecord(payload) ? payload : {};
  const item = isRecord(root.item) ? root.item : {};
  const checkpointRaw = isRecord(root.checkpoint) ? root.checkpoint : null;
  const openLoopsRaw = isRecord(root.openLoops) ? root.openLoops : {};

  const allEvents = arr(root.whatChanged);
  const events: AgentViewEvent[] = allEvents.slice(0, EVENT_MAX_ROWS).map((entry, index) => {
    const row = isRecord(entry) ? entry : {};
    return {
      id: str(row.id) ?? String(index),
      ts: str(row.ts) ?? "",
      type: str(row.type) ?? "unknown",
      actorType: str(row.actorType) ?? "",
      actorId: str(row.actorId),
      body: boundedText(str(row.body)),
    };
  });

  return {
    itemTitle: boundedText(str(item.title)),
    itemState: str(item.state) ?? "",
    itemBody: boundedText(str(item.body)),
    checkpoint:
      checkpointRaw === null
        ? null
        : {
            ts: str(checkpointRaw.ts) ?? "",
            headline: boundedText(str(checkpointRaw.headline)),
            body: boundedText(str(checkpointRaw.body)),
          },
    events,
    eventsTotal: allEvents.length,
    changedSince: str(root.changedSince) ?? "",
    horizon: str(root.horizon) ?? "",
    openLoops: {
      notDone: arr(openLoopsRaw.notDone).map((entry) => {
        const row = isRecord(entry) ? entry : {};
        return {
          text: boundedText(str(row.text)),
          detail: boundedText(str(row.reason)),
          itemId: str(row.itemId),
        };
      }),
      children: arr(openLoopsRaw.children).map((entry) => {
        const row = isRecord(entry) ? entry : {};
        return {
          text: boundedText(str(row.title)),
          detail: boundedText(str(row.state)),
          itemId: str(row.id),
        };
      }),
      // A loop carries no item id of its own — it is opened AGAINST the item
      // being viewed, so there is nothing to link to that the reader is not
      // already looking at. `itemId` is null here rather than filled in with
      // this item's id, which would render a link back to the current page.
      loops: arr(openLoopsRaw.loops).map((entry) => {
        const row = isRecord(entry) ? entry : {};
        return {
          text: boundedText(str(row.text)),
          detail: boundedText(str(row.openedAt)),
          itemId: null,
        };
      }),
    },
    crew: arr(root.crew).map((entry) => {
      const row = isRecord(entry) ? entry : {};
      return {
        holder: str(row.holderId) ?? str(row.holder) ?? "",
        role: str(row.role) ?? "",
        machine: str(row.machine),
      };
    }),
    raw: rawJson(payload),
  };
}

/**
 * The raw payload as pretty JSON, itself bounded.
 *
 * The escape hatch is bounded too, and that is deliberate rather than
 * timid. A reader who opens the raw block wants to inspect a value, not to
 * receive the entire response — and the whole point of this module is that
 * the page's cost cannot be set by a stored value's length. `RAW_MAX_CHARS`
 * is well above any payload that is comfortable to read on a screen and well
 * below the sizes that caused the problem.
 *
 * A payload that cannot be serialised at all (a cycle, a bigint that escaped
 * stringification) reports that rather than throwing — a diagnostic view
 * refusing to render because its input is odd would fail at precisely the
 * moment it is most useful.
 */
export const RAW_MAX_CHARS = 20_000;

export function rawJson(payload: unknown): BoundedText {
  let serialised: string;
  try {
    serialised = JSON.stringify(payload, null, 2) ?? "";
  } catch {
    serialised = "This payload could not be serialised as JSON.";
  }
  return boundedText(serialised, RAW_MAX_CHARS);
}
