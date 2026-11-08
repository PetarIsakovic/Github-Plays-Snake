/** Hand-built game states used by the SVG tests and the screenshot script. */
import { newGame, type EngineConfig } from "../../src/game/engine";
import type { GameState, Point, Tally } from "../../src/game/types";

export const ENGINE: EngineConfig = { cols: 16, rows: 12, roundMs: 120_000, initialLength: 3 };
export const NOW = Date.UTC(2026, 10, 8, 14, 30, 15);

export function base(overrides: Partial<GameState> = {}): GameState {
  return { ...newGame({ gameId: "global", seed: 42, now: NOW - 35_000, config: ENGINE }), ...overrides };
}

/** Boustrophedon path over the board; the LAST element is the head end. */
export function serpentine(cols: number, rows: number, n: number): Point[] {
  const path: Point[] = [];
  for (let y = rows - 1; y >= 0 && path.length < n; y--) {
    const leftToRight = (rows - 1 - y) % 2 === 0;
    for (let i = 0; i < cols && path.length < n; i++) path.push({ x: leftToRight ? i : cols - 1 - i, y });
  }
  return path.reverse();
}

export interface Scenario {
  name: string;
  state: GameState;
  tally: Tally;
  /** Render time; defaults to NOW (85s before the deadline). */
  now?: number;
}

export function scenarios(): Scenario[] {
  const fresh = base({ roundId: 1, runId: 1 });
  const long = serpentine(16, 12, 46);
  const full = serpentine(16, 12, 16 * 12);
  return [
    { name: "fresh", state: fresh, tally: { up: 0, down: 0, left: 0, right: 0 } },
    {
      name: "voting",
      state: base({
        roundId: 1287,
        runId: 14,
        score: 7,
        bestScore: 23,
        totalVotes: 4821,
        totalMoves: 1286,
        gamesPlayed: 13,
        runMoves: 61,
        snake: [{ x: 9, y: 4 }, { x: 9, y: 5 }, { x: 9, y: 6 }, { x: 8, y: 6 }, { x: 7, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 7 }, { x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 }],
        direction: "up",
        apple: { x: 4, y: 2 },
        lastMove: { roundId: 1286, direction: "up", outcome: "ate", votes: { up: 9, down: 0, left: 2, right: 4 } },
      }),
      tally: { up: 3, down: 0, left: 12, right: 9 },
    },
    {
      name: "long-snake-high-votes",
      state: base({
        roundId: 98_765,
        runId: 321,
        score: 43,
        bestScore: 43,
        totalVotes: 1_234_567,
        totalMoves: 98_000,
        gamesPlayed: 320,
        snake: long,
        direction: long[0]!.y % 2 === 0 ? "left" : "right",
        apple: { x: 3, y: 2 },
        lastMove: { roundId: 98_764, direction: "right", outcome: "moved", votes: { up: 0, down: 0, left: 0, right: 0 } },
      }),
      tally: { up: 48_211, down: 7, left: 0, right: 99_999 },
    },
    {
      name: "gameover-self",
      state: base({
        status: "gameover",
        roundId: 2001,
        runId: 15,
        score: 12,
        bestScore: 23,
        runMoves: 140,
        gamesPlayed: 15,
        deathCause: "self",
        snake: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 6, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 4 }, { x: 3, y: 4 }],
        direction: "right",
        crashAt: { x: 6, y: 5 },
        apple: { x: 12, y: 9 },
      }),
      tally: { up: 0, down: 0, left: 0, right: 0 },
    },
    {
      name: "gameover-wall-newbest",
      state: base({
        status: "gameover",
        roundId: 3000,
        runId: 16,
        score: 31,
        bestScore: 31,
        runMoves: 402,
        gamesPlayed: 16,
        deathCause: "wall",
        snake: [{ x: 15, y: 3 }, { x: 14, y: 3 }, { x: 13, y: 3 }, { x: 12, y: 3 }],
        direction: "right",
        crashAt: { x: 16, y: 3 },
        apple: { x: 2, y: 9 },
      }),
      tally: { up: 0, down: 0, left: 0, right: 0 },
    },
    {
      name: "refresh-overlay",
      state: base({ roundId: 1287, score: 7, bestScore: 23, snake: [{ x: 9, y: 4 }, { x: 9, y: 5 }, { x: 9, y: 6 }, { x: 8, y: 6 }], direction: "up", apple: { x: 4, y: 2 } }),
      tally: { up: 3, down: 0, left: 12, right: 9 },
      now: NOW + 86_000, // past the deadline: the overlay is shown immediately
    },
    {
      name: "won",
      state: base({ status: "won", roundId: 9999, score: 189, bestScore: 189, runMoves: 5000, snake: full, apple: null, direction: "left" }),
      tally: { up: 0, down: 0, left: 0, right: 0 },
    },
  ];
}
