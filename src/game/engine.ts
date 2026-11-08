/**
 * Pure Snake engine. No I/O, no clocks, no Math.random: every function takes the
 * current state (plus `now` where timestamps are needed) and returns a new state.
 *
 * Original implementation for GitHub Plays Snake.
 */
import { canMove, DELTA } from "./directions";
import { nextInt } from "./rng";
import { resolveDirection, tallyTotal } from "./voting";
import type { DeathCause, Direction, GameState, MoveOutcome, Point, RunSummary, Tally } from "./types";

export interface EngineConfig {
  cols: number;
  rows: number;
  roundMs: number;
  initialLength: number;
  /** How long the game-over / board-cleared screen stays up before a new snake starts. Defaults to roundMs. */
  gameOverMs?: number;
}

export const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

export function inBounds(p: Point, cols: number, rows: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
}

/**
 * Pick a uniformly random empty cell. Returns `apple: null` when the snake covers
 * every cell (the board is full; the run is won).
 */
export function spawnApple(snake: readonly Point[], cols: number, rows: number, rng: number): { apple: Point | null; rng: number } {
  const occupied = new Set(snake.map((p) => p.y * cols + p.x));
  const free = cols * rows - occupied.size;
  if (free <= 0) return { apple: null, rng };
  const pick = nextInt(rng, free);
  let k = pick.value;
  for (let i = 0; i < cols * rows; i++) {
    if (occupied.has(i)) continue;
    if (k === 0) return { apple: { x: i % cols, y: Math.floor(i / cols) }, rng: pick.state };
    k--;
  }
  /* c8 ignore next */
  throw new Error("unreachable: free cell not found");
}

/** Starting snake: horizontal, heading right, centred a little left of middle. */
export function initialSnake(cols: number, rows: number, length: number): { snake: Point[]; direction: Direction } {
  const len = Math.max(2, Math.min(length, cols - 1));
  const headX = Math.min(cols - 1, Math.floor(cols / 2) - 1 + Math.floor(len / 2));
  const y = Math.floor(rows / 2);
  const snake = Array.from({ length: len }, (_, i) => ({ x: headX - i, y }));
  return { snake, direction: "right" };
}

export interface NewGameInput {
  gameId: string;
  seed: number;
  now: number;
  config: EngineConfig;
}

export function newGame({ gameId, seed, now, config }: NewGameInput): GameState {
  const base: GameState = {
    gameId,
    runId: 0,
    status: "gameover",
    roundId: 0,
    roundStartedAt: now,
    nextTickAt: now,
    cols: config.cols,
    rows: config.rows,
    snake: [],
    direction: "right",
    apple: null,
    score: 0,
    bestScore: 0,
    runMoves: 0,
    totalMoves: 0,
    gamesPlayed: 0,
    totalVotes: 0,
    deathCause: null,
    crashAt: null,
    lastMove: null,
    rng: seed >>> 0,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
  return { ...startRun(base, now, config), roundId: 1, version: 1 };
}

/** Begin a fresh run, keeping lifetime statistics. Does not touch roundId/version. */
export function startRun(prev: GameState, now: number, config: EngineConfig): GameState {
  const { snake, direction } = initialSnake(config.cols, config.rows, config.initialLength);
  const { apple, rng } = spawnApple(snake, config.cols, config.rows, prev.rng);
  return {
    ...prev,
    runId: prev.runId + 1,
    status: "playing",
    cols: config.cols,
    rows: config.rows,
    snake,
    direction,
    apple,
    rng,
    score: 0,
    runMoves: 0,
    deathCause: null,
    crashAt: null,
    lastMove: null,
    roundStartedAt: now,
    nextTickAt: now + config.roundMs,
    updatedAt: now,
  };
}

export interface StepResult {
  outcome: MoveOutcome;
  snake: Point[];
  direction: Direction;
  apple: Point | null;
  rng: number;
  scoreDelta: number;
  deathCause: DeathCause | null;
  crashAt: Point | null;
}

/**
 * Move the snake one cell towards `to` (an absolute direction). A reversing
 * direction is never chosen by the vote; if passed anyway it is ignored and the
 * snake keeps its heading.
 *
 * Collision rules:
 * - Leaving the board kills the snake.
 * - Entering any body cell kills it, EXCEPT the current tail cell on a non-growing
 *   move, because the tail vacates that cell during the same step.
 * - Eating grows the snake by one (the tail stays), adds a point, and spawns a new
 *   apple. If no empty cell remains the run is won.
 */
export function step(state: Pick<GameState, "snake" | "direction" | "apple" | "cols" | "rows" | "rng">, to: Direction): StepResult {
  const direction = canMove(state.direction, to) ? to : state.direction;
  const head = state.snake[0]!;
  const d = DELTA[direction];
  const next: Point = { x: head.x + d.x, y: head.y + d.y };
  const dead = (cause: DeathCause): StepResult => ({
    outcome: "died",
    snake: state.snake,
    direction,
    apple: state.apple,
    rng: state.rng,
    scoreDelta: 0,
    deathCause: cause,
    crashAt: next,
  });

  if (!inBounds(next, state.cols, state.rows)) return dead("wall");

  const eats = state.apple !== null && samePoint(next, state.apple);
  // On a normal move the tail leaves, so it is not an obstacle.
  const obstacles = eats ? state.snake : state.snake.slice(0, -1);
  if (obstacles.some((p) => samePoint(p, next))) return dead("self");

  const snake = eats ? [next, ...state.snake] : [next, ...state.snake.slice(0, -1)];
  if (!eats) {
    return { outcome: "moved", snake, direction, apple: state.apple, rng: state.rng, scoreDelta: 0, deathCause: null, crashAt: null };
  }
  const spawned = spawnApple(snake, state.cols, state.rows, state.rng);
  return {
    outcome: spawned.apple === null ? "won" : "ate",
    snake,
    direction,
    apple: spawned.apple,
    rng: spawned.rng,
    scoreDelta: 1,
    deathCause: null,
    crashAt: null,
  };
}

/** When the round after `prev` should close. Keeps a steady cadence but never gives voters less than half a round. */
export function scheduleNext(prevNextTickAt: number, now: number, roundMs: number): number {
  return Math.max(prevNextTickAt + roundMs, now + Math.ceil(roundMs / 2));
}

export function isDue(state: Pick<GameState, "nextTickAt">, now: number): boolean {
  return now >= state.nextTickAt;
}

export interface AdvanceResult {
  state: GameState;
  /** Set when this tick ended a run. */
  run: RunSummary | null;
  /** The direction chosen this round (null when the tick started a new run). */
  chosen: Direction | null;
}

/**
 * The single state transition performed once per closed round.
 *
 * - `playing`: resolve the vote, move, and record the outcome. Death or a full board
 *   switches to a terminal status that is displayed for one round.
 * - `gameover` / `won`: start a new run.
 *
 * `roundId` and `version` always advance by exactly one, so a duplicate tick that was
 * computed from the same input is rejected by the version check in storage.
 */
export function advance(prev: GameState, tally: Tally, now: number, config: EngineConfig): AdvanceResult {
  const common = {
    roundId: prev.roundId + 1,
    roundStartedAt: now,
    nextTickAt: scheduleNext(prev.nextTickAt, now, config.roundMs),
    version: prev.version + 1,
    updatedAt: now,
  };

  if (prev.status !== "playing") {
    const fresh = startRun(prev, now, config);
    return { state: { ...fresh, ...common }, run: null, chosen: null };
  }

  const chosen = resolveDirection(tally, prev.direction);
  const r = step(prev, chosen);
  const score = prev.score + r.scoreDelta;
  const moved = r.outcome !== "died";
  const ended = r.outcome === "died" || r.outcome === "won";

  const state: GameState = {
    ...prev,
    ...common,
    // A finished run is shown for `gameOverMs`, then the next tick starts a new snake.
    ...(ended ? { nextTickAt: now + (config.gameOverMs ?? config.roundMs) } : {}),
    status: r.outcome === "died" ? "gameover" : r.outcome === "won" ? "won" : "playing",
    snake: r.snake,
    direction: r.direction,
    apple: r.apple,
    rng: r.rng,
    score,
    bestScore: Math.max(prev.bestScore, score),
    runMoves: prev.runMoves + (moved ? 1 : 0),
    totalMoves: prev.totalMoves + (moved ? 1 : 0),
    gamesPlayed: prev.gamesPlayed + (ended ? 1 : 0),
    totalVotes: prev.totalVotes + tallyTotal(tally),
    deathCause: r.deathCause,
    crashAt: r.crashAt,
    lastMove: { roundId: prev.roundId, direction: r.direction, outcome: r.outcome, votes: { ...tally } },
  };

  const run: RunSummary | null = ended
    ? {
        gameId: prev.gameId,
        runId: prev.runId,
        score,
        moves: state.runMoves,
        length: state.snake.length,
        result: r.outcome === "won" ? "won" : "gameover",
        deathCause: r.deathCause,
        startedRound: prev.roundId - prev.runMoves,
        endedRound: prev.roundId,
        endedAt: now,
      }
    : null;

  return { state, run, chosen };
}
