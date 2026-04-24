import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NOTFLUX_API_BASE = process.env.NOTFLUX_API_BASE ?? "https://notflux-api.ping-devops.com";
const PORT = Number(process.env.PORT ?? 8080);

// ---------------------------------------------------------------------------
// OAuth 2.0 Resource Server config (MCP spec §6, RFC 9470, RFC 6750)
//
// JWT validation engages when MCP_AUDIENCE is set.  Leave it unset to run
// without local JWT checks (e.g. during initial bring-up; Kong still enforces).
// ---------------------------------------------------------------------------
const P1_ENV_ID   = process.env.PINGONE_ENV_ID ?? "59bb6a66-e76e-490c-b83a-884c50423da4";
const MCP_ISSUER  = process.env.MCP_ISSUER ?? `https://auth.pingone.com/${P1_ENV_ID}/as`;
// The `aud` claim the exchanged MCP token must carry (PingOne MCP resource audience).
// The token's `aud` will be an ARRAY when the exchange requests scopes across multiple
// resources (e.g. get_media + use_mcp_tools).  jose's jwtVerify checks for membership.
const MCP_AUDIENCE = process.env.MCP_AUDIENCE ?? "";
// The MCP-specific scope to require — should be the scope owned by this resource server
// (e.g. use_mcp_tools), NOT get_media.  get_media is Kong/AAM's concern; use_mcp_tools
// is proof the token was exchanged specifically for MCP access.
// Both scopes exist on the token because the backend's Token Exchange requests them together.
const MCP_REQUIRED_SCOPE = process.env.MCP_REQUIRED_SCOPE ?? "use_mcp_tools";
const MCP_REQUIRED_SCOPES = MCP_REQUIRED_SCOPE.split(" ").filter(Boolean);
// Externally-visible base URL of this server (used in WWW-Authenticate + resource metadata)
const MCP_PUBLIC_BASE_URL =
  process.env.MCP_PUBLIC_BASE_URL ?? "https://notflux-mcp.ping-devops.com";

const JWT_VALIDATION_ENABLED = Boolean(MCP_AUDIENCE);

// Lazily-initialised JWKS client — only created when validation is enabled
// so we don't make outbound requests if the feature is off.
const JWKS = JWT_VALIDATION_ENABLED
  ? createRemoteJWKSet(new URL(`${MCP_ISSUER}/jwks`))
  : null;

if (JWT_VALIDATION_ENABLED) {
  console.log(`JWT validation enabled  — issuer: ${MCP_ISSUER}, audience: ${MCP_AUDIENCE}`);
  console.log(`Required scopes         — ${MCP_REQUIRED_SCOPES.join(" ")}`);
} else {
  console.log("JWT validation disabled — set MCP_AUDIENCE to enable");
}

// ---------------------------------------------------------------------------
// JWT validation helpers
// ---------------------------------------------------------------------------

type TokenFailure = "missing" | "invalid_token" | "insufficient_scope";

async function validateBearerToken(
  token: string
): Promise<{ ok: true } | { ok: false; reason: TokenFailure }> {
  if (!JWKS) return { ok: true }; // validation disabled — pass through

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: MCP_ISSUER,
      audience: MCP_AUDIENCE,
    });

    // PingOne encodes scopes as a space-delimited string in the `scope` claim.
    // Some AS implementations use `scp` (array); handle both.
    const raw = (payload["scope"] ?? payload["scp"]) as string | string[] | undefined;
    const tokenScopes: string[] =
      typeof raw === "string"
        ? raw.split(" ").filter(Boolean)
        : Array.isArray(raw)
          ? raw
          : [];

    const missing = MCP_REQUIRED_SCOPES.filter((s) => !tokenScopes.includes(s));
    if (missing.length > 0) {
      return { ok: false, reason: "insufficient_scope" };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: "invalid_token" };
  }
}

/** RFC 6750 §3.1 — WWW-Authenticate header value for an error */
function wwwAuthenticate(error?: "invalid_token" | "insufficient_scope"): string {
  const parts = [
    `Bearer realm="${MCP_PUBLIC_BASE_URL}"`,
    `resource="${MCP_PUBLIC_BASE_URL}"`,
  ];
  if (error) {
    parts.push(`error="${error}"`);
    if (error === "insufficient_scope") {
      parts.push(`scope="${MCP_REQUIRED_SCOPES.join(" ")}"`);
    }
  }
  return parts.join(", ");
}

/**
 * Express middleware — enforces JWT on /mcp/* when JWT_VALIDATION_ENABLED.
 * Returns:
 *   401 — no token, or token fails signature / expiry / issuer / audience check
 *   403 — valid token but missing required scope
 */
async function requireValidToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!JWT_VALIDATION_ENABLED) return next();

  const token = extractBearer(req);
  if (!token) {
    res.setHeader("WWW-Authenticate", wwwAuthenticate());
    res.status(401).json({ error: "Authorization required" });
    return;
  }

  const result = await validateBearerToken(token);
  if (!result.ok) {
    if (result.reason === "insufficient_scope") {
      res.setHeader("WWW-Authenticate", wwwAuthenticate("insufficient_scope"));
      res.status(403).json({
        error: "Insufficient scope",
        required_scope: MCP_REQUIRED_SCOPES,
      });
    } else {
      res.setHeader("WWW-Authenticate", wwwAuthenticate("invalid_token"));
      res.status(401).json({ error: "Invalid or expired token" });
    }
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Second Token Exchange — MCP Server → NotFlux API  (RFC 8693)
//
// The MCP Server holds its own confidential client credentials (RS client).
// On every tool call it exchanges the incoming MCP-audience token for a
// short-lived API-audience token using that client.
//
// This ensures:
//  • The agent/session state never contains a token that works directly
//    against Kong — a stolen MCP token is useless outside the MCP Server.
//  • sub is preserved → AAM policies still evaluate the real user.
//  • The MCP Server is the only trusted party that can obtain an API token.
//
// Gated by MCP_RS_CLIENT_ID — falls back to forwarding the inbound token
// unchanged when unset (previous behaviour, safe during bring-up).
// ---------------------------------------------------------------------------
const P1_TOKEN_URL  = `https://auth.pingone.com/${P1_ENV_ID}/as/token`;
const MCP_RS_CLIENT_ID     = process.env.MCP_RS_CLIENT_ID     ?? "";
const MCP_RS_CLIENT_SECRET = process.env.MCP_RS_CLIENT_SECRET ?? "";
// Audience of the NotFlux API resource server (what Kong/AAM validates)
const MCP_API_AUDIENCE = process.env.MCP_API_AUDIENCE ?? "";
// Scope(s) to request on the outbound API token
const MCP_API_SCOPE    = process.env.MCP_API_SCOPE    ?? "get_media";

const RS_EXCHANGE_ENABLED =
  Boolean(MCP_RS_CLIENT_ID) &&
  Boolean(MCP_RS_CLIENT_SECRET) &&
  Boolean(MCP_API_AUDIENCE);

if (RS_EXCHANGE_ENABLED) {
  console.log(`RS Token Exchange enabled — API audience: ${MCP_API_AUDIENCE}`);
} else {
  console.log("RS Token Exchange disabled — set MCP_RS_CLIENT_ID/SECRET/API_AUDIENCE to enable");
}

/**
 * Exchange the inbound MCP-audience token for a short-lived API-audience
 * token the MCP Server uses to call Kong.
 *
 * The MCP Server authenticates as itself (client_secret_basic) and presents
 * the user's MCP token as the subject_token.  PingOne validates:
 *   1. The subject_token is a valid MCP-audience token for a real user
 *   2. This RS client is permitted to exchange (Token Exchange policy)
 *   3. Issues a new token: aud=<API audience>, sub=<same user>, scope=get_media
 *
 * Returns the subject_token unchanged when RS_EXCHANGE_ENABLED is false.
 */
async function exchangeForApiToken(mcpToken: string): Promise<string> {
  if (!RS_EXCHANGE_ENABLED) return mcpToken;

  const params = new URLSearchParams({
    grant_type:           "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token:        mcpToken,
    subject_token_type:   "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience:             MCP_API_AUDIENCE,
    scope:                MCP_API_SCOPE,
  });

  const basicCred = Buffer.from(
    `${encodeURIComponent(MCP_RS_CLIENT_ID)}:${encodeURIComponent(MCP_RS_CLIENT_SECRET)}`
  ).toString("base64");

  const res = await fetch(P1_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicCred}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`RS Token Exchange failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error("RS Token Exchange response missing access_token");
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call the NotFlux API via Kong.
 * The inbound MCP token is exchanged for an API-audience token before use,
 * so the token forwarded to Kong has aud=<notflux-api> only — constrained
 * blast radius if the token is ever intercepted at or beyond Kong.
 */
async function notfluxRequest(
  mcpToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  // Exchange: notflux-mcp token → notflux-api token
  const apiToken = await exchangeForApiToken(mcpToken);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${NOTFLUX_API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `NotFlux API responded with ${response.status} ${response.statusText}: ${text}`
    );
  }

  return response.json();
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

    try {
      let data: unknown;

      const token = tokenRef.current;
      if (!token) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Authorization required. Send an MCP Bearer token (aud=notflux-mcp, scope=use_mcp_tools) in the Authorization header.",
          }],
        };
      }

      switch (name) {
        case "get_all_media_metadata": {
          data = await notfluxRequest(token, "GET", "/media/metadata");
          break;
        }

        case "get_media_metadata": {
          const { id } = args as { id: string };
          data = await notfluxRequest(
            token,
            "GET",
            `/media/metadata/${encodeURIComponent(id)}`
          );
          break;
        }

        case "get_media_content": {
          const { id, drm } = args as { id: string; drm: string };
          data = await notfluxRequest(
            token,
            "POST",
            `/media/content/${encodeURIComponent(id)}`,
            { drm }
          );
          break;
        }

        case "get_account": {
          const { id } = args as { id: string };
          data = await notfluxRequest(
            token,
            "GET",
            `/accounts/${encodeURIComponent(id)}`
          );
          break;
        }

        default:
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          };
      }

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: err instanceof Error ? err.message : String(err),
          },
        ],
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

function extractBearer(req: Request): string {
  const authHeader = req.headers["authorization"] ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return "";
  return authHeader.slice("bearer ".length).trim();
}

// ---------------------------------------------------------------------------
// RFC 9470 — OAuth 2.0 Protected Resource Metadata
// MCP clients discover required scopes / auth server from here BEFORE
// attempting to connect, so this endpoint must be publicly accessible.
// ---------------------------------------------------------------------------
app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
  res.json({
    resource: MCP_PUBLIC_BASE_URL,
    authorization_servers: [MCP_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: MCP_REQUIRED_SCOPES,
    resource_documentation: `${MCP_PUBLIC_BASE_URL}/docs`,
  });
});

// ---------------------------------------------------------------------------
// Session registry: sessionId -> { transport, tokenRef }
// ---------------------------------------------------------------------------

interface Session {
  transport: StreamableHTTPServerTransport;
  tokenRef: { current: string };
}

const sessions = new Map<string, Session>();

// POST /mcp  – handles initialize (new session) and all subsequent JSON-RPC requests
app.post("/mcp", requireValidToken, async (req: Request, res: Response) => {
  const token = extractBearer(req);
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
app.get("/mcp", requireValidToken, async (req: Request, res: Response) => {
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
app.delete("/mcp", requireValidToken, async (req: Request, res: Response) => {
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
