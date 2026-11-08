/**
 * DynamoDB single-table repository.
 *
 *   pk                         sk                 item
 *   GAME#<gameId>              STATE              authoritative GameState (+ version)
 *   GAME#<gameId>              RUN#<runId:09>     RunSummary, written once per finished run
 *   ROUND#<gameId>#<roundId>   TALLY              up / down / left / right atomic counters + `closed`
 *   ROUND#<gameId>#<roundId>   VOTE#<voterKey>    one visitor's current choice for that round
 *   ROUND#<gameId>#<roundId>   IP#<ipKey>         per-IP vote counter for abuse limiting
 *   META                       SECRET#<name>      random server-side salts (HMAC keys)
 *
 * ROUND# items carry a `ttl` attribute so DynamoDB deletes them automatically.
 * Multi-profile support later is just more `gameId`s; nothing is global except META.
 */
import { DynamoDBClient, TransactionCanceledException, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeTally } from "../game/voting";
import { isDirection } from "../game/directions";
import type { GameState, RunSummary, Tally } from "../game/types";
import type { CastVoteInput, CastVoteResult, CommitTickInput, GameRepository } from "./repository";

const gameKey = (gameId: string) => ({ pk: `GAME#${gameId}`, sk: "STATE" });
const roundPk = (gameId: string, roundId: number) => `ROUND#${gameId}#${roundId}`;
const runSk = (runId: number) => `RUN#${String(runId).padStart(9, "0")}`;

function cancellationCodes(err: unknown): (string | undefined)[] | null {
  if (err instanceof TransactionCanceledException || (err as { name?: string })?.name === "TransactionCanceledException") {
    return ((err as TransactionCanceledException).CancellationReasons ?? []).map((r) => r.Code);
  }
  return null;
}

function stripKeys<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, ttl: _ttl, ...rest } = item;
  return rest as T;
}

export interface DynamoRepositoryOptions {
  tableName: string;
  client?: DynamoDBClient;
  endpoint?: string;
  region?: string;
}

export class DynamoRepository implements GameRepository {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: DynamoRepositoryOptions) {
    this.table = opts.tableName;
    const client =
      opts.client ??
      new DynamoDBClient({
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        ...(opts.region ? { region: opts.region } : {}),
        maxAttempts: 3,
      });
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async getGame(gameId: string): Promise<GameState | null> {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: gameKey(gameId), ConsistentRead: true }));
    return r.Item ? stripKeys<GameState>(r.Item) : null;
  }

  async createGame(state: GameState): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...gameKey(state.gameId), ...state },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException || (e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async getTally(gameId: string, roundId: number): Promise<Tally> {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: roundPk(gameId, roundId), sk: "TALLY" }, ConsistentRead: true }),
    );
    return normalizeTally(r.Item as Partial<Tally> | undefined);
  }

  async getVote(gameId: string, roundId: number, voterKey: string) {
    const r = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: roundPk(gameId, roundId), sk: `VOTE#${voterKey}` }, ConsistentRead: true }),
    );
    const t = r.Item?.turn;
    return isDirection(t) ? t : null;
  }

  async closeRound(gameId: string, roundId: number, expiresAt: number): Promise<Tally> {
    // One atomic single-item write: freeze the tally and read the final counts.
    const r = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: roundPk(gameId, roundId), sk: "TALLY" },
        UpdateExpression: "SET closed = :t, #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":t": true, ":ttl": expiresAt },
        ReturnValues: "ALL_NEW",
      }),
    );
    return normalizeTally(r.Attributes as Partial<Tally> | undefined);
  }

  async castVote(i: CastVoteInput): Promise<CastVoteResult> {
    const pk = roundPk(i.gameId, i.roundId);
    const isCondFail = (e: unknown) => (e as { name?: string })?.name === "ConditionalCheckFailedException";

    // 1. Per-IP cap for this round (abuse limiting; may over-count on later failures, which is fine).
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk: `IP#${i.ipKey}` },
          UpdateExpression: "ADD n :one SET #ttl = :ttl",
          ConditionExpression: "attribute_not_exists(n) OR n < :cap",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":cap": i.ipCap, ":ttl": i.expiresAt },
        }),
      );
    } catch (e) {
      if (isCondFail(e)) return { kind: "rate-limited" };
      throw e;
    }

    // 2. The visitor's own record. The condition makes concurrent double clicks safe.
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk: `VOTE#${i.voterKey}` },
          UpdateExpression: "SET turn = :t, #ttl = :ttl",
          ConditionExpression: i.previous ? "turn = :prev" : "attribute_not_exists(pk)",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: { ":t": i.turn, ":ttl": i.expiresAt, ...(i.previous ? { ":prev": i.previous } : {}) },
        }),
      );
    } catch (e) {
      if (isCondFail(e)) return { kind: "conflict" };
      throw e;
    }

    // 3. Atomic counters on the round's tally, only while the round is open.
    //    Plain single-item updates on a hot item serialize inside DynamoDB without
    //    the conflicts that multi-item transactions would hit.
    const names: Record<string, string> = { "#new": i.turn, "#ttl": "ttl" };
    const values: Record<string, unknown> = { ":one": 1, ":ttl": i.expiresAt };
    let expr = "ADD #new :one";
    if (i.previous) {
      names["#prev"] = i.previous;
      values[":neg"] = -1;
      expr += ", #prev :neg";
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk: "TALLY" },
          UpdateExpression: `${expr} SET #ttl = :ttl`,
          ConditionExpression: "attribute_not_exists(closed)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return { kind: "recorded" };
    } catch (e) {
      if (!isCondFail(e)) throw e;
      // Round closed between our read and write: undo step 2 (best effort) and let the caller retry.
      await this.revertVote(pk, i).catch(() => undefined);
      return { kind: "round-closed" };
    }
  }

  private async revertVote(pk: string, i: CastVoteInput) {
    const Key = { pk, sk: `VOTE#${i.voterKey}` };
    if (i.previous) {
      await this.doc.send(
        new UpdateCommand({ TableName: this.table, Key, UpdateExpression: "SET turn = :p", ConditionExpression: "turn = :t", ExpressionAttributeValues: { ":p": i.previous, ":t": i.turn } }),
      );
    } else {
      await this.doc.send(new DeleteCommand({ TableName: this.table, Key, ConditionExpression: "turn = :t", ExpressionAttributeValues: { ":t": i.turn } }));
    }
  }

  async commitTick({ prev, next, run }: CommitTickInput): Promise<boolean> {
    const gamePut = {
      TableName: this.table,
      Item: { ...gameKey(next.gameId), ...next },
      ConditionExpression: "version = :v",
      ExpressionAttributeValues: { ":v": prev.version },
    };
    try {
      if (!run) {
        await this.doc.send(new PutCommand(gamePut));
      } else {
        // Rare (once per run): game state + run summary together.
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: gamePut },
              { Put: { TableName: this.table, Item: { pk: `GAME#${run.gameId}`, sk: runSk(run.runId), ...run }, ConditionExpression: "attribute_not_exists(pk)" } },
            ],
          }),
        );
      }
      return true;
    } catch (e) {
      if (cancellationCodes(e) || (e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async replaceGame(state: GameState, expectedVersion: number): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: { ...gameKey(state.gameId), ...state },
          ConditionExpression: "version = :v",
          ExpressionAttributeValues: { ":v": expectedVersion },
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async listRuns(gameId: string, limit: number): Promise<RunSummary[]> {
    const r = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :run)",
        ExpressionAttributeValues: { ":pk": `GAME#${gameId}`, ":run": "RUN#" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (r.Items ?? []).map((i) => stripKeys<RunSummary>(i));
  }

  async getOrCreateSecret(name: string, generate: () => string): Promise<string> {
    const Key = { pk: "META", sk: `SECRET#${name}` };
    const existing = await this.doc.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }));
    if (typeof existing.Item?.value === "string") return existing.Item.value;
    try {
      const value = generate();
      await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...Key, value }, ConditionExpression: "attribute_not_exists(pk)" }));
      return value;
    } catch (e) {
      if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
      const again = await this.doc.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }));
      return String(again.Item?.value);
    }
  }
}
