// Stands in for `next/font/local` when a test imports something that
// transitively loads a font.
//
// ── Why this is needed ────────────────────────────────────────────────
//
// `src/app/layout.tsx` imports `geist/font/sans`, and that package's entry
// point is one line: `import localFont from "next/font/local"`. That module
// is not an ordinary package export — it is a build-time construct the
// Next.js compiler resolves and rewrites, and it does not exist as a
// resolvable ES module outside that pipeline. Node's resolver reports it as
// `Directory import ... is not supported`.
//
// This suite runs under plain Vitest with `environment: "node"` and no Next
// compiler, so `tests/root-layout.test.ts` — which calls `RootLayout` as a
// function to assert on the element tree it returns — could not import the
// layout at all once the font was added.
//
// ── Why a stub, rather than the alternatives ──────────────────────────
//
// The options were: (a) drop Geist and lose the typeface the design system
// specifies; (b) move the font out of `layout.tsx` into something the test
// does not touch, which is a real structural distortion for a test's
// convenience; (c) give the test a DOM and a Next transform, which is
// exactly the "quietly convert the test approach" this repo's harness
// exists to avoid; or (d) this — resolve the one build-time module to a
// value with the same shape.
//
// (d) is the smallest and the most honest. It changes nothing about how any
// component is written or tested: `RootLayout` is still called as a plain
// function, still hook-free, and the assertions still inspect a real
// element tree. The only thing faked is a font loader whose real output is
// a generated class name that no assertion could meaningfully check anyway.
//
// ── What this deliberately does NOT verify ────────────────────────────
//
// That the font actually loads. It cannot — that happens in the Next build,
// and `npm run build` in CI is what proves it. What the stub preserves is
// that `layout.tsx` puts SOMETHING on `<html>`'s className, which is what
// `tests/root-layout.test.ts` asserts on.

/** The shape `next/font/local` returns for a loaded font. */
interface LoadedFont {
  readonly className: string;
  readonly variable: string;
  readonly style: { readonly fontFamily: string };
}

/**
 * A stand-in loader.
 *
 * Echoes back the caller's own `variable` rather than returning a fixed
 * string, so a test asserting that `--font-geist-sans` reached the html
 * element is asserting on something the layout actually passed through —
 * not on a constant this file made up. Two different fonts stub to two
 * different values, exactly as they would in a real build.
 */
export default function localFont(options: { variable?: string }): LoadedFont {
  const variable = options.variable ?? "--font-stub";
  return {
    className: `stub-font${variable}`,
    variable,
    style: { fontFamily: "stub" },
  };
}
