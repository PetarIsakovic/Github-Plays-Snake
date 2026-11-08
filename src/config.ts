import type { EngineConfig } from "./game/engine";

export interface AppConfig {
  /** Which game this deployment serves. `global` for the MVP. */
  gameId: string;
  engine: EngineConfig;
  /** Fixed redirect target after a vote. Never taken from the request. */
  profileUrl: string;
  /** Votes (including changed votes) one hashed IP may submit in one round. */
  votesPerIpPerRound: number;
  /** How long per-round vote records live in storage before TTL removes them. */
  voteTtlSeconds: number;
  /** Optional: public URL of this deployment, used only in the debug JSON / docs. */
  publicUrl: string | null;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${key}=${JSON.stringify(raw)}: expected an integer in [${min}, ${max}]`);
  }
  return n;
}

const GITHUB_URL = /^https:\/\/github\.com(?:\/[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\/[\w.-]{1,100})?)?\/?$/;
const LOCAL_URL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[\w./-]*)?$/;

export function validateProfileUrl(url: string, allowLocal: boolean): string {
  if (GITHUB_URL.test(url)) return url;
  if (allowLocal && LOCAL_URL.test(url)) return url;
  throw new Error(`PROFILE_URL must look like https://github.com/<user> (got ${JSON.stringify(url)})`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: { allowLocalRedirect?: boolean } = {}): AppConfig {
  const gameId = env.GAME_ID ?? "global";
  if (!/^[a-z0-9:_-]{1,64}$/i.test(gameId)) throw new Error(`Invalid GAME_ID=${JSON.stringify(gameId)}`);
  const roundSeconds = int(env, "ROUND_SECONDS", 60, 5, 86_400);
  return {
    gameId,
    engine: {
      cols: int(env, "BOARD_COLS", 12, 6, 24),
      rows: int(env, "BOARD_ROWS", 9, 6, 16),
      roundMs: roundSeconds * 1000,
      initialLength: int(env, "INITIAL_LENGTH", 3, 2, 6),
      gameOverMs: int(env, "GAMEOVER_SECONDS", 30, 5, 86_400) * 1000,
    },
    profileUrl: validateProfileUrl(env.PROFILE_URL ?? "https://github.com", opts.allowLocalRedirect ?? false),
    votesPerIpPerRound: int(env, "VOTES_PER_IP_PER_ROUND", 12, 1, 1000),
    voteTtlSeconds: int(env, "VOTE_TTL_SECONDS", 3 * 86_400, 600, 90 * 86_400),
    publicUrl: env.PUBLIC_URL ?? null,
  };
}
