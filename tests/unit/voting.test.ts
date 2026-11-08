import { describe, expect, it } from "vitest";
import { normalizeTally, percentages, resolveDirection, tallyTotal } from "../../src/game/voting";
import { canMove, OPPOSITE } from "../../src/game/directions";
import { DIRECTIONS } from "../../src/game/types";

const T = (up = 0, down = 0, left = 0, right = 0) => ({ up, down, left, right });

describe("canMove", () => {
  it("allows every direction except straight back", () => {
    for (const h of DIRECTIONS)
      for (const d of DIRECTIONS) expect(canMove(h, d)).toBe(d !== OPPOSITE[h]);
  });
});

describe("resolveDirection", () => {
  it("picks the plurality among allowed directions", () => {
    expect(resolveDirection(T(0, 0, 3, 1), "up")).toBe("left");
    expect(resolveDirection(T(5, 0, 0, 1), "right")).toBe("up");
    expect(resolveDirection(T(0, 2, 0, 0), "right")).toBe("down");
  });
  it("keeps going with zero votes", () => {
    for (const h of DIRECTIONS) expect(resolveDirection(T(), h)).toBe(h);
  });
  it("keeps going on any tie for first", () => {
    expect(resolveDirection(T(0, 0, 4, 4), "up")).toBe("up");
    expect(resolveDirection(T(4, 0, 4, 0), "up")).toBe("up");
    expect(resolveDirection(T(3, 3, 0, 0), "right")).toBe("right");
  });
  it("ignores votes for the reverse direction", () => {
    // Heading up: 'down' can never win, even with the most votes.
    expect(resolveDirection(T(0, 99, 1, 0), "up")).toBe("left");
    expect(resolveDirection(T(0, 99, 0, 0), "up")).toBe("up");
  });
});

describe("percentages", () => {
  it("sums to 100", () => {
    const p = percentages(T(1, 1, 1, 0));
    expect(p.up + p.down + p.left + p.right).toBe(100);
    expect(percentages(T(3, 0, 12, 9))).toEqual(T(13, 0, 50, 37));
  });
  it("is all zero with no votes", () => {
    expect(percentages(T())).toEqual(T());
  });
});

describe("normalizeTally", () => {
  it("drops garbage, negatives and unknown keys (e.g. a legacy 'straight' counter)", () => {
    expect(normalizeTally({ up: -3, down: "7", left: 2.9, straight: 5 } as Record<string, unknown>)).toEqual(T(0, 0, 2, 0));
    expect(normalizeTally(undefined)).toEqual(T());
    expect(tallyTotal(T(1, 2, 3, 4))).toBe(10);
  });
});
