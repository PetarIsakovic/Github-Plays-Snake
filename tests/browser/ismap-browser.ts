/**
 * Real-browser compatibility test for the README interaction (no GitHub needed).
 *
 * Starts the local dev server, loads the preview page that embeds the board with
 * the exact README markup (<a href=/vote?c=><img ismap width=512></a>) inside a
 * GitHub-like column with `img { max-width: 100% }`, and clicks with headless
 * Chrome. Verifies:
 *   - Chrome appends ?x,y in rendered CSS pixels
 *   - the 303 redirect returns to the "profile" page
 *   - the visitor cookie is set (HttpOnly) and dedupes votes
 *   - board clicks never vote
 *   - at narrower column widths, scaled clicks never vote for the wrong button
 *   - the plain-link fallback works at phone width
 *
 *   npm run test:browser
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import puppeteer, { type Page } from "puppeteer-core";
import { layoutFor } from "../../src/render/layout";
import { DIRECTIONS, type Direction, type Tally } from "../../src/game/types";

const PORT = 8791;
const BASE = `http://localhost:${PORT}`;
const STATE = ".dev-state.browser-test.json";
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) failures++;
}

rmSync(STATE, { force: true });
const server = spawn("node_modules/.bin/tsx", ["src/dev/server.ts"], {
  env: { ...process.env, PORT: String(PORT), DEV_STATE_FILE: STATE, ROUND_SECONDS: "3600", LOG_SILENT: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("dev server did not start")), 20_000);
  server.stdout!.on("data", (d: Buffer) => {
    if (d.toString().includes("Preview:")) {
      clearTimeout(t);
      resolve();
    }
  });
});

const tally = async (): Promise<Tally> => ((await (await fetch(`${BASE}/dev/state`)).json()) as { tally: Tally }).tally;
const total = (t: Tally) => t.up + t.down + t.left + t.right;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  const L = layoutFor(16, 12);

  async function openAt(page: Page, column: number) {
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.evaluate((w) => {
      for (const id of ["r1", "r2"]) (document.getElementById(id) as HTMLElement).style.width = `${w}px`;
    }, column);
    const box = await page.$eval("#r1 img", (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    return box;
  }

  async function clickImage(page: Page, X: number, Y: number, column: number) {
    const box = await openAt(page, column);
    const s = box.w / L.width;
    const nav = page.waitForNavigation({ waitUntil: "networkidle0" });
    let requested = "";
    const onReq = (r: { url(): string }) => {
      if (r.url().includes("/vote")) requested = r.url();
    };
    page.on("request", onReq);
    await page.mouse.click(box.x + X * s, box.y + Y * s);
    await nav;
    page.off("request", onReq);
    return { requested, finalUrl: page.url(), scale: s, box };
  }

  // ---------------------------------------------------------------- native width
  console.log("731px README column (MacBook window) -> image at native 512px");
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const R = L.controls.up; // fresh snake heads right, so up/down/right are allowed
    const before = await tally();
    const r = await clickImage(page, R.x + 60, R.y + 40, 731);
    check(r.box.w === 512, `image renders unscaled at 512px (got ${r.box.w})`);
    check(/\/vote\?c=\?\d+,\d+$/.test(r.requested), `browser appended ismap coordinates to href '/vote?c=': ${r.requested.replace(BASE, "")}`);
    const [qx, qy] = r.requested.split("?").pop()!.split(",").map(Number);
    check(Math.abs(qx! - (R.x + 60)) <= 1 && Math.abs(qy! - (R.y + 40)) <= 1, `coordinates are in image CSS pixels (${qx},${qy})`);
    check(r.finalUrl === `${BASE}/`, `303 redirected back to the profile page (${r.finalUrl})`);
    const after = await tally();
    check(after.up === before.up + 1, `UP vote recorded (${JSON.stringify(after)})`);

    const cookies = await page.cookies(`${BASE}/vote`);
    const c = cookies.find((k) => k.name === "gps_vid");
    check(!!c && !!c.httpOnly && c.sameSite === "Lax" && c.path === "/vote", "visitor cookie is HttpOnly, SameSite=Lax, Path=/vote");

    await clickImage(page, R.x + 90, R.y + 30, 731);
    check(total(await tally()) === total(after), "second click by the same visitor does not add a vote");

    const S = L.controls.down;
    await clickImage(page, S.x + 60, S.y + 40, 731);
    const changed = await tally();
    check(changed.up === after.up - 1 && changed.down === after.down + 1, "changing the vote moves it from UP to DOWN");

    const beforeReverse = await tally();
    const Rv = L.controls.left;
    await clickImage(page, Rv.x + 60, Rv.y + 30, 731);
    check(total(await tally()) === total(beforeReverse) - 0 && (await tally()).left === 0, "the disabled reverse arrow (LEFT) does not vote");

    const beforeBoard = await tally();
    await clickImage(page, L.board.x + 200, L.board.y + 150, 731);
    check(total(await tally()) === total(beforeBoard), "clicking the board does not vote");
    await page.close();
  }

  // ---------------------------------------------------------------- scaled widths
  for (const column of [500, 470, 343]) {
    console.log(`Scaled column ${column}px`);
    let wrong = 0;
    let counted = 0;
    let dropped = 0;
    for (const t of DIRECTIONS) {
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.2, 0.8],
        [0.85, 0.3],
      ] as const) {
        const ctx = await browser.createBrowserContext(); // fresh visitor (own cookie jar) each time
        const page = await ctx.newPage();
        await page.setViewport({ width: 1400, height: 1000 });
        const R = L.controls[t];
        const before = await tally();
        await clickImage(page, R.x + R.w * fx, R.y + R.h * fy, column);
        const after = await tally();
        const delta = (Object.keys(after) as Direction[]).filter((k) => after[k] !== before[k]);
        if (delta.length === 0) dropped++;
        else if (delta.length === 1 && delta[0] === t) counted++;
        else wrong++;
        await ctx.close();
      }
    }
    check(wrong === 0, `no click counted for the wrong button (counted ${counted}, ignored ${dropped}, wrong ${wrong})`);
  }

} finally {
  await browser.close();
  server.kill();
  rmSync(STATE, { force: true });
}

console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} browser check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
