#!/usr/bin/env node
// Measures the rendered size of every tap target on a page, so a claim
// about touch targets is a measurement rather than an assertion.
//
// ── Why this exists as a script rather than a test ─────────────────────
//
// The repo's harness runs `environment: "node"` with no DOM and no layout
// engine, so nothing in `tests/` can see a rendered height. The CSS tests
// that accompany this assert *mechanisms* — that a 44px `min-height` is
// declared, on a box it binds to, inside the block a phone reads — and say
// so in their own headers. This is what produces the numbers.
//
// It is not wired into CI: it needs a browser binary and a running server,
// which is a much heavier dependency than the claim justifies. Run it by
// hand when changing anything about widths or tap targets, and put the
// numbers in the pull request.
//
// ── Usage ──────────────────────────────────────────────────────────────
//
//   npx playwright install chromium          # once
//   npm run dev -- -p 3100                   # a server to point at
//   node scripts/measure-touch-targets.mjs --url http://localhost:3100/
//
// Compare against an unmodified checkout by running a second server from
// one and passing --control http://localhost:3101/. A measurement with no
// control cannot tell "this is fine" from "this never rendered", which is
// the mistake this file is shaped to prevent.
//
// Exits non-zero when a target is under the minimum, so it can gate.

const MIN_HEIGHT_PX = 44; // WCAG 2.5.5 / Apple HIG
const DEFAULT_WIDTHS = [320, 360, 390];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const url = arg("url");
const controlUrl = arg("control");
const widths = (arg("widths") ?? DEFAULT_WIDTHS.join(",")).split(",").map((w) => Number(w.trim()));
// A selector that must match at least one element, or the run is treated as
// having measured nothing. See `assertRendered`.
const requireSelector = arg("require", "a[class*=projectStripTitle]");

if (url === null) {
  console.error("Pass --url http://localhost:3100/ (see the header of this file).");
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

/**
 * Refuses to report on a page that did not render.
 *
 * The failure this exists for: a loading state, an error state or a 404 has
 * no tap targets at all, so "nothing under 44px" is true of it and looks
 * exactly like a pass. Any measurement of an empty page is thrown away
 * rather than counted. This caught a real 404 while the fix was being
 * written — the page was never rendering and every number was vacuous.
 */
function assertRendered(label, width, targets, required) {
  if (targets.length === 0) {
    throw new Error(`${label} @${width}px: zero tap targets — the page did not render.`);
  }
  if (required === 0) {
    throw new Error(
      `${label} @${width}px: nothing matched ${requireSelector} — the rows under test are absent, ` +
        `so any pass here would be vacuous.`,
    );
  }
}

async function measure(browser, label, target) {
  const perWidth = [];
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(target, { waitUntil: "networkidle" });
      const { targets, required, overflow } = await page.evaluate((selector) => {
        const nodes = [...document.querySelectorAll("a, button, input, select, [role=button]")];
        return {
          targets: nodes
            .map((el) => {
              const r = el.getBoundingClientRect();
              return {
                text: (el.textContent ?? "").trim().slice(0, 34),
                width: Math.round(r.width * 10) / 10,
                height: Math.round(r.height * 10) / 10,
              };
            })
            .filter((t) => t.width > 0 && t.height > 0),
          required: document.querySelectorAll(selector).length,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      }, requireSelector);

      assertRendered(label, width, targets, required);
      perWidth.push({ width, targets, required, overflow });
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
        `\n-- ${row.width}px | overflow ${row.overflow}px | targets ${row.targets.length} | ` +
          `matched ${requireSelector}: ${row.required} | under ${MIN_HEIGHT_PX}px: ${under.length}`,
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
  console.error(`\n${failures} tap target(s) under ${MIN_HEIGHT_PX}px.`);
  process.exit(1);
}
console.log(`\nEvery tap target is at least ${MIN_HEIGHT_PX}px tall.`);
