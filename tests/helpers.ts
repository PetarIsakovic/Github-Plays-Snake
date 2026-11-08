import { GameService } from "../src/service/game-service";
import { MemoryRepository } from "../src/storage/memory";
import type { EngineConfig } from "../src/game/engine";
import { loadConfig, type AppConfig } from "../src/config";
import { setLogSilent } from "../src/log";

setLogSilent(true);

export const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
export const ENGINE: EngineConfig = { cols: 16, rows: 12, roundMs: 120_000, initialLength: 3 };

export class FakeClock {
  constructor(public t = T0) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export function makeService(opts: { repo?: MemoryRepository; clock?: FakeClock; ipCap?: number; engine?: EngineConfig; seed?: number } = {}) {
  const repo = opts.repo ?? new MemoryRepository();
  const clock = opts.clock ?? new FakeClock();
  const service = new GameService(repo, {
    gameId: "global",
    engine: opts.engine ?? ENGINE,
    votesPerIpPerRound: opts.ipCap ?? 50,
    voteTtlSeconds: 3600,
    clock: clock.now,
    seed: () => opts.seed ?? 12345,
    retryDelayMs: 0,
  });
  return { repo, clock, service };
}

export function testConfig(over: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  return loadConfig({ PROFILE_URL: "https://github.com/octocat", ...over });
}
