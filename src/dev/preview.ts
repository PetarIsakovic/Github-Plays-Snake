/**
 * Local preview page. The two embeds use exactly the README markup (ismap image
 * inside a link). The debug panel uses JavaScript, which is fine locally. The
 * production README never contains any script.
 */
export function previewHtml(base: string): string {
  const embed = (theme: "dark" | "light") => `
    <p align="center">
      <a href="${base}/vote?c=">
        <img ismap src="${base}/board.svg?theme=${theme}" width="512" alt="GitHub Plays Snake: click an arrow to vote">
      </a>
    </p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub Plays Snake: local dev</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; background: #f6f8fa; color: #1f2328; }
  header { padding: 16px 24px; border-bottom: 1px solid #d0d7de; background: #fff; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0 12px 0 0; }
  button, select { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #d0d7de; background: #f6f8fa; cursor: pointer; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 24px; padding: 24px; }
  /* Mimic GitHub's README box: 24px padding, images max-width 100% */
  .readme { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 24px; margin-bottom: 24px; box-sizing: content-box; }
  .readme.dark { background: #0d1117; border-color: #30363d; color: #e6edf3; }
  .readme.dark a { color: #4493f8; }
  .readme img { max-width: 100%; box-sizing: content-box; }
  pre { background: #0d1117; color: #c9d1d9; padding: 12px; border-radius: 6px; overflow: auto; font-size: 12px; max-height: 70vh; }
  label { font-size: 13px; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
</style></head>
<body>
<header>
  <h1>🐍 GitHub Plays Snake: local dev</h1>
  <button onclick="post('/dev/tick')">Force tick</button>
  <button onclick="post('/dev/votes?n=5')">+5 random votes</button>
  <button onclick="post('/dev/votes?n=1&turn=up')">+1 up</button>
  <button onclick="post('/dev/votes?n=1&turn=left')">+1 left</button>
  <button onclick="post('/dev/votes?n=1&turn=right')">+1 right</button>
  <button onclick="post('/dev/reset')">Reset run</button>
  <button onclick="post('/dev/reset?hard=1')">Hard reset</button>
  <label>README column width
    <select id="w" onchange="setWidth(this.value)">
      <option value="846">846px (desktop ≥1280)</option>
      <option value="731">731px (MacBook window)</option>
      <option value="766">766px (1200px window)</option>
      <option value="600">600px</option>
      <option value="343">343px (phone)</option>
    </select>
  </label>
</header>
<main>
  <div>
    <div class="readme dark" id="r1">${embed("dark")}</div>
    <div class="readme" id="r2">${embed("light")}</div>
  </div>
  <div>
    <strong>Internal state</strong> (auto-refreshes)
    <pre id="state">loading…</pre>
  </div>
</main>
<script>
  async function post(p) { await fetch(p, { method: 'POST' }); location.reload(); }
  function setWidth(w) {
    for (const id of ['r1','r2']) document.getElementById(id).style.width = w + 'px';
    localStorage.setItem('w', w);
  }
  const saved = localStorage.getItem('w'); if (saved) { document.getElementById('w').value = saved; setWidth(saved); }
  async function refresh() {
    const s = await (await fetch('/dev/state')).json();
    const { state, tally, serverTime, runs } = s;
    document.getElementById('state').textContent = JSON.stringify({ serverTime, tally, ...state, runs }, null, 2);
  }
  refresh(); setInterval(refresh, 1000);
</script>
</body></html>`;
}
