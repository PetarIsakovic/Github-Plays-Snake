/**
 * Local development server: no AWS, in-memory storage (persisted to
 * .dev-state.json so restarts keep the game), a simulated scheduler, and a
 * preview page that embeds the board with the exact README markup.
 *
 *   npm run dev            # ROUND_SECONDS defaults to 20 locally
 *   open http://localhost:8787
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config";
import { route, secretGetter, type HttpRequest } from "../http/router";
import { GameService } from "../service/game-service";
import { MemoryRepository } from "../storage/memory";
import { DIRECTIONS, type Direction } from "../game/types";
import { previewHtml } from "./preview";

const PORT = Number(process.env.PORT ?? 8787);
const STATE_FILE = process.env.DEV_STATE_FILE ?? ".dev-state.json";
const env = {
  ...process.env,
  ROUND_SECONDS: process.env.ROUND_SECONDS ?? "20",
  PROFILE_URL: process.env.PROFILE_URL ?? `http://localhost:${PORT}/`,
};
const config = loadConfig(env, { allowLocalRedirect: true });
const repo = new MemoryRepository();
loadSnapshot();
const service = new GameService(repo, {
  gameId: config.gameId,
  engine: config.engine,
  // Generous locally so you can click around freely.
  votesPerIpPerRound: Math.max(config.votesPerIpPerRound, 1000),
  voteTtlSeconds: config.voteTtlSeconds,
});
const secret = secretGetter((n, g) => repo.getOrCreateSecret(n, g));

function loadSnapshot() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const snap = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    for (const [k, v] of snap.games ?? []) repo.games.set(k, v);
    for (const [k, v] of snap.rounds ?? []) repo.rounds.set(k, { tally: v.tally, closed: Boolean(v.closed), votes: new Map(v.votes), ipCounts: new Map(v.ipCounts) });
    for (const [k, v] of snap.runs ?? []) repo.runs.set(k, v);
    for (const [k, v] of snap.secrets ?? []) repo.secrets.set(k, v);
    console.log(`Loaded dev state from ${STATE_FILE}`);
  } catch (e) {
    console.warn(`Ignoring unreadable ${STATE_FILE}: ${String(e)}`);
  }
}

let lastSaved = "";
function saveSnapshot() {
  const rounds = [...repo.rounds.entries()].slice(-50).map(([k, v]) => [k, { tally: v.tally, closed: v.closed, votes: [...v.votes], ipCounts: [...v.ipCounts] }]);
  const data = JSON.stringify({ games: [...repo.games], rounds, runs: [...repo.runs], secrets: [...repo.secrets] });
  if (data !== lastSaved) {
    writeFileSync(STATE_FILE, data);
    lastSaved = data;
  }
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string, cookies?: string[]) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (cookies?.length) res.setHeader("set-cookie", cookies);
  res.end(body);
}

const json = (res: ServerResponse, data: unknown, status = 200) =>
  send(res, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, JSON.stringify(data, null, 2));

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const method = (req.method ?? "GET").toUpperCase();

  if (url.pathname === "/" && method === "GET") {
    return send(res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, previewHtml(`http://localhost:${PORT}`));
  }
  if (url.pathname.startsWith("/dev/")) {
    if (url.pathname === "/dev/state") {
      const snap = await service.snapshot("dev");
      return json(res, { ...snap, serverTime: new Date(snap.now).toISOString(), runs: await service.recentRuns(5) });
    }
    if (method !== "POST") return json(res, { error: "POST only" }, 405);
    if (url.pathname === "/dev/tick") {
      await service.expireRound();
      return json(res, await service.tick("dev-force"));
    }
    if (url.pathname === "/dev/reset") return json(res, await service.reset(url.searchParams.get("hard") === "1"));
    if (url.pathname === "/dev/votes") {
      // Simulate N distinct visitors voting.
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get("n") ?? 1)));
      const only = url.searchParams.get("turn");
      const results: string[] = [];
      for (let i = 0; i < n; i++) {
        const t: Direction = DIRECTIONS.includes(only as Direction) ? (only as Direction) : DIRECTIONS[Math.floor(Math.random() * 4)]!;
        const r = await service.vote(`sim-${randomBytes(6).toString("hex")}`, `sim-ip-${i % 50}`, t);
        results.push(r.status);
      }
      return json(res, { cast: n, results: results.reduce<Record<string, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}) });
    }
    return json(res, { error: "unknown dev route" }, 404);
  }

  const request: HttpRequest = {
    method,
    path: url.pathname,
    rawQuery: url.search.slice(1),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
    cookies: req.headers.cookie ? [req.headers.cookie] : [],
    sourceIp: req.socket.remoteAddress ?? null,
    secure: false,
  };
  const r = await route(request, { service, config, secret });
  send(res, r.status, r.headers, r.body, r.cookies);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    send(res, 500, { "content-type": "text/plain" }, "internal error");
  });
});

// Simulated EventBridge Scheduler. Like production it fires on a fixed cadence and
// relies on the service to advance only when the round is actually due.
const ticker = setInterval(() => {
  service.tick("dev-scheduler").catch((e) => console.error("tick failed", e));
  try {
    saveSnapshot();
  } catch {
    /* ignore */
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`\n  GitHub Plays Snake: local dev`);
  console.log(`  Preview:   http://localhost:${PORT}/`);
  console.log(`  Board SVG: http://localhost:${PORT}/board.svg?theme=dark`);
  console.log(`  Round length: ${config.engine.roundMs / 1000}s  (set ROUND_SECONDS to change)\n`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(ticker);
    saveSnapshot();
    server.close(() => process.exit(0));
  });
}
