#!/usr/bin/env node
// Measures touch-target height and header chrome height on `/board` at
// phone widths — row 74ef86fb-9da8-4ab1-9b63-9eb84bd43ee6.
//
// A thin, purpose-built sibling of `measure-touch-targets.mjs`: that
// harness assumes an unauthenticated page with content on first paint.
// `/board` requires a profile to be chosen first (`ProfileProvider`), so
// this script does that one extra step — click a named profile in the
// picker — then reuses the same measurement and the same
// zero-targets-is-vacuous guard that script's header explains.
//
// Not wired into CI, same reasoning as `measure-touch-targets.mjs`: needs a
// browser binary and two running servers (measured + control). Run by hand,
// numbers go in the PR.
//
//   node scripts/measure-board-mobile.mjs --url http://localhost:3101/board \
//     --control http://localhost:3102/board --profile "User A"

const MIN_HEIGHT_PX = 44;
const DEFAULT_WIDTHS = [320, 360, 390];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const url = arg("url");
const controlUrl = arg("control");
const profileName = arg("profile", "User A");
const widths = (arg("widths") ?? DEFAULT_WIDTHS.join(",")).split(",").map((w) => Number(w.trim()));

if (url === null) {
  console.error("Pass --url http://localhost:3101/board (see the header of this file).");
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed. It is deliberately not a dependency of this\n" +
      "repository — install it just for this measurement:\n\n" +
      "  npm install --no-save playwright && npx playwright install chromium\n",
  );
  process.exit(2);
}

/** Same shape as measure-touch-targets.mjs's guard: a page that measured nothing reports nothing. */
function assertRendered(label, width, targets) {
  if (targets.length === 0) {
    throw new Error(`${label} @${width}px: zero tap targets — the page did not render.`);
  }
}

async function measure(browser, label, target) {
  const perWidth = [];
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await page.goto(target, { waitUntil: "networkidle", timeout: 30000 });
      // Choose a profile if the picker is showing — a fresh browser context
      // has no `localStorage`, so every run starts here. Idempotent: if the
      // picker never appears (already chosen) this simply finds nothing and
      // moves on.
      const profileButton = page.getByText(profileName, { exact: true });
      if (await profileButton.count()) {
        await profileButton.first().click();
        await page.waitForLoadState("networkidle");
      }
      // The board's columns are fetched client-side, after the shell and
      // the profile picker's own request — `networkidle` after the click
      // does not wait for this second, later fetch. Waiting on a real card
      // link is what makes the count non-vacuous rather than a fixed delay
      // that is either too short (an empty-board false pass) or wastefully
      // long. Falls through on timeout so a genuinely empty board still
      // gets measured and hits `assertRendered` below instead of hanging.
      await page.waitForSelector("a[href^='/items/']", { timeout: 8000 }).catch(() => {});

      const result = await page.evaluate(() => {
        const nodes = [
          ...document.querySelectorAll("button, a, input, select, [role=button], [role=tab]"),
        ];
        const targets = nodes
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              text: (el.textContent ?? "").trim().slice(0, 40),
              width: Math.round(r.width * 10) / 10,
              height: Math.round(r.height * 10) / 10,
            };
          })
          .filter((t) => t.width > 0 && t.height > 0);

        const firstCard = document.querySelector("a[href^='/items/']");
        const firstCardTop = firstCard
          ? firstCard.getBoundingClientRect().top + window.scrollY
          : null;

        return {
          targets,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          firstCardTop,
        };
      });

      assertRendered(label, width, result.targets);
      perWidth.push({ width, ...result });
    } finally {
      await page.close();
    }
  }
  return perWidth;
}

const browser = await chromium.launch();
let failures = 0;
try {
  const runs = [["measured", url]];
  if (controlUrl !== null) runs.unshift(["control", controlUrl]);

  for (const [label, target] of runs) {
    console.log(`\n===== ${label}: ${target} =====`);
    for (const row of await measure(browser, label, target)) {
      const under = row.targets.filter((t) => t.height < MIN_HEIGHT_PX);
      console.log(
        `\n-- ${row.width}px | overflow ${row.overflow}px | first card top ${row.firstCardTop}px | ` +
          `targets ${row.targets.length} | under ${MIN_HEIGHT_PX}px: ${under.length}`,
      );
      for (const t of under) {
        console.log(
          `     UNDER ${String(t.width).padStart(7)} x ${String(t.height).padStart(6)}  ${t.text}`,
        );
      }
      if (label === "measured") failures += under.length;
    }
  }
} finally {
  await browser.close();
}

if (failures > 0) {
  console.error(`\n${failures} tap target(s) under ${MIN_HEIGHT_PX}px on the measured branch.`);
  process.exit(1);
}
console.log(`\nEvery tap target on the measured branch is at least ${MIN_HEIGHT_PX}px tall.`);
