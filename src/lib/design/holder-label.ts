// How the board names whoever holds an item.
//
// A person reads "Dana" or "an agent" - not the working name a crew or a
// session happens to carry, which means nothing outside the code that hands
// it out. The name stays on the record (and on operator screens such as the
// fleet page, where it is the thing being managed); the surfaces a person
// scans for "who has this" show plain words.
//
// Pure, no DOM.

/** The plain-words label for a holder: the person's name, or "an agent". */
export function holderLabel(holder: {
  readonly holderType: string;
  readonly displayName: string;
}): string {
  return holder.holderType === "agent" ? "an agent" : holder.displayName;
}

/** Several holders as one phrase: "Dana, an agent", with agents collapsed ("2 agents"). */
export function holdersLabel(
  holders: readonly { readonly holderType: string; readonly displayName: string }[],
): string {
  const people = [
    ...new Set(holders.filter((h) => h.holderType !== "agent").map((h) => h.displayName)),
  ];
  const agents = holders.filter((h) => h.holderType === "agent").length;
  const parts = [...people];
  if (agents === 1) parts.push("an agent");
  else if (agents > 1) parts.push(`${agents} agents`);
  return parts.join(", ");
}
