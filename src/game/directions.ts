import type { Direction, Point } from "./types";

export const DELTA: Readonly<Record<Direction, Point>> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export const OPPOSITE: Readonly<Record<Direction, Direction>> = { up: "down", down: "up", left: "right", right: "left" };

/** A snake heading `heading` may move any way except straight back into its neck. */
export function canMove(heading: Direction, to: Direction): boolean {
  return OPPOSITE[heading] !== to;
}

export function isDirection(v: unknown): v is Direction {
  return v === "up" || v === "right" || v === "down" || v === "left";
}
