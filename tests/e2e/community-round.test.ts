/**
 * End-to-end: anonymous visitors click the README image, the scheduled round
 * closes, the snake moves in the winning screen direction, the new board is
 * rendered, and the next round starts with empty votes. Exercises the real
 * router, cookie handling, ismap decoding, service, engine, repository and renderer.
 */
import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { route, secretGetter, type HttpRequest } from "../../src/http/router";
import { layoutFor } from "../../src/render/layout";
import type { Direction } from "../../src/game/types";
import { makeService, testConfig } from "../helpers";

describe("a full community round", () => {
  it("A: UP, B: DOWN, C: UP, D: LEFT (reverse, rejected) -> snake goes up -> fresh round", async () => {
    const { service, repo, clock } = makeService();
    const deps = { service, config: testConfig(), secret: secretGetter((n, g) => repo.getOrCreateSecret(n, g)) };
    const get = (path: string, extra: Partial<HttpRequest> = {}) => {
      const i = path.indexOf("?");
      const p = i < 0 ? path : path.slice(0, i);
      const q = i < 0 ? "" : path.slice(i + 1);
      return route({ method: "GET", path: p, rawQuery: q, headers: {}, cookies: [], sourceIp: "192.0.2.1", secure: true, ...extra }, deps);
    };

    expect((await get("/board.svg?theme=dark")).status).toBe(200);
    const s0 = await service.getState();
    expect(s0.direction).toBe("right"); // so LEFT is the forbidden reverse
    const head0 = s0.snake[0]!;

    const L = layoutFor(s0.cols, s0.rows);
    // Browser-appended ismap coordinates, on href "/vote?c=".
    const click = (d: Direction, dx = 0) => `/vote?c=?${Math.round(L.controls[d].x + 20 + dx)},${Math.round(L.controls[d].y + L.controls[d].h - 14)}`;

    const a = await get(click("up"), { sourceIp: "198.51.100.1" });
    const b = await get(click("down", 20), { sourceIp: "198.51.100.2" });
    const c = await get(click("up", 40), { sourceIp: "198.51.100.3" });
    const d = await get(click("left"), { sourceIp: "198.51.100.4" });
    for (const r of [a, b, c, d]) {
      expect(r.status).toBe(303);
      expect(r.headers.location).toBe("https://github.com/octocat");
      expect(r.cookies?.[0]).toMatch(/^gps_vid=/);
    }
    // Visitor A double-clicks with their cookie: still one vote.
    await get(click("up"), { sourceIp: "198.51.100.1", cookies: [a.cookies![0]!.split(";")[0]!] });

    expect((await service.snapshot()).tally).toEqual({ up: 2, down: 1, left: 0, right: 0 });
    const boardDuring = (await get("/board.svg?theme=light")).body;
    expect(boardDuring).toContain(" 67%");
    expect(boardDuring).toContain(" 33%");

    // The scheduler fires (plus a duplicate delivery) after the round closes.
    clock.advance(120_000);
    const [t1, t2] = await Promise.all([service.tick("scheduler"), service.tick("scheduler")]);
    expect([t1.status, t2.status].sort()).toEqual(["advanced", "not-due"]);

    const s1 = await service.getState();
    expect(s1.direction).toBe("up");
    expect(s1.snake[0]).toEqual({ x: head0.x, y: head0.y - 1 });
    expect(s1.roundId).toBe(s0.roundId + 1);
    expect(s1.lastMove).toMatchObject({ direction: "up", votes: { up: 2, down: 1, left: 0, right: 0 } });
    expect(s1.totalVotes).toBe(3);

    // New board: new round, empty votes, and now DOWN is the disabled arrow.
    const board1 = await get("/board.svg?theme=dark");
    expect(XMLValidator.validate(board1.body)).toBe(true);
    expect(board1.body).toContain(`round ${s1.roundId}`);
    expect((await service.snapshot()).tally).toEqual({ up: 0, down: 0, left: 0, right: 0 });
    expect(await service.vote("someone", "ip", "down")).toEqual({ status: "not-allowed", heading: "up" });
    expect(await service.vote("someone", "ip", "left")).toMatchObject({ status: "recorded" });
  });
});
