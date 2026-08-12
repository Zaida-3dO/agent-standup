// A minimal way to test a hook-free React component's OUTPUT without a DOM.
//
// A function component is just a function: calling it directly (rather
// than mounting it through a renderer) returns the React element tree it
// would produce — a plain object graph (`{ type, props, ... }`) built by
// JSX's `createElement` calls. Walking that tree lets a test assert on
// structure (which element, which props, which children) and even invoke a
// prop that's an event handler directly (it's just a function reference)
// — all without jsdom or `@testing-library/react`, neither of which this
// repo's test harness installs (`vitest.config.ts`: `environment: "node"`).
//
// This only works for components with NO hooks — one calling `useState`,
// `useEffect` or `useContext` throws outside a real render pass ("Invalid
// hook call"). The presentational components under `src/components/` are
// deliberately kept hook-free for exactly this reason; see e.g.
// `TopBar.tsx`'s header.
import type { ReactElement, ReactNode } from "react";

/** True if `node` is a React element (has the shape JSX produces), not a string/number/null/array. */
function isElement(node: ReactNode): node is ReactElement {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

/** Depth-first walk of an element tree, yielding every element (not text/null) it contains, itself included. */
export function* walk(node: ReactNode): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isElement(node)) return;
  yield node;
  const children = (node.props as { children?: ReactNode }).children;
  if (children !== undefined) yield* walk(children);
}

/** Every element in the tree whose `type` (tag name or component function) matches `type`. */
export function findAllByType(root: ReactNode, type: unknown): ReactElement[] {
  return [...walk(root)].filter((el) => el.type === type);
}

/** The single element whose `type` matches, or throws — for assertions that expect exactly one. */
export function findOneByType(root: ReactNode, type: unknown): ReactElement {
  const matches = findAllByType(root, type);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one element of type ${String(type)}, found ${matches.length}.`,
    );
  }
  return matches[0]!;
}
