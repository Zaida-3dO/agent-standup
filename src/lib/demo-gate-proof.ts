/**
 * Scratch fixture proving the mutation job executes in CI on a source change.
 * Not for merge.
 */
export function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
