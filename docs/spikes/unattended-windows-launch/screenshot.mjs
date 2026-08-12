#!/usr/bin/env node
/**
 * Spike-only. Not part of the app: never imported by anything under src/,
 * not wired into npm ci, npm test, npm run build, or CI. Exists purely so
 * TEST-PROTOCOL.md has something to point a scheduled task at.
 *
 * Launches a *headed* (non-headless) Chromium via Playwright's own Node
 * API and screenshots one static page. The library API is used rather
 * than Playwright's `screenshot` CLI subcommand because that subcommand
 * has no headed option -- checked directly against
 * `npx playwright screenshot --help`, not assumed -- and a headless run
 * would answer a different, easier question than the one this spike is
 * for (see docs/spikes/unattended-windows-launch/SPIKE.md).
 *
 * Needs the `playwright` package resolvable, which this repository does
 * not install by default. See TEST-PROTOCOL.md for the one-time setup.
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: node screenshot.mjs <output-directory>");
  process.exit(2);
}

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(outDir, `shot-${stamp}.png`);

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage();
  await page.setContent(
    `<h1>agent-standup spike</h1><p>unattended-windows-launch</p><p>${new Date().toISOString()}</p>`,
  );
  const buffer = await page.screenshot();
  await writeFile(outPath, buffer);
  // This repository's own probe script (not the launcher, which never calls
  // this file directly) reads the last line of stdout as the written path.
  console.log(outPath);
} finally {
  await browser.close();
}
