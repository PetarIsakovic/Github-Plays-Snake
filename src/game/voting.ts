import { canMove } from "./directions";
import { DIRECTIONS, type Direction, type Tally } from "./types";

export const EMPTY_TALLY: Readonly<Tally> = Object.freeze({ up: 0, down: 0, left: 0, right: 0 });

export function tallyTotal(t: Tally): number {
  return t.up + t.down + t.left + t.right;
}

/**
 * Decide where the snake goes.
 *
 * - Only directions that don't reverse the snake count.
 * - A strict plurality wins.
 * - No votes, or a tie for first place, means: keep going the current way.
 */
export function resolveDirection(t: Tally, heading: Direction): Direction {
  const allowed = DIRECTIONS.filter((d) => canMove(heading, d));
  const max = Math.max(...allowed.map((d) => t[d]));
  if (max <= 0) return heading;
  const leaders = allowed.filter((d) => t[d] === max);
  return leaders.length === 1 ? leaders[0]! : heading;
}

/** Whole-number percentages that sum to 100 (largest-remainder method), or all 0. */
export function percentages(t: Tally): Tally {
  const total = tallyTotal(t);
  if (total === 0) return { ...EMPTY_TALLY };
  const raw = DIRECTIONS.map((k) => (t[k] / total) * 100);
  const floors = raw.map(Math.floor);
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floors[i]!++;
    remaining--;
  }
  const out = { ...EMPTY_TALLY };
  DIRECTIONS.forEach((d, i) => (out[d] = floors[i]!));
  return out;
}

/** Sanitize a tally coming from storage: non-negative integers only, unknown keys dropped. */
export function normalizeTally(raw: Partial<Record<string, unknown>> | null | undefined): Tally {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { up: n(raw?.up), down: n(raw?.down), left: n(raw?.left), right: n(raw?.right) };
}
