// Checking caller-facing advice against the schemas it describes.
//
// **The defect class.** A refusal that names a remedy the caller cannot
// follow costs more than a refusal with no remedy at all: the caller trusts
// it and spends the time in the wrong place. Five instances landed in one
// month — `my_work` advising "a smaller `limit`" while accepting only a
// `sessionId`; `record_artifact.findings` indexing into `findings[0]` and
// claiming it "must be an array", which sent two reporters after a shape
// bug that did not exist; a merge gate advertising a written reason that
// `fields` discarded (#243); a draft telling callers to set
// `mergeAuthority: "pre_approved"` when `update_item` accepts the
// hyphenated `pre-approved` (#250). Every one of them was a *message*
// defect wearing a missing-feature costume.
//
// `response-size.ts` already carries a check of this shape, but it is
// narrow twice over: it reads one table (`NARROWER_CALL`) and it detects
// one parameter name (`limit`). This module is the general form — it reads
// advice text, works out which operation each named identifier is being
// attributed to, and asks that operation's real schema whether it would
// accept it.
//
// **What makes this rigorous rather than a plausible-looking sweep**, since
// a check that cannot fail honestly is the exact disease this file exists
// to treat:
//
//   1. **Attribution, not proximity.** Advice regularly names a parameter
//      belonging to a *different* tool, and correctly so:
//      `get_item_detail`'s advice says "`get_item` with `full: false`" —
//      `get_item_detail` has no `full`, `get_item` does, and the advice is
//      right. A checker that matched parameters against the operation whose
//      message it happened to be would flag that, be wrong, and get
//      switched off. So a parameter is attributed to the most recent
//      operation named before it in the text, falling back to the operation
//      the advice belongs to.
//   2. **Only phrasings that instruct.** The word `limit` appearing in
//      prose is not advice to send one — `my_work`'s corrected message says
//      it "takes no `limit`" precisely to rule the parameter out, and
//      flagging that would punish the fix. Recognition is therefore limited
//      to `key: value` forms and to verbs that ask for a value.
//   3. **Silence over guessing.** An identifier this module cannot
//      confidently classify is not reported. Under-reporting leaves a
//      defect for a human; over-reporting trains everyone to ignore the
//      check, which loses the ones it gets right too.
import { describeFields } from "./fields";
import { getOperation, isOperationName, listOperations } from "../registry";

/** One piece of advice, and the operation whose refusal carries it. */
export interface AdviceEntry {
  /** The operation the message is spoken *by*. */
  readonly operation: string;
  /** Where the text lives, for a failure message a reader can act on. */
  readonly source: string;
  readonly text: string;
}

/** A remedy the named operation would not accept. */
export interface AdviceDefect {
  readonly operation: string;
  readonly source: string;
  /** The identifier the advice names. */
  readonly named: string;
  /** The operation the identifier was attributed to. */
  readonly attributedTo: string;
  readonly kind: "parameter" | "enum-value" | "operation";
  readonly detail: string;
}

/**
 * Every field an operation accepts, including one level of nesting.
 *
 * `complete_item`'s contract lives inside its `summary` object —
 * `how_verified`, `user_facing`, `what_to_test`, `not_done` are all real
 * fields a caller sends and all real subjects of advice, and a top-level
 * walk sees none of them. Descending one level covers them without
 * pretending to a general recursive schema reader: two levels down, this
 * codebase has nothing, and a checker claiming depth it has not been tested
 * at is a worse answer than a documented single level.
 */
export function acceptedFieldNames(operation: string): ReadonlySet<string> {
  const found = getOperation(operation);
  const names = new Set<string>();
  if (!found) return names;
  for (const field of describeFields(found.input)) {
    names.add(field.name);
    // The nested shape, reached the same way `describeFields` reaches the
    // top-level one: through the operation's own schema object.
    const shape = nestedShapeOf(found.input, field.name);
    if (shape) for (const nested of describeFields(shape)) names.add(nested.name);
  }
  return names;
}

/**
 * The fields an operation's schema marks required — the machine-readable
 * half of the claim a caller reads before calling.
 *
 * Read through `describeFields` rather than off the Zod node directly, so
 * "required" means here exactly what it means everywhere else the product
 * reports it, including its treatment of a defaulted field as *not*
 * required. A second definition of required would let this check disagree
 * with the schema it is checking against.
 */
export function requiredFieldNames(operation: string): ReadonlySet<string> {
  const found = getOperation(operation);
  const names = new Set<string>();
  if (!found) return names;
  for (const field of describeFields(found.input)) {
    if (field.required) names.add(field.name);
  }
  return names;
}

/** The schema node under `field`, when that field is itself an object or an array of them. */
function nestedShapeOf(schema: unknown, field: string): unknown {
  const node = schema as {
    shape?: Record<string, unknown>;
    _def?: { schema?: unknown; innerType?: unknown };
  } | null;
  if (node === null || typeof node !== "object") return undefined;
  const shape =
    node.shape ??
    (node._def?.schema
      ? (node._def.schema as { shape?: Record<string, unknown> }).shape
      : undefined) ??
    (node._def?.innerType
      ? (node._def.innerType as { shape?: Record<string, unknown> }).shape
      : undefined);
  const entry = shape?.[field];
  if (entry === undefined) return undefined;
  // Peel the wrappers a field may carry, then the array element, so
  // `summary` and `findings: z.array(z.object(...))` both resolve.
  let current = entry as { _def?: Record<string, unknown>; shape?: unknown };
  for (let depth = 0; depth < 8; depth += 1) {
    if (current?.shape !== undefined) return current;
    const def = current?._def as Record<string, unknown> | undefined;
    const next = def?.innerType ?? def?.schema ?? def?.type;
    if (next === undefined) return undefined;
    current = next as typeof current;
  }
  return undefined;
}

/** Every enum member the operation accepts, across all its fields, one level deep. */
export function acceptedEnumValues(operation: string): ReadonlySet<string> {
  const found = getOperation(operation);
  const values = new Set<string>();
  if (!found) return values;
  for (const field of describeFields(found.input)) {
    for (const value of field.enumValues ?? []) values.add(value);
    const shape = nestedShapeOf(found.input, field.name);
    if (shape) {
      for (const nested of describeFields(shape)) {
        for (const value of nested.enumValues ?? []) values.add(value);
      }
    }
  }
  return values;
}

/**
 * A backticked identifier the advice is *instructing* the caller to send.
 *
 * The two recognised forms, and why only these. **`` `key: value` ``** is
 * the shape the messages use when naming a parameter and the value to give
 * it (`` `full: false` ``), and it is unambiguous — nothing else in this
 * corpus puts a colon inside ticks. **A verb of supply followed by a
 * backticked name** (`with a`, `a smaller`, `pass`, `set`, `send`) is the
 * shape used when the value is left to the caller. Bare mentions are
 * deliberately excluded: `my_work`'s message names `limit` in order to say
 * it has none, which is the opposite of the defect.
 */
const INSTRUCTING_PATTERNS: readonly RegExp[] = [
  // `key: value` — the parameter is the part before the colon. The most
  // reliable form in the corpus: a colon inside ticks is always a caller
  // sending a named field, never prose.
  /`([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^`]+`/g,
  // An imperative that asks the caller to supply a value, then the name.
  //
  // **`with` and `use` are deliberately NOT here, and that is a correctness
  // fix rather than a tuning preference.** Both appear constantly in
  // ordinary explanatory prose about a *different* tool — `create_task`'s
  // contract says "a session that registered with a `personId`", which
  // describes `register_session`'s field in the course of explaining
  // inheritance, and is not an instruction to send `personId` to
  // `create_task`. Including `with` reported all four create operations as
  // defective against advice that is entirely correct. A checker whose
  // output is mostly false positives gets switched off, taking its true
  // positives with it, so the narrower pattern is the stronger check.
  /(?:pass|send|set|supply|specify|a smaller|a narrower|a larger|raise the|lower the)\s+(?:an?\s+|the\s+)?`([A-Za-z_][A-Za-z0-9_]*)`/gi,
];

/** Backticked identifiers this advice instructs the caller to supply, in order of appearance. */
export function instructedIdentifiers(text: string): readonly { name: string; at: number }[] {
  const found: { name: string; at: number }[] = [];
  for (const pattern of INSTRUCTING_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      found.push({ name, at: match.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * `` `key: "value"` `` pairs, which are the form that names an enum member.
 *
 * Only quoted and bare-word values are read. A value containing a space is
 * prose rather than an enum member, and `true`/`false`/numbers are not enum
 * members in any operation here — reporting those would flag `full: false`,
 * which is the single most common correct piece of advice in the corpus.
 */
export function instructedValues(
  text: string,
): readonly { key: string; value: string; at: number }[] {
  const found: { key: string; value: string; at: number }[] = [];
  for (const match of text.matchAll(
    /`([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"?([A-Za-z_][A-Za-z0-9_-]*)"?`/g,
  )) {
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) continue;
    if (value === "true" || value === "false" || value === "null") continue;
    found.push({ key, value, at: match.index ?? 0 });
  }
  return found;
}

/** Operation names the advice mentions, in order of appearance. */
export function mentionedOperations(text: string): readonly { name: string; at: number }[] {
  const found: { name: string; at: number }[] = [];
  for (const match of text.matchAll(/`([a-z_][a-z0-9_]*)`/g)) {
    const name = match[1];
    if (name !== undefined && isOperationName(name)) found.push({ name, at: match.index ?? 0 });
  }
  return found;
}

/**
 * The operation a named identifier belongs to.
 *
 * The nearest operation named *before* it in the text, because that is how
 * the prose reads — "`get_item` with `full: false`" attributes `full` to
 * `get_item`. With no operation named earlier, it belongs to the operation
 * whose message this is, which is the reading for "a smaller `limit`" in
 * `list_items`' own refusal.
 */
export function attributeTo(text: string, at: number, fallback: string): string {
  let owner = fallback;
  for (const mention of mentionedOperations(text)) {
    if (mention.at < at) owner = mention.name;
  }
  return owner;
}

/**
 * Every remedy in `entries` that the operation it names would refuse.
 *
 * Three classes, all decided against a real schema rather than against a
 * second copy of the advice:
 *
 *   - **`operation`** — the advice names a tool that is not registered, so
 *     the caller has nothing to call. This is the strongest of the three:
 *     the registry is the canonical index (`registry.ts`), an operation
 *     absent from it is genuinely unreachable on every adapter, and there
 *     is no judgement involved in the lookup.
 *   - **`parameter`** — the advice instructs the caller to supply a field
 *     the attributed operation's schema has no key for. This is `my_work`'s
 *     phantom `limit`.
 *   - **`enum-value`** — the advice names a value for a field whose enum
 *     does not contain it, and no field of that operation does. This is
 *     #250's `pre_approved`-for-`pre-approved`.
 */
export function findAdviceDefects(entries: readonly AdviceEntry[]): readonly AdviceDefect[] {
  const defects: AdviceDefect[] = [];
  for (const entry of entries) {
    for (const mention of calledNames(entry.text)) {
      if (isOperationName(mention.name)) continue;
      defects.push({
        operation: entry.operation,
        source: entry.source,
        named: mention.name,
        attributedTo: mention.name,
        kind: "operation",
        detail: `advice names \`${mention.name}\`, which is not a registered operation`,
      });
    }
    for (const instructed of instructedIdentifiers(entry.text)) {
      const owner = attributeTo(entry.text, instructed.at, entry.operation);
      // An identifier that is itself an operation name is a redirect, not a
      // parameter — "use `loop_list`" names a call, not a field.
      if (isOperationName(instructed.name)) continue;
      const fields = acceptedFieldNames(owner);
      if (fields.has(instructed.name)) continue;
      const enums = acceptedEnumValues(owner);
      if (enums.has(instructed.name)) continue;
      defects.push({
        operation: entry.operation,
        source: entry.source,
        named: instructed.name,
        attributedTo: owner,
        kind: "parameter",
        detail:
          `advice tells the caller to supply \`${instructed.name}\` to \`${owner}\`, ` +
          `which accepts only: ${[...fields].sort().join(", ") || "(no fields)"}`,
      });
    }
    // The value half of `key: value`. A key the operation accepts can still
    // be paired with a member it rejects — #250's `pre_approved` against an
    // `update_item` that takes the hyphenated `pre-approved` — and that
    // reads as authoritative precisely because the key is right.
    for (const pair of instructedValues(entry.text)) {
      const owner = attributeTo(entry.text, pair.at, entry.operation);
      const fields = acceptedFieldNames(owner);
      // Only judge a value whose key the operation actually has; an unknown
      // key is already reported above, and guessing at the enum of a field
      // that does not exist would report the same defect twice.
      if (!fields.has(pair.key)) continue;
      const permitted = enumValuesForField(owner, pair.key);
      // A field with no enum accepts any string — there is nothing to check.
      if (permitted === undefined || permitted.length === 0) continue;
      if (permitted.includes(pair.value)) continue;
      defects.push({
        operation: entry.operation,
        source: entry.source,
        named: pair.value,
        attributedTo: owner,
        kind: "enum-value",
        detail:
          `advice tells the caller to send \`${pair.key}: "${pair.value}"\` to \`${owner}\`, ` +
          `which permits only: ${permitted.join(", ")}`,
      });
    }
  }
  return defects;
}

/** The enum members permitted for one field of an operation, one level deep. */
export function enumValuesForField(
  operation: string,
  field: string,
): readonly string[] | undefined {
  const found = getOperation(operation);
  if (!found) return undefined;
  for (const descriptor of describeFields(found.input)) {
    if (descriptor.name === field) return descriptor.enumValues;
    const shape = nestedShapeOf(found.input, descriptor.name);
    if (!shape) continue;
    for (const nested of describeFields(shape)) {
      if (nested.name === field) return nested.enumValues;
    }
  }
  return undefined;
}

/**
 * Backticked names the advice is telling the caller to **call**.
 *
 * **Why this is anchored on a calling verb instead of on name shape.** The
 * obvious implementation — flag any backticked `snake_case` token that is
 * not a registered operation — was written first and was wrong. This
 * codebase's fields and enum members are snake_case too, so it reported
 * `what_to_test`, `how_verified`, `not_done` and `commit_sha` (real fields
 * of `complete_item`'s summary) and `lgtm_with_nits`, `code_review`,
 * `pull_request` (real enum members of `record_artifact`) as missing tools:
 * 26 reports, 26 of them false. A check with that signal-to-noise does not
 * survive contact with a reviewer, and the row this work belongs to is
 * explicitly about not shipping a check that cannot be trusted.
 *
 * Requiring a verb of invocation is the honest narrowing. "call
 * `merge_item`" is unambiguously a tool reference; a bare `` `code_review` ``
 * in prose is not. This under-reports, and under-reporting is the correct
 * direction for a check whose false positives would be indistinguishable
 * from its true ones.
 *
 * **The recall gap was measured before it was narrowed, and the obvious fix
 * was rejected on evidence.** Resolving every backticked `snake_case` token
 * against the registry — flagging only what is neither a registered
 * operation nor any known field or enum member — sounds like it should
 * inherit the zero-false-positive property the parameter and enum-value
 * classes have. Against the live corpus it does not: it reports **three**
 * defects, all false. `item_id` is real but sits at
 * `summary.not_done[].item_id`, two levels below the input and past the
 * documented one-level walk; `commit_sha` is a free-form key inside
 * `complete_item`'s open `fields` bag, so no schema can ever vouch for it;
 * `open_loops` names a section of the progress report rather than a field.
 * All three are correct prose, and the registry cannot exonerate any of
 * them — so that widening reintroduces the first draft's failure in
 * miniature and is deliberately not taken.
 *
 * **What IS taken is a second phrasing of invocation**, which keeps the
 * identification basis exactly where it is — an explicit statement that the
 * name is something to call — while covering a construction the corpus
 * actually uses. `progress_report` says "the way to raise one is
 * `loop_add` and the way to clear one is `loop_close`": both are tool
 * references and neither carries a verb of invocation next to the name, so
 * a rule keyed only on the verb cannot see either. It matches two real
 * operations and flags nothing.
 *
 * **`use` was tried here and rejected**, on the same evidence footing as
 * `with` above: it matches `complete_item`'s "use the `decision` field",
 * where `decision` is a real field being described rather than a tool being
 * named, so adding it flags correct advice.
 */
const CALLING_PATTERNS: readonly RegExp[] = [
  // A verb of invocation immediately before the name.
  /(?:\bcall\b|\bcalling\b|\brun\b|\binvoke\b|\bvia\b)\s+(?:an?\s+|the\s+)?`([a-z][a-z0-9_]*)`/gi,
  // "the way to <do something> is `tool`" — an invocation stated as a
  // route rather than as an imperative. The `[a-z ]+` between is bounded
  // to lowercase words so it cannot leap a sentence boundary or a
  // backtick and attach the verb to a name it does not govern.
  /\bthe way to [a-z ]+ is\s+`([a-z][a-z0-9_]*)`/gi,
];

function calledNames(text: string): readonly { name: string; at: number }[] {
  const found: { name: string; at: number }[] = [];
  for (const pattern of CALLING_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name === undefined) continue;
      found.push({ name, at: match.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Every operation the registry declares, for a sweep to iterate. */
export function allOperationNames(): readonly string[] {
  return listOperations().map((operation) => operation.name);
}

/**
 * Every advice string the service layer can put in front of a caller, with
 * the operation that speaks it.
 *
 * Two sources, and they are the two that are *structured* — read from the
 * registry rather than scraped out of source text. That is the whole reason
 * this sweep can be trusted: it asks the same objects the runtime asks, so
 * an operation added tomorrow is swept without anyone remembering to add
 * it, and advice cannot hide from the check by living in a file the sweep
 * did not glob.
 *
 *   - `NARROWER_CALL` in `response-size.ts` — what a caller is told to do
 *     when a read will not fit.
 *   - `contract.rules` on each operation — the conditional rules a schema
 *     cannot state, which `describe_tool` serves to a caller who has just
 *     been refused and is the single most load-bearing advice surface here.
 *
 * Guard refusal messages are deliberately **not** included, and that is a
 * limitation worth stating rather than papering over: a guard's message is
 * built inside its `check()` from the row in front of it, so there is no
 * way to enumerate the messages without a database and a fixture per guard.
 * Scraping the string literals out of the guard sources was tried and
 * rejected — it cannot tell an instruction from an explanation, and it
 * reported 26 false defects against advice that was entirely correct.
 */
export function collectAdvice(
  narrowerCallFor: (operation: string) => string | undefined,
): readonly AdviceEntry[] {
  const entries: AdviceEntry[] = [];
  for (const operation of listOperations()) {
    const narrower = narrowerCallFor(operation.name);
    if (narrower !== undefined) {
      entries.push({
        operation: operation.name,
        source: "response-size.ts NARROWER_CALL",
        text: narrower,
      });
    }
    for (const rule of contractRulesOf(operation)) {
      entries.push({
        operation: operation.name,
        source: `${operation.name} contract.rules`,
        text: rule.rule,
      });
    }
  }
  return entries;
}

/** The declared rules of an operation, reached through the erased registry type. */
export function contractRulesOf(operation: {
  readonly name: string;
}): readonly { readonly fields: readonly string[]; readonly rule: string }[] {
  const contract = (
    operation as unknown as {
      contract?: { rules?: readonly { fields?: readonly string[]; rule?: string }[] };
    }
  ).contract;
  const rules: { fields: readonly string[]; rule: string }[] = [];
  for (const rule of contract?.rules ?? []) {
    if (typeof rule?.rule === "string") rules.push({ fields: rule.fields ?? [], rule: rule.rule });
  }
  return rules;
}

/**
 * A field that some code path refuses as *required* even though the
 * operation's own JSON Schema marks it optional — paired with whether the
 * operation's contract rules say anything about it.
 *
 * ── Why this check exists ───────────────────────────────────────────────
 *
 * A conditionally-required field is the one thing a JSON Schema genuinely
 * cannot express: `originType` is required *unless the calling session
 * registered with a personId*, which is runtime state, not shape. So the
 * schema honestly marks it optional and the server honestly refuses it, and
 * a caller reading the only machine-readable contract they have is told the
 * opposite of what will happen.
 *
 * That is precisely the gap `describe_tool` exists to close — "the
 * conditional rules its schema cannot state". The rule is therefore not
 * optional documentation; it is the *only* place the requirement is
 * stateable at all, and its absence is a defect of the same kind as a
 * missing error message.
 *
 * Two instances were reported by crews within one day (2026-08-31):
 * `create_task`'s `originType`, and `complete_item`'s summary shape. Both
 * turned out to be already documented — but nothing was *enforcing* that,
 * so the next one would have shipped undocumented and been found the same
 * expensive way, by a caller being refused.
 *
 * ── What counts as an instance ──────────────────────────────────────────
 *
 * A field is flagged only when **all three** hold, which is what keeps this
 * from firing on ordinary schema-level required fields:
 *
 *   1. some source file refuses it with an `InvalidInputError` whose message
 *      says it is required,
 *   2. the operation's schema does **not** mark it required (so the schema
 *      and the server disagree), and
 *   3. no contract rule names it in `fields`.
 *
 * Dropping (2) would flag every required field in the product; dropping (3)
 * would flag the two cases that are already correctly documented.
 */
export function findUndocumentedConditionalRequirements(
  refusals: readonly { field: string; operations: readonly string[] }[],
): readonly AdviceDefect[] {
  const defects: AdviceDefect[] = [];
  for (const { field, operations } of refusals) {
    for (const name of operations) {
      const operation = listOperations().find((candidate) => candidate.name === name);
      if (!operation) continue;
      // (2) The schema already saying "required" means a caller was never
      // misled, so there is nothing for a rule to rescue.
      if (requiredFieldNames(name).has(field)) continue;
      // (3) Documented if any rule claims the field, which is the same
      // `fields` lookup a refused caller performs.
      const documented = contractRulesOf(operation).some((rule) =>
        rule.fields.some((declared) => {
          const leaf = declared.includes(".")
            ? declared.slice(declared.lastIndexOf(".") + 1)
            : declared;
          return leaf === field;
        }),
      );
      if (documented) continue;
      defects.push({
        operation: name,
        source: `${name} contract.rules`,
        named: field,
        attributedTo: name,
        kind: "parameter",
        detail:
          `\`${field}\` is refused as required at runtime but is optional in \`${name}\`'s ` +
          `schema, and no contract rule mentions it — so the only machine-readable contract a ` +
          `caller has says the opposite of what the server does. Add a rule naming ` +
          `\`${field}\` in its \`fields\`, stating what makes it required.`,
      });
    }
  }
  return defects;
}

/**
 * Rules whose declared `fields` name something the operation has no field
 * for.
 *
 * A separate and stronger check than the prose one, because `fields` is
 * structured data rather than English: its contract (`operation.ts`) is
 * that it "match the `fields` a refusal of this rule carries, so a caller
 * that has been refused can find the rule that refused it without matching
 * on prose". A name here that no schema field answers to silently breaks
 * that lookup for exactly the caller who is already stuck — the same
 * population every defect in this class harmed.
 *
 * Dotted paths (`summary.shipped`) are resolved against the nested shape,
 * since that is how the rules address a field inside an object.
 */
export function findRuleFieldDefects(): readonly AdviceDefect[] {
  const defects: AdviceDefect[] = [];
  for (const operation of listOperations()) {
    const accepted = acceptedFieldNames(operation.name);
    for (const rule of contractRulesOf(operation)) {
      for (const field of rule.fields) {
        // A dotted path names a nested field; `acceptedFieldNames` already
        // flattens one level, so the leaf is what has to exist.
        const leaf = field.includes(".") ? field.slice(field.lastIndexOf(".") + 1) : field;
        if (accepted.has(leaf)) continue;
        defects.push({
          operation: operation.name,
          source: `${operation.name} contract.rules`,
          named: field,
          attributedTo: operation.name,
          kind: "parameter",
          detail:
            `a contract rule declares it is about \`${field}\`, which \`${operation.name}\` ` +
            `has no field for — it accepts: ${[...accepted].sort().join(", ") || "(no fields)"}`,
        });
      }
    }
  }
  return defects;
}
