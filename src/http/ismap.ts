/**
 * Decoding of server-side image map clicks.
 *
 * When an <img ismap> inside <a href="U"> is clicked, the browser navigates to
 * `U?x,y`, where x,y are integer CSS-pixel offsets from the image's top-left corner
 * IN THE RENDERED SIZE. GitHub constrains README images with `max-width: 100%`, so
 * in a column narrower than the image it is scaled down by an
 * unknown factor s (0 < s <= 1) and we receive (s*X, s*Y) for a true point (X, Y).
 *
 * The server cannot know s. Every candidate true point lies on the ray from the
 * origin through the received point: (x, y) * t for t in [1, 1/sMin]. We therefore:
 *
 *   1. interpret the click at s = 1 (by far the common desktop case), and
 *   2. accept a vote only if NO OTHER visible vote button intersects that ray
 *      inside the image. Otherwise the click is ambiguous and is ignored.
 *
 * The vote buttons are the bottom-most interactive row, so a scaled click
 * anywhere in the image either maps to the right button or is dropped. It can
 * never record the wrong direction. Small phone screens (s around 0.4) never reach the
 * button row at s = 1, so their clicks are ignored and the embed offers plain
 * text links as the mobile/accessible fallback.
 */
import { DIRECTIONS, type Direction } from "../game/types";
import { contains, type Layout, type Rect } from "../render/layout";

/** Smallest scale we guard against (a 320px-wide phone column is ~0.33). */
export const MIN_SCALE = 0.25;

export interface Click {
  x: number;
  y: number;
}

/**
 * Parse the raw query string produced by an ismap click. Strict: two small
 * non-negative integers, in one of two shapes:
 *
 *   `x,y`      the classic form, for an href without a query (`.../vote`)
 *   `c=?x,y`   for href `.../vote?c=`. Browsers append the `?x,y` suffix to
 *              the serialized href string (WHATWG "follow the hyperlink"), so the
 *              coordinates end up inside the value of `c`.
 *
 * The second form exists because AWS Lambda Function URLs reject a request whose
 * query-string KEY contains a comma (`?84,585` -> 400 before our code runs), while
 * a comma inside a value is fine. Verified against the live Function URL.
 */
export function parseIsmapQuery(rawQuery: string | undefined | null): Click | null {
  if (!rawQuery) return null;
  const m = /^(?:c=(?:\?|%3F)?)?(\d{1,5})(?:,|%2C)(\d{1,5})$/i.exec(rawQuery);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

export type HitResult =
  | { kind: "vote"; direction: Direction }
  | { kind: "ambiguous"; candidates: Direction[] }
  | { kind: "none" }
  | { kind: "out-of-range" };

/** Does the segment from (x,y)*t0 to (x,y)*t1 intersect rectangle r? (slab method) */
function rayHitsRect(x: number, y: number, t0: number, t1: number, r: Rect): boolean {
  let lo = t0;
  let hi = t1;
  for (const [p, a, b] of [
    [x, r.x, r.x + r.w],
    [y, r.y, r.y + r.h],
  ] as const) {
    if (p === 0) {
      if (0 < a || 0 >= b) return false;
      continue;
    }
    let ta = a / p;
    let tb = b / p;
    if (ta > tb) [ta, tb] = [tb, ta];
    lo = Math.max(lo, ta);
    hi = Math.min(hi, tb);
    if (lo >= hi) return false;
  }
  return true;
}

export function hitTest(layout: Layout, click: Click): HitResult {
  const { x, y } = click;
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return { kind: "out-of-range" };

  const direct = DIRECTIONS.find((t) => contains(layout.hitAreas[t], x, y)) ?? null;
  if (!direct) return { kind: "none" };

  // Farthest the true point can be along the ray while staying inside the image.
  const tMax = Math.min(1 / MIN_SCALE, layout.width / Math.max(x, 1e-9), layout.height / Math.max(y, 1e-9));
  const others = DIRECTIONS.filter((t) => t !== direct && rayHitsRect(x, y, 1, tMax, layout.controls[t]));
  if (others.length > 0) return { kind: "ambiguous", candidates: [direct, ...others] };
  return { kind: "vote", direction: direct };
}
