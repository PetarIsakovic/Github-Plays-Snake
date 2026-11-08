/**
 * IAM-authenticated admin actions against the deployed game. There is no public
 * admin endpoint: these invoke the Tick Lambda directly, which requires AWS credentials.
 *
 *   npm run admin -- state          # current state (JSON)
 *   npm run admin -- runs           # recent finished runs
 *   npm run admin -- tick           # run the scheduler's tick now (no-op unless due)
 *   npm run admin -- expire-round   # end the current round immediately and tick
 *   npm run admin -- reset          # start a new run now (keeps best score / totals)
 *   npm run admin -- hard-reset     # wipe everything and start over
 */
import { readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const action = process.argv[2] ?? "state";
const allowed = ["state", "runs", "tick", "expire-round", "reset", "hard-reset"];
if (!allowed.includes(action)) {
  console.error(`Usage: npm run admin -- <${allowed.join("|")}>`);
  process.exit(2);
}

let fn = process.env.TICK_FUNCTION_NAME;
if (!fn) {
  try {
    const outputs = JSON.parse(readFileSync("cdk-outputs.json", "utf8"));
    fn = (Object.values(outputs)[0] as Record<string, string>).TickFunctionName;
  } catch {
    /* handled below */
  }
}
if (!fn) {
  console.error("Set TICK_FUNCTION_NAME or deploy first (npm run deploy writes cdk-outputs.json).");
  process.exit(2);
}

const client = new LambdaClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const res = await client.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify({ action })) }));
const payload = res.Payload ? Buffer.from(res.Payload).toString() : "";
if (res.FunctionError) {
  console.error(`Function error: ${payload}`);
  process.exit(1);
}
console.log(JSON.stringify(JSON.parse(payload || "null"), null, 2));
