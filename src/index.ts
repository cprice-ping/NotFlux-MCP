import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NOTFLUX_API_BASE = "https://notflux-api.ping-devops.com";
const PORT = Number(process.env.PORT ?? 8080);

/**
 * The `aud` claim value that MCP-scoped tokens must carry.
 * Set via EXPECTED_AUDIENCE env var — should match the PingOne resource
 * that the backend Token Exchange (RFC 8693) targets (PINGONE_MCP_AUDIENCE).
 * When unset, audience validation is skipped (useful for local dev with curl).
 */
const EXPECTED_AUDIENCE = process.env.EXPECTED_AUDIENCE ?? "";

if (EXPECTED_AUDIENCE) {
  console.log(`Audience validation enabled — required aud: ${EXPECTED_AUDIENCE}`);
} else {
  console.warn("EXPECTED_AUDIENCE not set — audience validation disabled. Set this in production.");
}

// ---------------------------------------------------------------------------
// Exchange 2: mcp_token → kong_token (RFC 8693 Token Exchange)
// The MCP server receives an mcp-scoped token from the ADK agent, but Kong
// requires a token with its own audience. This exchange is performed once per
// unique mcp_token and the result is cached for the token's lifetime.
// ---------------------------------------------------------------------------

const PINGONE_ENV_ID = process.env.PINGONE_ENV_ID ?? "59bb6a66-e76e-490c-b83a-884c50423da4";
const P1_TOKEN_URL = `https://auth.pingone.com/${PINGONE_ENV_ID}/as/token`;
const P1_TX_CLIENT_ID = process.env.PINGONE_TX_CLIENT_ID ?? "";
const P1_TX_CLIENT_SECRET = process.env.PINGONE_TX_CLIENT_SECRET ?? "";
const PINGONE_KONG_AUDIENCE = process.env.PINGONE_KONG_AUDIENCE ?? "";

const EXCHANGE2_ENABLED =
  Boolean(P1_TX_CLIENT_ID) &&
  Boolean(P1_TX_CLIENT_SECRET) &&
  Boolean(PINGONE_KONG_AUDIENCE);

if (EXCHANGE2_ENABLED) {
  console.log(`Exchange 2 enabled — kong audience: ${PINGONE_KONG_AUDIENCE}`);
} else {
  console.warn("Exchange 2 not configured — set PINGONE_TX_CLIENT_ID/SECRET/KONG_AUDIENCE. MCP tools will fail against Kong.");
}

/**
 * Cache: "<mcp_token>::<scope>" → kong_token.
 * Keyed on both token and scope since different tools may need different scopes.
 * Evicted after the kong_token's expires_in.
 */
const kongTokenCache = new Map<string, string>();

function tokenPreview(token: string): string {
  if (!token) return "<empty>";
  if (token.length <= 12) return "<redacted>";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

/**
 * Exchange an mcp_token for a kong_token via RFC 8693 Token Exchange.
 * @param mcpToken  The MCP-audience token received from the ADK agent.
 * @param scope     The OAuth scope required by the target Kong endpoint.
 * Falls back to the input token when Exchange 2 is not configured (local dev).
 */
async function exchangeForKongToken(mcpToken: string, scope: string): Promise<string> {
  if (!EXCHANGE2_ENABLED) return mcpToken;

  const cacheKey = `${mcpToken}::${scope}`;
  const cached = kongTokenCache.get(cacheKey);
  if (cached) {
    console.log(`[exchange2] cache_hit scope=${scope} token=${tokenPreview(mcpToken)}`);
    return cached;
  }

  console.log(`[exchange2] cache_miss scope=${scope} token=${tokenPreview(mcpToken)}`);

  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: mcpToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience: PINGONE_KONG_AUDIENCE,
    scope,
  });

  const basicCred = Buffer.from(
    `${encodeURIComponent(P1_TX_CLIENT_ID)}:${encodeURIComponent(P1_TX_CLIENT_SECRET)}`
  ).toString("base64");

  const res = await fetch(P1_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicCred}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Exchange 2 failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Exchange 2 response missing access_token");

  kongTokenCache.set(cacheKey, data.access_token);
  // Evict after token expiry to avoid using stale tokens
  const ttl = (data.expires_in ?? 3600) * 1000;
  setTimeout(() => kongTokenCache.delete(cacheKey), ttl).unref();

  return data.access_token;
}

// ---------------------------------------------------------------------------
// HITL types
// ---------------------------------------------------------------------------

interface BearerChallenge {
  /** error= from WWW-Authenticate Bearer challenge — the HITL event type */
  error: string;
  errorDescription: string;
  /** acr_values= — PingOne MFA transaction handle, passed back on retry */
  transactionId: string;
  maxAge?: number;
}

interface RequestContext {
  method: string;
  path: string;
  body?: unknown;
  extraHeaders?: Record<string, string>;
}

type NotfluxResult =
  | { kind: "ok";    data: unknown }
  | { kind: "hitl";  challenge: BearerChallenge; ctx: RequestContext }
  | { kind: "error"; message: string; status: number };

// ---------------------------------------------------------------------------
// Bearer challenge parser (RFC 6750)
// ---------------------------------------------------------------------------

/**
 * Parses a WWW-Authenticate: Bearer header into a structured challenge.
 * Returns null if the header is absent, malformed, or missing error=/acr_values=.
 */
function parseBearerChallenge(header: string): BearerChallenge | null {
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

// ---------------------------------------------------------------------------
// JWT audience helper
// ---------------------------------------------------------------------------

/**
 * Decodes the payload of a JWT (base64url) and returns the `aud` claim.
 * Does NOT verify the signature — Kong handles that on the forwarded request.
 * Returns null if the token is malformed.
 */
function jwtAudience(token: string): string | string[] | null {
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
 * Always returns true when EXPECTED_AUDIENCE is not configured.
 */
function hasExpectedAudience(token: string): boolean {
  if (!EXPECTED_AUDIENCE) return true;
  const aud = jwtAudience(token);
  if (aud === null) return false;
  return Array.isArray(aud) ? aud.includes(EXPECTED_AUDIENCE) : aud === EXPECTED_AUDIENCE;
}

/**
 * Accepts either:
 * - UUID (d6df...))
 * - managed reference (managed/primaryAccount/d6df...)
 * and returns managed/primaryAccount/<id>.
 */
function normalizePrimaryRef(value: unknown): string | null {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Raw HTTP call to the NotFlux/Kong API. Returns a discriminated union. */
async function notfluxRequest(
  token: string,
  ctx: RequestContext
): Promise<NotfluxResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...ctx.extraHeaders,
  };
  if (ctx.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${NOTFLUX_API_BASE}${ctx.path}`, {
    method: ctx.method,
    headers,
    body: ctx.body !== undefined ? JSON.stringify(ctx.body) : undefined,
  });

  if (response.ok) {
    if (response.status === 204) {
      return { kind: "ok", data: { success: true, status: response.status } };
    }

    const text = await response.text();
    if (!text.trim()) {
      return { kind: "ok", data: { success: true, status: response.status } };
    }

    try {
      return { kind: "ok", data: JSON.parse(text) };
    } catch {
      return {
        kind: "ok",
        data: {
          success: true,
          status: response.status,
          body: text,
        },
      };
    }
  }

  if (response.status === 401) {
    const wwwAuth = response.headers.get("www-authenticate") ?? "";
    const challenge = parseBearerChallenge(wwwAuth);
    if (challenge) {
      return { kind: "hitl", challenge, ctx };
    }
  }

  const text = await response.text();
  return {
    kind: "error",
    message: `NotFlux API responded with ${response.status} ${response.statusText}: ${text}`,
    status: response.status,
  };
}

/**
 * Executes a NotFlux API call and handles 401 Bearer challenges via a
 * conversational two-step flow suitable for ADK runtimes:
 * 1) First call gets a challenge → return structured HITL payload.
 * 2) Agent asks user for required input and re-calls tool with transaction_id
 *    and otp_code, which are translated to X-Hitl-* headers on retry.
 */
async function executeWithHitl(
  mcpToken: string,
  ctx: RequestContext,
  scope: string,
  hitl?: { transactionId?: string; otpCode?: string }
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  console.log(
    `[tool_http] request method=${ctx.method} path=${ctx.path} scope=${scope}` +
      ` hitlTx=${hitl?.transactionId ? "yes" : "no"} otp=${hitl?.otpCode ? "yes" : "no"}`
  );

  let kongToken: string;
  try {
    kongToken = await exchangeForKongToken(mcpToken, scope);
  } catch (e) {
    console.error(`[tool_http] exchange2_error path=${ctx.path} scope=${scope} err=${String(e)}`);
    return { isError: true, content: [{ type: "text" as const, text: `Token Exchange failed: ${e}` }] };
  }

  const hitlHeaders: Record<string, string> = {
    ...(ctx.extraHeaders ?? {}),
  };
  if (hitl?.transactionId) {
    hitlHeaders["X-Hitl-Transaction-Id"] = hitl.transactionId;
  }
  if (hitl?.otpCode) {
    hitlHeaders["X-Hitl-Otp"] = hitl.otpCode;
  }

  const result = await notfluxRequest(kongToken, {
    ...ctx,
    extraHeaders: hitlHeaders,
  });

  if (result.kind === "ok") {
    console.log(`[tool_http] ok method=${ctx.method} path=${ctx.path}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }

  if (result.kind === "error") {
    console.error(`[tool_http] error method=${ctx.method} path=${ctx.path} status=${result.status}`);
    return { isError: true, content: [{ type: "text" as const, text: result.message }] };
  }

  // --- 401 Bearer challenge — conversational HITL path ---
  console.warn(
    `[tool_http] hitl_challenge method=${ctx.method} path=${ctx.path}` +
      ` event=${result.challenge.error} tx=${result.challenge.transactionId}`
  );
  // For qr-required, P1AZ puts the QR image URL in error_description
  // (custom WWW-Authenticate params are stripped). Promote it to qr_code_url
  // and replace message with a human-readable prompt.
  const isQr = result.challenge.error === "qr-required";
  const challengePayload: Record<string, unknown> = {
    hitl_required: true,
    event_type: result.challenge.error,
    transaction_id: result.challenge.transactionId,
    message: isQr
      ? "Scan the QR code with your mobile device to verify your identity."
      : result.challenge.errorDescription,
  };
  if (isQr && result.challenge.errorDescription) {
    challengePayload.qr_code_url = result.challenge.errorDescription;
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(challengePayload, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

/**
 * tokenRef is a mutable ref updated by the HTTP layer on every incoming
 * request (from the Authorization: Bearer header).  Tool handlers read from
 * it so the token never appears in tool arguments.
 */
function buildMcpServer(tokenRef: { current: string }): Server {
  const server = new Server(
    { name: "notflux-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ---- tools/list ----------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_all_media_metadata",
        title: "Get All Media Metadata",
        description:
          "Returns a list of all media content available to the authenticated user. " +
          "Requires a Bearer token (sent via Authorization header) with scope 'get_media' " +
          "and permission 'read_metadata'. " +
          "AAM policy on the Kong Gateway filters results based on the user's content-rating restrictions.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
      {
        name: "get_media_metadata",
        title: "Get Media Metadata",
        description:
          "Returns metadata for a single media item by its UUID. " +
          "The response contains a 'drm' field that must be passed to get_media_content. " +
          "Requires scope 'get_media' and permission 'Media:read_metadata'. " +
          "Known IDs: Horror Movie = 6b1527a6-67e5-44b6-acc4-64e66c65129c, " +
          "Children Show = 343cb976-7790-4b97-ac9c-1ae99c5d99bd.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the media item",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "get_media_content",
        title: "Get Media Content",
        description:
          "Retrieves the playable content for a media item. " +
          "The 'drm' value must be obtained from get_media_metadata first. " +
          "The AAM policy validates the DRM token against the user's entitlements. " +
          "Requires scope 'get_media' and permission 'Media:view_content'.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the media item",
            },
            drm: {
              type: "string",
              description: "DRM token from the get_media_metadata response",
            },
            transaction_id: {
              type: "string",
              description: "HITL transaction id from a previous challenge response.",
            },
            otp_code: {
              type: "string",
              description: "OTP value provided by the user for HITL retries.",
            },
          },
          required: ["id", "drm"],
        },
      },
      {
        name: "get_account",
        title: "Get Account",
        description:
          "Returns account details for the authenticated user or a specific account by UUID. " +
          "If no id is provided, returns the account for the user identified by the Bearer token's sub claim.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the account to look up. Omit to look up the current user's account.",
            },
          },
          required: [],
        },
      },
      {
        name: "create_profile",
        title: "Create Profile",
        description:
          "Creates a new profile under a primary account. " +
          "Requires scope 'manage_profiles'. " +
          "Use get_account first, then pass associated_primary_id as associatedPrimary " +
          "(UUID) or pass associated_primary_ref as managed/primaryAccount/{id}.",
        inputSchema: {
          type: "object" as const,
          properties: {
            name: {
              type: "string",
              description: "Display name of the profile to create.",
            },
            email: {
              type: "string",
              description: "Email address for the profile.",
            },
            associated_primary_id: {
              type: "string",
              description: "Primary account UUID from get_account.associatedPrimary.",
            },
            associated_primary_ref: {
              type: "string",
              description: "Managed reference form: managed/primaryAccount/{id}.",
            },
            account: {
              type: "object",
              description: "Optional raw get_account response object containing associatedPrimary.",
              additionalProperties: true,
            },
            transaction_id: {
              type: "string",
              description: "HITL transaction id from a previous QR-code challenge response, used to retry after the QR has been scanned.",
            },
          },
          required: ["name", "email"],
        },
      },
      {
        name: "delete_profile",
        title: "Delete Profile",
        description:
          "Deletes a profile by profile UUID. " +
          "Requires scope 'manage_profiles'.",
        inputSchema: {
          type: "object" as const,
          properties: {
            profile_id: {
              type: "string",
              description: "UUID of the profile to delete.",
            },
          },
          required: ["profile_id"],
        },
      },
      {
        name: "get_primary_account",
        title: "Get Primary Account",
        description:
          "Returns primary account details using the primary account UUID. " +
          "Use get_account() and pass its associatedPrimary value as account_id. " +
          "Requires scope 'manage_profiles'.",
        inputSchema: {
          type: "object" as const,
          properties: {
            account_id: {
              type: "string",
              description: "Primary account UUID (for example from get_account.associatedPrimary).",
            },
          },
          required: ["account_id"],
        },
      },
    ],
  }));

  // ---- tools/call ----------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    console.log(`[tool_call] start name=${name} args=${JSON.stringify(args)}`);

    const token = tokenRef.current;
    if (!token) {
      console.warn(`[tool_call] denied name=${name} reason=missing_authorization`);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Authorization required. Send a PingOne Bearer token in the Authorization header: Bearer <token>",
        }],
      };
    }

    switch (name) {
      case "get_all_media_metadata": {
        const result = await executeWithHitl(token, { method: "GET", path: "/media/metadata" }, "get_media");
        console.log(`[tool_call] finish name=${name} isError=${Boolean(result.isError)}`);
        return result;
      }

      case "get_media_metadata": {
        const { id } = args as { id: string };
        const result = await executeWithHitl(token, {
          method: "GET",
          path: `/media/metadata/${encodeURIComponent(id)}`,
        }, "get_media");
        console.log(`[tool_call] finish name=${name} id=${id} isError=${Boolean(result.isError)}`);
        return result;
      }

      case "get_media_content": {
        const { id, drm, transaction_id, otp_code } = args as {
          id: string;
          drm: string;
          transaction_id?: string;
          otp_code?: string;
        };
        const result = await executeWithHitl(token, {
          method: "POST",
          path: `/media/content/${encodeURIComponent(id)}`,
          body: { drm },
        }, "get_media", {
          transactionId: transaction_id,
          otpCode: otp_code,
        });
        console.log(`[tool_call] finish name=${name} id=${id} isError=${Boolean(result.isError)}`);
        return result;
      }

      case "get_account": {
        const { id } = args as { id?: string };
        const path = id ? `/accounts/${encodeURIComponent(id)}` : "/accounts";
        const result = await executeWithHitl(token, { method: "GET", path }, "manage_account");
        console.log(`[tool_call] finish name=${name} id=${id ?? "self"} isError=${Boolean(result.isError)}`);
        return result;
      }

      case "create_profile": {
        const {
          name: profileName,
          email,
          associated_primary_id,
          associated_primary_ref,
          account,
          transaction_id,
        } = args as {
          name: string;
          email: string;
          associated_primary_id?: string;
          associated_primary_ref?: string;
          account?: unknown;
          transaction_id?: string;
        };

        const primaryRef =
          normalizePrimaryRef(associated_primary_ref) ??
          normalizePrimaryRef(associated_primary_id) ??
          normalizePrimaryRef(account);

        if (!primaryRef) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text:
                "Missing associated primary account reference. Provide associated_primary_id (UUID), " +
                "associated_primary_ref (managed/primaryAccount/{id}), or account from get_account().",
            }],
          };
        }

        const result = await executeWithHitl(token, {
          method: "POST",
          path: "/profiles/profile",
          body: {
            name: profileName,
            email,
            associatedPrimary: { _ref: primaryRef },
          },
        }, "manage_profiles", {
          transactionId: transaction_id,
        });

        console.log(
          `[tool_call] finish name=${name} email=${email} primaryRef=${primaryRef} isError=${Boolean(result.isError)}`
        );
        return result;
      }

      case "delete_profile": {
        const { profile_id } = args as { profile_id: string };

        const result = await executeWithHitl(token, {
          method: "DELETE",
          path: `/profiles/profile/${encodeURIComponent(profile_id)}`,
        }, "manage_profiles");

        console.log(
          `[tool_call] finish name=${name} profile_id=${profile_id} isError=${Boolean(result.isError)}`
        );
        return result;
      }

      case "get_primary_account": {
        const { account_id } = args as { account_id: string };
        const fields = encodeURIComponent("*,*_ref/*");

        const result = await executeWithHitl(token, {
          method: "GET",
          path: `/profiles/primaryAccount/${encodeURIComponent(account_id)}?_fields=${fields}`,
        }, "manage_profiles");

        console.log(
          `[tool_call] finish name=${name} account_id=${account_id} isError=${Boolean(result.isError)}`
        );
        return result;
      }

      default:
        console.warn(`[tool_call] unknown name=${name}`);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server (Streamable HTTP transport – MCP spec 2025-11-25)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Token extraction helper
// ---------------------------------------------------------------------------

/**
 * Extracts the Bearer token from the Authorization header.
 * Returns the token string, or an empty string if the header is absent/invalid.
 * Auth is intentionally not enforced here so that unauthenticated requests
 * (e.g. tools/list during agent discovery) are still served.
 */
function extractBearer(req: Request): string {
  const authHeader = req.headers["authorization"] ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return authHeader.slice("bearer ".length).trim();
}

// ---------------------------------------------------------------------------
// Session registry: sessionId -> { transport, tokenRef }
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  tokenRef: { current: string };
}

const sessions = new Map<string, Session>();

// POST /mcp  – handles initialize (new session) and all subsequent JSON-RPC requests
app.post("/mcp", async (req: Request, res: Response) => {
  const token = extractBearer(req);

  // Reject tokens that are present but carry the wrong audience.
  // Returns HTTP 401 per MCP spec 2025-11-25 §Authentication.
  // Requests with no token are allowed through so that unauthenticated
  // initialize / tools/list (agent discovery) still works.
  if (token && !hasExpectedAudience(token)) {
    res.status(401)
      .set("WWW-Authenticate", `Bearer realm="notflux-mcp", error="invalid_token", error_description="Token audience is not valid for this MCP server. Use a Token Exchange token."`)
      .json({ error: "invalid_token", error_description: "Token audience is not valid for this MCP server. Use a Token Exchange token." });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Reuse an existing session – update the token ref for this request
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    session.tokenRef.current = token;
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session – create a fresh transport + server pair
  const tokenRef = { current: token };
  let transport!: StreamableHTTPServerTransport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, tokenRef });
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
  };

  const server = buildMcpServer(tokenRef);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// GET /mcp  – SSE stream for server-to-client notifications
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  session.tokenRef.current = extractBearer(req);
  await session.transport.handleRequest(req, res);
});

// DELETE /mcp  – explicit session termination
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  if (session) {
    await session.transport.close();
    sessions.delete(sessionId!);
  }

  res.status(200).end();
});

// GET /healthz  – liveness / readiness probe
app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`NotFlux MCP Server listening on http://localhost:${PORT}/mcp`);
  console.log(`Protocol : MCP 2025-11-25`);
  console.log(`Transport: Streamable HTTP`);
});
