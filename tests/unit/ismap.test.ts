import { describe, expect, it } from "vitest";
import { hitTest, MIN_SCALE, parseIsmapQuery } from "../../src/http/ismap";
import { layoutFor, WIDTH, type Rect } from "../../src/render/layout";
import { DIRECTIONS, type Direction } from "../../src/game/types";

const L = layoutFor(12, 9); // the default board
const centre = (d: Direction) => ({ x: L.controls[d].x + L.controls[d].w / 2, y: L.controls[d].y + L.controls[d].h / 2 });
const inside = (R: Rect, X: number, Y: number) => X >= R.x && X < R.x + R.w && Y >= R.y && Y < R.y + R.h;

describe("parseIsmapQuery", () => {
  it("accepts browser-appended coordinates", () => {
    expect(parseIsmapQuery("250,120")).toEqual({ x: 250, y: 120 });
    expect(parseIsmapQuery("0,0")).toEqual({ x: 0, y: 0 });
  });
  it("accepts the Function-URL-safe form produced by href '/vote?c='", () => {
    expect(parseIsmapQuery("c=?250,120")).toEqual({ x: 250, y: 120 });
    expect(parseIsmapQuery("c=%3F250,120")).toEqual({ x: 250, y: 120 });
    expect(parseIsmapQuery("c=%3f250%2C120")).toEqual({ x: 250, y: 120 });
    expect(parseIsmapQuery("c=250,120")).toEqual({ x: 250, y: 120 });
  });
  it.each(["", "250", "250,", ",1", "-1,5", "1.5,2", "1,2,3", "x=1&y=2", "99999999,1", "1, 2", "%20", "1,2&theme=dark", "c=", "c=?", "c=?1", "d=?1,2", "c=?1,2&c=?3,4", "c=??1,2"])(
    "rejects %j",
    (q) => expect(parseIsmapQuery(q)).toBeNull(),
  );
});

describe("layout", () => {
  it("is 512 wide, everything inside the image, four buttons left-to-right along the bottom", () => {
    expect(L.width).toBe(WIDTH);
    for (const r of [L.board, L.bar, ...DIRECTIONS.map((d) => L.controls[d])]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(L.width);
      expect(r.y + r.h).toBeLessThanOrEqual(L.height);
    }
    for (let i = 1; i < DIRECTIONS.length; i++) {
      const a = L.controls[DIRECTIONS[i - 1]!];
      expect(a.x + a.w).toBeLessThan(L.controls[DIRECTIONS[i]!].x);
    }
    for (const d of DIRECTIONS) {
      expect(L.controls[d].y).toBeGreaterThan(L.board.y + L.board.h);
      expect(L.controls[d].w).toBeGreaterThanOrEqual(90);
      expect(L.hitAreas[d].y + L.hitAreas[d].h).toBe(L.height);
    }
  });
});

describe("hitTest at native size", () => {
  it("maps each button centre to its direction", () => {
    for (const d of DIRECTIONS) expect(hitTest(L, centre(d))).toEqual({ kind: "vote", direction: d });
  });
  it("ignores clicks on the board, header and status line", () => {
    expect(hitTest(L, { x: L.board.x + 50, y: L.board.y + 50 })).toEqual({ kind: "none" });
    expect(hitTest(L, { x: 100, y: 20 })).toEqual({ kind: "none" });
    expect(hitTest(L, { x: 400, y: L.statusBaseline })).toEqual({ kind: "none" });
  });
  it("covers margins and gaps in the bottom band", () => {
    expect(hitTest(L, { x: 5, y: L.height - 5 })).toEqual({ kind: "vote", direction: "left" });
    expect(hitTest(L, { x: L.width - 5, y: L.height - 5 }).kind).not.toBe("none");
  });
  it("rejects out-of-range coordinates", () => {
    expect(hitTest(L, { x: L.width, y: 10 })).toEqual({ kind: "out-of-range" });
    expect(hitTest(L, { x: 10, y: L.height })).toEqual({ kind: "out-of-range" });
  });
  it("most of each button's area is an unambiguous vote", () => {
    for (const d of DIRECTIONS) {
      const R = L.controls[d];
      let ok = 0;
      let total = 0;
      for (let x = R.x; x < R.x + R.w; x += 2)
        for (let y = R.y; y < R.y + R.h; y += 2) {
          total++;
          const h = hitTest(L, { x, y });
          if (h.kind === "vote") {
            expect(h.direction).toBe(d);
            ok++;
          }
        }
      expect(ok / total).toBeGreaterThan(0.85);
    }
  });
});

describe("hitTest when GitHub scales the image down", () => {
  it("never attributes a click on one button to a different button, at any scale", () => {
    let wrong = 0;
    let clicks = 0;
    for (let s = 1; s >= MIN_SCALE; s -= 0.01)
      for (let X = 0; X < L.width; X += 6)
        for (let Y = 0; Y < L.height; Y += 6) {
          const h = hitTest(L, { x: Math.floor(X * s), y: Math.floor(Y * s) });
          if (h.kind !== "vote") continue;
          clicks++;
          if (DIRECTIONS.some((d) => d !== h.direction && inside(L.controls[d], X, Y))) wrong++;
        }
    expect(clicks).toBeGreaterThan(0);
    expect(wrong).toBe(0);
  });

  it("phone-width clicks on the buttons are ignored (not mis-attributed)", () => {
    const s = 0.4; // a shrunk image (e.g. a very narrow window or tablet split view)
    for (const d of DIRECTIONS) {
      const c = centre(d);
      expect(hitTest(L, { x: Math.floor(c.x * s), y: Math.floor(c.y * s) }).kind).not.toBe("vote");
    }
  });
});
