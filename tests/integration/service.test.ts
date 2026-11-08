import { describe, expect, it } from "vitest";
import { FakeClock, makeService, T0 } from "../helpers";
import { MemoryRepository } from "../../src/storage/memory";
import type { GameState } from "../../src/game/types";

describe("game creation and recovery", () => {
  it("creates the game exactly once, even under concurrent first reads", async () => {
    const { service, repo } = makeService();
    const states = await Promise.all(Array.from({ length: 10 }, () => service.getState()));
    expect(new Set(states.map((s) => s.version)).size).toBe(1);
    expect(repo.games.size).toBe(1);
    expect(states[0]!.roundId).toBe(1);
  });

  it("repairs a corrupted state item instead of failing forever", async () => {
    const { service, repo } = makeService();
    const good = await service.getState();
    repo.games.set("global", { ...good, snake: "garbage" } as unknown as GameState);
    const repaired = await service.getState();
    expect(repaired.status).toBe("playing");
    expect(Array.isArray(repaired.snake)).toBe(true);
    expect(repaired.version).toBe(good.version + 1);
    expect(repaired.roundId).toBeGreaterThan(good.roundId);
  });

  it("survives a 'server restart' (new service instance, same storage)", async () => {
    const repo = new MemoryRepository();
    const clock = new FakeClock();
    const a = makeService({ repo, clock }).service;
    await a.vote("v1", "ip1", "up");
    const b = makeService({ repo, clock }).service; // fresh process
    expect((await b.snapshot()).tally.up).toBe(1);
    clock.advance(120_000);
    expect((await b.tick("scheduler")).status).toBe("advanced");
  });
});

describe("voting", () => {
  it("counts one vote per visitor per round and lets them change it", async () => {
    const { service } = makeService();
    expect(await service.vote("alice", "ip-a", "up")).toMatchObject({ status: "recorded", changed: false });
    expect(await service.vote("alice", "ip-a", "up")).toMatchObject({ status: "unchanged" });
    expect((await service.snapshot()).tally).toEqual({ up: 1, down: 0, left: 0, right: 0 });
    expect(await service.vote("alice", "ip-a", "down")).toMatchObject({ status: "recorded", changed: true });
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 1, left: 0, right: 0 });
    await service.vote("bob", "ip-b", "down");
    await service.vote("carol", "ip-c", "right");
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 2, left: 0, right: 1 });
  });

  it("handles rapid repeated clicks from one visitor", async () => {
    const { service } = makeService();
    const turns = ["up", "down", "up", "right", "down", "up"] as const;
    await Promise.all(turns.map((t) => service.vote("spammer", "ip", t)));
    const { tally } = await service.snapshot();
    expect(tally.up + tally.right + tally.down).toBe(1);
  });

  it("is concurrency-safe: 300 simultaneous voters are all counted exactly", async () => {
    const { service } = makeService({ ipCap: 1000 });
    const turns = ["up", "right", "down"] as const;
    await Promise.all(Array.from({ length: 300 }, (_, i) => service.vote(`v${i}`, `ip${i % 7}`, turns[i % 3]!)));
    expect((await service.snapshot()).tally).toEqual({ up: 100, down: 100, left: 0, right: 100 });
  });

  it("rejects a vote for the reverse of the current heading", async () => {
    const { service } = makeService();
    const s = await service.getState();
    expect(s.direction).toBe("right");
    expect(await service.vote("a", "ip", "left")).toEqual({ status: "not-allowed", heading: "right" });
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 0, left: 0, right: 0 });
  });

  it("legacy 'straight' votes mean 'keep the current heading'", async () => {
    const { service } = makeService();
    expect(await service.vote("a", "ip", "straight")).toMatchObject({ status: "recorded", direction: "right" });
  });

  it("caps votes per hashed IP per round", async () => {
    const { service } = makeService({ ipCap: 3 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await service.vote(`v${i}`, "same-ip", "up")).status);
    expect(results).toEqual(["recorded", "recorded", "recorded", "rate-limited", "rate-limited"]);
    expect((await service.snapshot()).tally.up).toBe(3);
  });

  it("does not carry votes over to the next round", async () => {
    const { service, clock } = makeService();
    await service.vote("a", "ip", "up");
    clock.advance(120_000);
    await service.tick("scheduler");
    const snap = await service.snapshot();
    expect(snap.state.roundId).toBe(2);
    expect(snap.tally).toEqual({ up: 0, down: 0, left: 0, right: 0 });
    // The same visitor can vote again in the new round.
    expect(await service.vote("a", "ip", "up")).toMatchObject({ status: "recorded", roundId: 2 });
  });

  it("a late vote (after the deadline, before the tick ran) closes the old round first and counts in the new one", async () => {
    const { service, clock } = makeService();
    await service.vote("a", "ip", "down");
    clock.advance(120_000 + 5_000);
    const r = await service.vote("b", "ip", "left");
    expect(r).toMatchObject({ status: "recorded", roundId: 2 });
    const s = await service.getState();
    expect(s.lastMove).toMatchObject({ roundId: 1, direction: "down", votes: { up: 0, down: 1, left: 0, right: 0 } });
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 0, left: 1, right: 0 });
  });

  it("rejects votes while the game-over screen is shown", async () => {
    const { service, clock, repo } = makeService();
    const s = await service.getState();
    repo.games.set("global", { ...s, snake: [{ x: 15, y: 6 }, { x: 14, y: 6 }], direction: "right" });
    clock.advance(120_000);
    await service.tick("scheduler"); // hits the wall
    expect((await service.getState()).status).toBe("gameover");
    expect(await service.vote("a", "ip", "up")).toEqual({ status: "not-accepting", reason: "gameover" });
  });
});

describe("ticks / scheduler", () => {
  it("does nothing before the round is due", async () => {
    const { service, clock } = makeService();
    await service.getState();
    clock.advance(119_999);
    expect(await service.tick("scheduler")).toMatchObject({ status: "not-due", msUntilDue: 1 });
    expect((await service.getState()).roundId).toBe(1);
  });

  it("advances exactly one round per due tick, and duplicate/retried ticks are harmless", async () => {
    const { service, clock } = makeService();
    const before = await service.getState();
    clock.advance(120_000);
    const results = await Promise.all([service.tick("scheduler"), service.tick("scheduler-retry"), service.tick("render"), service.tick("vote")]);
    expect(results.filter((r) => r.status === "advanced")).toHaveLength(1);
    const after = await service.getState();
    expect(after.roundId).toBe(before.roundId + 1);
    expect(after.version).toBe(before.version + 1);
    expect(after.runMoves).toBe(1);
    // A late duplicate of the same scheduled event is also a no-op.
    expect((await service.tick("scheduler")).status).toBe("not-due");
  });

  it("a very late scheduler (long outage) still moves only ONE step", async () => {
    const { service, clock } = makeService();
    await service.getState();
    clock.advance(60 * 60_000);
    await service.tick("scheduler");
    const s = await service.getState();
    expect(s.runMoves).toBe(1);
    expect(s.nextTickAt).toBe(clock.t + 60_000); // at least half a round to vote
  });

  it("applies the winning vote", async () => {
    const { service, clock } = makeService();
    const s0 = await service.getState(); // heading right
    await service.vote("a", "1", "up");
    await service.vote("b", "2", "up");
    await service.vote("c", "3", "down");
    clock.advance(120_000);
    await service.tick("scheduler");
    const s1 = await service.getState();
    expect(s1.direction).toBe("up");
    expect(s1.snake[0]).toEqual({ x: s0.snake[0]!.x, y: s0.snake[0]!.y - 1 });
  });

  it("votes racing the round close are never lost or double counted (conservation)", async () => {
    for (let trial = 0; trial < 20; trial++) {
      const { service, clock, repo } = makeService({ ipCap: 1000 });
      await service.getState();
      for (let i = 0; i < 3; i++) await service.vote(`pre${i}`, `ip${i}`, "up");
      clock.advance(120_000);
      const turns = ["up", "right"] as const; // valid both before (heading right) and after (heading up) the tick
      const racing = Array.from({ length: 12 }, (_, i) => service.vote(`race${trial}-${i}`, `ipr${i}`, turns[i % 2]!));
      const [, ...votes] = await Promise.all([service.tick("scheduler"), ...racing]);
      const recorded = 3 + votes.filter((v) => v.status === "recorded").length;
      const s = await service.getState();
      const r1 = repo.rounds.get("global#1")!;
      expect(r1.closed).toBe(true);
      expect(s.lastMove!.votes).toEqual(r1.tally); // the move used exactly the closed tally
      const r2 = await repo.getTally("global", 2);
      const sum = (t: { up: number; down: number; left: number; right: number }) => t.up + t.down + t.left + t.right;
      expect(sum(r1.tally) + sum(r2)).toBe(recorded);
      expect(votes.every((v) => v.status === "recorded")).toBe(true);
    }
  });

  it("a vote whose round closes mid-write is retried into the next round", async () => {
    const { service, clock, repo } = makeService();
    await service.getState();
    let fired = false;
    repo.beforeWrite = (op) => {
      if (op === "vote" && !fired) {
        fired = true;
        // The scheduler closes the round right as this vote is being written.
        repo.round("global", 1).closed = true;
        clock.advance(120_000);
      }
    };
    const r = await service.vote("late", "ip", "down");
    expect(r).toMatchObject({ status: "recorded", roundId: 2 });
    expect(repo.rounds.get("global#1")!.votes.has("late")).toBe(false); // compensated
    expect(await repo.getTally("global", 2)).toEqual({ up: 0, down: 1, left: 0, right: 0 });
  });

  it("game over is shown for one interval, then a new run starts exactly once", async () => {
    const { service, clock, repo } = makeService();
    const s = await service.getState();
    repo.games.set("global", { ...s, snake: [{ x: 15, y: 6 }, { x: 14, y: 6 }], direction: "right", score: 4, bestScore: 2 });
    clock.advance(120_000);
    const died = await service.tick("scheduler");
    expect(died).toMatchObject({ status: "advanced", outcome: "died" });
    const over = await service.getState();
    expect(over).toMatchObject({ status: "gameover", bestScore: 4, gamesPlayed: 1 });
    expect(await service.recentRuns()).toHaveLength(1);

    // Retries during the game-over window do nothing.
    clock.advance(60_000);
    expect((await service.tick("scheduler")).status).toBe("not-due");

    clock.advance(60_000);
    const results = await Promise.all([service.tick("a"), service.tick("b"), service.tick("c")]);
    expect(results.filter((r) => r.status === "advanced")).toHaveLength(1);
    const fresh = await service.getState();
    expect(fresh).toMatchObject({ status: "playing", runId: over.runId + 1, score: 0, bestScore: 4, gamesPlayed: 1 });
    expect(await service.recentRuns()).toHaveLength(1);
  });

  it("concurrent game reset and voting never corrupt the tally", async () => {
    const { service } = makeService({ ipCap: 1000 });
    await service.getState();
    await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => service.vote(`v${i}`, `ip${i}`, "up")),
      service.reset(),
      ...Array.from({ length: 30 }, (_, i) => service.vote(`w${i}`, `ip${i}`, "down")),
    ]);
    const snap = await service.snapshot();
    expect(snap.state.status).toBe("playing");
    expect(snap.tally.up + snap.tally.right + snap.tally.down).toBeLessThanOrEqual(60);
  });

  it("storage errors propagate from tick (so the scheduler retries) but rendering degrades gracefully", async () => {
    const { service, repo, clock } = makeService();
    await service.getState();
    clock.advance(120_000);
    repo.failNext = new Error("ProvisionedThroughputExceeded");
    await expect(service.tick("scheduler")).rejects.toThrow();
    // Lazy tick during render swallows the error and still renders state.
    repo.failNext = new Error("boom");
    const snap = await service.snapshot("render");
    expect(snap.state.roundId).toBe(1);
    // Next scheduler run recovers.
    expect((await service.tick("scheduler")).status).toBe("advanced");
  });

  it("plays a long deterministic game without ever breaking invariants", async () => {
    const { service, clock } = makeService({ ipCap: 1000 });
    const turns = ["up", "right", "down"] as const;
    let rng = 1;
    for (let round = 0; round < 400; round++) {
      const votes = 1 + (round % 4);
      for (let v = 0; v < votes; v++) {
        rng = (rng * 1103515245 + 12345) >>> 0;
        await service.vote(`r${round}v${v}`, `ip${v}`, turns[rng % 3]!);
      }
      clock.advance(120_000);
      await service.tick("scheduler");
      const s = await service.getState();
      const keys = new Set(s.snake.map((p) => `${p.x},${p.y}`));
      if (s.status === "playing") {
        expect(keys.size).toBe(s.snake.length);
        for (const p of s.snake) expect(p.x >= 0 && p.y >= 0 && p.x < s.cols && p.y < s.rows).toBe(true);
        expect(s.apple && keys.has(`${s.apple.x},${s.apple.y}`)).toBeFalsy();
        expect(s.snake.length).toBe(3 + s.score);
      }
      expect(s.bestScore).toBeGreaterThanOrEqual(s.score);
    }
    expect((await service.getState()).roundId).toBe(401);
  });
});

it("T0 sanity", () => expect(T0).toBeGreaterThan(0));
