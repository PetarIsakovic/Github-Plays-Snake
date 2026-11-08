/**
 * Render every scenario in both themes and capture PNGs with headless Chrome,
 * inside a page that mimics GitHub's README box at several column widths.
 *
 *   npm run screenshots   ->  screenshots/*.png
 *
 * Uses the locally installed Google Chrome (set CHROME_PATH to override).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { renderSvg } from "../src/render/svg";
import { NOW, scenarios } from "../tests/fixtures/scenarios";

const OUT = "screenshots";
const TMP = join(OUT, "tmp");
mkdirSync(TMP, { recursive: true });

const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const only = process.argv[2];

const widths = [
  { name: "desktop", column: 846 },
  { name: "narrow", column: 700 },
  { name: "mobile", column: 343 },
];

const page = (svgFile: string, theme: "dark" | "light", column: number) => `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;background:${theme === "dark" ? "#0d1117" : "#ffffff"}}
.readme{width:${column}px;padding:24px;border:1px solid ${theme === "dark" ? "#30363d" : "#d0d7de"};border-radius:6px;margin:16px}
img{max-width:100%;display:block}</style></head>
<body><div class="readme"><a href="#"><img ismap src="${svgFile}" width="512"></a></div></body></html>`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--allow-file-access-from-files"] });
try {
  const tab = await browser.newPage();
  for (const sc of scenarios()) {
    if (only && !sc.name.includes(only)) continue;
    for (const theme of ["dark", "light"] as const) {
      const svg = renderSvg({ state: sc.state, tally: sc.tally, now: sc.now ?? NOW, roundMs: 120_000, theme });
      const svgFile = `${sc.name}-${theme}.svg`;
      writeFileSync(join(TMP, svgFile), svg);
      for (const w of widths) {
        if (w.name !== "desktop" && sc.name !== "voting") continue; // other widths only for the main scenario
        const html = join(TMP, `${sc.name}-${theme}-${w.name}.html`);
        writeFileSync(html, page(svgFile, theme, w.column));
        await tab.setViewport({ width: w.column + 84, height: 900, deviceScaleFactor: 2 });
        await tab.goto(`file://${process.cwd()}/${html}`, { waitUntil: "load" });
        const el = await tab.$(".readme");
        const png = join(OUT, `${sc.name}-${theme}-${w.name}.png`);
        await el!.screenshot({ path: png as `${string}.png` });
        console.log(png, `${(svg.length / 1024).toFixed(1)} KB svg`);
      }
    }
  }
} finally {
  await browser.close();
}
