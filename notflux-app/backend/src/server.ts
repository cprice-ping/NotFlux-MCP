import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleAuth } from 'google-auth-library';

const app = express();
const PORT = process.env.BACKEND_PORT ?? 3001;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AGENT_RESOURCE =
  process.env.VERTEX_AGENT_RESOURCE ??
  'projects/3682147732/locations/us-west1/reasoningEngines/7712115294709219328';
const AGENT_REGION = AGENT_RESOURCE.match(/locations\/([^/]+)/)?.[1] ?? 'us-west1';
const AGENT_BASE = `https://${AGENT_REGION}-aiplatform.googleapis.com/v1/${AGENT_RESOURCE}`;

const NOTFLUX_API =
  process.env.NOTFLUX_API_BASE ?? 'https://notflux-api.ping-devops.com';

// ---------------------------------------------------------------------------
// PingOne Token Exchange config (RFC 8693)
// Set all three env vars to enable. If unset, the raw frontend token is used
// (current behaviour — safe fallback while the PingOne client is being set up).
// ---------------------------------------------------------------------------
const P1_ENV_ID =
  process.env.PINGONE_ENV_ID ?? '59bb6a66-e76e-490c-b83a-884c50423da4';
const P1_TOKEN_URL = `https://auth.pingone.com/${P1_ENV_ID}/as/token`;
const P1_TX_CLIENT_ID = process.env.PINGONE_TX_CLIENT_ID ?? '';      // confidential backend client
const P1_TX_CLIENT_SECRET = process.env.PINGONE_TX_CLIENT_SECRET ?? '';
// The audience the MCP Server validates — e.g. the MCP resource server's client_id in PingOne
const P1_MCP_AUDIENCE = process.env.PINGONE_MCP_AUDIENCE ?? '';
// Optional extra scopes to request on the exchanged token
const P1_MCP_SCOPE = process.env.PINGONE_MCP_SCOPE ?? '';

const TOKEN_EXCHANGE_ENABLED =
  Boolean(P1_TX_CLIENT_ID) &&
  Boolean(P1_TX_CLIENT_SECRET) &&
  Boolean(P1_MCP_AUDIENCE);

// ---------------------------------------------------------------------------
// Agent token scope validation
//
// When PINGONE_AGENT_AUDIENCE / PINGONE_AGENT_SCOPE are set, the backend
// decodes (without full verification — no JWKS call needed here since Kong
// and the MCP Server both re-validate) the incoming token on agent routes
// to confirm it is the agent-scoped token and not the person_token.
//
// This is a lightweight defence-in-depth check.  Full JWT verification of
// the incoming agent token would require the backend's own JWKS client and
// is out of scope for this demo — PingOne's Token Exchange endpoint will
// reject an invalid/expired subject_token regardless.
// ---------------------------------------------------------------------------
const EXPECTED_AGENT_AUDIENCE = process.env.PINGONE_AGENT_AUDIENCE ?? ''; // e.g. https://google-agent
const EXPECTED_AGENT_SCOPE    = process.env.PINGONE_AGENT_SCOPE    ?? 'agent-use';

/** Lightweight JWT payload decode (no signature verification) */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validate that the incoming token is an agent-scoped token.
 * Returns an error string when the check fails, null when it passes.
 * Only runs when PINGONE_AGENT_AUDIENCE is configured.
 */
function checkAgentToken(token: string): string | null {
  if (!EXPECTED_AGENT_AUDIENCE) return null; // validation not configured — skip

  const payload = decodeJwtPayload(token);
  if (!payload) return 'Could not decode token payload';

  // Audience check — `aud` can be a string or array per RFC 7519
  const aud = payload['aud'];
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.includes(EXPECTED_AGENT_AUDIENCE)) {
    return `Token audience ${JSON.stringify(aud)} does not match expected agent audience ${EXPECTED_AGENT_AUDIENCE}. ` +
           `Are you sending the person_token instead of the agent_token?`;
  }

  // Scope check
  const rawScope = (payload['scope'] ?? payload['scp']) as string | string[] | undefined;
  const scopes: string[] =
    typeof rawScope === 'string' ? rawScope.split(' ') :
    Array.isArray(rawScope)     ? rawScope : [];
  if (!scopes.includes(EXPECTED_AGENT_SCOPE)) {
    return `Token is missing required scope '${EXPECTED_AGENT_SCOPE}'. Scopes present: ${scopes.join(' ')}`;
  }

  return null;
}

if (TOKEN_EXCHANGE_ENABLED) {
  console.log(`Token Exchange enabled → audience: ${P1_MCP_AUDIENCE}`);
} else {
  console.log('Token Exchange disabled — set PINGONE_TX_CLIENT_ID/SECRET/MCP_AUDIENCE to enable');
}
if (EXPECTED_AGENT_AUDIENCE) {
  console.log(`Agent token validation → audience: ${EXPECTED_AGENT_AUDIENCE}, scope: ${EXPECTED_AGENT_SCOPE}`);
} else {
  console.log('Agent token audience validation disabled — set PINGONE_AGENT_AUDIENCE to enable');
}

/**
 * Exchange the user's frontend access token for an MCP-audience token.
 * Uses RFC 8693 Token Exchange with client_secret_basic authentication.
 *
 * PingOne requirement: the backend application must have the
 * "Token Exchange" grant type enabled, and an "Actor" token policy
 * that permits this client to act on behalf of the subject token's user.
 */
async function tokenExchange(subjectToken: string): Promise<string> {
  if (!TOKEN_EXCHANGE_ENABLED) return subjectToken;

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: P1_MCP_AUDIENCE,
    ...(P1_MCP_SCOPE ? { scope: P1_MCP_SCOPE } : {}),
  });

  // client_secret_basic — credentials in Authorization header
  const basicCred = Buffer.from(
    `${encodeURIComponent(P1_TX_CLIENT_ID)}:${encodeURIComponent(P1_TX_CLIENT_SECRET)}`
  ).toString('base64');

  const res = await fetch(P1_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicCred}`,
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token Exchange failed (${res.status}): ${err}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) {
    throw new Error('Token Exchange response missing access_token');
  }
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Google Cloud auth (Application Default Credentials)
// ---------------------------------------------------------------------------
const gauth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function gcpToken(): Promise<string> {
  const client = await gauth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to obtain GCP access token');
  return token;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(
  cors({
    origin: [
      'http://localhost:5173',
      'http://localhost:4173',
      ...(process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : []),
    ],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

function extractBearer(req: express.Request): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireBearer(
  req: express.Request,
  res: express.Response
): string | null {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return null;
  }
  return token;
}

// ---------------------------------------------------------------------------
// POST /api/sessions — create a Vertex AI Agent Engine session
//
// Expects: Bearer agent_token (aud=google-agent, scope=agent-use)
// The backend exchanges this for an MCP-audience token before injecting
// it into the Vertex session state.
// ---------------------------------------------------------------------------
app.post('/api/sessions', async (req, res) => {
  const userToken = requireBearer(req, res);
  if (!userToken) return;

  const agentScopeErr = checkAgentToken(userToken);
  if (agentScopeErr) {
    return res.status(403).json({ error: `Invalid agent token: ${agentScopeErr}` });
  }

  try {
    // Exchange for an MCP-audience token if Token Exchange is configured.
    // Falls back to the raw frontend token when not yet enabled.
    const mcpToken = await tokenExchange(userToken);

    const token = await gcpToken();
    const body = {
      user_id: (req.body.sub as string | undefined) ?? 'anonymous',
      session_state: {
        state: {
          // ADK tools access this via tool_context.state['pingone_authorization']
          pingone_authorization: `Bearer ${mcpToken}`,
        },
      },
    };

    const r = await fetch(`${AGENT_BASE}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: err });
    }

    const session = await r.json() as { name?: string };
    // Extract the last path segment as the session ID
    const sessionId = session.name?.split('/').pop() ?? session.name;
    res.json({ sessionId, raw: session });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/chat — streaming chat with the Vertex AI Agent Engine
//
// Expects: Bearer agent_token (aud=google-agent, scope=agent-use)
// Accepts: { message: string, sessionId?: string }
// Returns: text/event-stream (SSE) — each event is raw NDJSON from Agent Engine
// ---------------------------------------------------------------------------
app.post('/api/chat', async (req, res) => {
  const userToken = requireBearer(req, res);
  if (!userToken) return;

  const agentScopeErr = checkAgentToken(userToken);
  if (agentScopeErr) {
    return res.status(403).json({ error: `Invalid agent token: ${agentScopeErr}` });
  }

  const { message, sessionId } = req.body as {
    message: string;
    sessionId?: string;
  };
  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    // Refresh the exchanged token on every turn so it stays valid.
    // If Token Exchange is disabled this is a no-op (returns userToken).
    const mcpToken = await tokenExchange(userToken);

    const token = await gcpToken();

    // Choose session-based or stateless URL
    const url = sessionId
      ? `${AGENT_BASE}/sessions/${sessionId}:streamQuery`
      : `${AGENT_BASE}:streamQuery`;

    // Pass token in two places for maximum compatibility:
    //  1. stateDelta  — updates session state each turn with the fresh token
    //  2. input dict  — available as raw input to the agent
    const inputBody = sessionId
      ? {
          query: {
            parts: [{ text: message }],
            role: 'user',
          },
          // Re-inject token on every turn so it stays fresh
          stateDelta: {
            pingone_authorization: `Bearer ${mcpToken}`,
          },
        }
      : {
          input: {
            input: message,
            user_metadata: {
              pingone_authorization: `Bearer ${mcpToken}`,
            },
          },
        };

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(inputBody),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return res.status(upstream.status).json({ error: err });
    }

    // Stream SSE back to the browser
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) res.write(`data: ${trimmed}\n\n`);
      }
    }

    if (buffer.trim()) res.write(`data: ${buffer.trim()}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e) });
    } else {
      res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// NotFlux API proxy — forwards requests to the NotFlux/Kong API
// Avoids CORS issues in local dev; production can call the external API directly
// ---------------------------------------------------------------------------
app.use('/api/notflux', async (req, res) => {
  const userToken = requireBearer(req, res);
  if (!userToken) return;

  // Strip /api/notflux prefix, forward to real API
  const upstream = NOTFLUX_API + req.path;
  try {
    const r = await fetch(upstream, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body:
        req.method !== 'GET' && req.method !== 'HEAD'
          ? JSON.stringify(req.body)
          : undefined,
    });

    res.status(r.status);
    r.headers.forEach((v, k) => {
      // Skip headers that break the proxy
      if (['transfer-encoding', 'connection'].includes(k.toLowerCase())) return;
      res.setHeader(k, v);
    });
    const data = await r.text();
    res.send(data);
  } catch (e) {
    res.status(502).json({ error: `Upstream error: ${String(e)}` });
  }
});

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () =>
  console.log(`NotFlux backend proxy listening on http://localhost:${PORT}`)
);
