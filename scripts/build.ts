/**
 * Bundle the two Lambda handlers with esbuild into dist/<name>/index.js.
 * The CDK stack deploys exactly these bundles. The AWS SDK v3 is provided by the
 * Node.js Lambda runtime, so it is left external to keep cold starts small.
 */
import { build } from "esbuild";
import { rmSync, statSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const entries = { http: "src/lambda/http.ts", tick: "src/lambda/tick.ts" };
for (const [name, entry] of Object.entries(entries)) {
  await build({
    entryPoints: [entry],
    outfile: `dist/${name}/index.js`,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: true,
    sourcemap: false,
    external: ["@aws-sdk/*"],
    legalComments: "none",
  });
  console.log(`dist/${name}/index.js  ${(statSync(`dist/${name}/index.js`).size / 1024).toFixed(1)} KB`);
}
