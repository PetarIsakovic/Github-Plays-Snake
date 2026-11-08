/**
 * Live end-to-end check against a deployed endpoint, in real headless Chrome,
 * using the exact README embed markup.
 *
 *   npm run live-check -- https://<id>.lambda-url.us-east-1.on.aws
 *   (defaults to ServiceUrl from cdk-outputs.json)
 *
 * NOTE: this casts real votes (one per run, plus one ignored repeat).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { layoutFor } from "../src/render/layout";
import { OPPOSITE } from "../src/game/directions";
import { DIRECTIONS, type Direction } from "../src/game/types";
import { embedSnippet } from "../src/embed";

let base = process.argv[2];
if (!base) {
  const outputs = JSON.parse(readFileSync("cdk-outputs.json", "utf8"));
  base = (Object.values(outputs)[0] as Record<string, string>).ServiceUrl;
}
base = base!.replace(/\/$/, "");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${msg}`);
  if (!ok) failures++;
};
type Tally = { up: number; down: number; left: number; right: number };
const state = async () => (await (await fetch(`${base}/state.json`)).json()) as { tally: Tally; state: { roundId: number; direction: Direction; status: string } };

mkdirSync("screenshots/tmp", { recursive: true });
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff}.readme{width:731px;padding:24px}img{max-width:100%}</style>
<div class="readme">${embedSnippet(base)}</div>`;
writeFileSync("screenshots/tmp/live.html", html);

const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(`file://${process.cwd()}/screenshots/tmp/live.html`, { waitUntil: "networkidle0" });
  const box = await page.$eval("img[ismap]", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, natural: (el as HTMLImageElement).naturalWidth };
  });
  check(box.w === 512 && box.h > 450, `live SVG rendered in <img ismap> at ${box.w}x${Math.round(box.h)}`);
  await page.screenshot({ path: "screenshots/live-embed.png" });

  const L = layoutFor(16, 12);
  const before = await state();
  // Vote for any direction that doesn't reverse the live snake.
  const dir = DIRECTIONS.find((d) => d !== OPPOSITE[before.state.direction])!;
  const R = L.controls[dir];
  const hops: { url: string; status: number; location?: string }[] = [];
  page.on("response", (res) => {
    if (res.url().includes("/vote")) hops.push({ url: res.url(), status: res.status(), location: res.headers().location });
  });
  // Don't load github.com itself; we only need to see that the browser was sent there.
  await page.setRequestInterception(true);
  page.on("request", (req) => (req.url().startsWith("https://github.com") ? req.respond({ status: 200, body: "github" }) : req.continue()));

  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.mouse.click(box.x + R.x + 60, box.y + R.y + 36)]);
  const hop = hops[0];
  check(!!hop && /\/vote\?c=\?\d+,\d+$/.test(hop.url), `click sent ismap coordinates: ${hop?.url.replace(base, "")}`);
  check(hop?.status === 303, `vote endpoint answered 303 (got ${hop?.status})`);
  check(page.url().startsWith("https://github.com"), `browser landed on the GitHub profile (${page.url()})`);

  const after = await state();
  const sameRound = after.state.roundId === before.state.roundId;
  if (before.state.status === "playing") check(!sameRound || after.tally[dir] === before.tally[dir] + 1, `${dir.toUpperCase()} counted live (${before.tally[dir]} -> ${after.tally[dir]}, round ${after.state.roundId})`);

  const cookies = await page.cookies(`${base}/vote`);
  const c = cookies.find((k) => k.name === "gps_vid");
  check(!!c && !!c.secure && !!c.httpOnly && c.sameSite === "Lax", "visitor cookie set: Secure, HttpOnly, SameSite=Lax");

  // Same visitor clicks again -> no double count.
  await page.goto(`file://${process.cwd()}/screenshots/tmp/live.html`, { waitUntil: "networkidle0" });
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.mouse.click(box.x + R.x + 90, box.y + R.y + 30)]);
  const again = await state();
  if (again.state.roundId === after.state.roundId) check(again.tally[dir] === after.tally[dir], "repeat click by the same visitor is not double counted");
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} live check(s) FAILED` : "\nAll live checks passed.");
process.exit(failures ? 1 : 0);
