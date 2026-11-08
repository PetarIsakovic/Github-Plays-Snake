/**
 * Orchestrates the pure engine and the repository. This is where the
 * at-least-once, concurrent, retrying real world is turned into exactly-once
 * game transitions.
 */
import { advance, isDue, newGame, startRun, type EngineConfig } from "../game/engine";
import { canMove, isDirection } from "../game/directions";
import { randomSeed } from "../game/rng";
import { EMPTY_TALLY } from "../game/voting";
import type { Direction, GameState, Point, RunSummary, Tally } from "../game/types";
import type { GameRepository } from "../storage/repository";
import { log } from "../log";

export interface ServiceOptions {
  gameId: string;
  engine: EngineConfig;
  votesPerIpPerRound: number;
  voteTtlSeconds: number;
  clock?: () => number;
  seed?: () => number;
  /** Base delay for jittered retry backoff. Default 15ms. */
  retryDelayMs?: number;
}

export type TickResult =
  | { status: "advanced"; roundId: number; chosen: Direction | null; outcome: string; runEnded: RunSummary | null }
  | { status: "not-due"; msUntilDue: number }
  | { status: "contended" };

export type VoteOutcome =
  | { status: "recorded"; roundId: number; direction: Direction; changed: boolean }
  | { status: "unchanged"; roundId: number; direction: Direction }
  /** Voting for the reverse of the current heading is not allowed. */
  | { status: "not-allowed"; heading: Direction }
  | { status: "not-accepting"; reason: "gameover" | "won" }
  | { status: "rate-limited" }
  | { status: "contended" };

export interface Snapshot {
  state: GameState;
  tally: Tally;
  now: number;
}

const MAX_TICK_ATTEMPTS = 5;
const MAX_VOTE_ATTEMPTS = 6;

/** Small jittered backoff between optimistic retries (0 in tests via `retryDelayMs: 0`). */
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Structural validation of a stored state. A corrupted item must not crash rendering forever. */
export function isValidState(s: unknown): s is GameState {
  if (!s || typeof s !== "object") return false;
  const g = s as GameState;
  const pt = (p: unknown): p is Point =>
    !!p && typeof p === "object" && Number.isInteger((p as Point).x) && Number.isInteger((p as Point).y);
  return (
    typeof g.gameId === "string" &&
    Number.isInteger(g.roundId) &&
    Number.isInteger(g.version) &&
    Number.isFinite(g.nextTickAt) &&
    Number.isInteger(g.cols) &&
    Number.isInteger(g.rows) &&
    (g.status === "playing" || g.status === "gameover" || g.status === "won") &&
    Array.isArray(g.snake) &&
    g.snake.length >= 1 &&
    g.snake.every(pt) &&
    (g.apple === null || pt(g.apple)) &&
    isDirection(g.direction) &&
    Number.isInteger(g.rng)
  );
}

export class GameService {
  private readonly clock: () => number;
  private readonly seed: () => number;

  constructor(
    private readonly repo: GameRepository,
    private readonly opts: ServiceOptions,
  ) {
    this.clock = opts.clock ?? (() => Date.now());
    this.seed = opts.seed ?? randomSeed;
  }

  get gameId() {
    return this.opts.gameId;
  }

  get roundMs() {
    return this.opts.engine.roundMs;
  }

  now(): number {
    return this.clock();
  }

  private expiresAt(now: number): number {
    return Math.floor(now / 1000) + this.opts.voteTtlSeconds;
  }

  private backoff(attempt: number): Promise<void> {
    const base = this.opts.retryDelayMs ?? 15;
    return sleep(base * 2 ** attempt * Math.random());
  }

  /** Read the authoritative state, creating the game on first use and repairing a corrupted item. */
  async getState(): Promise<GameState> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.repo.getGame(this.opts.gameId);
      if (existing && isValidState(existing)) return existing;
      const now = this.clock();
      if (!existing) {
        const fresh = newGame({ gameId: this.opts.gameId, seed: this.seed(), now, config: this.opts.engine });
        if (await this.repo.createGame(fresh)) {
          log.info("game.created", { gameId: fresh.gameId });
          return fresh;
        }
        continue; // someone else created it concurrently; read theirs
      }
      // Corrupted: start a fresh run but keep whatever counters survived.
      const old = existing as Partial<GameState>;
      const version = Number.isInteger(old.version) ? (old.version as number) : 0;
      const base = newGame({ gameId: this.opts.gameId, seed: this.seed(), now, config: this.opts.engine });
      const repaired: GameState = {
        ...base,
        roundId: (Number.isInteger(old.roundId) ? (old.roundId as number) : 0) + 1,
        bestScore: Number.isInteger(old.bestScore) ? (old.bestScore as number) : 0,
        gamesPlayed: Number.isInteger(old.gamesPlayed) ? (old.gamesPlayed as number) : 0,
        totalMoves: Number.isInteger(old.totalMoves) ? (old.totalMoves as number) : 0,
        totalVotes: Number.isInteger(old.totalVotes) ? (old.totalVotes as number) : 0,
        version: version + 1,
      };
      log.error("game.corrupted_state_repaired", { gameId: this.opts.gameId, version });
      if (await this.repo.replaceGame(repaired, version)) return repaired;
    }
    throw new Error("Could not load or initialise game state");
  }

  /**
   * Advance the game by exactly one round if (and only if) the current round is due.
   * Safe to call from any number of concurrent schedulers, retries, and requests.
   */
  async tick(source: string): Promise<TickResult> {
    for (let attempt = 0; attempt < MAX_TICK_ATTEMPTS; attempt++) {
      const prev = await this.getState();
      const now = this.clock();
      if (!isDue(prev, now)) return { status: "not-due", msUntilDue: prev.nextTickAt - now };

      // Freeze the round first: from here on no vote can change its tally, and the
      // returned counts are final. Idempotent, so retries/duplicates re-read the same.
      const closed = await this.repo.closeRound(prev.gameId, prev.roundId, this.expiresAt(now));
      const tally = prev.status === "playing" ? closed : { ...EMPTY_TALLY };
      const { state: next, run, chosen } = advance(prev, tally, now, this.opts.engine);
      if (await this.repo.commitTick({ prev, next, run })) {
        const outcome = next.lastMove && next.lastMove.roundId === prev.roundId ? next.lastMove.outcome : "new-run";
        log.info("game.tick", {
          source,
          gameId: prev.gameId,
          round: prev.roundId,
          chosen,
          outcome,
          votes: tally,
          score: next.score,
          lateMs: now - prev.nextTickAt,
        });
        if (run) log.info("game.run_ended", { ...run });
        return { status: "advanced", roundId: next.roundId, chosen, outcome, runEnded: run };
      }
      // Lost the optimistic race to another tick; re-read (it will usually be not-due now).
      log.info("game.tick_retry", { source, attempt, round: prev.roundId });
    }
    return { status: "contended" };
  }

  /** Lazily advance an overdue round, but never let that break the caller (e.g. SVG rendering). */
  async tickIfDue(source: string): Promise<void> {
    try {
      const s = await this.repo.getGame(this.opts.gameId);
      if (!s || isDue(s, this.clock())) await this.tick(source);
    } catch (e) {
      log.error("game.lazy_tick_failed", { source, error: String(e) });
    }
  }

  /**
   * Record or replace a visitor's vote for the round that is open right now.
   * Votes that arrive after the deadline trigger the overdue tick first and then
   * count towards the new round. A vote for the reverse of the current heading
   * is rejected (the snake can't turn back into itself).
   */
  async vote(voterKey: string, ipKey: string, turn: Direction | "straight"): Promise<VoteOutcome> {
    if (turn !== "straight" && !isDirection(turn)) throw new Error("invalid direction");
    for (let attempt = 0; attempt < MAX_VOTE_ATTEMPTS; attempt++) {
      const state = await this.getState();
      const now = this.clock();
      if (isDue(state, now)) {
        await this.tick("vote");
        continue;
      }
      if (state.status !== "playing") return { status: "not-accepting", reason: state.status };
      // "straight" (legacy link) means: keep the current heading.
      const direction: Direction = turn === "straight" ? state.direction : turn;
      if (!canMove(state.direction, direction)) return { status: "not-allowed", heading: state.direction };

      const previous = await this.repo.getVote(state.gameId, state.roundId, voterKey);
      if (previous === direction) return { status: "unchanged", roundId: state.roundId, direction };

      const result = await this.repo.castVote({
        gameId: state.gameId,
        roundId: state.roundId,
        voterKey,
        ipKey,
        turn: direction,
        previous,
        expiresAt: this.expiresAt(now),
        ipCap: this.opts.votesPerIpPerRound,
      });
      if (result.kind === "recorded") return { status: "recorded", roundId: state.roundId, direction, changed: previous !== null };
      if (result.kind === "rate-limited") return { status: "rate-limited" };
      // round-closed or conflict: state moved under us; re-read and try again.
      await this.backoff(attempt);
    }
    return { status: "contended" };
  }

  /** Everything the renderer needs, after catching up on an overdue round. */
  async snapshot(source = "render"): Promise<Snapshot> {
    await this.tickIfDue(source);
    const state = await this.getState();
    const tally = state.status === "playing" ? await this.repo.getTally(state.gameId, state.roundId) : { ...EMPTY_TALLY };
    return { state, tally, now: this.clock() };
  }

  async recentRuns(limit = 10): Promise<RunSummary[]> {
    return this.repo.listRuns(this.opts.gameId, limit);
  }

  /**
   * Admin: abandon the current run and start a new one immediately (lifetime stats are kept).
   * With `hard`, lifetime stats are wiped too. Guarded by the version check.
   */
  async reset(hard = false): Promise<GameState> {
    for (let attempt = 0; attempt < MAX_TICK_ATTEMPTS; attempt++) {
      const prev = await this.getState();
      const now = this.clock();
      // Close the abandoned round so no in-flight vote can land in it.
      await this.repo.closeRound(prev.gameId, prev.roundId, this.expiresAt(now));
      const base: GameState = hard
        ? newGame({ gameId: prev.gameId, seed: this.seed(), now, config: this.opts.engine })
        : startRun(prev, now, this.opts.engine);
      const next: GameState = {
        ...base,
        roundId: prev.roundId + 1,
        version: prev.version + 1,
        nextTickAt: now + this.opts.engine.roundMs,
        roundStartedAt: now,
      };
      if (await this.repo.replaceGame(next, prev.version)) {
        log.info("game.reset", { gameId: prev.gameId, hard, round: next.roundId });
        return next;
      }
    }
    throw new Error("reset contended");
  }

  /** Admin/dev: make the current round due right now (the next tick will run immediately). */
  async expireRound(): Promise<void> {
    for (let attempt = 0; attempt < MAX_TICK_ATTEMPTS; attempt++) {
      const prev = await this.getState();
      const now = this.clock();
      if (prev.nextTickAt <= now) return;
      if (await this.repo.replaceGame({ ...prev, nextTickAt: now, version: prev.version + 1 }, prev.version)) return;
    }
  }
}
