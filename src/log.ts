/**
 * Minimal structured logger (one JSON object per line, which CloudWatch Logs
 * Insights can query). Never pass raw IPs, cookies, or visitor ids here.
 */
type Fields = Record<string, unknown>;

let silent = process.env.LOG_SILENT === "1";

export function setLogSilent(v: boolean) {
  silent = v;
}

function emit(level: "info" | "warn" | "error", event: string, fields?: Fields) {
  if (silent) return;
  const line = JSON.stringify({ level, event, ...fields, t: new Date().toISOString() });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
