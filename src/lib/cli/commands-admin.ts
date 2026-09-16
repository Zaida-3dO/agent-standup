// The `repo` · `area` · `machine` · `account` · `person` command-line nouns
// — SCHEMA.md §20 ("`standup <noun> <verb>`, nouns … `repo` · `area` ·
// `machine` · `account` · `person`"), §23.3 ("the same operations on the
// command line so an installation with no server is not locked out of the
// one class of data it cannot start without"). MILESTONES.md #92.
//
// **`person` arrived late, and its absence was the expensive one.** The
// four nouns above landed with #92; `person` was named in the same two
// spec sections and in this file's own header, and bound to nothing — for
// as long as that was true, this module quoted a list it did not implement.
// The cost was not cosmetic. `update_person` is waived from both MCP
// transports (`../adapters/waivers.ts`) on the stated grounds that a person
// curates reference entities "through the web interface or the command
// line", and the second half of that sentence was false, which left a
// no-server installation with **no** way to create a `Person` row: the web
// interface needs the server it does not have, and MCP is waived. That
// matters because `merge_approval` is person-only
// (`../service/operations/record-artifact.ts`), so an item with
// `mergeAuthority: needs_approval` could not be landed at all. `init` does
// seed profiles, so a properly initialised install was never stuck — but
// §23.3's "must not be locked out" is about the install that is not.
//
// **The waiver is right and stays.** It is not lifted here, and lifting it
// would be a soundness hole rather than a convenience: an agent that could
// call `update_person` could mint the very person whose approval authorises
// that agent's own merge, which is exactly what `../guards/merge.ts` closes
// for `code_review`. Only the waiver's *factual claim about the command
// line* was wrong, and binding the verb below is what makes it true —
// so the fix is here, not in the waiver text.
//
// **Its own module, appended into `COMMANDS` (`./commands.ts`) with one
// spread — never entries written inline there.** Several rows land CLI verbs
// on that same table concurrently (MILESTONES.md #80-83, #89); a command
// object per entry in one shared array literal is a merge conflict waiting
// to happen the moment two of those land in the same window, so this row
// keeps all five nouns' worth of verbs entirely in a file nothing else
// touches and only *appends* to the shared table.
//
// **Flags are kebab-case and spelled out explicitly per command**, not
// passed through generically the way `item list`/`item create` collect
// `flagsToInput` in `./commands.ts`: every field these operations take is
// multi-word (`displayName`, `sourceGlobs`, `needsVisualReview`...), and a
// generic pass-through would require typing the flag as the *operation's*
// camelCase field name (`--needsVisualReview`), which is not how a
// command-line flag reads. Each `buildInput` below does the one translation
// a generic collector cannot: kebab-case flag to camelCase field.
import { malformed, type ErrorEnvelope } from "./envelope";
import { stringFlag, booleanFlag, numericFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

function idArg(rest: readonly string[], label: string): { ok: true; id: string } | InputResult {
  const id = rest[0];
  if (id === undefined) {
    return { ok: false, envelope: malformed(`\`standup ${label}\` needs an id.`, ["id"]) };
  }
  return { ok: true, id };
}

/** Reads `--source-globs a,b,c` as a comma-split array, or `--clear-source-globs` as `null`. Omitted = no change. */
function sourceGlobsFlag(
  flags: ParsedArgs["flags"],
): { ok: true; value?: readonly string[] | null } | { ok: false; envelope: ErrorEnvelope } {
  const clear = booleanFlag(flags, "clear-source-globs");
  if (!clear.ok) return clear;
  const raw = stringFlag(flags, "source-globs");
  if (!raw.ok) return raw;
  if (clear.value && raw.value !== undefined) {
    return {
      ok: false,
      envelope: malformed("--source-globs and --clear-source-globs are mutually exclusive.", [
        "sourceGlobs",
      ]),
    };
  }
  if (clear.value) return { ok: true, value: null };
  if (raw.value === undefined) return { ok: true };
  return {
    ok: true,
    value: raw.value
      .split(",")
      .map((glob) => glob.trim())
      .filter((glob) => glob.length > 0),
  };
}

/** Reads `--budget-windows <json>` parsed as JSON, or `--clear-budget-windows` as `null`. Omitted = no change. */
function budgetWindowsFlag(
  flags: ParsedArgs["flags"],
): { ok: true; value?: unknown } | { ok: false; envelope: ErrorEnvelope } {
  const clear = booleanFlag(flags, "clear-budget-windows");
  if (!clear.ok) return clear;
  const raw = stringFlag(flags, "budget-windows");
  if (!raw.ok) return raw;
  if (clear.value && raw.value !== undefined) {
    return {
      ok: false,
      envelope: malformed("--budget-windows and --clear-budget-windows are mutually exclusive.", [
        "budgetWindows",
      ]),
    };
  }
  if (clear.value) return { ok: true, value: null };
  if (raw.value === undefined) return { ok: true };
  try {
    return { ok: true, value: JSON.parse(raw.value) as unknown };
  } catch {
    return {
      ok: false,
      envelope: malformed("--budget-windows must be valid JSON.", ["budgetWindows"]),
    };
  }
}

/**
 * Reads `--notify-rules <json>` parsed as JSON, or `--clear-notify-rules` as `null`. Omitted = no change.
 *
 * Deliberately a *sibling* of `budgetWindowsFlag` rather than a shared
 * generic, matching how every other flag in this file is spelled out per
 * command: the two differ in the field they name and in the message a bad
 * value produces, and both of those are what a person reads when they get
 * it wrong.
 *
 * **No casing translation here, unlike every other flag in this module.**
 * `update_person` validates `notify_rules` in the *stored* snake_case
 * spelling on purpose — its header explains that accepting the evaluator's
 * `whenAll`/`whenAny` camelCase would store a rule that parses back to zero
 * conditions and then silently never fires. Helpfully rewriting the keys
 * here would defeat that check from behind the adapter it is meant to
 * protect, so the JSON is passed through exactly as typed and the
 * operation's schema is what accepts or refuses it.
 */
function notifyRulesFlag(
  flags: ParsedArgs["flags"],
): { ok: true; value?: unknown } | { ok: false; envelope: ErrorEnvelope } {
  const clear = booleanFlag(flags, "clear-notify-rules");
  if (!clear.ok) return clear;
  const raw = stringFlag(flags, "notify-rules");
  if (!raw.ok) return raw;
  if (clear.value && raw.value !== undefined) {
    return {
      ok: false,
      envelope: malformed("--notify-rules and --clear-notify-rules are mutually exclusive.", [
        "notifyRules",
      ]),
    };
  }
  if (clear.value) return { ok: true, value: null };
  if (raw.value === undefined) return { ok: true };
  try {
    return { ok: true, value: JSON.parse(raw.value) as unknown };
  } catch {
    return {
      ok: false,
      envelope: malformed("--notify-rules must be valid JSON.", ["notifyRules"]),
    };
  }
}

export const ADMIN_COMMANDS: readonly CommandSpec[] = Object.freeze([
  // ── repo ──────────────────────────────────────────────────────────────
  {
    noun: "repo",
    verb: "list",
    operation: "list_repos",
    summary: "List repositories.",
    buildInput: (_rest, flags) => {
      const includeArchived = booleanFlag(flags, "include-archived");
      if (!includeArchived.ok) return includeArchived;
      return { ok: true, input: { includeArchived: includeArchived.value } };
    },
  },
  {
    noun: "repo",
    verb: "get",
    operation: "get_repo",
    summary: "Show one repository.",
    buildInput: (rest) => {
      const idResult = idArg(rest, "repo get");
      if (!("id" in idResult)) return idResult;
      return { ok: true, input: { id: idResult.id } };
    },
  },
  {
    noun: "repo",
    verb: "create",
    operation: "create_repo",
    summary: "Create a repository. Refused if the id already exists.",
    buildInput: (rest, flags) => {
      const idResult = idArg(rest, "repo create");
      if (!("id" in idResult)) return idResult;
      const displayName = stringFlag(flags, "display-name");
      if (!displayName.ok) return displayName;
      const defaultBranch = stringFlag(flags, "default-branch");
      if (!defaultBranch.ok) return defaultBranch;
      const host = stringFlag(flags, "host");
      if (!host.ok) return host;
      const needsVisualReview = booleanFlag(flags, "needs-visual-review");
      if (!needsVisualReview.ok) return needsVisualReview;
      return {
        ok: true,
        input: {
          id: idResult.id,
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          ...(defaultBranch.value === undefined ? {} : { defaultBranch: defaultBranch.value }),
          ...(host.value === undefined ? {} : { host: host.value }),
          needsVisualReview: needsVisualReview.value,
        },
      };
    },
  },
  {
    noun: "repo",
    verb: "update",
    operation: "update_repo",
    summary: "Edit a repository, and archive or un-archive it.",
    buildInput: (rest, flags) => {
      const idResult = idArg(rest, "repo update");
      if (!("id" in idResult)) return idResult;
      const displayName = stringFlag(flags, "display-name");
      if (!displayName.ok) return displayName;
      const defaultBranch = stringFlag(flags, "default-branch");
      if (!defaultBranch.ok) return defaultBranch;
      const host = stringFlag(flags, "host");
      if (!host.ok) return host;
      const needsVisualReview = booleanFlag(flags, "needs-visual-review");
      if (!needsVisualReview.ok) return needsVisualReview;
      const archive = booleanFlag(flags, "archive");
      if (!archive.ok) return archive;
      const unarchive = booleanFlag(flags, "unarchive");
      if (!unarchive.ok) return unarchive;
      if (archive.value && unarchive.value) {
        return {
          ok: false,
          envelope: malformed("--archive and --unarchive are mutually exclusive.", ["archived"]),
        };
      }
      return {
        ok: true,
        input: {
          id: idResult.id,
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          ...(defaultBranch.value === undefined ? {} : { defaultBranch: defaultBranch.value }),
          ...(host.value === undefined ? {} : { host: host.value }),
          ...(needsVisualReview.value ? { needsVisualReview: true } : {}),
          ...(archive.value ? { archived: true } : {}),
          ...(unarchive.value ? { archived: false } : {}),
        },
      };
    },
  },
  // ── area ──────────────────────────────────────────────────────────────
  {
    noun: "area",
    verb: "list",
    operation: "list_areas",
    summary: "List areas.",
    buildInput: (_rest, flags) => {
      const includeArchived = booleanFlag(flags, "include-archived");
      if (!includeArchived.ok) return includeArchived;
      return { ok: true, input: { includeArchived: includeArchived.value } };
    },
  },
  {
    noun: "area",
    verb: "get",
    operation: "get_area",
    summary: "Show one area.",
    buildInput: (rest) => {
      const idResult = idArg(rest, "area get");
      if (!("id" in idResult)) return idResult;
      return { ok: true, input: { id: idResult.id } };
    },
  },
  {
    noun: "area",
    verb: "create",
    operation: "create_area",
    summary: "Find or create an area by its normalised name.",
    buildInput: (rest) => {
      const name = rest[0];
      if (name === undefined) {
        return { ok: false, envelope: malformed("`standup area create` needs a name.", ["name"]) };
      }
      return { ok: true, input: { name } };
    },
  },
  {
    noun: "area",
    verb: "update",
    operation: "update_area",
    summary: "Rename an area's display name, and archive or un-archive it.",
    buildInput: (rest, flags) => {
      const idResult = idArg(rest, "area update");
      if (!("id" in idResult)) return idResult;
      const displayName = stringFlag(flags, "display-name");
      if (!displayName.ok) return displayName;
      const archive = booleanFlag(flags, "archive");
      if (!archive.ok) return archive;
      const unarchive = booleanFlag(flags, "unarchive");
      if (!unarchive.ok) return unarchive;
      if (archive.value && unarchive.value) {
        return {
          ok: false,
          envelope: malformed("--archive and --unarchive are mutually exclusive.", ["archived"]),
        };
      }
      return {
        ok: true,
        input: {
          id: idResult.id,
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          ...(archive.value ? { archived: true } : {}),
          ...(unarchive.value ? { archived: false } : {}),
        },
      };
    },
  },
  {
    noun: "area",
    verb: "merge",
    operation: "merge_areas",
    summary: "Fold one area's membership into another, and archive the losing area.",
    // No local "needs two ids" or "from === to" check: `merge_areas`'
    // own schema (`min(1)` on both fields) and its `SAME_AREA_GUARD` are
    // what refuse those, exactly as they do for the `http` and `mcp`
    // adapters — the http route (`../../app/api/areas/merge/route.ts`)
    // passes its body straight through with no route-side validation
    // either. Refusing here first would mean this adapter answers a
    // missing/duplicate `from`/`to` with `malformed_command` while the
    // other two answer `invalid_input`/`area_merge.same_area` for the
    // identical caller mistake — the divergence the conformance suite's
    // assertion 4 bound exists to catch. `from`/`to` are simply passed
    // through, undefined or not, and the operation says what is wrong.
    buildInput: (rest) => ({ ok: true, input: { from: rest[0], to: rest[1] } }),
  },
  // ── machine ───────────────────────────────────────────────────────────
  {
    noun: "machine",
    verb: "list",
    operation: "list_machines",
    summary: "List machines.",
    buildInput: () => ({ ok: true, input: {} }),
  },
  {
    noun: "machine",
    verb: "get",
    operation: "get_machine",
    summary: "Show one machine.",
    buildInput: (rest) => {
      const id = rest[0];
      if (id === undefined) {
        return { ok: false, envelope: malformed("`standup machine get` needs a name.", ["name"]) };
      }
      return { ok: true, input: { name: id } };
    },
  },
  {
    noun: "machine",
    verb: "update",
    operation: "update_machine",
    summary: "Set or clear a machine's source-globs override, creating it if it is new.",
    buildInput: (rest, flags) => {
      const name = rest[0];
      if (name === undefined) {
        return {
          ok: false,
          envelope: malformed("`standup machine update` needs a name.", ["name"]),
        };
      }
      const sourceGlobs = sourceGlobsFlag(flags);
      if (!sourceGlobs.ok) return sourceGlobs;
      return {
        ok: true,
        input: {
          name,
          ...("value" in sourceGlobs ? { sourceGlobs: sourceGlobs.value } : {}),
        },
      };
    },
  },
  // ── account ───────────────────────────────────────────────────────────
  {
    noun: "account",
    verb: "list",
    operation: "list_accounts",
    summary: "List accounts.",
    buildInput: () => ({ ok: true, input: {} }),
  },
  {
    noun: "account",
    verb: "get",
    operation: "get_account",
    summary: "Show one account.",
    buildInput: (rest) => {
      const idResult = idArg(rest, "account get");
      if (!("id" in idResult)) return idResult;
      return { ok: true, input: { id: idResult.id } };
    },
  },
  {
    noun: "account",
    verb: "update",
    operation: "update_account",
    summary:
      "Edit an account, or create one if the id is new (needs vendor, display-name, plan-type).",
    buildInput: (rest, flags) => {
      const idResult = idArg(rest, "account update");
      if (!("id" in idResult)) return idResult;
      const vendor = stringFlag(flags, "vendor");
      if (!vendor.ok) return vendor;
      const displayName = stringFlag(flags, "display-name");
      if (!displayName.ok) return displayName;
      const planType = stringFlag(flags, "plan-type");
      if (!planType.ok) return planType;
      const budgetWindows = budgetWindowsFlag(flags);
      if (!budgetWindows.ok) return budgetWindows;
      return {
        ok: true,
        input: {
          id: idResult.id,
          ...(vendor.value === undefined ? {} : { vendor: vendor.value }),
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          ...(planType.value === undefined ? {} : { planType: planType.value }),
          ...("value" in budgetWindows ? { budgetWindows: budgetWindows.value } : {}),
        },
      };
    },
  },
  // ── person ────────────────────────────────────────────────────────────
  //
  // **Two verbs, not three.** `repo`, `area` and `account` each have a
  // `get`, and `person` does not, because there is no `get_person`
  // operation to bind: the service layer registers `list_people`,
  // `update_person` and `delete_person` and nothing else. Inventing a
  // `person get` here would mean this adapter growing a surface of its own
  // — one operation's worth of behaviour implemented in the command table
  // rather than reached through it — which is precisely what §22's "every
  // adapter parses the same schema through the same call" forbids and what
  // makes the conformance comparison meaningful. `person list` answers the
  // same question one row at a time.
  //
  // No `delete` verb either, for the same reason `repo` and `area` have
  // none despite `delete_reference_row` registering one: §23.1 is "archive,
  // never delete" because attribution rows point at these, and `update
  // --archive` is the verb that says so.
  {
    noun: "person",
    verb: "list",
    operation: "list_people",
    summary: "List profiles.",
    buildInput: (_rest, flags) => {
      const includeArchived = booleanFlag(flags, "include-archived");
      if (!includeArchived.ok) return includeArchived;
      // `list_people` is paged (`limit`/`cursor`), unlike `list_repos` and
      // `list_areas`, so those two flags are carried here and nowhere else
      // in this file. `--limit` goes through `numericFlag` for the reason
      // `item list` gives: the field is a `z.number()` and a flag is always
      // a string, so passing it raw would be refused by the schema as a
      // type error rather than accepted as the number the caller typed.
      const limit = numericFlag(flags, "limit");
      if (!limit.ok) return limit;
      const cursor = stringFlag(flags, "cursor");
      if (!cursor.ok) return cursor;
      return {
        ok: true,
        input: {
          includeArchived: includeArchived.value,
          ...(limit.value === undefined ? {} : { limit: limit.value }),
          ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
        },
      };
    },
  },
  {
    noun: "person",
    verb: "update",
    operation: "update_person",
    summary:
      "Edit a profile, or create one if the id is new (needs display-name), and archive or un-archive it.",
    // The upsert, spelled `update` rather than split into create + update
    // because `update_person` is one operation — the same shape `account
    // update` has, and for the same reason: both are keyed on a
    // caller-supplied natural id. `update_person`'s own header carries the
    // argument for why `Person` sits with `machines`/`accounts` rather than
    // with `repos`/`areas` here.
    buildInput: (rest, flags) => {
      const idResult = idArg(rest, "person update");
      if (!("id" in idResult)) return idResult;
      const displayName = stringFlag(flags, "display-name");
      if (!displayName.ok) return displayName;
      const avatar = stringFlag(flags, "avatar");
      if (!avatar.ok) return avatar;
      const clearAvatar = booleanFlag(flags, "clear-avatar");
      if (!clearAvatar.ok) return clearAvatar;
      if (clearAvatar.value && avatar.value !== undefined) {
        return {
          ok: false,
          envelope: malformed("--avatar and --clear-avatar are mutually exclusive.", ["avatar"]),
        };
      }
      const colour = stringFlag(flags, "colour");
      if (!colour.ok) return colour;
      const clearColour = booleanFlag(flags, "clear-colour");
      if (!clearColour.ok) return clearColour;
      if (clearColour.value && colour.value !== undefined) {
        return {
          ok: false,
          envelope: malformed("--colour and --clear-colour are mutually exclusive.", ["colour"]),
        };
      }
      const notifyRules = notifyRulesFlag(flags);
      if (!notifyRules.ok) return notifyRules;
      const archive = booleanFlag(flags, "archive");
      if (!archive.ok) return archive;
      const unarchive = booleanFlag(flags, "unarchive");
      if (!unarchive.ok) return unarchive;
      if (archive.value && unarchive.value) {
        return {
          ok: false,
          envelope: malformed("--archive and --unarchive are mutually exclusive.", ["archived"]),
        };
      }
      return {
        ok: true,
        input: {
          id: idResult.id,
          ...(displayName.value === undefined ? {} : { displayName: displayName.value }),
          // `avatar` and `colour` are nullable on the operation — `null`
          // clears, omitted means no change — so each needs a `--clear-*`
          // switch as well as a value flag. A bare `--avatar ""` cannot
          // stand in for the clear: the schema is `.trim().min(1)`, so the
          // empty string is refused rather than read as "remove it".
          ...(clearAvatar.value
            ? { avatar: null }
            : avatar.value === undefined
              ? {}
              : { avatar: avatar.value }),
          ...(clearColour.value
            ? { colour: null }
            : colour.value === undefined
              ? {}
              : { colour: colour.value }),
          ...("value" in notifyRules ? { notifyRules: notifyRules.value } : {}),
          ...(archive.value ? { archived: true } : {}),
          ...(unarchive.value ? { archived: false } : {}),
        },
      };
    },
  },
]);
