/**
 * Scheduled tick + IAM-only admin actions.
 *
 * EventBridge Scheduler invokes this every minute with {"action":"tick"}. The tick
 * only advances the game when the authoritative `nextTickAt` has passed, and the
 * version-conditioned commit makes duplicate, retried, or concurrent invocations
 * harmless. Admin actions are only reachable via `lambda:InvokeFunction`, which
 * requires AWS credentials. There is no public admin endpoint.
 */
import { loadConfig } from "../config";
import { GameService } from "../service/game-service";
import { DynamoRepository } from "../storage/dynamodb";
import { log } from "../log";

const config = loadConfig(process.env);
const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error("Missing env TABLE_NAME");
const repo = new DynamoRepository({ tableName });
const service = new GameService(repo, {
  gameId: config.gameId,
  engine: config.engine,
  votesPerIpPerRound: config.votesPerIpPerRound,
  voteTtlSeconds: config.voteTtlSeconds,
});

export type TickEvent = { action?: "tick" | "reset" | "hard-reset" | "expire-round" | "state" | "runs" };

export async function handler(event: TickEvent = {}) {
  const action = event?.action ?? "tick";
  switch (action) {
    case "tick":
      return service.tick("scheduler");
    case "expire-round":
      await service.expireRound();
      return service.tick("admin");
    case "reset":
    case "hard-reset": {
      const s = await service.reset(action === "hard-reset");
      log.info("admin.reset", { hard: action === "hard-reset" });
      return { status: "reset", roundId: s.roundId, runId: s.runId };
    }
    case "state": {
      const { rng: _rng, ...s } = await service.getState();
      return s;
    }
    case "runs":
      return service.recentRuns(20);
    default:
      throw new Error(`Unknown action ${String(action)}`);
  }
}
