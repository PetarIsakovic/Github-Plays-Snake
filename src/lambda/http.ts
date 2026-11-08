/** Lambda Function URL entry point (payload format 2.0). */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { gzipSync } from "node:zlib";
import { loadConfig } from "../config";
import { route, secretGetter, type HttpResponse } from "../http/router";
import { GameService } from "../service/game-service";
import { DynamoRepository } from "../storage/dynamodb";
import { log } from "../log";
import { toHttpRequest } from "./http-adapter";

// Initialised once per container and reused across invocations.
const config = loadConfig(process.env);
const repo = new DynamoRepository({ tableName: requireEnv("TABLE_NAME") });
const service = new GameService(repo, {
  gameId: config.gameId,
  engine: config.engine,
  votesPerIpPerRound: config.votesPerIpPerRound,
  voteTtlSeconds: config.voteTtlSeconds,
});
const secret = secretGetter((name, gen) => repo.getOrCreateSecret(name, gen));

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}

/** Gzip larger bodies when the client accepts it (SVG ~25 KB -> ~4 KB; cuts egress and latency). */
export function toLambdaResult(res: HttpResponse, acceptEncoding: string | undefined): LambdaFunctionURLResult {
  const base = { statusCode: res.status, ...(res.cookies ? { cookies: res.cookies } : {}) };
  if (res.body.length > 1024 && /\bgzip\b/i.test(acceptEncoding ?? "")) {
    return {
      ...base,
      headers: { ...res.headers, "content-encoding": "gzip", vary: "Accept-Encoding" },
      body: gzipSync(res.body).toString("base64"),
      isBase64Encoded: true,
    };
  }
  return { ...base, headers: res.headers, body: res.body };
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  try {
    const req = toHttpRequest(event);
    const res = await route(req, { service, config, secret });
    return toLambdaResult(res, req.headers["accept-encoding"]);
  } catch (e) {
    log.error("http.unhandled", { error: String(e) });
    return { statusCode: 500, headers: { "content-type": "text/plain", "cache-control": "no-store" }, body: "internal error" };
  }
}
