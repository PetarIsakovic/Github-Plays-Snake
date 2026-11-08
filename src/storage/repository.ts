import type { Direction, GameState, RunSummary, Tally } from "../game/types";

export interface CastVoteInput {
  gameId: string;
  roundId: number;
  /** Opaque, salted hash of the visitor cookie. */
  voterKey: string;
  /** Opaque, salted hash of the client IP (abuse limiting only). */
  ipKey: string;
  turn: Direction;
  /** The voter's previous choice in this round, as read just before; null if none. */
  previous: Direction | null;
  /** Epoch seconds after which storage may delete the vote records. */
  expiresAt: number;
  ipCap: number;
}

export type CastVoteResult =
  | { kind: "recorded" }
  /** The round's tally is closed (a tick or reset happened). Re-read and retry. */
  | { kind: "round-closed" }
  /** The voter's own vote changed concurrently (double click). Re-read and retry. */
  | { kind: "conflict" }
  | { kind: "rate-limited" };

export interface CommitTickInput {
  prev: GameState;
  next: GameState;
  run: RunSummary | null;
}

/**
 * Persistence contract. All concurrency control lives here, expressed as
 * single-item conditional writes, so the in-memory and DynamoDB implementations
 * behave identically and hot items never need multi-item transactions.
 *
 * The round's TALLY item is the linearization point:
 * - `castVote` adds to the tally only while the tally is NOT closed.
 * - `closeRound` atomically marks it closed and returns the final counts.
 * - A tick closes round N before committing state N+1 (version-conditioned).
 *
 * So every recorded vote is counted in exactly one move (or rejected and retried
 * into the next round), and duplicate or retried ticks can never apply twice.
 */
export interface GameRepository {
  getGame(gameId: string): Promise<GameState | null>;
  /** Insert only if absent. Returns false if a game already exists. */
  createGame(state: GameState): Promise<boolean>;
  /** Current counts (for display; not authoritative until closed). */
  getTally(gameId: string, roundId: number): Promise<Tally>;
  /** Freeze the round's tally and return the final counts. Idempotent. */
  closeRound(gameId: string, roundId: number, expiresAt: number): Promise<Tally>;
  getVote(gameId: string, roundId: number, voterKey: string): Promise<Direction | null>;
  castVote(input: CastVoteInput): Promise<CastVoteResult>;
  /** Commit the next state if `prev.version` is still current (and record the finished run). */
  commitTick(input: CommitTickInput): Promise<boolean>;
  /** Replace the game only if `expectedVersion` matches (admin reset/repair). */
  replaceGame(state: GameState, expectedVersion: number): Promise<boolean>;
  listRuns(gameId: string, limit: number): Promise<RunSummary[]>;
  /** Fetch a named random secret, creating it exactly once. Never leaves the backend. */
  getOrCreateSecret(name: string, generate: () => string): Promise<string>;
}
