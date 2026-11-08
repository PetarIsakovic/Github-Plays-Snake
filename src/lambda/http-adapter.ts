import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { HttpRequest } from "../http/router";

/** Translate a Function URL (payload v2) event into our transport-agnostic request. */
export function toHttpRequest(event: LambdaFunctionURLEvent): HttpRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const cookies = event.cookies ?? (headers.cookie ? [headers.cookie] : []);
  return {
    method: event.requestContext?.http?.method ?? "GET",
    path: event.rawPath || "/",
    rawQuery: event.rawQueryString ?? "",
    headers,
    cookies,
    sourceIp: event.requestContext?.http?.sourceIp ?? null,
    secure: true,
  };
}
