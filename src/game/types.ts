/** Absolute compass heading on the board. `up` is towards row 0. */
export type Direction = "up" | "right" | "down" | "left";

/** Votes are absolute screen directions. Button order on the board, left to right. */
export const DIRECTIONS: readonly Direction[] = ["left", "up", "down", "right"] as const;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * - `playing`: votes are accepted, the next tick moves the snake.
 * - `gameover`: the snake died; the board is frozen for one round, then a new run starts.
 * - `won`: the snake filled the whole board; shown for one round, then a new run starts.
 */
export type GameStatus = "playing" | "gameover" | "won";

export type DeathCause = "wall" | "self";

export type MoveOutcome = "moved" | "ate" | "died" | "won";

export type Tally = Record<Direction, number>;

export interface LastMove {
  roundId: number;
  direction: Direction;
  outcome: MoveOutcome;
  votes: Tally;
}

/** The authoritative, persisted state of one game (one snake, many runs). */
export interface GameState {
  /** Stable id of this game. `global` in the MVP; `u:<github-user>` in the future. */
  gameId: string;
  /** 1-based number of the current run (a run ends when the snake dies). */
  runId: number;
  status: GameStatus;

  /** Monotonic across runs. Votes are stored per round. */
  roundId: number;
  roundStartedAt: number;
  /** Epoch ms at which the current round closes and the next tick may run. */
  nextTickAt: number;

  cols: number;
  rows: number;
  /** Head first. Always at least 2 segments. */
  snake: Point[];
  direction: Direction;
  /** `null` only when the board is completely full. */
  apple: Point | null;

  score: number;
  bestScore: number;
  /** Moves made in the current run. */
  runMoves: number;
  /** Moves made across all runs. */
  totalMoves: number;
  /** Completed runs (deaths and wins). */
  gamesPlayed: number;
  /** Sum of all votes counted at round close, across all runs. */
  totalVotes: number;

  deathCause: DeathCause | null;
  /** Cell the head tried to enter when it died (may be off-board for wall hits). */
  crashAt: Point | null;
  lastMove: LastMove | null;

  /** Seeded PRNG state, so apple placement is deterministic and replayable. */
  rng: number;

  /** Optimistic-concurrency version. Incremented on every committed tick. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** Summary written once when a run ends. */
export interface RunSummary {
  gameId: string;
  runId: number;
  score: number;
  moves: number;
  length: number;
  result: "gameover" | "won";
  deathCause: DeathCause | null;
  startedRound: number;
  endedRound: number;
  endedAt: number;
}
