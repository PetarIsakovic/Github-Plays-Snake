import { normalizeTally } from "../game/voting";
import type { Direction, GameState, RunSummary, Tally } from "../game/types";
import type { CastVoteInput, CastVoteResult, CommitTickInput, GameRepository } from "./repository";

const clone = <T>(v: T): T => structuredClone(v);

interface RoundData {
  tally: Tally;
  closed: boolean;
  votes: Map<string, Direction>;
  ipCounts: Map<string, number>;
}

/**
 * In-memory repository with the same conditional semantics as DynamoDB. Each
 * write step is synchronous between awaits; castVote deliberately yields between
 * its steps (like separate DynamoDB calls) so tests exercise real interleavings.
 * Used by unit/integration tests and the local dev server.
 */
export class MemoryRepository implements GameRepository {
  games = new Map<string, GameState>();
  rounds = new Map<string, RoundData>();
  runs = new Map<string, RunSummary[]>();
  secrets = new Map<string, string>();
  /** Test hook: runs at the start of castVote / closeRound / commitTick. */
  beforeWrite: ((op: "vote" | "close" | "tick") => void) | null = null;
  /** Test hook: force a failure on the next call to exercise error handling. */
  failNext: Error | null = null;

  private maybeFail() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  round(gameId: string, roundId: number): RoundData {
    const key = `${gameId}#${roundId}`;
    let r = this.rounds.get(key);
    if (!r) {
      r = { tally: { up: 0, down: 0, left: 0, right: 0 }, closed: false, votes: new Map(), ipCounts: new Map() };
      this.rounds.set(key, r);
    }
    return r;
  }

  async getGame(gameId: string) {
    this.maybeFail();
    const g = this.games.get(gameId);
    return g ? clone(g) : null;
  }

  async createGame(state: GameState) {
    this.maybeFail();
    if (this.games.has(state.gameId)) return false;
    this.games.set(state.gameId, clone(state));
    return true;
  }

  async getTally(gameId: string, roundId: number) {
    this.maybeFail();
    return normalizeTally(this.rounds.get(`${gameId}#${roundId}`)?.tally);
  }

  async closeRound(gameId: string, roundId: number) {
    this.maybeFail();
    this.beforeWrite?.("close");
    const r = this.round(gameId, roundId);
    r.closed = true;
    return normalizeTally(r.tally);
  }

  async getVote(gameId: string, roundId: number, voterKey: string) {
    this.maybeFail();
    return this.rounds.get(`${gameId}#${roundId}`)?.votes.get(voterKey) ?? null;
  }

  async castVote(i: CastVoteInput): Promise<CastVoteResult> {
    this.maybeFail();
    this.beforeWrite?.("vote");
    const r = this.round(i.gameId, i.roundId);
    // 1. per-IP cap
    const ipCount = r.ipCounts.get(i.ipKey) ?? 0;
    if (ipCount >= i.ipCap) return { kind: "rate-limited" };
    r.ipCounts.set(i.ipKey, ipCount + 1);
    await Promise.resolve();
    // 2. the voter's own record (guards concurrent double clicks)
    if ((r.votes.get(i.voterKey) ?? null) !== i.previous) return { kind: "conflict" };
    r.votes.set(i.voterKey, i.turn);
    await Promise.resolve();
    // 3. the tally, only while the round is open
    if (r.closed) {
      if (r.votes.get(i.voterKey) === i.turn) {
        if (i.previous) r.votes.set(i.voterKey, i.previous);
        else r.votes.delete(i.voterKey);
      }
      return { kind: "round-closed" };
    }
    r.tally[i.turn]++;
    if (i.previous) r.tally[i.previous]--;
    return { kind: "recorded" };
  }

  async commitTick({ prev, next, run }: CommitTickInput) {
    this.maybeFail();
    this.beforeWrite?.("tick");
    const g = this.games.get(prev.gameId);
    if (!g || g.version !== prev.version) return false;
    const list = this.runs.get(prev.gameId) ?? [];
    if (run && list.some((r) => r.runId === run.runId)) return false;
    this.games.set(prev.gameId, clone(next));
    if (run) this.runs.set(prev.gameId, [...list, clone(run)]);
    return true;
  }

  async replaceGame(state: GameState, expectedVersion: number) {
    this.maybeFail();
    const g = this.games.get(state.gameId);
    if (!g || g.version !== expectedVersion) return false;
    this.games.set(state.gameId, clone(state));
    return true;
  }

  async listRuns(gameId: string, limit: number) {
    this.maybeFail();
    return clone((this.runs.get(gameId) ?? []).slice(-limit).reverse());
  }

  async getOrCreateSecret(name: string, generate: () => string) {
    this.maybeFail();
    let s = this.secrets.get(name);
    if (!s) {
      s = generate();
      this.secrets.set(name, s);
    }
    return s;
  }
}
