// ---------------------------------------------------------------------------
// Pure helpers extracted from index.ts so they can be unit-tested without
// starting the HTTP server. No side effects, no env reads at import time.
// ---------------------------------------------------------------------------

export interface BearerChallenge {
  /** error= from WWW-Authenticate Bearer challenge — the HITL event type */
  error: string;
  errorDescription: string;
  /** acr_values= — PingOne MFA transaction handle, passed back on retry */
  transactionId: string;
  maxAge?: number;
}

/**
 * Parses a WWW-Authenticate: Bearer header into a structured challenge.
 * Returns null if the header is absent, malformed, or missing error=/acr_values=.
 */
export function parseBearerChallenge(header: string): BearerChallenge | null {
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    params[m[1]] = m[2];
  }
  const error = params["error"];
  const transactionId = params["acr_values"];
  if (!error || !transactionId) return null;
  return {
    error,
    errorDescription: params["error_description"] ?? error,
    transactionId,
    maxAge: params["max_age"] !== undefined ? Number(params["max_age"]) : undefined,
  };
}

/**
 * Decodes the payload of a JWT (base64url) and returns the `aud` claim.
 * Does NOT verify the signature — this is a routing hint only; the cryptographic
 * gate is the gateway / PingOne, which reject forged tokens at exchange time.
 * Returns null if the token is malformed.
 */
export function jwtAudience(token: string): string | string[] | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as Record<string, unknown>;
    const aud = payload["aud"];
    if (typeof aud === "string" || Array.isArray(aud)) return aud as string | string[];
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the token's `aud` claim contains the expected audience.
 * Always returns true when expectedAudience is empty (validation disabled).
 * NOTE: this is an unsigned decode — a routing hint, not cryptographic
 * enforcement. The gateway / PingOne verify the signature downstream.
 */
export function hasExpectedAudience(token: string, expectedAudience: string): boolean {
  if (!expectedAudience) return true;
  const aud = jwtAudience(token);
  if (aud === null) return false;
  return Array.isArray(aud) ? aud.includes(expectedAudience) : aud === expectedAudience;
}

/**
 * Accepts either:
 * - UUID (d6df...)
 * - managed reference (managed/primaryAccount/d6df...)
 * - an object carrying _ref / associatedPrimary
 * and returns managed/primaryAccount/<id>, or null.
 */
export function normalizePrimaryRef(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("managed/primaryAccount/")) return trimmed;
    return `managed/primaryAccount/${trimmed}`;
  }

  if (!value || typeof value !== "object") return null;

  const rec = value as Record<string, unknown>;
  if (typeof rec._ref === "string") return normalizePrimaryRef(rec._ref);
  if (typeof rec.associatedPrimary === "string") return normalizePrimaryRef(rec.associatedPrimary);

  return null;
}

export function tokenPreview(token: string): string {
  if (!token) return "<empty>";
  if (token.length <= 12) return "<redacted>";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}
