// What credential the front end's forwarding route presents, and — more
// importantly — when it presents none at all.
//
// The refusals are the substance here. A resolver that returned *some*
// token whenever it could would be a resolver that turns a misconfiguration
// into a working front end with the wrong identity, and the point of
// per-machine tokens is that identity is worth something.
import { describe, expect, it } from "vitest";
import { AUTH_TOKENS_ENV_VAR } from "@/lib/auth";
import {
  BROWSER_MACHINE_ENV_VAR,
  DEFAULT_BROWSER_MACHINE,
  browserSessionToken,
} from "@/lib/auth/browser-session";

function env(tokens?: string, machine?: string): Record<string, string | undefined> {
  return {
    ...(tokens === undefined ? {} : { [AUTH_TOKENS_ENV_VAR]: tokens }),
    ...(machine === undefined ? {} : { [BROWSER_MACHINE_ENV_VAR]: machine }),
  };
}

describe("browserSessionToken", () => {
  it("resolves the token configured for the default machine name", () => {
    expect(browserSessionToken(env("browser:b-tok,laptop:l-tok"))).toBe("b-tok");
  });

  it("resolves the token for an overridden machine name", () => {
    expect(browserSessionToken(env("browser:b-tok,frontend:f-tok", "frontend"))).toBe("f-tok");
  });

  it("uses the documented default machine name", () => {
    // Pins the constant to the name the error message and the README tell an
    // operator to configure. If this drifts, the instructions send someone to
    // configure a machine the code will not look for.
    expect(DEFAULT_BROWSER_MACHINE).toBe("browser");
    expect(browserSessionToken(env(`${DEFAULT_BROWSER_MACHINE}:x`))).toBe("x");
  });

  it("returns null when nothing is configured at all", () => {
    // The fail-closed case that matters most: an unconfigured deployment
    // must not produce a usable front-end credential from nowhere.
    expect(browserSessionToken(env(undefined))).toBeNull();
  });

  it("returns null when tokens exist but none belongs to the browser machine", () => {
    // The realistic misconfiguration — tokens set up for the command-line
    // clients, nobody having added one for the front end. It must refuse
    // rather than borrow one of the others.
    expect(browserSessionToken(env("laptop:l-tok,desktop:d-tok"))).toBeNull();
  });

  it("never borrows another machine's token", () => {
    const token = browserSessionToken(env("laptop:l-tok,desktop:d-tok"));
    expect(token).not.toBe("l-tok");
    expect(token).not.toBe("d-tok");
  });

  it("returns null when the machine name is configured twice", () => {
    // Two tokens for one name means the operator's intent is unreadable.
    // Choosing one would make the answer depend on entry order.
    expect(browserSessionToken(env("browser:one,browser:two"))).toBeNull();
  });

  it("returns null when the override names an empty machine", () => {
    expect(browserSessionToken(env("browser:b-tok", "   "))).toBeNull();
  });

  it("does not match a machine name by prefix or suffix", () => {
    // `browser-staging` is a different machine from `browser`. A loose
    // comparison here would hand the front end a credential belonging to
    // something else entirely.
    expect(browserSessionToken(env("browser-staging:s-tok"))).toBeNull();
    expect(browserSessionToken(env("my-browser:m-tok"))).toBeNull();
  });

  it("ignores a malformed entry rather than reading it charitably", () => {
    // `parseTokenTable` drops entries with no separator; this asserts the
    // resolver inherits that rather than reconstructing a token from one.
    expect(browserSessionToken(env("browser"))).toBeNull();
    expect(browserSessionToken(env("browser:"))).toBeNull();
  });

  it("reads the environment per call, so a rotated token takes effect", () => {
    // Captured-at-module-load would keep serving the withdrawn token, which
    // is precisely the failure that makes revocation not work.
    expect(browserSessionToken(env("browser:first"))).toBe("first");
    expect(browserSessionToken(env("browser:second"))).toBe("second");
  });
});
