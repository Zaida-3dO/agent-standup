// The `repo` · `area` · `machine` · `account` command-line nouns — SCHEMA.md
// §20 ("`standup <noun> <verb>`, nouns … `repo` · `area` · `machine` ·
// `account` · `person`"), §23.3 ("the same operations on the command line
// so an installation with no server is not locked out of the one class of
// data it cannot start without"). MILESTONES.md #92.
//
// **Its own module, appended into `COMMANDS` (`./commands.ts`) with one
// spread — never entries written inline there.** Several rows land CLI verbs
// on that same table concurrently (MILESTONES.md #80-83, #89); a command
// object per entry in one shared array literal is a merge conflict waiting
// to happen the moment two of those land in the same window, so this row
// keeps its five nouns' worth of verbs entirely in a file nothing else
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
import { stringFlag, booleanFlag, type ParsedArgs } from "./args";
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
]);
