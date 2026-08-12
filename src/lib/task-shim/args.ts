// Argument parsing for `task-shim` — deliberately its own copy rather than
// `src/lib/cli/args.ts`. That module returns `src/lib/cli/envelope.ts`'s
// error shape, which is this row's *new* contract, not the reduced one this
// surface has to keep instead — and importing it would mean the day this
// surface is deleted (MILESTONES.md #40), untangling a shared dependency
// rather than removing one file.
//
// Only `--flag value` is supported — no `--flag=value`, no bare booleans.
// The five commands below never take a boolean flag, so there is nothing for
// that second form to do.

export interface ShimParsed {
  readonly command: string | undefined;
  readonly rest: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

export function parseShimArgs(argv: readonly string[]): ShimParsed {
  const words: string[] = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        index += 1;
      } else {
        flags[name] = "";
      }
      continue;
    }

    words.push(token);
  }

  const [command, ...rest] = words;
  return { command, rest, flags };
}
