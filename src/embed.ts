/**
 * The README embed. Plain HTML that GitHub's sanitizer keeps: a link around a
 * <picture> (dark/light) whose <img> has `ismap`. No script, no iframe, no CSS.
 *
 * - href ends in `?c=` so the browser-appended `?x,y` lands in a query VALUE
 *   (Lambda Function URLs reject commas in query keys).
 * - Keep width="512" and no height: coordinates are decoded against a 512px layout.
 */
export function embedSnippet(base: string): string {
  const b = base.replace(/\/$/, "");
  return `<p align="center">
  <a href="${b}/vote?c=">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="${b}/board.svg?theme=dark">
      <img ismap src="${b}/board.svg?theme=light" width="512" alt="GitHub Plays Snake: a community-controlled snake. Click an arrow to vote on its next move.">
    </picture>
  </a>
</p>`;
}
