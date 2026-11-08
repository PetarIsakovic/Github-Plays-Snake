/**
 * DynamoDB repository against a real DynamoDB engine. Runs only when configured:
 *
 *   DYNAMO_ENDPOINT=http://localhost:8000 npm test      # DynamoDB Local (creates its own table)
 *   DYNAMO_TABLE=<deployed table> AWS_PROFILE=... npm test   # real AWS, isolated gameIds, cleaned up
 *
 * Every test uses a unique gameId so it never touches the live `global` game.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateTableCommand, DeleteItemCommand, DescribeTableCommand, DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { DynamoRepository } from "../../src/storage/dynamodb";
import { GameService } from "../../src/service/game-service";
import { FakeClock, ENGINE } from "../helpers";

const endpoint = process.env.DYNAMO_ENDPOINT;
const realTable = process.env.DYNAMO_TABLE;
const enabled = Boolean(endpoint || realTable);
const tableName = realTable ?? `gps-test-${Date.now()}`;
const region = process.env.AWS_REGION ?? "us-east-1";

const client = new DynamoDBClient({
  region,
  ...(endpoint ? { endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
});
const usedGameIds: string[] = [];

function makeDynamoService(opts: { ipCap?: number } = {}) {
  const gameId = `test-${Math.random().toString(36).slice(2, 10)}`;
  usedGameIds.push(gameId);
  const repo = new DynamoRepository({ tableName, client });
  const clock = new FakeClock(Date.now());
  const service = new GameService(repo, {
    gameId,
    engine: ENGINE,
    votesPerIpPerRound: opts.ipCap ?? 1000,
    voteTtlSeconds: 3600,
    clock: clock.now,
    seed: () => 777,
  });
  return { service, repo, clock, gameId };
}

describe.skipIf(!enabled)("DynamoRepository (real DynamoDB)", () => {
  beforeAll(async () => {
    if (realTable) return;
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
    for (let i = 0; i < 30; i++) {
      const d = await client.send(new DescribeTableCommand({ TableName: tableName }));
      if (d.Table?.TableStatus === "ACTIVE") break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 30_000);

  afterAll(async () => {
    if (!realTable) return;
    // Clean up test items from the real table (round items also expire via TTL).
    for (const gameId of usedGameIds) {
      for (const pk of [`GAME#${gameId}`, ...Array.from({ length: 6 }, (_, i) => `ROUND#${gameId}#${i + 1}`)]) {
        const items = await client.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": { S: pk } } }));
        for (const it of items.Items ?? []) await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: it.pk!, sk: it.sk! } }));
      }
    }
  }, 120_000);

  it("creates the game once under concurrent first reads", async () => {
    const { service } = makeDynamoService();
    const states = await Promise.all(Array.from({ length: 8 }, () => service.getState()));
    expect(new Set(states.map((s) => `${s.version}:${s.rng}`)).size).toBe(1);
  });

  it("round-trips the full state", async () => {
    const { service } = makeDynamoService();
    const a = await service.getState();
    const b = await service.getState();
    expect(b).toEqual(a);
  });

  it("counts 60 truly concurrent votes exactly (transactions, atomic counters)", async () => {
    const { service } = makeDynamoService();
    await service.getState();
    const turns = ["up", "right", "down"] as const;
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => service.vote(`v${i}`, `ip${i % 5}`, turns[i % 3]!)));
    expect(results.every((r) => r.status === "recorded")).toBe(true);
    expect((await service.snapshot()).tally).toEqual({ up: 20, down: 20, left: 0, right: 20 });
  }, 30_000);

  it("vote change replaces (not adds) and concurrent same-visitor clicks count once", async () => {
    const { service } = makeDynamoService();
    await service.getState();
    await service.vote("alice", "ip", "up");
    await service.vote("alice", "ip", "down");
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 1, left: 0, right: 0 });
    await Promise.all(["up", "right", "down", "up", "right"].map((t) => service.vote("bob", "ip2", t as "up")));
    const t = (await service.snapshot()).tally;
    expect(t.up + t.right + t.down).toBe(2);
  }, 30_000);

  it("enforces the per-IP cap atomically", async () => {
    const { service } = makeDynamoService({ ipCap: 5 });
    await service.getState();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => service.vote(`x${i}`, "one-ip", "up")));
    expect(results.filter((r) => r.status === "recorded")).toHaveLength(5);
    expect((await service.snapshot()).tally.up).toBe(5);
  }, 30_000);

  it("duplicate concurrent ticks advance exactly once", async () => {
    const { service, clock } = makeDynamoService();
    const s0 = await service.getState();
    await service.vote("a", "ip", "up");
    clock.advance(ENGINE.roundMs);
    const results = await Promise.all(Array.from({ length: 6 }, () => service.tick("scheduler")));
    expect(results.filter((r) => r.status === "advanced")).toHaveLength(1);
    const s1 = await service.getState();
    expect(s1.roundId).toBe(s0.roundId + 1);
    expect(s1.version).toBe(s0.version + 1);
    expect(s1.direction).toBe("up");
  }, 30_000);

  it("votes racing a tick at the round boundary are never lost or double counted", async () => {
    const { service, clock, repo, gameId } = makeDynamoService();
    await service.getState();
    for (let i = 0; i < 5; i++) await service.vote(`pre${i}`, `ip${i}`, "up");
    clock.advance(ENGINE.roundMs);
    // Votes arrive while the tick runs. Every recorded vote must land in exactly one round.
    const [_, ...votes] = await Promise.all([service.tick("scheduler"), ...Array.from({ length: 20 }, (_, i) => service.vote(`race${i}`, `ipr${i}`, "right"))]);
    expect(votes.every((v) => v.status === "recorded")).toBe(true);
    const s = await service.getState();
    const round1 = await repo.getTally(gameId, 1);
    const round2 = await repo.getTally(gameId, 2);
    // What the move used == what round 1 holds (the commit checked it).
    expect(s.lastMove!.votes).toEqual(round1);
    const total = round1.up + round1.right + round1.down + round2.up + round2.right + round2.down;
    expect(total).toBe(25);
  }, 30_000);

  it("records a run summary exactly once on death and restarts once", async () => {
    const { service, clock, repo, gameId } = makeDynamoService();
    const s = await service.getState();
    await repo.replaceGame({ ...s, snake: [{ x: 15, y: 6 }, { x: 14, y: 6 }], direction: "right", version: s.version + 1 }, s.version);
    clock.advance(ENGINE.roundMs);
    await Promise.all([service.tick("a"), service.tick("b")]);
    expect((await service.getState()).status).toBe("gameover");
    clock.advance(ENGINE.roundMs);
    await Promise.all([service.tick("a"), service.tick("b"), service.tick("c")]);
    const fresh = await service.getState();
    expect(fresh.status).toBe("playing");
    expect(fresh.runId).toBe(2);
    expect(await repo.listRuns(gameId, 10)).toHaveLength(1);
  }, 30_000);

  it("creates the HMAC secret once", async () => {
    const repo = new DynamoRepository({ tableName, client });
    const name = `test-${Date.now()}`;
    const vals = await Promise.all(Array.from({ length: 5 }, (_, i) => repo.getOrCreateSecret(name, () => `s${i}`)));
    expect(new Set(vals).size).toBe(1);
    if (realTable) await client.send(new DeleteItemCommand({ TableName: tableName, Key: { pk: { S: "META" }, sk: { S: `SECRET#${name}` } } }));
  });
});
