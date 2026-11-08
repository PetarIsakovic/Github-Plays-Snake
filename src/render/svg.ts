/**
 * Server-side SVG renderer. Output is a single self-contained SVG that survives
 * GitHub's Camo proxy, which serves it with the CSP
 * `default-src 'none'; img-src data:; style-src 'unsafe-inline'`.
 * So: no external resources, no web fonts (system monospace only), no script.
 *
 * The only animation is a countdown to the real, server-computed deadline. It
 * never pretends the board itself is live.
 */
import { canMove, DELTA } from "../game/directions";
import { inBounds } from "../game/engine";
import { percentages, resolveDirection, tallyTotal } from "../game/voting";
import { DIRECTIONS, type Direction, type GameState, type Point, type Tally } from "../game/types";
import { layoutFor, type Layout, type Rect } from "./layout";
import { THEMES, type Theme, type ThemeName } from "./theme";

export interface RenderInput {
  state: GameState;
  tally: Tally;
  now: number;
  roundMs: number;
  theme: ThemeName;
}

const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Integer with thousands separators; compacts above `compactFrom` (e.g. 48.2k, 1.23M) so labels never overflow. */
export function fmtInt(n: number, compactFrom = 100_000): string {
  if (!Number.isFinite(n)) return "0";
  const v = Math.max(0, Math.floor(n));
  if (v >= compactFrom) {
    const [div, unit] = v >= 1_000_000 ? [1_000_000, "M"] : [1000, "k"];
    const x = v / div;
    const digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
    const f = Math.floor(x * 10 ** digits) / 10 ** digits; // never round up past the true value
    return `${f.toFixed(digits).replace(/\.?0+$/, "")}${unit}`;
  }
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function text(x: number, y: number, content: string, attrs: string): string {
  return `<text x="${r1(x)}" y="${r1(y)}" ${attrs}>${esc(content)}</text>`;
}

function rect(r: Rect, attrs: string): string {
  return `<rect x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}" ${attrs}/>`;
}

/**
 * A once-per-second countdown using SMIL `set` (allowed inside <img>). The first
 * frame is visible without animation support, so static renderers show the value
 * computed at fetch time; after the deadline it switches to `doneText`.
 */
function countdown(x: number, y: number, seconds: number, attrs: string, label: (clock: string) => string, doneText: string): string {
  const total = Math.max(0, Math.ceil(seconds));
  if (total === 0) return text(x, y, doneText, attrs);
  const step = total <= 600 ? 1 : 60;
  const parts: string[] = [];
  for (let t = 0; t < total; t += step) {
    const content = esc(label(fmtClock(total - t)));
    parts.push(
      t === 0
        ? `<text x="${x}" y="${y}" ${attrs}>${content}<set attributeName="visibility" to="hidden" begin="${step}s" fill="freeze"/></text>`
        : `<text x="${x}" y="${y}" ${attrs} visibility="hidden">${content}<set attributeName="visibility" to="visible" begin="${t}s" dur="${Math.min(step, total - t)}s"/></text>`,
    );
  }
  parts.push(`<text x="${x}" y="${y}" ${attrs} visibility="hidden">${esc(doneText)}<set attributeName="visibility" to="visible" begin="${total}s" fill="freeze"/></text>`);
  return parts.join("");
}

/** Arrow glyph pointing up, centred on (0,0); rotated per direction. */
const ARROW = "M0 -6V6M-4.5 -1.5 0 -6l4.5 4.5";
const ROTATION: Record<Direction, number> = { up: 0, right: 90, down: 180, left: 270 };

function arrow(cx: number, cy: number, d: Direction, color: string): string {
  return `<path d="${ARROW}" transform="translate(${r1(cx)} ${r1(cy)}) rotate(${ROTATION[d]})" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// ---------------------------------------------------------------- pieces

function header(L: Layout, th: Theme, s: GameState): string {
  const right = `round ${fmtInt(s.roundId)}  score ${fmtInt(s.score)}  best ${fmtInt(s.bestScore)}`;
  return (
    text(L.contentX, L.headerBaseline, "github plays snake", `class="m" font-size="13" font-weight="600" fill="${th.text}"`) +
    text(L.contentX + L.contentW, L.headerBaseline, right, `class="m" font-size="12" fill="${th.muted}" text-anchor="end" xml:space="preserve"`)
  );
}

function board(L: Layout, th: Theme, s: GameState): string {
  const { board: B, cell: c } = L;
  const out: string[] = [];
  // A faint dot at every cell centre: enough to read the grid, nothing more.
  out.push(
    `<defs><pattern id="g" x="${B.x}" y="${B.y}" width="${c}" height="${c}" patternUnits="userSpaceOnUse">` +
      `<circle cx="${c / 2}" cy="${c / 2}" r="1.1" fill="${th.line}"/></pattern></defs>`,
  );
  out.push(rect(B, `rx="6" fill="url(#g)" stroke="${th.line}"`));

  const cx = (p: Point) => B.x + p.x * c + c / 2;
  const cy = (p: Point) => B.y + p.y * c + c / 2;
  if (s.apple) out.push(`<circle cx="${r1(cx(s.apple))}" cy="${r1(cy(s.apple))}" r="${r1(c * 0.26)}" fill="${th.apple}"/>`);
  out.push(snake(L, th, s));

  if (s.status === "gameover" && s.crashAt) {
    const head = s.snake[0]!;
    // Mark the cell the snake tried to enter (clamped onto the board edge for wall hits).
    const p = inBounds(s.crashAt, s.cols, s.rows) ? { x: cx(s.crashAt), y: cy(s.crashAt) } : { x: cx(head) + (DELTA[s.direction].x * c) / 2, y: cy(head) + (DELTA[s.direction].y * c) / 2 };
    out.push(`<path d="M${r1(p.x - 4)} ${r1(p.y - 4)}l8 8m0 -8l-8 8" stroke="${th.apple}" stroke-width="2" stroke-linecap="round"/>`);
  }
  return out.join("");
}

function snake(L: Layout, th: Theme, s: GameState): string {
  const { board: B, cell: c } = L;
  const segs = s.snake;
  const dead = s.status === "gameover";
  const body = dead ? th.faint : th.snake;
  const inset = 2;
  const size = c - 2 * inset;
  const px = (p: Point) => B.x + p.x * c;
  const py = (p: Point) => B.y + p.y * c;
  const out: string[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = segs[i]!;
    const color = i === 0 && !dead ? th.head : body;
    const next = i > 0 ? segs[i - 1]! : null;
    if (next && Math.abs(next.x - p.x) + Math.abs(next.y - p.y) === 1) {
      const horizontal = next.x !== p.x;
      const x = horizontal ? Math.min(px(p), px(next)) + c / 2 : px(p) + inset;
      const y = horizontal ? py(p) + inset : Math.min(py(p), py(next)) + c / 2;
      out.push(`<rect x="${x}" y="${y}" width="${horizontal ? c : size}" height="${horizontal ? size : c}" fill="${body}"/>`);
    }
    out.push(`<rect x="${px(p) + inset}" y="${py(p) + inset}" width="${size}" height="${size}" rx="3" fill="${color}"/>`);
  }
  if (!dead && segs[0]) {
    // Two small eyes looking where the snake is heading.
    const h = segs[0];
    const ccx = px(h) + c / 2;
    const ccy = py(h) + c / 2;
    const d = DELTA[s.direction];
    const side = { x: -d.y, y: d.x };
    for (const k of [-1, 1]) {
      out.push(`<circle cx="${r1(ccx + d.x * 3.5 + side.x * 4.5 * k)}" cy="${r1(ccy + d.y * 3.5 + side.y * 4.5 * k)}" r="1.8" fill="${th.bg}"/>`);
    }
  }
  return out.join("");
}

function progress(L: Layout, th: Theme, s: GameState, now: number, roundMs: number): string {
  const remaining = Math.max(0, (s.nextTickAt - now) / 1000);
  // Length of the current phase (a voting round, or the shorter game-over pause).
  const phaseMs = s.nextTickAt - s.roundStartedAt > 0 ? s.nextTickAt - s.roundStartedAt : roundMs;
  const frac0 = phaseMs > 0 ? Math.min(1, Math.max(0, 1 - (remaining * 1000) / phaseMs)) : 1;
  const w0 = r1(L.bar.w * frac0);
  const fill = s.status === "playing" ? th.muted : th.apple;
  return (
    rect(L.bar, `rx="1" fill="${th.lineSoft}"`) +
    `<rect x="${L.bar.x}" y="${L.bar.y}" width="${w0}" height="${L.bar.h}" rx="1" fill="${fill}">` +
    (remaining > 0 ? `<animate attributeName="width" from="${w0}" to="${L.bar.w}" dur="${r1(remaining)}s" fill="freeze"/>` : "") +
    `</rect>`
  );
}

function status(L: Layout, th: Theme, s: GameState, now: number): string {
  const remaining = Math.max(0, (s.nextTickAt - now) / 1000);
  const y = L.statusBaseline;
  const attrs = `class="m" font-size="12" fill="${th.muted}"`;
  if (s.status === "playing") {
    return (
      countdown(L.contentX, y, remaining, attrs, (t) => `next move in ${t}`, "moving, reload") +
      text(L.contentX + L.contentW, y, "click an arrow", `${attrs} text-anchor="end"`)
    );
  }
  const what = s.status === "won" ? "board cleared" : s.deathCause === "wall" ? "hit the wall" : "bit itself";
  return (
    text(L.contentX, y, `${what} · score ${fmtInt(s.score)}`, `class="m" font-size="12" fill="${s.status === "won" ? th.snake : th.apple}"`) +
    countdown(L.contentX + L.contentW, y, remaining, `${attrs} text-anchor="end"`, (t) => `new snake in ${t}`, "reload")
  );
}

function controls(L: Layout, th: Theme, s: GameState, tally: Tally): string {
  const playing = s.status === "playing";
  const pct = percentages(tally);
  const total = tallyTotal(tally);
  const going = resolveDirection(tally, s.direction);
  const out: string[] = [];
  for (const d of DIRECTIONS) {
    const R = L.controls[d];
    const allowed = canMove(s.direction, d);
    const cy = R.y + R.h / 2;
    if (!playing || !allowed) {
      // Disabled: the reverse of the current heading (or everything during game over).
      out.push(rect(R, `rx="6" fill="none" stroke="${th.lineSoft}" stroke-dasharray="3 3"`));
      out.push(arrow(R.x + R.w / 2, cy, d, th.faint));
      continue;
    }
    const lead = d === going;
    out.push(rect({ x: R.x + 0.5, y: R.y + 0.5, w: R.w - 1, h: R.h - 1 }, `rx="6" fill="none" stroke="${lead ? th.text : th.line}" stroke-width="${lead ? 1.5 : 1}"`));
    out.push(arrow(R.x + 20, cy, d, lead ? th.text : th.muted));
    const count = fmtInt(tally[d], 10_000);
    out.push(
      `<text x="${r1(R.x + R.w - 10)}" y="${r1(cy + 4)}" class="m" font-size="12" text-anchor="end" fill="${th.text}">${esc(count)}` +
        (total > 0 ? `<tspan fill="${th.faint}" font-size="10"> ${pct[d]}%</tspan>` : "") +
        `</text>`,
    );
  }
  return out.join("");
}

/**
 * Once the round's deadline passes, the open README is stale. Fade a translucent
 * layer over the whole board with a big refresh icon. Clicking anywhere on the
 * image goes through /vote, which always redirects back to the profile, so any
 * click reloads the page. Shown immediately if the board was rendered overdue.
 */
function refreshOverlay(L: Layout, th: Theme, s: GameState, now: number): string {
  const remaining = Math.max(0, (s.nextTickAt - now) / 1000);
  const cx = L.width / 2;
  const cy = L.board.y + L.board.h / 2;
  const r = 34;
  const icon =
    `<g transform="translate(${r1(cx - 24)} ${r1(cy - 24)}) scale(2)" fill="none" stroke="${th.text}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/></g>`;
  const inner =
    rect({ x: 0, y: 0, w: L.width, h: L.height }, `rx="12" fill="${th.bg}" opacity="0.82"`) +
    `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" fill="${th.bg}" stroke="${th.line}" stroke-width="1.5"/>` +
    icon +
    text(cx, cy + r + 26, "click to refresh", `class="m" font-size="13" font-weight="600" fill="${th.text}" text-anchor="middle"`);
  if (remaining <= 0) return `<g>${inner}</g>`;
  return (
    `<g opacity="0" visibility="hidden">` +
    `<set attributeName="visibility" to="visible" begin="${r1(remaining)}s" fill="freeze"/>` +
    `<animate attributeName="opacity" from="0" to="1" begin="${r1(remaining)}s" dur="0.4s" fill="freeze"/>` +
    inner +
    `</g>`
  );
}

function describe(s: GameState, tally: Tally): string {
  const status =
    s.status === "playing"
      ? `Round ${s.roundId}. The snake is heading ${s.direction} with length ${s.snake.length}.`
      : s.status === "won"
        ? "The snake filled the board. A new snake starts next round."
        : `Game over: the snake ${s.deathCause === "wall" ? "hit the wall" : "bit itself"}. A new snake starts next round.`;
  return `${status} Score ${s.score}, best ${s.bestScore}. Votes this round: up ${tally.up}, down ${tally.down}, left ${tally.left}, right ${tally.right}.`;
}

export function renderSvg({ state: s, tally, now, roundMs, theme }: RenderInput): string {
  const th = THEMES[theme];
  const L = layoutFor(s.cols, s.rows);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}" role="img" aria-labelledby="t d">`,
    `<title id="t">GitHub Plays Snake</title><desc id="d">${esc(describe(s, tally))}</desc>`,
    `<style>.m{font-family:${MONO}}</style>`,
    rect({ x: 0.5, y: 0.5, w: L.width - 1, h: L.height - 1 }, `rx="12" fill="${th.bg}" stroke="${th.line}"`),
    header(L, th, s),
    board(L, th, s),
    progress(L, th, s, now, roundMs),
    status(L, th, s, now),
    controls(L, th, s, tally),
    refreshOverlay(L, th, s, now),
    `</svg>`,
  ].join("");
}
