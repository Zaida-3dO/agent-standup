// Who holds an item, in plain words.
//
// A person reads "user-a" or "an agent", never the working name a crew or a
// session carries. Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import { holderLabel, holdersLabel } from "@/lib/design/holder-label";

const agent = (displayName: string) => ({ holderType: "agent", displayName });
const person = (displayName: string) => ({ holderType: "person", displayName });

describe("holderLabel", () => {
  it("shows an agent as 'an agent', whatever its crew name is", () => {
    // Breaks if: the agent branch returns displayName.
    expect(holderLabel(agent("crew-w7"))).toBe("an agent");
    expect(holderLabel(agent("Builder One"))).toBe("an agent");
  });

  it("shows a person by name", () => {
    // Breaks if: the plain-words rule is applied to every holder.
    expect(holderLabel(person("user-a"))).toBe("user-a");
  });
});

describe("holdersLabel", () => {
  it("collapses several agents to a count, not a list of crew names", () => {
    expect(holdersLabel([agent("crew-a"), agent("crew-b")])).toBe("2 agents");
  });

  it("lists people by name followed by the agents", () => {
    expect(holdersLabel([agent("crew-a"), person("user-a")])).toBe("user-a, an agent");
  });

  it("names a person once however many roles they hold", () => {
    expect(holdersLabel([person("user-a"), person("user-a")])).toBe("user-a");
  });

  it("is empty for nobody", () => {
    expect(holdersLabel([])).toBe("");
  });

  it("never leaks a crew name", () => {
    expect(holdersLabel([agent("crew-w7"), agent("session-9")])).not.toContain("crew");
    expect(holdersLabel([agent("crew-w7"), agent("session-9")])).not.toContain("session");
  });
});
