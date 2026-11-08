/**
 * Transport-agnostic HTTP routing. The Lambda Function URL adapter and the local
 * dev server both translate to/from these plain objects.
 *
 *   GET  /board.svg?theme=dark|light   live SVG (no-cache, Camo-friendly)
 *   GET  /vote?X,Y                     ismap click -> vote -> 303 back to GitHub
 *   GET  /health                       liveness + staleness check
 *   GET  /state.json                   public game state (no visitor data)
 *   GET  /robots.txt                   disallow crawling (votes are GETs)
 */
import { layoutFor } from "../render/layout";
import { renderSvg, esc } from "../render/svg";
import { parseTheme, THEMES } from "../render/theme";
import type { AppConfig } from "../config";
import type { GameService } from "../service/game-service";
import type { Direction } from "../game/types";
import { hitTest, parseIsmapQuery } from "./ismap";
import { generateSecret, hashKey, newVisitorId, readVisitorId, visitorCookie } from "./identity";
import { log } from "../log";

export interface HttpRequest {
  method: string;
  path: string;
  /** Raw query string without the leading `?`. */
  rawQuery: string;
  headers: Record<string, string | undefined>;
  cookies: string[];
  sourceIp: string | null;
  /** Whether the client connection is HTTPS (controls the cookie Secure flag). */
  secure: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}

export interface RouterDeps {
  service: GameService;
  config: AppConfig;
  /** Server-side HMAC secret (lazily created once in storage). */
  secret: () => Promise<string>;
}

const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "cross-origin-resource-policy": "cross-origin",
};

const NO_CACHE = "no-cache, no-store, max-age=0, must-revalidate";

function svgResponse(body: string): HttpResponse {
  return {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "content-type": "image/svg+xml; charset=utf-8",
      // Camo forwards these, so browsers revalidate on every README view.
      "cache-control": NO_CACHE,
      pragma: "no-cache",
      expires: "0",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    },
    body,
  };
}

function json(status: number, data: unknown): HttpResponse {
  return {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    },
    body: JSON.stringify(data),
  };
}

function plain(status: number, body: string, extra: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
    body,
  };
}

function redirect(location: string, cookies?: string[]): HttpResponse {
  return {
    status: 303,
    headers: { ...BASE_HEADERS, location, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
    body: "",
    ...(cookies?.length ? { cookies } : {}),
  };
}

/** Shown instead of a broken image if storage is unavailable. */
export function unavailableSvg(theme: "dark" | "light"): string {
  const th = THEMES[theme];
  const L = layoutFor(16, 12);
  const font = `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="13" text-anchor="middle"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="120" viewBox="0 0 ${L.width} 120" role="img" aria-label="GitHub Plays Snake is temporarily unavailable">` +
    `<rect x="0.5" y="0.5" width="${L.width - 1}" height="119" rx="12" fill="${th.bg}" stroke="${th.line}"/>` +
    `<text x="${L.width / 2}" y="56" ${font} fill="${th.text}">${esc("the snake is taking a short nap")}</text>` +
    `<text x="${L.width / 2}" y="78" ${font} fill="${th.muted}">${esc("the game server could not be reached, reload in a minute")}</text>` +
    `</svg>`
  );
}

async function handleVote(req: HttpRequest, deps: RouterDeps, turn: Direction | "straight" | null, reason: string): Promise<HttpResponse> {
  const existing = readVisitorId(req.cookies);
  const visitorId = existing ?? newVisitorId();
  const cookies = existing ? undefined : [visitorCookie(visitorId, req.secure)];
  if (!turn) {
    log.info("vote.ignored", { reason });
    return redirect(deps.config.profileUrl, cookies);
  }
  try {
    const secret = await deps.secret();
    const result = await deps.service.vote(hashKey(secret, "voter", visitorId), hashKey(secret, "ip", req.sourceIp ?? "unknown"), turn);
    log.info("vote", { via: reason, turn, result: result.status, newVisitor: !existing });
  } catch (e) {
    // Never strand the visitor on an error page; the board will show the truth.
    log.error("vote.failed", { error: String(e) });
  }
  return redirect(deps.config.profileUrl, cookies);
}

export async function route(req: HttpRequest, deps: RouterDeps): Promise<HttpResponse> {
  const method = req.method.toUpperCase();
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  const isRead = method === "GET" || method === "HEAD";
  const known = ["/", "/board.svg", "/vote", "/health", "/state.json", "/robots.txt"];
  if (!known.includes(path)) return plain(404, "not found");
  if (!isRead) return plain(405, "method not allowed", { allow: "GET, HEAD" });

  const res = await dispatch(req, path, deps);
  return method === "HEAD" ? { ...res, body: "" } : res;
}

async function dispatch(req: HttpRequest, path: string, deps: RouterDeps): Promise<HttpResponse> {
  const params = new URLSearchParams(req.rawQuery);
  switch (path) {
    case "/board.svg": {
      const theme = parseTheme(params.get("theme"));
      try {
        const snap = await deps.service.snapshot("render");
        return svgResponse(renderSvg({ ...snap, roundMs: deps.service.roundMs, theme }));
      } catch (e) {
        log.error("render.failed", { error: String(e) });
        return svgResponse(unavailableSvg(theme));
      }
    }
    case "/vote": {
      const click = parseIsmapQuery(req.rawQuery);
      if (!click) return handleVote(req, deps, null, req.rawQuery ? "malformed-coordinates" : "no-coordinates");
      // Layout depends on board size; read it from the live state (cheap, consistent).
      let cols = deps.config.engine.cols;
      let rows = deps.config.engine.rows;
      try {
        const s = await deps.service.getState();
        cols = s.cols;
        rows = s.rows;
      } catch {
        /* fall back to configured size */
      }
      const hit = hitTest(layoutFor(cols, rows), click);
      if (hit.kind === "vote") return handleVote(req, deps, hit.direction, "ismap");
      return handleVote(req, deps, null, `click-${hit.kind}`);
    }
    case "/health": {
      try {
        const s = await deps.service.getState();
        const overdueMs = Math.max(0, deps.service.now() - s.nextTickAt);
        const stale = overdueMs > 3 * 60_000;
        return json(stale ? 503 : 200, { ok: !stale, gameId: s.gameId, status: s.status, roundId: s.roundId, nextTickAt: new Date(s.nextTickAt).toISOString(), overdueMs });
      } catch (e) {
        log.error("health.failed", { error: String(e) });
        return json(503, { ok: false });
      }
    }
    case "/state.json": {
      try {
        const snap = await deps.service.snapshot("state");
        const { rng: _rng, ...publicState } = snap.state;
        return json(200, { state: publicState, tally: snap.tally, serverTime: new Date(snap.now).toISOString(), roundSeconds: deps.service.roundMs / 1000 });
      } catch (e) {
        log.error("state.failed", { error: String(e) });
        return json(503, { ok: false });
      }
    }
    case "/robots.txt":
      return plain(200, "User-agent: *\nDisallow: /\n");
    case "/":
    default:
      return redirect(deps.config.profileUrl);
  }
}

/** Build the memoised secret getter used by RouterDeps. */
export function secretGetter(getOrCreate: (name: string, gen: () => string) => Promise<string>): () => Promise<string> {
  let cached: Promise<string> | null = null;
  return () => {
    if (!cached) {
      cached = getOrCreate("visitor-hmac", generateSecret).catch((e) => {
        cached = null;
        throw e;
      });
    }
    return cached;
  };
}
