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
  if (cached) return cached;

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

interface HitlFieldSchema {
  type: "string" | "number" | "boolean" | "integer";
  title: string;
  description?: string;
  /** SDK-supported formats only */
  format?: "email" | "uri" | "date" | "date-time";
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

interface HitlPrompt {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, HitlFieldSchema>;
    required: string[];
  };
}

type HitlHandlerFn = (challenge: BearerChallenge) => HitlPrompt;

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
// HITL handler registry
// Add new P1AZ event types here as they are built out in PingOne.
// ---------------------------------------------------------------------------

const HITL_HANDLERS: Partial<Record<string, HitlHandlerFn>> = {
  "otp-required": (c) => ({
    message: c.errorDescription,
    requestedSchema: {
      type: "object",
      properties: {
        otp: {
          type: "string",
          title: "One-Time Passcode",
          description: "Enter the OTP sent to the Primary Account Holder.",
          minLength: 1,
        },
      },
      required: ["otp"],
    },
  }),
};

/** Falls back to a freeform text prompt for unknown HITL event types. */
function resolveHitlHandler(error: string): HitlHandlerFn {
  return (
    HITL_HANDLERS[error] ??
    ((c) => ({
      message: c.errorDescription,
      requestedSchema: {
        type: "object",
        properties: {
          response: {
            type: "string",
            title: "Action Required",
            description: c.errorDescription,
          },
        },
        required: ["response"],
      },
    }))
  );
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
    return { kind: "ok", data: await response.json() };
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
 * Executes a NotFlux API call, handling 401 Bearer challenges transparently
 * via MCP Elicitation. On a HITL 401 the tool call is suspended while the
 * user provides the required value (e.g. OTP), then the original request is
 * retried with X-Hitl-Transaction-Id and X-Hitl-<Field> headers injected.
 * The agent sees only the final result — the HITL exchange is invisible to it.
 * If the MCP client does not advertise elicitation support, degrades gracefully
 * to a standard access-denied response.
 */
async function executeWithHitl(
  server: Server,
  mcpToken: string,
  ctx: RequestContext,
  scope: string
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  let kongToken: string;
  try {
    kongToken = await exchangeForKongToken(mcpToken, scope);
  } catch (e) {
    return { isError: true, content: [{ type: "text" as const, text: `Token Exchange failed: ${e}` }] };
  }

  const result = await notfluxRequest(kongToken, ctx);

  if (result.kind === "ok") {
    return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
  }

  if (result.kind === "error") {
    return { isError: true, content: [{ type: "text" as const, text: result.message }] };
  }

  // --- 401 Bearer challenge — HITL path ---
  const handler = resolveHitlHandler(result.challenge.error);
  const { message, requestedSchema } = handler(result.challenge);

  try {
    // Cast to SDK's ElicitRequestFormParams — our schema is structurally compatible
    // but TypeScript can't narrow the union (FormParams | URLParams) from HitlPrompt.
    const elicitation = await server.elicitInput(
      { message, requestedSchema } as unknown as Parameters<Server["elicitInput"]>[0]
    );

    if (elicitation.action !== "accept") {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Access was not authorized for this content." }],
      };
    }

    // Inject transaction ID + one X-Hitl-<Field> header per elicited value
    const retryHeaders: Record<string, string> = {
      "X-Hitl-Transaction-Id": result.challenge.transactionId,
    };
    for (const [key, value] of Object.entries(elicitation.content ?? {})) {
      retryHeaders[`X-Hitl-${key.charAt(0).toUpperCase()}${key.slice(1)}`] = String(value);
    }

    const retry = await notfluxRequest(kongToken, {
      ...result.ctx,
      extraHeaders: { ...(result.ctx.extraHeaders ?? {}), ...retryHeaders },
    });

    if (retry.kind === "ok") {
      return { content: [{ type: "text" as const, text: JSON.stringify(retry.data, null, 2) }] };
    }

    // Retry also denied — indistinguishable from a normal authz failure
    return {
      isError: true,
      content: [{ type: "text" as const, text: "Access was not authorized for this content." }],
    };
  } catch {
    // elicitInput threw — client doesn't support elicitation; degrade gracefully
    return {
      isError: true,
      content: [{ type: "text" as const, text: "Access was not authorized for this content." }],
    };
  }
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
          },
          required: ["id", "drm"],
        },
      },
      {
        name: "get_account",
        title: "Get Account",
        description:
          "Returns account details for the specified account by UUID.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: {
              type: "string",
              description: "UUID of the account to look up",
            },
          },
          required: ["id"],
        },
      },
    ],
  }));

  // ---- tools/call ----------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const token = tokenRef.current;
    if (!token) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: "Authorization required. Send a PingOne Bearer token in the Authorization header: Bearer <token>",
        }],
      };
    }

    switch (name) {
      case "get_all_media_metadata":
        return executeWithHitl(server, token, { method: "GET", path: "/media/metadata" }, "get_media");

      case "get_media_metadata": {
        const { id } = args as { id: string };
        return executeWithHitl(server, token, {
          method: "GET",
          path: `/media/metadata/${encodeURIComponent(id)}`,
        }, "get_media");
      }

      case "get_media_content": {
        const { id, drm } = args as { id: string; drm: string };
        return executeWithHitl(server, token, {
          method: "POST",
          path: `/media/content/${encodeURIComponent(id)}`,
          body: { drm },
        }, "get_media");
      }

      case "get_account": {
        const { id } = args as { id: string };
        return executeWithHitl(server, token, {
          method: "GET",
          path: `/accounts/${encodeURIComponent(id)}`,
        }, "manage_account");
      }

      default:
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
