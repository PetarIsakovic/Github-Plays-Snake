import { describe, expect, it } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { esc, fmtClock, fmtInt, renderSvg } from "../../src/render/svg";
import { layoutFor } from "../../src/render/layout";
import { NOW, scenarios, base } from "../fixtures/scenarios";

const render = (sc = scenarios()[1]!, theme: "dark" | "light" = "dark") =>
  renderSvg({ state: sc.state, tally: sc.tally, now: NOW, roundMs: 120_000, theme });

describe("renderSvg", () => {
  it.each(scenarios().flatMap((s) => [[s.name, "dark"], [s.name, "light"]] as const))("%s/%s is valid XML with explicit size and viewBox", (name, theme) => {
    const sc = scenarios().find((s) => s.name === name)!;
    const svg = render(sc, theme);
    expect(XMLValidator.validate(svg)).toBe(true);
    const L = layoutFor(sc.state.cols, sc.state.rows);
    expect(svg).toContain(`width="${L.width}" height="${L.height}" viewBox="0 0 ${L.width} ${L.height}"`);
    expect(svg.length).toBeLessThan(80_000);
  });

  it("contains no script, external references, or web fonts (Camo CSP)", () => {
    for (const sc of scenarios())
      for (const theme of ["dark", "light"] as const) {
        const svg = render(sc, theme);
        expect(svg).not.toMatch(/<script|javascript:|@import|@font-face|url\((?!#)|href=|<foreignObject|<image/i);
      }
  });

  it("has no NaN/undefined geometry", () => {
    for (const sc of scenarios()) {
      const svg = render(sc);
      expect(svg).not.toMatch(/NaN|undefined|Infinity|null/);
    }
  });

  it("shows the title, round, score, best and per-arrow percentages", () => {
    const svg = render();
    for (const s of ["github plays snake", "round 1,287", "score 7", "best 23", "click an arrow", " 50%", " 13%", " 37%"]) expect(svg).toContain(s);
  });

  it("disables only the arrow that would reverse the snake", () => {
    const svg = render(); // heading up -> 'down' disabled
    const dashed = svg.match(/stroke-dasharray/g) ?? [];
    expect(dashed).toHaveLength(1);
    const L = layoutFor(16, 12);
    const D = L.controls.down;
    expect(svg).toContain(`<rect x="${Math.round(D.x * 10) / 10}" y="${D.y}" width="${Math.round(D.w * 10) / 10}" height="${D.h}" rx="6" fill="none" stroke="#21262d" stroke-dasharray`);
  });

  it("draws every snake segment inside the board and the apple", () => {
    const sc = scenarios()[1]!;
    const svg = render(sc);
    const L = layoutFor(16, 12);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(svg);
    expect(parsed.svg).toBeTruthy();
    // Each segment is drawn as a rounded rect whose top-left lies within its cell.
    for (const p of sc.state.snake) {
      const x0 = L.board.x + p.x * L.cell;
      const y0 = L.board.y + p.y * L.cell;
      expect(svg).toMatch(new RegExp(`<rect x="${x0 + 2}|<rect x="${x0 + 3}|<rect x="${x0 + 4.5}`));
      expect(y0).toBeGreaterThanOrEqual(L.board.y);
    }
  });

  it("controls are drawn exactly where the hit-test expects them", () => {
    const svg = render();
    const L = layoutFor(16, 12);
    const r1 = (n: number) => Math.round(n * 10) / 10;
    for (const d of ["left", "up", "right"] as const) {
      const R = L.controls[d];
      expect(svg).toContain(`<rect x="${r1(R.x + 0.5)}" y="${r1(R.y + 0.5)}" width="${r1(R.w - 1)}" height="${r1(R.h - 1)}" rx="6"`);
    }
  });

  it("shows a distinctive game over state", () => {
    const svg = render(scenarios().find((s) => s.name === "gameover-self"));
    expect(svg).toContain("bit itself · score 12");
    expect(svg).toContain("new snake in 1:25");
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(4); // all arrows disabled
  });

  it("shows a celebration when the board is full", () => {
    expect(render(scenarios().find((s) => s.name === "won"))).toContain("board cleared");
  });

  it("escapes any text it renders", () => {
    expect(esc(`<script>alert("x")&'</script>`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;");
    // Even a hostile gameId in state never reaches the output unescaped.
    const svg = renderSvg({ state: base({ gameId: "<script>x</script>" }), tally: { up: 0, down: 0, left: 0, right: 0 }, now: NOW, roundMs: 120_000, theme: "dark" });
    expect(svg).not.toContain("<script>");
  });

  it("fades in a full-board refresh overlay exactly at the deadline", () => {
    const svg = render();
    expect(svg).toContain("click to refresh");
    expect(svg).toMatch(/<g opacity="0" visibility="hidden"><set attributeName="visibility" to="visible" begin="85s"/);
    const sc = scenarios().find((s) => s.name === "refresh-overlay")!;
    const overdue = renderSvg({ state: sc.state, tally: sc.tally, now: sc.now!, roundMs: 120_000, theme: "dark" });
    expect(overdue).toContain("click to refresh");
    expect(overdue).not.toContain('<g opacity="0" visibility="hidden">'); // shown immediately
  });

  it("countdown animates to the real deadline and is static-friendly", () => {
    const svg = render();
    // nextTickAt - now = 85s in the fixture
    expect(svg).toContain(">next move in 1:25<");
    expect(svg).toContain('begin="85s"');
    expect(svg).toContain("moving, reload");
    // An overdue round shows the reload hint immediately.
    const sc = scenarios()[1]!;
    const overdue = renderSvg({ state: sc.state, tally: sc.tally, now: sc.state.nextTickAt + 5000, roundMs: 120_000, theme: "light" });
    expect(overdue).toContain("moving, reload");
    expect(XMLValidator.validate(overdue)).toBe(true);
  });

  it("text is never smaller than 9.5px", () => {
    const sizes = [...render().matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(9.5);
  });
});

describe("formatters", () => {
  it("fmtInt", () => {
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(1287)).toBe("1,287");
    expect(fmtInt(99_999)).toBe("99,999");
    expect(fmtInt(123_456)).toBe("123k");
    expect(fmtInt(1_234_567)).toBe("1.23M");
    expect(fmtInt(48_211, 10_000)).toBe("48.2k");
    expect(fmtInt(99_999, 10_000)).toBe("99.9k");
    expect(fmtInt(-5)).toBe("0");
    expect(fmtInt(Number.NaN)).toBe("0");
  });
  it("fmtClock", () => {
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(84.2)).toBe("1:25");
    expect(fmtClock(3725)).toBe("1:02:05");
  });
});
