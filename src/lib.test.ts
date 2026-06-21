import { describe, it, expect } from "vitest";
import {
  parseBearerChallenge,
  normalizePrimaryRef,
  hasExpectedAudience,
  jwtAudience,
  tokenPreview,
} from "./lib.js";

/** Build an unsigned JWT-shaped string with the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("parseBearerChallenge", () => {
  it("parses an OTP step-up challenge", () => {
    const header =
      'Bearer realm="notflux", error="otp-required", error_description="Enter the code", acr_values="tx-123", max_age="300"';
    expect(parseBearerChallenge(header)).toEqual({
      error: "otp-required",
      errorDescription: "Enter the code",
      transactionId: "tx-123",
      maxAge: 300,
    });
  });

  it("falls back errorDescription to error when absent", () => {
    const c = parseBearerChallenge('Bearer error="qr-required", acr_values="tx-9"');
    expect(c?.errorDescription).toBe("qr-required");
    expect(c?.maxAge).toBeUndefined();
  });

  it("returns null without the bearer scheme", () => {
    expect(parseBearerChallenge('Basic error="x", acr_values="y"')).toBeNull();
  });

  it("returns null when error or acr_values is missing", () => {
    expect(parseBearerChallenge('Bearer error="otp-required"')).toBeNull();
    expect(parseBearerChallenge('Bearer acr_values="tx-1"')).toBeNull();
  });
});

describe("normalizePrimaryRef", () => {
  it("wraps a bare UUID", () => {
    expect(normalizePrimaryRef("d6df-1234")).toBe("managed/primaryAccount/d6df-1234");
  });

  it("passes through an already-managed ref", () => {
    expect(normalizePrimaryRef("managed/primaryAccount/abc")).toBe(
      "managed/primaryAccount/abc"
    );
  });

  it("trims whitespace and rejects empty", () => {
    expect(normalizePrimaryRef("  abc  ")).toBe("managed/primaryAccount/abc");
    expect(normalizePrimaryRef("   ")).toBeNull();
  });

  it("reads _ref / associatedPrimary off an object", () => {
    expect(normalizePrimaryRef({ _ref: "abc" })).toBe("managed/primaryAccount/abc");
    expect(normalizePrimaryRef({ associatedPrimary: "managed/primaryAccount/xyz" })).toBe(
      "managed/primaryAccount/xyz"
    );
  });

  it("returns null for unusable input", () => {
    expect(normalizePrimaryRef(null)).toBeNull();
    expect(normalizePrimaryRef(42)).toBeNull();
    expect(normalizePrimaryRef({})).toBeNull();
  });
});

describe("jwtAudience / hasExpectedAudience", () => {
  it("extracts a string aud", () => {
    expect(jwtAudience(fakeJwt({ aud: "notflux-mcp" }))).toBe("notflux-mcp");
  });

  it("extracts an array aud", () => {
    expect(jwtAudience(fakeJwt({ aud: ["a", "notflux-mcp"] }))).toEqual([
      "a",
      "notflux-mcp",
    ]);
  });

  it("returns null on malformed tokens", () => {
    expect(jwtAudience("not-a-jwt")).toBeNull();
  });

  it("matches the expected audience (string and array)", () => {
    expect(hasExpectedAudience(fakeJwt({ aud: "notflux-mcp" }), "notflux-mcp")).toBe(true);
    expect(hasExpectedAudience(fakeJwt({ aud: ["x", "notflux-mcp"] }), "notflux-mcp")).toBe(true);
    expect(hasExpectedAudience(fakeJwt({ aud: "wrong" }), "notflux-mcp")).toBe(false);
  });

  it("is a no-op when no expected audience is configured", () => {
    expect(hasExpectedAudience("anything", "")).toBe(true);
  });

  it("rejects a malformed token when an audience is required", () => {
    expect(hasExpectedAudience("garbage", "notflux-mcp")).toBe(false);
  });
});

describe("tokenPreview", () => {
  it("redacts the middle of a token", () => {
    expect(tokenPreview("abcdef0123456789")).toBe("abcdef...6789");
  });
  it("handles empty and short tokens", () => {
    expect(tokenPreview("")).toBe("<empty>");
    expect(tokenPreview("short")).toBe("<redacted>");
  });
});
