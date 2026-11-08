/**
 * CDK entry point. All settings come from environment variables (or `-c key=value`
 * context) so redeploying with different settings needs no code changes:
 *
 *   PROFILE_URL=https://github.com/<you> npm run deploy
 */
import { App } from "aws-cdk-lib";
import { SnakeStack } from "../lib/snake-stack";

const app = new App();
const setting = (key: string, def?: string): string => {
  const v = (app.node.tryGetContext(key) as string | undefined) ?? process.env[key] ?? def;
  if (v === undefined) throw new Error(`Missing setting ${key} (set env ${key}=... or -c ${key}=...)`);
  return v;
};
const num = (key: string, def: number) => {
  const n = Number(setting(key, String(def)));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
};

const profileUrl = setting("PROFILE_URL");
if (!/^https:\/\/github\.com(\/[A-Za-z0-9-]+(\/[\w.-]+)?)?\/?$/.test(profileUrl)) {
  throw new Error(`PROFILE_URL must look like https://github.com/<username> (got ${profileUrl})`);
}

new SnakeStack(app, setting("STACK_NAME", "GitHubPlaysSnake"), {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? "us-east-1" },
  description: "GitHub Plays Snake: community-controlled Snake inside a GitHub README",
  profileUrl,
  roundSeconds: num("ROUND_SECONDS", 120),
  boardCols: num("BOARD_COLS", 12),
  boardRows: num("BOARD_ROWS", 9),
  votesPerIpPerRound: num("VOTES_PER_IP_PER_ROUND", 12),
  httpConcurrency: num("HTTP_CONCURRENCY", 50),
  tags: { project: "github-plays-snake" },
});
