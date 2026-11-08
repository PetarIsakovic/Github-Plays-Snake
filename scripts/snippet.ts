/** Print the ready-to-paste README snippet for a deployment: npm run snippet [-- <service-url>] */
import { readFileSync } from "node:fs";
import { embedSnippet } from "../src/embed";

let base = process.argv[2];
if (!base) {
  try {
    base = (Object.values(JSON.parse(readFileSync("cdk-outputs.json", "utf8")))[0] as Record<string, string>).ServiceUrl;
  } catch {
    base = "https://YOUR-FUNCTION-URL.lambda-url.us-east-1.on.aws";
  }
}
console.log(embedSnippet(base!));
