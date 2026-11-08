import { describe, expect, it } from "vitest";
import { advance, initialSnake, newGame, scheduleNext, spawnApple, startRun, step, type EngineConfig } from "../../src/game/engine";
import { DELTA } from "../../src/game/directions";
import type { Direction, GameState, Point } from "../../src/game/types";

const CFG: EngineConfig = { cols: 8, rows: 6, roundMs: 120_000, initialLength: 3 };
const T0 = 1_700_000_000_000;

function game(over: Partial<GameState> = {}): GameState {
  return { ...newGame({ gameId: "t", seed: 7, now: T0, config: CFG }), ...over };
}
const noVotes = { up: 0, down: 0, left: 0, right: 0 };

describe("no reversing", () => {
  it("a reverse direction is ignored and the snake keeps its heading", () => {
    const pairs: [Direction, Direction][] = [["up", "down"], ["down", "up"], ["left", "right"], ["right", "left"]];
    for (const [heading, reverse] of pairs) {
      const snake: Point[] = [{ x: 4, y: 3 }, { x: 4 - DELTA[heading].x, y: 3 - DELTA[heading].y }];
      const r = step({ snake, direction: heading, apple: null, cols: 8, rows: 6, rng: 1 }, reverse);
      expect(r.direction).toBe(heading);
      expect(r.snake[0]).toEqual({ x: 4 + DELTA[heading].x, y: 3 + DELTA[heading].y });
    }
  });
});

describe("movement", () => {
  const snake: Point[] = [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }];
  const base = { snake, direction: "right" as Direction, apple: { x: 7, y: 0 }, cols: 8, rows: 6, rng: 1 };

  it.each([
    ["right", { x: 4, y: 3 }, "right"],
    ["up", { x: 3, y: 2 }, "up"],
    ["down", { x: 3, y: 4 }, "down"],
  ] as const)("%s moves the head to %j and the body follows", (turn, head, dir) => {
    const r = step(base, turn);
    expect(r.outcome).toBe("moved");
    expect(r.direction).toBe(dir);
    expect(r.snake).toEqual([head, { x: 3, y: 3 }, { x: 2, y: 3 }]);
    expect(r.snake).toHaveLength(3);
  });

  it("moves in all four absolute directions", () => {
    const mid: Point[] = [{ x: 4, y: 3 }, { x: 4, y: 4 }];
    expect(step({ ...base, snake: mid, direction: "up" }, "up").snake[0]).toEqual({ x: 4, y: 2 });
    expect(step({ ...base, snake: [{ x: 4, y: 3 }, { x: 4, y: 2 }], direction: "down" }, "down").snake[0]).toEqual({ x: 4, y: 4 });
    expect(step({ ...base, snake: [{ x: 4, y: 3 }, { x: 5, y: 3 }], direction: "left" }, "left").snake[0]).toEqual({ x: 3, y: 3 });
    expect(step({ ...base, snake: [{ x: 4, y: 3 }, { x: 3, y: 3 }], direction: "right" }, "right").snake[0]).toEqual({ x: 5, y: 3 });
  });
});

describe("eating and growth", () => {
  it("grows by one, scores, and respawns the apple outside the snake", () => {
    const s = { snake: [{ x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }], direction: "right" as Direction, apple: { x: 4, y: 3 }, cols: 8, rows: 6, rng: 99 };
    const r = step(s, "right");
    expect(r.outcome).toBe("ate");
    expect(r.scoreDelta).toBe(1);
    expect(r.snake).toEqual([{ x: 4, y: 3 }, { x: 3, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 3 }]);
    expect(r.apple).not.toBeNull();
    expect(r.snake.some((p) => p.x === r.apple!.x && p.y === r.apple!.y)).toBe(false);
    expect(r.rng).not.toBe(99);
  });

  it("advance() updates score, best score and counters", () => {
    const g = game({ snake: [{ x: 3, y: 3 }, { x: 2, y: 3 }], direction: "right", apple: { x: 4, y: 3 }, score: 4, bestScore: 4 });
    const { state } = advance(g, noVotes, T0 + 120_000, CFG);
    expect(state.score).toBe(5);
    expect(state.bestScore).toBe(5);
    expect(state.snake).toHaveLength(3);
    expect(state.runMoves).toBe(g.runMoves + 1);
    expect(state.lastMove?.outcome).toBe("ate");
  });
});

describe("collisions", () => {
  it("dies on each wall", () => {
    const at = (snake: Point[], direction: Direction) => step({ snake, direction, apple: null, cols: 8, rows: 6, rng: 1 }, direction);
    expect(at([{ x: 7, y: 2 }, { x: 6, y: 2 }], "right")).toMatchObject({ outcome: "died", deathCause: "wall", crashAt: { x: 8, y: 2 } });
    expect(at([{ x: 0, y: 2 }, { x: 1, y: 2 }], "left")).toMatchObject({ outcome: "died", deathCause: "wall" });
    expect(at([{ x: 3, y: 0 }, { x: 3, y: 1 }], "up")).toMatchObject({ outcome: "died", deathCause: "wall" });
    expect(at([{ x: 3, y: 5 }, { x: 3, y: 4 }], "down")).toMatchObject({ outcome: "died", deathCause: "wall" });
  });

  it("dies when biting its body", () => {
    // Head at (2,2) heading up; body curls so that turning right hits (3,2).
    const snake = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }, { x: 3, y: 1 }];
    const r = step({ snake, direction: "up", apple: null, cols: 8, rows: 6, rng: 1 }, "right");
    expect(r).toMatchObject({ outcome: "died", deathCause: "self", crashAt: { x: 3, y: 2 } });
    expect(r.snake).toBe(snake); // body unchanged on death
  });

  it("may enter the cell its tail is vacating", () => {
    // A 2x2 loop: the head chases its own tail.
    const snake = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }];
    const r = step({ snake, direction: "up", apple: { x: 7, y: 5 }, cols: 8, rows: 6, rng: 1 }, "right");
    expect(r.outcome).toBe("moved");
    expect(r.snake[0]).toEqual({ x: 3, y: 2 });
  });

  it("may NOT enter the tail cell when growing (the tail stays)", () => {
    const snake = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }];
    // Apple on the tail cell is impossible in real play, but the rule must hold.
    const r = step({ snake, direction: "up", apple: { x: 3, y: 2 }, cols: 8, rows: 6, rng: 1 }, "right");
    expect(r).toMatchObject({ outcome: "died", deathCause: "self" });
  });
});

describe("apple spawning", () => {
  it("never spawns inside the snake, for many seeds", () => {
    const { snake } = initialSnake(8, 6, 3);
    for (let seed = 0; seed < 500; seed++) {
      const { apple } = spawnApple(snake, 8, 6, seed);
      expect(apple).not.toBeNull();
      expect(snake.some((p) => p.x === apple!.x && p.y === apple!.y)).toBe(false);
    }
  });

  it("is deterministic for a given seed", () => {
    const { snake } = initialSnake(8, 6, 3);
    expect(spawnApple(snake, 8, 6, 1234)).toEqual(spawnApple(snake, 8, 6, 1234));
  });

  it("reaches the single remaining free cell", () => {
    const snake: Point[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (!(x === 1 && y === 1)) snake.push({ x, y });
    for (let seed = 0; seed < 20; seed++) expect(spawnApple(snake, 3, 3, seed).apple).toEqual({ x: 1, y: 1 });
  });

  it("returns null when the board is full", () => {
    const snake: Point[] = [];
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) snake.push({ x, y });
    expect(spawnApple(snake, 2, 2, 5).apple).toBeNull();
  });
});

describe("full-board victory", () => {
  it("wins when eating the last free cell", () => {
    // 2x3 board (cols=3, rows=2): snake covers 5 cells, apple on the last one.
    const snake = [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    const r = step({ snake, direction: "right", apple: { x: 2, y: 1 }, cols: 3, rows: 2, rng: 3 }, "right");
    expect(r.outcome).toBe("won");
    expect(r.apple).toBeNull();
    expect(r.snake).toHaveLength(6);
  });

  it("advance() marks the game won and records the run", () => {
    const cfg = { ...CFG, cols: 3, rows: 2 };
    const g = { ...newGame({ gameId: "t", seed: 1, now: T0, config: cfg }), snake: [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], direction: "right" as Direction, apple: { x: 2, y: 1 } };
    const { state, run } = advance(g, noVotes, T0 + 1, cfg);
    expect(state.status).toBe("won");
    expect(run?.result).toBe("won");
    expect(state.gamesPlayed).toBe(1);
  });
});

describe("game lifecycle", () => {
  it("newGame starts playing in round 1 with a valid snake and apple", () => {
    const g = game();
    expect(g.status).toBe("playing");
    expect(g.roundId).toBe(1);
    expect(g.runId).toBe(1);
    expect(g.snake).toHaveLength(3);
    expect(g.nextTickAt).toBe(T0 + CFG.roundMs);
    expect(g.snake.some((p) => p.x === g.apple!.x && p.y === g.apple!.y)).toBe(false);
  });

  it("the game-over screen lasts gameOverMs (e.g. 30s), not a full round", () => {
    const g = game({ snake: [{ x: 7, y: 2 }, { x: 6, y: 2 }], direction: "right" });
    const died = advance(g, noVotes, T0 + 120_000, { ...CFG, gameOverMs: 30_000 });
    expect(died.state.status).toBe("gameover");
    expect(died.state.nextTickAt).toBe(T0 + 120_000 + 30_000);
    const reborn = advance(died.state, noVotes, died.state.nextTickAt, { ...CFG, gameOverMs: 30_000 });
    expect(reborn.state.status).toBe("playing");
    expect(reborn.state.nextTickAt - reborn.state.roundStartedAt).toBeGreaterThanOrEqual(60_000);
  });

  it("death -> gameover for one round -> fresh run that keeps lifetime stats", () => {
    const g = game({ snake: [{ x: 7, y: 2 }, { x: 6, y: 2 }], direction: "right", score: 9, bestScore: 4, runMoves: 30, totalMoves: 100, totalVotes: 50 });
    const died = advance(g, { up: 0, down: 0, left: 0, right: 2 }, T0 + 120_000, CFG);
    expect(died.state.status).toBe("gameover");
    expect(died.state.deathCause).toBe("wall");
    expect(died.state.bestScore).toBe(9);
    expect(died.state.gamesPlayed).toBe(1);
    expect(died.state.totalVotes).toBe(52);
    expect(died.run).toMatchObject({ runId: 1, score: 9, result: "gameover", deathCause: "wall" });
    expect(died.state.roundId).toBe(g.roundId + 1);

    const reborn = advance(died.state, noVotes, T0 + 240_000, CFG);
    expect(reborn.state.status).toBe("playing");
    expect(reborn.state.runId).toBe(2);
    expect(reborn.state.score).toBe(0);
    expect(reborn.state.runMoves).toBe(0);
    expect(reborn.state.bestScore).toBe(9);
    expect(reborn.state.gamesPlayed).toBe(1);
    expect(reborn.state.totalMoves).toBe(100);
    expect(reborn.state.snake).toEqual(initialSnake(CFG.cols, CFG.rows, CFG.initialLength).snake);
    expect(reborn.run).toBeNull();
  });

  it("every advance bumps roundId and version by exactly one", () => {
    let g = game();
    for (let i = 0; i < 50; i++) {
      const next = advance(g, noVotes, g.nextTickAt, CFG).state;
      expect(next.roundId).toBe(g.roundId + 1);
      expect(next.version).toBe(g.version + 1);
      g = next;
    }
  });

  it("startRun keeps cumulative fields", () => {
    const g = game({ bestScore: 12, gamesPlayed: 4, totalVotes: 99 });
    const s = startRun(g, T0, CFG);
    expect(s).toMatchObject({ bestScore: 12, gamesPlayed: 4, totalVotes: 99, runId: g.runId + 1, score: 0 });
  });
});

describe("scheduling", () => {
  it("keeps a steady cadence when on time", () => {
    expect(scheduleNext(1000, 1000, 120_000)).toBe(121_000);
  });
  it("never leaves less than half a round after a late tick", () => {
    expect(scheduleNext(1000, 1000 + 100_000, 120_000)).toBe(1000 + 100_000 + 60_000);
  });
});
