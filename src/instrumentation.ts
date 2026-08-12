// Next.js runs `register()` exactly once, in the Node.js runtime, before
// the server starts handling requests — the same "before the process can
// reach the database" moment §17 of SCHEMA.md draws the bootstrap/settings
// line at. This is where the retired-environment-variable check (#90) runs.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    // Also invoked once for the edge runtime; the check reads a registry
    // that imports zod and Node process.env, neither of which the edge
    // runtime needs this for, so it runs exactly once, on the Node side.
    return;
  }

  const { checkFormerEnv } = await import("./lib/settings/former-env-check");
  checkFormerEnv();
}
