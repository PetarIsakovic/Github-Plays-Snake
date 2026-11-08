/**
 * Single source of truth for the SVG geometry. The renderer draws from these
 * numbers and the ismap click decoder hit-tests against the same numbers, so the
 * two can never drift apart.
 *
 * Width is 512 CSS px: narrower than GitHub's README column on any laptop or
 * desktop window (the column is ~730px on a 1245px-wide window, 846px at >= 1280px),
 * so the image is never scaled down there and ismap click coordinates are exact.
 * Height (~500px) fits below GitHub's profile header on a MacBook screen.
 * The embed uses width="512" and no height, so the browser keeps the aspect ratio.
 */
import { DIRECTIONS, type Direction } from "../game/types";

export const WIDTH = 512;
export const PAD = 16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  /** Left/right edges of the centred content column (board width). */
  contentX: number;
  contentW: number;
  headerBaseline: number;
  board: Rect;
  cell: number;
  /** Hairline round-progress bar under the board. */
  bar: Rect;
  statusBaseline: number;
  /** Visible buttons, left to right: left, up, down, right. */
  controls: Record<Direction, Rect>;
  /**
   * Clickable areas: each button extended to the image's bottom/side edges and to
   * the middle of the gaps. The button row is the bottom edge of the image, which
   * makes scaled clicks decodable (see http/ismap.ts).
   */
  hitAreas: Record<Direction, Rect>;
  controlsRow: Rect;
}

const layoutCache = new Map<string, Layout>();

export function layoutFor(cols: number, rows: number): Layout {
  const key = `${cols}x${rows}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const cell = Math.max(12, Math.min(Math.floor((WIDTH - 2 * PAD) / cols), Math.floor(360 / rows)));
  const contentW = cols * cell;
  const contentX = Math.round((WIDTH - contentW) / 2);

  const headerBaseline = PAD + 13;
  const board: Rect = { x: contentX, y: headerBaseline + 11, w: contentW, h: rows * cell };
  const bar: Rect = { x: contentX, y: board.y + board.h + 8, w: contentW, h: 2 };
  const statusBaseline = bar.y + 20;

  const gap = 6;
  const controlsTop = statusBaseline + 12;
  const controlH = 44;
  const controlW = (contentW - gap * (DIRECTIONS.length - 1)) / DIRECTIONS.length;
  const controls = {} as Record<Direction, Rect>;
  DIRECTIONS.forEach((d, i) => {
    controls[d] = { x: contentX + i * (controlW + gap), y: controlsTop, w: controlW, h: controlH };
  });
  const height = controlsTop + controlH + PAD;
  const controlsRow: Rect = { x: contentX, y: controlsTop, w: contentW, h: controlH };

  const hitAreas = {} as Record<Direction, Rect>;
  DIRECTIONS.forEach((d, i) => {
    const left = i === 0 ? 0 : controls[d].x - gap / 2;
    const right = i === DIRECTIONS.length - 1 ? WIDTH : controls[d].x + controlW + gap / 2;
    hitAreas[d] = { x: left, y: controlsTop, w: right - left, h: height - controlsTop };
  });

  const layout: Layout = { width: WIDTH, height, contentX, contentW, headerBaseline, board, cell, bar, statusBaseline, controls, hitAreas, controlsRow };
  layoutCache.set(key, layout);
  return layout;
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
