import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { route, secretGetter, type HttpRequest } from "../../src/http/router";
import { COOKIE_NAME } from "../../src/http/identity";
import { layoutFor } from "../../src/render/layout";
import { makeService, testConfig } from "../helpers";
import { toHttpRequest } from "../../src/lambda/http-adapter";
import type { LambdaFunctionURLEvent } from "aws-lambda";

function setup(over: Parameters<typeof makeService>[0] = {}) {
  const ctx = makeService(over);
  const config = testConfig();
  const deps = { service: ctx.service, config, secret: secretGetter((n, g) => ctx.repo.getOrCreateSecret(n, g)) };
  const call = (path: string, init: Partial<HttpRequest> = {}) => {
    const [p, q = ""] = path.split("?");
    return route({ method: "GET", path: p!, rawQuery: q, headers: {}, cookies: [], sourceIp: "203.0.113.9", secure: true, ...init }, deps);
  };
  return { ...ctx, call, config };
}

const L = layoutFor(16, 12);
const centre = (t: "up" | "right" | "down") => `${Math.round(L.controls[t].x + L.controls[t].w / 2)},${Math.round(L.controls[t].y + L.controls[t].h / 2)}`;
const cookieFrom = (setCookie: string) => setCookie.split(";")[0]!;

describe("GET /board.svg", () => {
  it.each(["dark", "light"])("serves valid, uncached SVG for theme=%s", async (theme) => {
    const { call } = setup();
    const res = await call(`/board.svg?theme=${theme}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers["cache-control"]).toContain("no-cache");
    expect(res.headers["cache-control"]).toContain("max-age=0");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(XMLValidator.validate(res.body)).toBe(true);
    expect(res.body.startsWith("<svg")).toBe(true);
  });

  it("themes differ, unknown theme falls back to light", async () => {
    const { call } = setup();
    const dark = (await call("/board.svg?theme=dark")).body;
    const light = (await call("/board.svg?theme=light")).body;
    const junk = (await call("/board.svg?theme=<script>")).body;
    const none = (await call("/board.svg")).body;
    expect(dark).not.toBe(light);
    expect(dark).toContain("#0d1117");
    expect(light).toContain("#ffffff");
    expect(junk).toBe(light);
    expect(none).toBe(light);
  });

  it("supports HEAD without a body", async () => {
    const { call } = setup();
    const res = await call("/board.svg", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["content-type"]).toContain("image/svg+xml");
  });

  it("renders a friendly fallback SVG (200) if storage is down", async () => {
    const { call, repo } = setup();
    repo.failNext = new Error("dynamo down");
    // getGame fails inside tickIfDue (swallowed) -> then getState fails -> fallback.
    repo.getGame = async () => {
      throw new Error("dynamo down");
    };
    const res = await call("/board.svg?theme=dark");
    expect(res.status).toBe(200);
    expect(res.body).toContain("taking a short nap");
    expect(XMLValidator.validate(res.body)).toBe(true);
  });

  it("lazily catches up an overdue round when rendered", async () => {
    const { call, clock, service } = setup();
    await service.getState();
    clock.advance(121_000);
    await call("/board.svg");
    expect((await service.getState()).roundId).toBe(2);
  });
});

describe("GET /vote (ismap)", () => {
  it("records the vote at the button and 303-redirects to the fixed profile URL", async () => {
    const { call, service } = setup();
    const res = await call(`/vote?${centre("up")}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("https://github.com/octocat");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await service.snapshot()).tally.up).toBe(1);
  });

  it("issues a Secure, HttpOnly, SameSite=Lax cookie scoped to /vote", async () => {
    const { call } = setup();
    const res = await call(`/vote?${centre("down")}`);
    expect(res.cookies).toHaveLength(1);
    const c = res.cookies![0]!;
    expect(c).toMatch(new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{22};`));
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/vote");
  });

  it("dedupes by cookie: same visitor changes their vote, never double-counts", async () => {
    const { call, service } = setup();
    const first = await call(`/vote?${centre("up")}`);
    const cookie = cookieFrom(first.cookies![0]!);
    const again = await call(`/vote?${centre("up")}`, { cookies: [cookie] });
    expect(again.cookies).toBeUndefined(); // existing cookie is reused
    await call(`/vote?${centre("right")}`, { cookies: [cookie] });
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 0, left: 0, right: 1 });
  });

  it("treats malformed cookies as a new visitor", async () => {
    const { call, service } = setup();
    const res = await call(`/vote?${centre("up")}`, { cookies: [`${COOKIE_NAME}=../../etc; other=1`] });
    expect(res.status).toBe(303);
    expect(res.cookies?.[0]).toContain(`${COOKIE_NAME}=`);
    expect((await service.snapshot()).tally.up).toBe(1);
  });

  it.each([
    ["board click", `${L.board.x + 40},${L.board.y + 40}`],
    ["header click", "100,40"],
    ["out of range", "5000,5000"],
    ["malformed", "abc"],
    ["injection", "1,2%3Cscript%3E"],
    ["no coordinates", ""],
    ["negative", "-5,600"],
  ])("%s: redirects without recording a vote", async (_name, q) => {
    const { call, service } = setup();
    const res = await call(q ? `/vote?${q}` : "/vote");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("https://github.com/octocat");
    const { tally } = await service.snapshot();
    expect(tally.up + tally.right + tally.down).toBe(0);
  });

  it("the redirect target cannot be influenced by the request", async () => {
    const { call } = setup();
    for (const q of ["redirect=https://evil.example", "next=//evil.example", centre("up")]) {
      const res = await call(`/vote?${q}`, { headers: { referer: "https://evil.example", host: "evil.example" } });
      expect(res.headers.location).toBe("https://github.com/octocat");
    }
  });

  it("there is no link-based voting: only clicks on the board image vote", async () => {
    const { call, service } = setup();
    for (const p of ["/vote/up", "/vote/down", "/vote/left", "/vote/right", "/vote/straight"]) expect((await call(p)).status).toBe(404);
    const { tally } = await service.snapshot();
    expect(tally.up + tally.down + tally.left + tally.right).toBe(0);
  });

  it("clicking the disabled reverse arrow redirects without voting", async () => {
    const { call, service } = setup();
    const R = L.controls.left; // fresh snake heads right
    const res = await call(`/vote?c=?${Math.round(R.x + R.w / 2)},${Math.round(R.y + R.h / 2)}`);
    expect(res.status).toBe(303);
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 0, left: 0, right: 0 });
  });

  it("survives storage failure during a vote by still redirecting", async () => {
    const { call, repo } = setup();
    repo.castVote = async () => {
      throw new Error("dynamo down");
    };
    const res = await call(`/vote?${centre("up")}`);
    expect(res.status).toBe(303);
  });

  it("emits noindex on vote redirects and disallows crawling", async () => {
    const { call } = setup();
    expect((await call(`/vote?${centre("up")}`)).headers["x-robots-tag"]).toContain("noindex");
    const robots = await call("/robots.txt");
    expect(robots.body).toContain("Disallow: /");
  });
});

describe("other routes and methods", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("%s is rejected with 405", async (method) => {
    const { call } = setup();
    const res = await call("/vote", { method });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
  });

  it("unknown paths 404 (including admin-looking ones)", async () => {
    const { call } = setup();
    for (const p of ["/admin", "/reset", "/dev/tick", "/vote/sideways", "/../etc/passwd"]) expect((await call(p)).status).toBe(404);
  });

  it("/health reports ok, then stale when ticks stop", async () => {
    const { call } = setup();
    const ok = await call("/health");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, status: "playing", roundId: 1 });
  });

  it("/health returns 503 when the scheduler has stalled for > 3 minutes", async () => {
    const { call, clock, repo } = setup();
    await call("/health");
    clock.advance(120_000 + 4 * 60_000);
    // Health must not itself advance the game (it is a pure read).
    const res = await call("/health");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).ok).toBe(false);
    expect(repo.games.get("global")!.roundId).toBe(1);
  });

  it("/state.json exposes game state but no RNG seed or visitor data", async () => {
    const { call } = setup();
    await call(`/vote?${centre("up")}`);
    const res = await call("/state.json");
    const body = JSON.parse(res.body);
    expect(body.state.roundId).toBe(1);
    expect(body.state.rng).toBeUndefined();
    expect(body.tally.up).toBe(1);
    expect(res.body).not.toContain("203.0.113.9");
    expect(res.body).not.toMatch(/voter|VOTE#|ip:/i);
  });

  it("/ redirects to the profile", async () => {
    const { call } = setup();
    expect((await call("/")).status).toBe(303);
  });
});

describe("Lambda Function URL adapter", () => {
  it("maps the event, preserving the raw ismap query and cookies", () => {
    const event = {
      rawPath: "/vote",
      rawQueryString: "250,600",
      cookies: [`${COOKIE_NAME}=abcdefghijklmnopqrstuv`],
      headers: { "User-Agent": "x" },
      requestContext: { http: { method: "GET", sourceIp: "198.51.100.7" } },
    } as unknown as LambdaFunctionURLEvent;
    const req = toHttpRequest(event);
    expect(req).toMatchObject({ method: "GET", path: "/vote", rawQuery: "250,600", sourceIp: "198.51.100.7", secure: true });
    expect(req.cookies).toEqual([`${COOKIE_NAME}=abcdefghijklmnopqrstuv`]);
    expect(req.headers["user-agent"]).toBe("x");
  });
});

describe("Lambda handler (with DynamoDB Local when available)", () => {
  it.skipIf(!process.env.DYNAMO_ENDPOINT)("serves gzip SVG and 303 votes through the real Lambda handler", async () => {
    const { CreateTableCommand, DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const table = `gps-lambda-${Date.now()}`;
    const ddb = new DynamoDBClient({ endpoint: process.env.DYNAMO_ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "l", secretAccessKey: "l" } });
    await ddb.send(new CreateTableCommand({ TableName: table, BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }] }));
    Object.assign(process.env, { TABLE_NAME: table, PROFILE_URL: "https://github.com/octocat", AWS_ENDPOINT_URL_DYNAMODB: process.env.DYNAMO_ENDPOINT, AWS_ACCESS_KEY_ID: "l", AWS_SECRET_ACCESS_KEY: "l", AWS_REGION: "us-east-1" });
    const { handler } = await import("../../src/lambda/http");
    const { gunzipSync } = await import("node:zlib");
    const ev = (path: string, q = "", headers: Record<string, string> = {}) =>
      ({ rawPath: path, rawQueryString: q, headers, requestContext: { http: { method: "GET", sourceIp: "198.51.100.9" } } }) as unknown as LambdaFunctionURLEvent;

    const svg = await handler(ev("/board.svg", "theme=dark", { "accept-encoding": "gzip, deflate" }));
    expect(svg).toMatchObject({ statusCode: 200, isBase64Encoded: true });
    const body = gunzipSync(Buffer.from((svg as { body: string }).body, "base64")).toString();
    expect(XMLValidator.validate(body)).toBe(true);
    expect((svg as { headers: Record<string, string> }).headers["content-encoding"]).toBe("gzip");

    const plainSvg = await handler(ev("/board.svg", "theme=light"));
    expect((plainSvg as { body: string }).body.startsWith("<svg")).toBe(true);

    const vote = await handler(ev("/vote", centre("up")));
    expect(vote).toMatchObject({ statusCode: 303, headers: { location: "https://github.com/octocat" } });
    expect((vote as { cookies?: string[] }).cookies?.[0]).toContain("gps_vid=");
    const state = await handler(ev("/state.json"));
    expect(JSON.parse((state as { body: string }).body).tally.up).toBe(1);
  }, 30_000);
});
