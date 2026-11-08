/**
 * Anonymous, best-effort visitor identity.
 *
 * Clicking an image on GitHub tells us nothing about the GitHub account, so a
 * visitor is a random id in an HttpOnly cookie. We never store the raw cookie or
 * IP: both are HMAC'd with a server-side secret that lives only in the database.
 * Clearing cookies yields a new identity; the per-IP cap bounds that abuse.
 */
import { createHmac, randomBytes } from "node:crypto";

export const COOKIE_NAME = "gps_vid";
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const ONE_YEAR = 365 * 24 * 3600;

/** Find our cookie among `Cookie` header fragments. Malformed or oversized values are ignored. */
export function readVisitorId(cookieFragments: readonly string[]): string | null {
  for (const fragment of cookieFragments) {
    if (fragment.length > 4096) continue;
    for (const part of fragment.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
      const value = part.slice(eq + 1).trim();
      if (ID_RE.test(value)) return value;
    }
  }
  return null;
}

export function newVisitorId(): string {
  return randomBytes(16).toString("base64url");
}

export function visitorCookie(id: string, secure: boolean): string {
  return `${COOKIE_NAME}=${id}; Path=/vote; Max-Age=${ONE_YEAR}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function hashKey(secret: string, purpose: "voter" | "ip", value: string): string {
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest("base64url").slice(0, 27);
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}
